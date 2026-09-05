import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { hostname } from "node:os";
import { ulid } from "../utils/ulid";
import { assertJsonValue } from "../json";
import { ContentBlobStore } from "../blob-store";
import type { DeviceIdentityState } from "../device-identity";
import {
  ProducerDescriptorStore,
  createConnectorProducerDescriptor,
  createProducerBinding,
  type ProducerBinding,
} from "../producer-descriptor";
import type { SystemIdentity } from "../system-identity";
import { ConnectorAuthManager } from "./auth";
import type { OAuthAttemptView, OAuthStartResult } from "./auth";
import {
  createBoundConnectorGuard,
  sourceForConnector,
  type ConnectorHostGuard,
} from "./guard";
import {
  InProcessRunnerSession,
  ProcessRunnerSession,
  type RunnerCapabilities,
  type RunnerConfigUiCapabilities,
  type RunnerSourceIdentityCapabilities,
  type RunnerSession,
} from "./process-runner";
import {
  activePlatformRequirements,
  currentConnectorPlatform,
  isPlatformSupported,
  validateConnectorId,
  validateConnectorManifest,
} from "./manifest";
import {
  WorkspaceConnectorRegistry,
  hashConnectorPackage,
  trustStatusForSource,
} from "./registry";
import {
  ConnectorPackageArchiveStore,
} from "./connector-package-archive";
import { ConnectorInstallationStore } from "./installations";
import { validateConnectorDefinition } from "./runtime";
import {
  ConnectorSourceStore,
  createConnectorStateHandle,
  defaultAuthRef,
  isSourcePaused,
  newSourceId,
  type EnsureSourceInput,
  type UpdateSourceInput,
} from "./state";
import {
  sanitizeSourceIdentityError,
  validateConnectorSourceIdentityResult,
} from "./source-identity";
import { validateConnectorSchedule } from "./schedule";
import {
  isDirectOAuthAuthSpec,
  isManagedProviderAuthSpec,
  isOAuthAuthSpec,
  runtimeAuthType,
} from "./types";
import type {
  ConnectorConfigPanel,
  ConnectorConfigPatch,
  ConnectorConfigField,
  ConnectorDefinition,
  ConnectorSource,
  ConnectorOwnership,
  InstalledConnectorView,
  ConnectorManifest,
  ConnectorOfficialCatalogEntry,
  ConnectorPackageRecord,
  ConnectorPackageTrust,
  ConnectorPlatform,
  ConnectorRequirementContext,
  ConnectorRequirementRecord,
  ConnectorRequirementState,
  ConnectorRequirementStatus,
  ConnectorRunRecord,
  ConnectorRunTrigger,
  ConnectorRunHandle,
  ConnectorSourceIdentityKind,
  ConnectorWarningInput,
  JsonObject,
} from "./types";

export interface ConnectorRequirementView {
  id: string;
  status: ConnectorRequirementState | "unknown";
  message?: string;
  lastCheckedAt?: number;
}

export interface InstalledConnectorPackageView extends InstalledConnectorView {
  readonly manifest: ConnectorManifest;
  readonly eventCatalog: ConnectorPackageRecord["eventCatalog"];
}

export type ConnectorSetupPendingReason = "identity" | "auth" | "requirements" | "config";
export type ConnectorRuntimeReconcileReason =
  | "config_changed"
  | "credential_connected"
  | "source_created"
  | "readiness_changed";

export class ConnectorLifecycleConflictError extends Error {
  constructor(
    message: string,
    readonly code: "CONNECTOR_UPDATE_INCOMPATIBLE" = "CONNECTOR_UPDATE_INCOMPATIBLE",
  ) {
    super(message);
    this.name = "ConnectorLifecycleConflictError";
  }
}

interface Registration {
  manifest: ConnectorManifest;
  definition?: ConnectorDefinition;
  package?: ConnectorPackageRecord;
  trust: ConnectorPackageTrust;
  /** Explicit test/embedding identity; packaged Connectors derive this at admission. */
  producer?: ProducerBinding;
}

interface OpenedTrustedSession {
  session: RunnerSession;
  producer?: ProducerBinding;
}

interface ActiveRunIntent {
  instanceId: string;
  runId: string;
  trigger: ConnectorRunTrigger;
  controller: AbortController;
  attemptController: AbortController | undefined;
  runtimeGeneration: number;
  signal: AbortSignal;
  promise: Promise<void>;
  attemptSettled: Promise<void> | undefined;
  identityBarrier: Promise<void> | undefined;
  abort(): void;
  invalidateRuntime(): void;
  holdForIdentityMutation(): Promise<void>;
  releaseIdentityBarrier(): void;
  waitForIdentityMutation(): Promise<void>;
}

interface IdentityMutationClaim {
  sourceId: string;
  authAttemptId?: string;
  expiresAt?: number;
}

interface ActiveConfigUiSession {
  id: string;
  instanceId: string;
  connectorId: string;
  panelId: string;
  controller: AbortController;
  session: RunnerSession;
  url: string;
  startedAt: number;
}

export interface ConnectorSupervisorOptions {
  systemDb: DatabaseSync;
  guard: ConnectorHostGuard;
  workspacePath: string;
  systemIdentity: SystemIdentity;
  producerDescriptorStore?: ProducerDescriptorStore;
  packageArchiveStore?: Pick<
    ConnectorPackageArchiveStore,
    "publish" | "requireExists"
  >;
  /** Required only for in-process test/embedding definitions that receive D0 capability. */
  inProcessProducer?: ProducerBinding;
  platform?: ConnectorPlatform;
  authManager?: ConnectorAuthManager;
  officialCatalog?: ConnectorOfficialCatalogEntry[];
  // How long an aborted runner process gets to exit cooperatively before it
  // is force-killed.
  runnerKillGraceMs?: number;
  // How long bounded runner commands (load/check/request) may take before the
  // child is killed and the operation fails.
  runnerCommandTimeoutMs?: number;
  oauthRedirectUri?: string;
  managedProviderAppOrigin?: string;
  deviceIdentity?: DeviceIdentityState;
  deviceDisplayName?: string;
}

export interface ConnectorSourceView extends ConnectorSource {
  name: string;
  connectorName: string;
  description?: string;
  mode: string;
  identityKind: ConnectorSourceIdentityKind;
  ownership: ConnectorOwnership;
  ownershipReason?: string;
  conflictSourceId?: string;
  source: string | null;
  running: boolean;
  supported: boolean;
  packageTrust: ConnectorPackageTrust["status"];
  authType: string;
  authStatus?: string;
  authAttention?: "refresh_failed" | "redirect_uri_changed";
  authReady: boolean;
  setupPending: ConnectorSetupPendingReason[];
  requirements: ConnectorRequirementView[];
  recentRuns: ConnectorRunRecord[];
  configSchema?: Record<string, ConnectorConfigField>;
  configPanels?: Record<string, ConnectorConfigPanel>;
}

export interface ConnectSourceInput {
  authRef?: string;
}

type NonConfigSourceUpdateInput = Omit<UpdateSourceInput<never>, "config">;

const DEFAULT_MANAGED_PROVIDER_APP_ORIGIN = "https://app.lamarck.ai";

const MANUAL_TRUST: ConnectorPackageTrust = {
  status: "custom",
  badge: "Custom",
  runnable: true,
};

export class ConnectorSupervisor {
  private registrations = new Map<string, Registration>();
  private updatingConnectorIds = new Set<string>();
  private identityMutations = new Map<string, IdentityMutationClaim>();
  private activeRuns = new Map<string, ActiveRunIntent>();
  private runtimeReconcileListeners = new Set<(
    instanceId: string,
    reason: ConnectorRuntimeReconcileReason,
  ) => void>();
  private activeConfigUiSessions = new Map<string, ActiveConfigUiSession>();
  private store: ConnectorSourceStore;
  private authManager: ConnectorAuthManager;
  private platform: ConnectorPlatform;
  private runnerKillGraceMs: number | undefined;
  private runnerCommandTimeoutMs: number | undefined;
  private guard: ConnectorHostGuard;
  private workspacePath: string;
  private registry: WorkspaceConnectorRegistry;
  private oauthRedirectUri: string | undefined;
  private managedProviderAppOrigin: string;
  private deviceIdentity: DeviceIdentityState;
  private deviceDisplayName: string;
  private systemIdentity: SystemIdentity;
  private producerDescriptorStore: ProducerDescriptorStore;
  private packageArchiveStore: Pick<
    ConnectorPackageArchiveStore,
    "publish" | "requireExists"
  >;
  private inProcessProducer: ProducerBinding | undefined;
  private installationStore: ConnectorInstallationStore;

  constructor(opts: ConnectorSupervisorOptions) {
    this.guard = opts.guard;
    this.workspacePath = opts.workspacePath;
    this.systemIdentity = opts.systemIdentity;
    this.producerDescriptorStore = opts.producerDescriptorStore
      ?? new ProducerDescriptorStore(opts.workspacePath);
    this.packageArchiveStore = opts.packageArchiveStore
      ?? new ConnectorPackageArchiveStore(opts.workspacePath);
    this.inProcessProducer = opts.inProcessProducer;
    this.store = new ConnectorSourceStore(opts.systemDb);
    this.installationStore = new ConnectorInstallationStore(opts.systemDb);
    this.store.recoverInterruptedRuns();
    this.authManager = opts.authManager ?? new ConnectorAuthManager();
    this.platform = opts.platform ?? currentConnectorPlatform();
    this.runnerKillGraceMs = opts.runnerKillGraceMs;
    this.runnerCommandTimeoutMs = opts.runnerCommandTimeoutMs;
    this.oauthRedirectUri = opts.oauthRedirectUri;
    this.managedProviderAppOrigin = opts.managedProviderAppOrigin ?? DEFAULT_MANAGED_PROVIDER_APP_ORIGIN;
    this.deviceIdentity = opts.deviceIdentity ?? {
      status: "unavailable",
      reason: "Device identity was not provided by Core",
    };
    this.deviceDisplayName = opts.deviceDisplayName ?? hostname();
    this.registry = new WorkspaceConnectorRegistry({
      systemDb: opts.systemDb,
      officialCatalog: opts.officialCatalog ?? [],
    });
  }

  register<TConfig = unknown, TState = unknown>(
    manifest: ConnectorManifest,
    definition: ConnectorDefinition<TConfig, TState>,
  ): void {
    const normalized = validateConnectorManifest(manifest as ConnectorManifest);
    validateConnectorDefinition(
      definition as ConnectorDefinition,
      normalized.source.identity,
    );
    if (this.registrations.has(normalized.id)) {
      throw new Error(`Connector already registered: ${normalized.id}`);
    }
    this.registrations.set(normalized.id, {
      manifest: normalized,
      definition: definition as ConnectorDefinition,
      trust: MANUAL_TRUST,
      producer: this.inProcessProducer,
    });
  }

  async registerDirectory(connectorDir: string): Promise<ConnectorManifest> {
    const pkg = await this.registry.loadPackage(connectorDir);
    if (this.registrations.has(pkg.connectorId) && !this.updatingConnectorIds.has(pkg.connectorId)) {
      throw new Error(`Connector already registered: ${pkg.connectorId}`);
    }
    this.registrations.set(pkg.connectorId, {
      manifest: pkg.manifest,
      package: pkg,
      trust: pkg.trust,
    });
    this.store.setTrustForConnector(
      pkg.connectorId,
      trustStatusForSource(pkg.trust),
      pkg.contentHash,
    );
    return pkg.manifest;
  }

  /** Exact-hash trust authority used by staged install/update admission. */
  async verifyTrustedPackage(
    connectorDir: string,
    connectorId: string,
  ): Promise<ConnectorPackageRecord> {
    const pkg = await this.registry.loadPackage(connectorDir, connectorId);
    if (!pkg.trust.runnable) {
      throw new Error(`Connector ${pkg.connectorId} is not trusted: ${pkg.trust.status}`);
    }
    return pkg;
  }

  /** Record one Backend-verified Official Connector release by exact logical hash. */
  recordOfficialMarketplaceRelease(connectorId: string, contentHash: string): void {
    this.registry.recordOfficialRelease(connectorId, contentHash);
    const registration = this.registrations.get(connectorId);
    if (!registration?.package || registration.package.contentHash !== contentHash) return;

    // Same-hash Marketplace confirmation does not reinstall the package, so
    // publish the verified exact-hash provenance into the live registration
    // and Source views immediately rather than waiting for a Core restart.
    const trust = this.registry.classify(connectorId, contentHash);
    const packageRecord = { ...registration.package, trust };
    this.registrations.set(connectorId, {
      ...registration,
      package: packageRecord,
      trust,
    });
    this.store.setTrustForConnector(
      connectorId,
      trustStatusForSource(trust),
      contentHash,
    );
  }

  recordMarketplaceInstallation(connectorId: string, contentHash: string, releaseId: string): void {
    this.installationStore.record(connectorId, contentHash, releaseId);
  }

  marketplaceInstallation(connectorId: string) {
    return this.installationStore.get(connectorId);
  }

  async publishPackageArchive(connectorDir: string, contentHash: string): Promise<void> {
    await this.packageArchiveStore.publish(connectorDir, contentHash);
  }

  async withConnectorUpdate<T>(
    connectorId: string,
    nextManifest: ConnectorManifest,
    update: () => Promise<T>,
  ): Promise<T> {
    validateConnectorId(connectorId);
    const registration = this.requireRegistration(connectorId);
    if (!registration.package) {
      throw new Error(`Connector ${connectorId} was not loaded from a workspace package`);
    }
    if (this.updatingConnectorIds.has(connectorId)) {
      throw new ConnectorLifecycleConflictError(`Connector ${connectorId} is already updating`);
    }

    const normalized = validateConnectorManifest(nextManifest as ConnectorManifest);
    if (normalized.id !== connectorId) {
      throw new Error(
        `Connector manifest id "${normalized.id}" does not match installed id "${connectorId}"`,
      );
    }
    const sources = this.store.listForConnector(connectorId);
    if (sources.length > 0) {
      if (normalized.source.identity !== registration.manifest.source.identity) {
        throw new ConnectorLifecycleConflictError(
          `Connector ${connectorId} cannot change source.identity while Sources exist`,
        );
      }
      const currentAuth = runtimeAuthType(registration.manifest.auth ?? { type: "none" });
      const nextAuth = runtimeAuthType(normalized.auth ?? { type: "none" });
      if (currentAuth !== nextAuth) {
        throw new ConnectorLifecycleConflictError(
          `Connector ${connectorId} cannot change auth type while Sources exist`,
        );
      }
    }

    const identitySources = registration.manifest.source.identity === "connector"
      ? sources
      : [];
    const identityClaim = identitySources.length > 0
      ? this.claimIdentityMutation(connectorId, identitySources[0].id)
      : undefined;
    this.updatingConnectorIds.add(connectorId);
    try {
      for (const sourceRecord of identitySources) {
        this.store.beginIdentityResolution(sourceRecord.id);
      }
      for (const sourceRecord of sources) {
        const active = this.activeRuns.get(sourceRecord.id);
        if (active) {
          active.abort();
          await active.promise.catch(() => {});
        }
        await this.stopConfigUiSessionsForSource(sourceRecord.id);
      }
      try {
        const result = await update();
        for (const sourceRecord of identitySources) {
          await this.resolveSourceIdentityInClaim(sourceRecord.id);
        }
        return result;
      } catch (error) {
        // The update coordinator restores the old package before returning an
        // error. Resolve against whichever trusted package is registered now;
        // if rollback itself failed, leaving unresolved is the fail-closed
        // recovery state.
        for (const sourceRecord of identitySources) {
          if (!this.store.get(sourceRecord.id)) continue;
          await this.resolveSourceIdentityInClaim(sourceRecord.id).catch(() => {});
        }
        throw error;
      }
    } finally {
      this.updatingConnectorIds.delete(connectorId);
      if (identityClaim) this.releaseIdentityMutation(connectorId, identityClaim);
    }
  }

  async approveCurrentPackage(connectorId: string): Promise<ConnectorManifest> {
    const registration = this.requireRegistration(connectorId);
    if (!registration.package) {
      throw new Error(`Connector ${connectorId} was not loaded from a workspace package`);
    }
    const current = await this.registry.loadPackage(registration.package.dir);
    await this.packageArchiveStore.publish(current.dir, current.contentHash);
    return this.withConnectorUpdate(connectorId, current.manifest, async () => {
      const approved = this.registry.approveCustomPackage(current);
      this.registrations.set(connectorId, {
        ...registration,
        manifest: approved.manifest,
        package: approved,
        trust: approved.trust,
      });
      this.store.setTrustForConnector(
        connectorId,
        trustStatusForSource(approved.trust),
        approved.contentHash,
      );
      // D0 audit: the trust decision — who approved which exact package content.
      await this.guard.writeLifecycleEvent({
        type: "connector.approved",
        startedAt: Date.now(),
        payload: { connector_id: connectorId, approved_hash: approved.contentHash },
      });
      return approved.manifest;
    });
  }

  // The single Connector removal authority. The visible package directory is
  // part of remove itself because Workspace bootstrap admits it again. Source,
  // credential, checkpoint, and run remnants are reconstructable best-effort
  // cleanup after package removal, admission retirement, and the D0 event.
  async removeConnector(
    connectorId: string,
    removePackage: () => Promise<boolean>,
    eventWriter: ConnectorHostGuard = this.guard,
  ): Promise<boolean> {
    validateConnectorId(connectorId);
    const registration = this.registrations.get(connectorId);
    if (!registration?.package) return false;
    if (this.updatingConnectorIds.has(connectorId)) {
      throw new ConnectorLifecycleConflictError(`Connector ${connectorId} has a lifecycle operation in progress`);
    }
    this.updatingConnectorIds.add(connectorId);
    try {
      const sources = this.store.listForConnector(connectorId);
      for (const sourceRecord of sources) {
        const active = this.activeRuns.get(sourceRecord.id);
        active?.releaseIdentityBarrier();
        active?.abort();
        await active?.promise.catch(() => {});
        await this.stopConfigUiSessionsForSource(sourceRecord.id);
      }
      // Failure is authoritative: keep the Connector admitted and do not emit
      // connector.removed when its boot-visible package could not be removed.
      await removePackage();
      this.registrations.delete(connectorId);
      this.registry.removeApprovals(connectorId);
      this.installationStore.remove(connectorId);
      await eventWriter.writeLifecycleEvent({
        type: "connector.removed",
        startedAt: Date.now(),
        payload: { connector_id: connectorId },
      });
      setImmediate(() => {
        void this.clearInactiveConnectorRemnants(connectorId).catch((error) => {
          console.warn(`[connectors] best-effort cleanup for ${connectorId} failed:`, error);
        });
      });
      return true;
    } finally {
      this.updatingConnectorIds.delete(connectorId);
    }
  }

  private async removeSourcesForConnector(connectorId: string): Promise<number> {
    validateConnectorId(connectorId);
    const sources = this.store.list().filter((sourceRecord) => sourceRecord.connectorId === connectorId);
    for (const sourceRecord of sources) {
      await this.removeSource(sourceRecord.id);
    }
    return sources.length;
  }

  async clearInactiveConnectorRemnants(connectorId: string): Promise<number> {
    validateConnectorId(connectorId);
    if (this.registrations.has(connectorId)) return 0;
    return this.removeSourcesForConnector(connectorId);
  }

  async reconcileInstalledConnectorIds(installedConnectorIds: Iterable<string>): Promise<string[]> {
    const installed = new Set([...installedConnectorIds, ...this.registrations.keys()]);
    const orphaned = new Set(
      this.store.list()
        .filter((sourceRecord) => !installed.has(sourceRecord.connectorId))
        .map((sourceRecord) => sourceRecord.connectorId),
    );
    for (const connectorId of orphaned) {
      await this.removeSourcesForConnector(connectorId);
      this.registry.removeApprovals(connectorId);
      this.installationStore.remove(connectorId);
    }
    return [...orphaned].sort();
  }

  // Removes one Source: aborts its run, stops config UI, purges credentials,
  // config/checkpoint/schedule/run history with the row, and leaves no
  // placeholder behind. An installed connector may own zero Sources.
  async removeSource(instanceId: string): Promise<void> {
    const sourceRecord = this.store.get(instanceId);
    if (!sourceRecord) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }

    let identityClaim = this.identityMutations.get(sourceRecord.connectorId);
    if (identityClaim && identityClaim.expiresAt === undefined) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${sourceRecord.connectorId} has an identity mutation in progress`,
      );
    }

	  const active = this.activeRuns.get(instanceId);
    let claimedBrowserAttempt = identityClaim?.sourceId === instanceId
      ? identityClaim
      : undefined;
    if (claimedBrowserAttempt) {
      // Explicit removal cancels the browser attempt synchronously, then owns
      // its claim until deletion completes. Release only the run barrier here
      // so aborting the preserved intent cannot deadlock behind that claim.
      this.authManager.cancelAttemptsForSource(instanceId);
      claimedBrowserAttempt.expiresAt = undefined;
      active?.releaseIdentityBarrier();
    }
	    if (active) {
	      active.abort();
	      await active.promise.catch(() => {});
    }
    await this.stopConfigUiSessionsForSource(instanceId);

    // Re-check after awaited cleanup: a browser callback may have moved its
    // claim into non-expiring identity finalization while removal was waiting.
    identityClaim = this.identityMutations.get(sourceRecord.connectorId);
    if (
      identityClaim
      && identityClaim !== claimedBrowserAttempt
      && identityClaim.expiresAt === undefined
    ) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${sourceRecord.connectorId} has an identity mutation in progress`,
      );
    }
    if (
      identityClaim
      && identityClaim !== claimedBrowserAttempt
      && identityClaim.sourceId === instanceId
    ) {
      this.authManager.cancelAttemptsForSource(instanceId);
      identityClaim.expiresAt = undefined;
      claimedBrowserAttempt = identityClaim;
    }
    this.authManager.cancelAttemptsForSource(instanceId, { removed: true });
    try {
      await this.authManager.deleteSourceCredentials(instanceId, sourceRecord.authRef);
      this.store.delete(instanceId);
    } finally {
      if (claimedBrowserAttempt) {
        this.releaseIdentityMutation(sourceRecord.connectorId, claimedBrowserAttempt);
      }
    }
  }

  // apiKey connect: store the pasted token and run the normal connect flow.
  // oauth2 uses the browser authorization flow, not this token endpoint.
  async connectSourceWithToken<TConfig = unknown, TState = unknown>(
    instanceId: string,
    token: string,
  ): Promise<ConnectorSource<TConfig, TState>> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    const auth = registration.manifest.auth ?? { type: "none" };
    if (auth.type === "none") {
      throw new Error(`Connector ${existing.connectorId} does not require auth`);
    }
    if (isOAuthAuthSpec(auth) || isManagedProviderAuthSpec(auth)) {
      throw new Error(`Connector ${existing.connectorId} uses browser auth; use the browser connect flow`);
    }
    if (!token || !token.trim()) {
      throw new Error("Connector apiKey connect requires a non-empty token");
    }
    const authRef = existing.authRef ?? defaultAuthRef(existing.id);
    if (registration.manifest.source.identity === "connector") {
      const connected = await this.withIdentityMutation(instanceId, async () => {
        const generation = this.authManager.currentSourceAuthGeneration(existing.id);
        await this.authManager.setToken(authRef, token.trim(), {
          ownerType: "connector",
          ownerId: existing.id,
          generation,
        });
        this.store.update(instanceId, { authRef });
      });
      this.requestRuntimeReconcile(instanceId, "credential_connected", false);
      return connected as ConnectorSource<TConfig, TState>;
    }

    const generation = this.authManager.currentSourceAuthGeneration(existing.id);
    await this.authManager.setToken(authRef, token.trim(), {
      ownerType: "connector",
      ownerId: existing.id,
      generation,
    });
    return this.connectSource<TConfig, TState>(instanceId, { authRef });
  }

  async startOAuthSource(
    instanceId: string,
    input: { redirectUri: string; replacePending?: boolean },
  ): Promise<OAuthStartResult> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    const auth = registration.manifest.auth ?? { type: "none" };
    if (!isOAuthAuthSpec(auth)) {
      throw new Error(`Connector ${existing.connectorId} does not use oauth2`);
    }
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${existing.connectorId} is not supported on ${this.platform}`);
    }
    return this.startBrowserAuth(
      existing,
      () => this.authManager.startOAuth(existing, auth, input),
      input.replacePending,
    );
  }

  async startAuthSource(
    instanceId: string,
    input: { redirectUri: string; replacePending?: boolean },
  ): Promise<OAuthStartResult> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    const auth = registration.manifest.auth ?? { type: "none" };
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${existing.connectorId} is not supported on ${this.platform}`);
    }
    if (isDirectOAuthAuthSpec(auth)) {
      return this.startBrowserAuth(
        existing,
        () => this.authManager.startOAuth(existing, auth, input),
        input.replacePending,
      );
    }
    if (isManagedProviderAuthSpec(auth)) {
      return this.startBrowserAuth(
        existing,
        () => this.authManager.startManagedProvider(existing, auth, {
          appOrigin: this.managedProviderAppOrigin,
        }),
        input.replacePending,
      );
    }
    throw new Error(`Connector ${existing.connectorId} does not use browser auth`);
  }

  async getOAuthAttempt(instanceId: string, attemptId: string): Promise<OAuthAttemptView> {
    const result = await this.authManager.getOAuthAttempt(instanceId, attemptId);
    await this.finalizeConnectedAuthAttempt(result);
    return result;
  }

  cancelAuthAttempt(instanceId: string, attemptId: string): boolean {
    const sourceRecord = this.store.get(instanceId);
    if (!sourceRecord) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    this.requireRegistration(sourceRecord.connectorId);
    const cancelled = this.authManager.cancelPendingAuthAttempt(instanceId, attemptId);
    const identityClaim = this.identityMutations.get(sourceRecord.connectorId);
    if (
      cancelled
      && identityClaim?.sourceId === instanceId
      && identityClaim.authAttemptId === attemptId
      && identityClaim.expiresAt !== undefined
    ) {
      this.releaseIdentityMutation(sourceRecord.connectorId, identityClaim);
    }
    return cancelled;
  }

  async completeOAuthCallback(params: URLSearchParams): Promise<OAuthAttemptView> {
    const result = await this.authManager.completeOAuthCallback(params);
    await this.finalizeConnectedAuthAttempt(result);
    return result;
  }

  ensureSource<TConfig = unknown, TState = unknown>(
    input: EnsureSourceInput<TConfig>,
  ): ConnectorSource<TConfig, TState> {
    if (
      input.displayName !== undefined
      && input.displayName !== null
      && typeof input.displayName !== "string"
    ) {
      throw new Error("Source displayName must be a string or null");
    }
    const registration = this.requireRegistration(input.connectorId);
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${input.connectorId} is not supported on ${this.platform}`);
    }

    const scheduleCron = input.scheduleCron === undefined
      ? registration.manifest.runtime.defaultSchedule
      : input.scheduleCron ?? undefined;
    if (scheduleCron !== undefined) {
      validateConnectorSchedule(scheduleCron);
    }
    const packageHash = input.packageHash ?? registration.package?.contentHash;
    const trustStatus = input.trustStatus ?? trustStatusForSource(registration.trust);
    const storeInput = {
      ...input,
      setupStatus: "setup" as const,
      scheduleCron,
      packageHash,
      trustStatus,
    };

    if (input.id) {
      return this.store.ensure<TConfig, TState>(storeInput);
    }

    let created: ConnectorSource<TConfig, TState>;
    switch (registration.manifest.source.identity) {
      case "single":
        created = this.store.createSingle<TConfig, TState>(storeInput);
        break;
      case "device":
        if (this.deviceIdentity.status === "unavailable") {
          throw new Error(`Device identity unavailable: ${this.deviceIdentity.reason}`);
        }
        try {
          created = this.store.createDevice<TConfig, TState>(
            storeInput,
            this.deviceIdentity.value,
            normalizeDeviceLabel(this.deviceDisplayName),
          );
        } catch (error) {
          if (isSourceIdentityConflictError(error)) {
            throw new ConnectorLifecycleConflictError(
              `Connector ${input.connectorId} already has a Source for this device`,
            );
          }
          throw error;
        }
        break;
      case "connector":
        created = this.store.createConnector<TConfig, TState>(storeInput);
        break;
    }

    const noAuth = (registration.manifest.auth ?? { type: "none" }).type === "none";
    const requirementsReady = this.requirementsSatisfiedFor(registration.manifest, created);
    const configReady = this.configSatisfiedFor(registration.manifest, created.config);
    if (
      registration.manifest.source.identity !== "connector"
      && noAuth
      && requirementsReady
      && configReady
    ) {
      return this.store.update<TConfig, TState>(created.id, { setupStatus: "ready" });
    }
    return created;
  }

  async addSource<TConfig = unknown, TState = unknown>(
    input: Omit<EnsureSourceInput<TConfig>, "id">,
  ): Promise<ConnectorSource<TConfig, TState>> {
    const registration = this.requireRegistration(input.connectorId);
    if (this.updatingConnectorIds.has(input.connectorId)) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${input.connectorId} is updating`,
      );
    }
    const before = registration.manifest.source.identity === "single"
      ? this.store.firstForConnector(input.connectorId)
      : undefined;
    const created = this.ensureSource<TConfig, TState>(input);
    let refreshed = await this.refreshSetupStatus(created.id, {
      allowIdentityResolution: false,
    });
    if (
      registration.manifest.source.identity === "connector"
      && await this.otherIdentityGatesReady(registration.manifest, refreshed)
    ) {
      refreshed = await this.withIdentityMutation<TConfig, TState>(created.id);
    }
    if (!before && refreshed.setupStatus === "ready") {
      this.requestRuntimeReconcile(refreshed.id, "source_created");
    }
    return refreshed as ConnectorSource<TConfig, TState>;
  }

  updateSource<TConfig = unknown, TState = unknown>(
    instanceId: string,
    input: NonConfigSourceUpdateInput,
  ): ConnectorSource<TConfig, TState> {
    if ("config" in input) {
      throw new Error(
        `Connector Source ${instanceId} config changes must use configureSource`,
      );
    }
    return this.persistSourceUpdate<TConfig, TState>(instanceId, input).updated;
  }

  async configureSource<TConfig = unknown, TState = unknown>(
    instanceId: string,
    input: UpdateSourceInput<TConfig>,
  ): Promise<ConnectorSource<TConfig, TState>> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    this.validateSourceUpdateInput(existing, registration, input);
    const previousEffectiveConfig = mergeConfig(
      schemaDefaults(registration.manifest),
      existing.config,
    );
    const nextEffectiveConfig = mergeConfig(
      schemaDefaults(registration.manifest),
      input.config === undefined ? existing.config : input.config,
    );
    const effectiveConfigChanged = input.config !== undefined
      && !isDeepStrictEqual(previousEffectiveConfig, nextEffectiveConfig);

    if (registration.manifest.source.identity === "connector" && effectiveConfigChanged) {
      const refreshed = await this.withIdentityMutation(instanceId, async () => {
        this.persistSourceUpdate<TConfig, TState>(instanceId, input);
      });
      this.requestRuntimeReconcile(instanceId, "config_changed", false);
      return refreshed as ConnectorSource<TConfig, TState>;
    }

    const persisted = this.persistSourceUpdate<TConfig, TState>(instanceId, input);
    let refreshed: ConnectorSource;
    try {
      refreshed = await this.refreshSetupStatus(instanceId, {
        allowIdentityResolution: false,
      });
    } catch (err) {
      // The config is already durable. Do not leave an active attempt on the
      // stale value just because an asynchronous readiness check failed.
      if (persisted.effectiveConfigChanged) {
        this.requestRuntimeReconcile(instanceId, "config_changed");
      }
      throw err;
    }
    if (persisted.effectiveConfigChanged) {
      this.requestRuntimeReconcile(instanceId, "config_changed");
    } else if (persisted.updated.setupStatus !== refreshed.setupStatus) {
      this.requestRuntimeReconcile(instanceId, "readiness_changed");
    }
    return refreshed as ConnectorSource<TConfig, TState>;
  }

  private persistSourceUpdate<TConfig = unknown, TState = unknown>(
    instanceId: string,
    input: UpdateSourceInput<TConfig>,
  ): {
    updated: ConnectorSource<TConfig, TState>;
    effectiveConfigChanged: boolean;
  } {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    this.validateSourceUpdateInput(existing, registration, input);
    const nextConfig = input.config === undefined ? existing.config : input.config;
    const previousEffectiveConfig = mergeConfig(
      schemaDefaults(registration.manifest),
      existing.config,
    );
    const setupStatus = this.requirementsSatisfiedFor(registration.manifest, existing)
      && this.configSatisfiedFor(registration.manifest, nextConfig)
      ? existing.setupStatus
      : "setup";
    const updated = this.store.update<TConfig, TState>(instanceId, {
      ...input,
      setupStatus,
    });
    const nextEffectiveConfig = mergeConfig(
      schemaDefaults(registration.manifest),
      updated.config,
    );
    return {
      updated,
      effectiveConfigChanged: input.config !== undefined
        && !isDeepStrictEqual(previousEffectiveConfig, nextEffectiveConfig),
    };
  }

  private validateSourceUpdateInput(
    existing: ConnectorSource,
    registration: Registration,
    input: UpdateSourceInput<unknown>,
  ): void {
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${existing.connectorId} is not supported on ${this.platform}`);
    }
    if (input.authRef !== undefined && input.authRef !== existing.authRef) {
      throw new Error(
        `Connector Source ${existing.id} authRef changes must use connectSource`,
      );
    }
    validateScheduleInput(input.scheduleCron);
  }

  async connectSource<TConfig = unknown, TState = unknown>(
    instanceId: string,
    input: ConnectSourceInput = {},
  ): Promise<ConnectorSource<TConfig, TState>> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    const auth = registration.manifest.auth ?? { type: "none" };
    if (auth.type === "none") {
      throw new Error(`Connector ${existing.connectorId} does not require auth`);
    }
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${existing.connectorId} is not supported on ${this.platform}`);
    }
    const authRef = input.authRef ?? existing.authRef;
    if (!authRef || !(await this.authManager.hasToken(authRef))) {
      throw new Error(`Connector Source ${instanceId} requires credentials before it can be ready`);
    }
    if (registration.manifest.source.identity === "connector") {
      const connected = await this.withIdentityMutation(instanceId, async () => {
        this.store.update(instanceId, { authRef });
      });
      this.requestRuntimeReconcile(instanceId, "credential_connected", false);
      return connected as ConnectorSource<TConfig, TState>;
    }
    this.store.update(instanceId, { authRef });
    const connected = await this.refreshSetupStatus(instanceId);
    this.requestRuntimeReconcile(instanceId, "credential_connected");
    return connected as ConnectorSource<TConfig, TState>;
  }

  async disconnectSource<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): Promise<ConnectorSource<TConfig, TState>> {
    const existing = this.store.get<TConfig, TState>(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    if ((registration.manifest.auth ?? { type: "none" }).type === "none") {
      throw new Error(`Connector ${existing.connectorId} does not use an account credential`);
    }
    const pendingIdentityClaim = this.identityMutations.get(existing.connectorId);
    if (pendingIdentityClaim && pendingIdentityClaim.expiresAt === undefined) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${existing.connectorId} already has an identity mutation in progress`,
      );
    }

    let claimedBrowserAttempt = pendingIdentityClaim?.sourceId === instanceId
      ? pendingIdentityClaim
      : undefined;
    if (claimedBrowserAttempt) {
      // The preserved run intent is waiting on this claim's barrier. Cancel
      // the browser attempt and release only that barrier before awaiting the
      // intent, while retaining the Connector exclusion through deletion.
      this.authManager.cancelAttemptsForSource(instanceId);
      claimedBrowserAttempt.expiresAt = undefined;
      this.activeRuns.get(instanceId)?.releaseIdentityBarrier();
    }

    // Disconnect is a readiness change, not Source removal: stop current use
    // of the account and delete credentials, while preserving Source identity,
    // config, checkpoint, schedule, and pause policy.
    const active = this.activeRuns.get(instanceId);
    if (active) {
      active.abort();
      await active.promise.catch(() => {});
    }

    // A browser connect can claim this Source while Disconnect is awaiting a
    // previously active attempt. Adopt and cancel that late expiring claim;
    // never interrupt finalization after it has become non-expiring.
    const currentIdentityClaim = this.identityMutations.get(existing.connectorId);
    if (
      currentIdentityClaim
      && currentIdentityClaim !== claimedBrowserAttempt
      && currentIdentityClaim.expiresAt === undefined
    ) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${existing.connectorId} already has an identity mutation in progress`,
      );
    }
    if (
      currentIdentityClaim
      && currentIdentityClaim !== claimedBrowserAttempt
      && currentIdentityClaim.sourceId === instanceId
    ) {
      this.authManager.cancelAttemptsForSource(instanceId);
      currentIdentityClaim.expiresAt = undefined;
      claimedBrowserAttempt = currentIdentityClaim;
    }
    if (!claimedBrowserAttempt) {
      this.authManager.cancelAttemptsForSource(instanceId);
    }
    try {
      await this.authManager.deleteSourceCredentials(instanceId, existing.authRef);
      return (await this.refreshSetupStatus(instanceId)) as ConnectorSource<TConfig, TState>;
    } finally {
      if (claimedBrowserAttempt) {
        this.releaseIdentityMutation(existing.connectorId, claimedBrowserAttempt);
      }
    }
  }

  isRegistered(connectorId: string): boolean {
    return this.registrations.has(connectorId);
  }

  listInstalledConnectors(): InstalledConnectorView[] {
    return [...this.registrations.values()]
      .map((registration) => ({
        connectorId: registration.manifest.id,
        name: registration.manifest.name,
        description: registration.manifest.description,
        mode: registration.manifest.runtime.mode,
        identityKind: registration.manifest.source.identity,
        supported: isPlatformSupported(registration.manifest, this.platform),
        packageTrust: registration.trust.status,
        packageHash: registration.package?.contentHash,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.connectorId.localeCompare(b.connectorId));
  }

  installedConnectorPackage(connectorId: string): InstalledConnectorPackageView | undefined {
    validateConnectorId(connectorId);
    const registration = this.registrations.get(connectorId);
    if (!registration?.package) return undefined;
    return Object.freeze({
      connectorId: registration.manifest.id,
      name: registration.manifest.name,
      description: registration.manifest.description,
      mode: registration.manifest.runtime.mode,
      identityKind: registration.manifest.source.identity,
      supported: isPlatformSupported(registration.manifest, this.platform),
      packageTrust: registration.trust.status,
      packageHash: registration.package.contentHash,
      manifest: registration.manifest,
      eventCatalog: registration.package.eventCatalog,
    });
  }

  /** Re-reads package identity for Public CLI/control-plane decisions. */
  async currentInstalledConnectorPackage(
    connectorId: string,
  ): Promise<InstalledConnectorPackageView | undefined> {
    validateConnectorId(connectorId);
    const registration = this.registrations.get(connectorId);
    if (!registration?.package) return undefined;
    const packageHash = await hashConnectorPackage(registration.package.dir);
    const installation = this.installationStore.get(connectorId);
    const packageTrust = packageHash !== registration.package.contentHash
      || (installation !== undefined && installation.packageHash !== packageHash)
      ? "modified" as const
      : this.registry.classify(connectorId, packageHash).status;
    return Object.freeze({
      connectorId: registration.manifest.id,
      name: registration.manifest.name,
      description: registration.manifest.description,
      mode: registration.manifest.runtime.mode,
      identityKind: registration.manifest.source.identity,
      supported: isPlatformSupported(registration.manifest, this.platform),
      packageTrust,
      packageHash,
      manifest: registration.manifest,
      eventCatalog: registration.package.eventCatalog,
    });
  }

  listInstalledConnectorPackages(): InstalledConnectorPackageView[] {
    return this.listInstalledConnectors()
      .map((value) => this.installedConnectorPackage(value.connectorId))
      .filter((value): value is InstalledConnectorPackageView => value !== undefined);
  }

  async listCurrentInstalledConnectorPackages(): Promise<InstalledConnectorPackageView[]> {
    const packages = await Promise.all(this.listInstalledConnectors()
      .map((value) => this.currentInstalledConnectorPackage(value.connectorId)));
    return packages.filter((value): value is InstalledConnectorPackageView => value !== undefined);
  }

  /** One command-local Public CLI snapshot; no persistent Shape cache. */
  async currentCliShape(): Promise<{
    readonly packages: readonly InstalledConnectorPackageView[];
    readonly sources: readonly ConnectorSourceView[];
  }> {
    const [packages, sources] = await Promise.all([
      this.listCurrentInstalledConnectorPackages(),
      this.listAdmitted(),
    ]);
    return Object.freeze({ packages: Object.freeze(packages), sources: Object.freeze(sources) });
  }

  sourceRun(sourceId: string, runId: string): ConnectorRunRecord | undefined {
    const record = this.store.getRun(runId);
    return record?.sourceId === sourceId ? record : undefined;
  }

  async list(): Promise<ConnectorSourceView[]> {
    return this.projectSourceViews(this.store.list());
  }

  /** Current Shape projection excludes Sources whose Connector is no longer admitted. */
  async listAdmitted(): Promise<ConnectorSourceView[]> {
    return this.projectSourceViews(
      this.store.list().filter((source) => this.registrations.has(source.connectorId)),
    );
  }

  private async projectSourceViews(
    records: readonly ConnectorSource[],
  ): Promise<ConnectorSourceView[]> {
    return Promise.all(records.map(async (sourceRecord) => {
      const registration = this.registrations.get(sourceRecord.connectorId);
      const identityKind = registration?.manifest.source.identity ?? "single";
      const identityReady = registration
        ? identityPairResolved(sourceRecord, identityKind)
        : sourceRecord.identityStatus === "resolved";
      const activeRequirements = registration
        ? activePlatformRequirements(registration.manifest, this.platform)
        : [];
      const authSpec = registration?.manifest.auth ?? { type: "none" };
      const authType = authSpec.type;
      const credential = sourceRecord.authRef ? this.authManager.credential(sourceRecord.authRef) : undefined;
      const storedRedirectUri = typeof credential?.metadata?.redirect_uri === "string"
        ? credential.metadata.redirect_uri
        : undefined;
      const authAttention = credential?.status === "refresh_failed"
        ? "refresh_failed"
        : isDirectOAuthAuthSpec(authSpec)
          && storedRedirectUri
          && this.oauthRedirectUri
          && storedRedirectUri !== this.oauthRedirectUri
            ? "redirect_uri_changed"
            : undefined;
      const authReady = authType === "none"
        || Boolean(sourceRecord.authRef && (await this.authManager.hasToken(sourceRecord.authRef)));

      const setupPending: ConnectorSetupPendingReason[] = [];
      if (registration) {
        if (!authReady) setupPending.push("auth");
        if (!this.requirementsSatisfiedFor(registration.manifest, sourceRecord)) {
          setupPending.push("requirements");
        }
        if (!this.configSatisfiedFor(registration.manifest, sourceRecord.config)) {
          setupPending.push("config");
        }
        if (!identityReady) setupPending.push("identity");
      }

      const ownership = registration
        ? this.ownershipFor(sourceRecord, registration.manifest)
        : "here";
      const connectorName = registration?.manifest.name ?? sourceRecord.connectorId;
      const conflictSourceId = sourceRecord.identityStatus === "conflict"
        && sourceRecord.lastResolvedKey
        ? this.store.getBySourceKey(sourceRecord.connectorId, sourceRecord.lastResolvedKey)?.id
        : undefined;

      return {
        ...sourceRecord,
        setupStatus: registration
          ? setupPending.length > 0 ? "setup" : "ready"
          : sourceRecord.setupStatus,
        name: sourceRecord.displayName ?? sourceRecord.suggestedLabel ?? connectorName,
        connectorName,
        ...(registration ? { description: registration.manifest.description } : {}),
        mode: registration?.manifest.runtime.mode ?? "unknown",
        identityKind,
        ownership,
        ...(ownership === "device-unknown" && this.deviceIdentity.status === "unavailable"
          ? { ownershipReason: this.deviceIdentity.reason }
          : {}),
        ...(conflictSourceId ? { conflictSourceId } : {}),
        source: identityReady
          ? sourceForConnector(sourceRecord.connectorId, sourceRecord.sourceKey ?? undefined)
          : null,
        running: this.activeRuns.has(sourceRecord.id),
        supported: registration ? isPlatformSupported(registration.manifest, this.platform) : false,
        packageTrust: registration?.trust.status ?? "missing",
        authType,
        authStatus: credential?.status,
        authAttention,
        authReady,
        setupPending,
        requirements: activeRequirements.map((id) => ({
          id,
          status: sourceRecord.requirementsStatus?.[id]?.status ?? "unknown",
          message: sourceRecord.requirementsStatus?.[id]?.message,
          lastCheckedAt: sourceRecord.requirementsStatus?.[id]?.lastCheckedAt,
        })),
	        recentRuns: this.store.listRuns(sourceRecord.id),
	        configSchema: registration?.manifest.config,
	        configPanels: registration?.manifest.configPanels,
	      };
	    }));
	  }

  async run(instanceId: string, opts?: { trigger?: ConnectorRunTrigger }): Promise<void> {
    const active = this.createRun(instanceId, opts);
    await active.promise;
  }

  start(instanceId: string, opts?: { trigger?: ConnectorRunTrigger }): ConnectorRunHandle {
    return this.createRun(instanceId, opts);
  }

  abort(instanceId: string): void {
    this.activeRuns.get(instanceId)?.abort();
  }

  onRuntimeReconcileRequested(
    listener: (
      instanceId: string,
      reason: ConnectorRuntimeReconcileReason,
    ) => void,
  ): () => void {
    this.runtimeReconcileListeners.add(listener);
    return () => this.runtimeReconcileListeners.delete(listener);
  }

  private requestRuntimeReconcile(
    instanceId: string,
    reason: ConnectorRuntimeReconcileReason,
    invalidateRuntime = true,
  ): void {
    if (invalidateRuntime) this.activeRuns.get(instanceId)?.invalidateRuntime();
    for (const listener of this.runtimeReconcileListeners) {
      try {
        listener(instanceId, reason);
      } catch (err) {
        console.warn("[connectors] runtime reconcile listener failed:", err);
      }
    }
  }

  private claimIdentityMutation(
    connectorId: string,
    sourceId: string,
    expiresAt?: number,
  ): IdentityMutationClaim {
    const existing = this.identityMutations.get(connectorId);
    if (existing) {
      if (existing.expiresAt !== undefined && Date.now() > existing.expiresAt) {
        // Expiry must invalidate the auth generation as well as the exclusion;
        // otherwise an already-running callback could commit after the sweep.
        this.authManager.cancelAttemptsForSource(existing.sourceId);
        this.identityMutations.delete(connectorId);
        this.activeRuns.get(existing.sourceId)?.releaseIdentityBarrier();
      } else {
        throw new ConnectorLifecycleConflictError(
          `Connector ${connectorId} already has an identity mutation in progress`,
        );
      }
    }
    const claim: IdentityMutationClaim = { sourceId, expiresAt };
    this.identityMutations.set(connectorId, claim);
    return claim;
  }

  private releaseIdentityMutation(
    connectorId: string,
    claim: IdentityMutationClaim,
  ): void {
    if (this.identityMutations.get(connectorId) !== claim) return;
    this.identityMutations.delete(connectorId);
    this.activeRuns.get(claim.sourceId)?.releaseIdentityBarrier();
  }

  private async drainExecutionAttemptForIdentity(instanceId: string): Promise<void> {
    const active = this.activeRuns.get(instanceId);
    if (!active) return;
    await active.holdForIdentityMutation();
  }

  private async withIdentityMutation<TConfig = unknown, TState = unknown>(
    instanceId: string,
    commit: () => Promise<void> | void = () => {},
  ): Promise<ConnectorSource<TConfig, TState>> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    if (registration.manifest.source.identity !== "connector") {
      throw new Error(`Connector ${existing.connectorId} does not resolve Source identity`);
    }
    const claim = this.claimIdentityMutation(existing.connectorId, instanceId);
    try {
      this.store.beginIdentityResolution(instanceId);
      await this.drainExecutionAttemptForIdentity(instanceId);
      try {
        await commit();
      } catch (error) {
        this.store.publishIdentityError(
          instanceId,
          sanitizeSourceIdentityError(existing.connectorId, error),
        );
        throw error;
      }
      return await this.resolveSourceIdentityInClaim(instanceId) as ConnectorSource<TConfig, TState>;
    } finally {
      this.releaseIdentityMutation(existing.connectorId, claim);
    }
  }

  private async startBrowserAuth(
    sourceRecord: ConnectorSource,
    start: () => Promise<OAuthStartResult> | OAuthStartResult,
    replacePending = false,
  ): Promise<OAuthStartResult> {
    const registration = this.requireRegistration(sourceRecord.connectorId);
    if (registration.manifest.source.identity !== "connector") {
      if (replacePending) {
        this.authManager.cancelPendingAuthAttemptsForSource(sourceRecord.id);
      }
      return await start();
    }

    if (replacePending) {
      this.cancelPendingBrowserIdentityMutation(sourceRecord);
    }

    const claim = this.claimIdentityMutation(sourceRecord.connectorId, sourceRecord.id);
    try {
      this.store.beginIdentityResolution(sourceRecord.id);
      await this.drainExecutionAttemptForIdentity(sourceRecord.id);
      const result = await start();
      claim.authAttemptId = result.attemptId;
      claim.expiresAt = result.expiresAt;
      return result;
    } catch (error) {
      this.store.publishIdentityError(
        sourceRecord.id,
        sanitizeSourceIdentityError(sourceRecord.connectorId, error),
      );
      this.releaseIdentityMutation(sourceRecord.connectorId, claim);
      throw error;
    }
  }

  private cancelPendingBrowserIdentityMutation(sourceRecord: ConnectorSource): boolean {
    const claim = this.identityMutations.get(sourceRecord.connectorId);
    if (
      !claim
      || claim.sourceId !== sourceRecord.id
      || claim.expiresAt === undefined
    ) {
      return false;
    }
    const cancelled = claim.authAttemptId
      ? this.authManager.cancelPendingAuthAttempt(sourceRecord.id, claim.authAttemptId)
      : this.authManager.cancelPendingAuthAttemptsForSource(sourceRecord.id);
    if (!cancelled) {
      return false;
    }
    this.releaseIdentityMutation(sourceRecord.connectorId, claim);
    return true;
  }

  private async resolveSourceIdentityInClaim(
    instanceId: string,
  ): Promise<ConnectorSource> {
    let sourceRecord = this.store.get(instanceId);
    if (!sourceRecord) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(sourceRecord.connectorId);
    if (registration.manifest.source.identity !== "connector") {
      throw new Error(`Connector ${sourceRecord.connectorId} does not resolve Source identity`);
    }
    if (!(await this.otherIdentityGatesReady(registration.manifest, sourceRecord))) {
      return await this.refreshSetupStatus(instanceId, { allowIdentityResolution: false });
    }

    const controller = new AbortController();
    let session: RunnerSession | undefined;
    try {
      session = (await this.openTrustedSession(registration, controller.signal)).session;
      sourceRecord = this.store.get(instanceId)!;
      const result = await session.resolveSourceIdentity({
        connectorId: sourceRecord.connectorId,
        config: mergeConfig(schemaDefaults(registration.manifest), sourceRecord.config),
        signal: controller.signal,
        capabilities: this.buildSourceIdentityCapabilities(registration, sourceRecord),
      });
      const validated = validateConnectorSourceIdentityResult(
        sourceRecord.connectorId,
        result,
      );
      this.store.publishSourceIdentity(
        sourceRecord.id,
        validated.key,
        validated.label,
      );
    } catch (error) {
      this.store.publishIdentityError(
        instanceId,
        sanitizeSourceIdentityError(sourceRecord.connectorId, error),
      );
    } finally {
      controller.abort();
      await session?.close().catch(() => {});
    }
    return await this.refreshSetupStatus(instanceId, { allowIdentityResolution: false });
  }

  private async otherIdentityGatesReady(
    manifest: ConnectorManifest,
    sourceRecord: ConnectorSource,
  ): Promise<boolean> {
    const auth = manifest.auth ?? { type: "none" as const };
    const authReady = auth.type === "none"
      || Boolean(sourceRecord.authRef && await this.authManager.hasToken(sourceRecord.authRef));
    return authReady
      && this.requirementsSatisfiedFor(manifest, sourceRecord)
      && this.configSatisfiedFor(manifest, sourceRecord.config);
  }

  private async finalizeConnectedAuthAttempt(result: OAuthAttemptView): Promise<void> {
    if (!result.sourceId) return;
    const sourceRecord = this.store.get(result.sourceId);
    if (!sourceRecord) return;
    const registration = this.requireRegistration(sourceRecord.connectorId);
    const identityClaim = registration.manifest.source.identity === "connector"
      ? this.identityMutations.get(sourceRecord.connectorId)
      : undefined;

    if (registration.manifest.source.identity === "connector") {
      if (!identityClaim || identityClaim.sourceId !== sourceRecord.id) return;
      if (result.status === "pending") return;
      if (result.status !== "connected" || !result.authRef) {
        this.releaseIdentityMutation(sourceRecord.connectorId, identityClaim);
        return;
      }
    } else if (result.status !== "connected" || !result.authRef) {
      return;
    }

    const attemptId = result.attemptId;
    if (
      attemptId
      && !this.authManager.claimConnectedAttemptFinalization(attemptId)
    ) {
      return;
    }

    // From this point the browser exchange is complete and identity
    // finalization owns the mutation. It must no longer be swept or cancelled
    // as an abandoned browser attempt while the resolver is running.
    if (identityClaim) identityClaim.expiresAt = undefined;

    try {
      if (sourceRecord.authRef !== result.authRef) {
        this.store.update(sourceRecord.id, { authRef: result.authRef });
      }
      if (identityClaim) {
        await this.resolveSourceIdentityInClaim(sourceRecord.id);
      } else {
        await this.refreshSetupStatus(sourceRecord.id);
      }
      this.requestRuntimeReconcile(
        sourceRecord.id,
        "credential_connected",
        identityClaim === undefined,
      );
    } catch (err) {
      if (attemptId) {
        this.authManager.releaseConnectedAttemptFinalization(attemptId);
      }
      throw err;
    } finally {
      if (identityClaim) {
        this.releaseIdentityMutation(sourceRecord.connectorId, identityClaim);
      }
    }
  }

  async pauseSource<TConfig = unknown, TState = unknown>(
    instanceId: string,
    durationMs?: number,
  ): Promise<ConnectorSource<TConfig, TState>> {
    const existing = this.store.get<TConfig, TState>(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    this.requireRegistration(existing.connectorId);
    if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0)) {
      throw new Error("Connector pause durationMs must be a positive number");
    }

    // Persist first so a concurrent scheduler tick observes the pause before
    // the currently active run is asked to stop.
    this.store.pause(instanceId, durationMs === undefined ? undefined : Date.now() + durationMs);
    const active = this.activeRuns.get(instanceId);
    if (active && active.trigger !== "manual") {
      // An identity mutation may have parked this preserved run intent behind
      // its barrier. Pause terminates the intent, so wake that barrier before
      // awaiting it without releasing the Connector's mutation claim.
      active.releaseIdentityBarrier();
      active.abort();
      await active.promise.catch(() => {});
    }
    return this.store.get<TConfig, TState>(instanceId)!;
  }

  resumeSource<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): ConnectorSource<TConfig, TState> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    this.requireRegistration(existing.connectorId);
    return this.store.resume(instanceId) as ConnectorSource<TConfig, TState>;
  }

  resumeExpiredPauses(now = Date.now()): number {
    return this.store.resumeExpired(now);
  }

	  async startConfigUi(
	    instanceId: string,
	    panelId: string,
	  ): Promise<{ sessionId: string; url: string }> {
	    const sourceRecord = this.store.get(instanceId);
	    if (!sourceRecord) {
	      throw new Error(`Connector Source not found: ${instanceId}`);
	    }
	    const registration = this.requireRegistration(sourceRecord.connectorId);
	    if (!isPlatformSupported(registration.manifest, this.platform)) {
	      throw new Error(`Connector ${sourceRecord.connectorId} is not supported on ${this.platform}`);
	    }
	    if (!registration.manifest.configPanels?.[panelId]) {
	      throw new Error(`Connector ${sourceRecord.connectorId} does not declare config panel: ${panelId}`);
	    }

	    const controller = new AbortController();
	    let session: RunnerSession | undefined;
	    try {
	      session = (await this.openTrustedSession(registration, controller.signal)).session;
	      if (!registration.manifest.configPanels?.[panelId]) {
	        throw new Error(`Connector ${sourceRecord.connectorId} does not declare config panel: ${panelId}`);
	      }
	      const config = mergeConfig(schemaDefaults(registration.manifest), sourceRecord.config);
	      const result = await session.configUi({
	        panelId,
	        config,
	        signal: controller.signal,
	        capabilities: this.buildConfigUiCapabilities(sourceRecord.id),
	      });
	      validateConfigUiUrl(result.url);
	      const sessionId = newConfigUiSessionId();
	      this.activeConfigUiSessions.set(sessionId, {
	        id: sessionId,
	        instanceId: sourceRecord.id,
	        connectorId: sourceRecord.connectorId,
	        panelId,
	        controller,
	        session,
	        url: result.url,
	        startedAt: Date.now(),
	      });
	      return { sessionId, url: result.url };
	    } catch (err) {
	      controller.abort();
	      await session?.close().catch(() => {});
	      throw err;
	    }
	  }

	  async stopConfigUiSession(sessionId: string): Promise<boolean> {
	    const active = this.activeConfigUiSessions.get(sessionId);
	    if (!active) return false;
	    this.activeConfigUiSessions.delete(sessionId);
	    active.controller.abort();
	    await active.session.close().catch(() => {});
	    return true;
	  }

  getSource<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): ConnectorSource<TConfig, TState> | undefined {
    return this.store.get<TConfig, TState>(instanceId);
  }

  renameSource<TConfig = unknown, TState = unknown>(
    instanceId: string,
    displayName: string | null,
  ): ConnectorSource<TConfig, TState> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    this.requireRegistration(existing.connectorId);
    if (displayName !== null && typeof displayName !== "string") {
      throw new Error("Source displayName must be a string or null");
    }
    return this.store.setDisplayName(instanceId, displayName) as ConnectorSource<TConfig, TState>;
  }

  async retrySourceIdentity<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): Promise<ConnectorSource<TConfig, TState>> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    if (registration.manifest.source.identity !== "connector") {
      throw new Error(`Connector ${existing.connectorId} does not resolve Source identity`);
    }
    if (existing.identityStatus === "resolved") {
      throw new Error(`Connector Source identity is already resolved: ${instanceId}`);
    }
    // Retry is also the recovery action for a browser connection that the user
    // abandoned. Cancel that same-Source attempt before taking a fresh fence;
    // generation invalidation prevents a late callback from committing.
    this.cancelPendingBrowserIdentityMutation(existing);
    const resolved = await this.withIdentityMutation<TConfig, TState>(instanceId);
    if (resolved.setupStatus === "ready") {
      this.requestRuntimeReconcile(instanceId, "readiness_changed");
    }
    return resolved;
  }

  // Startup recovery is deliberately the ordinary setup path: every durable
  // non-resolved Connector identity is retried only after the other gates pass.
  async recoverSourceIdentities(): Promise<void> {
    for (const sourceRecord of this.store.list()) {
      const registration = this.registrations.get(sourceRecord.connectorId);
      if (!registration) continue;
      if (
        registration.manifest.source.identity === "connector"
        && sourceRecord.identityStatus !== "resolved"
        && await this.otherIdentityGatesReady(registration.manifest, sourceRecord)
      ) {
        await this.withIdentityMutation(sourceRecord.id);
      } else {
        await this.refreshSetupStatus(sourceRecord.id, { allowIdentityResolution: false });
      }
    }
  }

  getAuthManager(): ConnectorAuthManager {
    return this.authManager;
  }

  // Re-runs the unified setup evaluator for one Source. Use after edits
  // that can complete setup without an auth/requirement action (for example
  // setting the Source key on a no-auth connector).
  async refreshSourceSetup<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): Promise<ConnectorSource<TConfig, TState>> {
    return (
      await this.refreshSetupStatus(instanceId, { reconcileTransition: true })
    ) as ConnectorSource<TConfig, TState>;
  }

  // Explicit human recovery for a crashed run. Crashed ready sources stay
  // in error ("needs attention") by design — a connector bug should be seen,
  // not silently retried. Restart resets to idle so the scheduler picks the
  // Source up again.
  restartSource<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): ConnectorSource<TConfig, TState> {
    const sourceRecord = this.store.get<TConfig, TState>(instanceId);
    if (!sourceRecord) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    this.requireRegistration(sourceRecord.connectorId);
    if (this.activeRuns.has(instanceId) || sourceRecord.status === "running") {
      throw new Error(`Connector Source is already running: ${instanceId}`);
    }
    if (sourceRecord.setupStatus !== "ready") {
      throw new Error(`Connector Source is not set up: ${instanceId}`);
    }
    if (sourceRecord.status !== "error") {
      return sourceRecord;
    }
    this.store.resetErrorToIdle(instanceId);
    return this.store.get<TConfig, TState>(instanceId)!;
  }

  async checkSourceRequirements(
    instanceId: string,
  ): Promise<Record<string, ConnectorRequirementRecord>> {
    const sourceRecord = this.store.get(instanceId);
    if (!sourceRecord) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(sourceRecord.connectorId);
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${sourceRecord.connectorId} is not supported on ${this.platform}`);
    }
    const requirementIds = activePlatformRequirements(registration.manifest, this.platform);
    if (requirementIds.length === 0) return {};

    // Trust before handler: loading requirement handlers runs connector code,
    // so the package must pass the same trust gate as run(). Package handlers
    // execute in a separate runner process.
    const session = (await this.openTrustedSession(registration)).session;
    try {
      const records = await this.evaluateRequirements(registration, sourceRecord, session, requirementIds);
      await this.refreshSetupStatus(instanceId, { reconcileTransition: true });
      return records;
    } finally {
      await session.close();
    }
  }

  async requestSourceRequirement(
    instanceId: string,
    requirementId: string,
  ): Promise<ConnectorRequirementRecord> {
    const sourceRecord = this.store.get(instanceId);
    if (!sourceRecord) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(sourceRecord.connectorId);
    const requirementIds = activePlatformRequirements(registration.manifest, this.platform);
    if (!requirementIds.includes(requirementId)) {
      throw new Error(
        `Connector ${sourceRecord.connectorId} has no active requirement ${requirementId} on ${this.platform}`,
      );
    }

    const session = (await this.openTrustedSession(registration)).session;
    try {
      if (!session.requirementIds().includes(requirementId)) {
        throw new Error(
          `Connector ${sourceRecord.connectorId} does not implement requirement handler: ${requirementId}`,
        );
      }

      const ctx = this.requirementContext(sourceRecord);
      const rawRequest = await session.request(requirementId, ctx);
      const requestStatus = rawRequest === null ? undefined : normalizeRequirementStatus(rawRequest);
      if (requestStatus?.status === "error") {
        const record: ConnectorRequirementRecord = {
          ...requestStatus,
          lastCheckedAt: Date.now(),
        };
        this.persistRequirementRecords(instanceId, { [requirementId]: record });
        await this.refreshSetupStatus(instanceId, { reconcileTransition: true });
        return record;
      }

      const records = await this.evaluateRequirements(registration, sourceRecord, session, [requirementId]);
      let record = records[requirementId];
      // check() is the authority for grants, but an in-flight request must stay
      // visible: when request() reports pending (e.g. "grant in System Settings")
      // and the immediate re-check still says missing, keep the pending record so
      // the UI shows the actionable request message instead of a bare missing.
      if (requestStatus?.status === "pending" && record.status === "missing") {
        record = { ...requestStatus, lastCheckedAt: record.lastCheckedAt };
        this.persistRequirementRecords(instanceId, { [requirementId]: record });
      }
      await this.refreshSetupStatus(instanceId, { reconcileTransition: true });
      return record;
    } finally {
      await session.close();
    }
  }

  private requirementContext(sourceRecord: ConnectorSource): ConnectorRequirementContext {
    return {
      connectorId: sourceRecord.connectorId,
      sourceId: sourceRecord.id,
      platform: this.platform,
    };
  }

  private requirementsSatisfiedFor(
    manifest: ConnectorManifest,
    sourceRecord: ConnectorSource | undefined,
  ): boolean {
    const requirementIds = activePlatformRequirements(manifest, this.platform);
    if (requirementIds.length === 0) return true;
    const status = sourceRecord?.requirementsStatus;
    return requirementIds.every((id) => status?.[id]?.status === "satisfied");
  }

  private async evaluateRequirements(
    registration: Registration,
    sourceRecord: ConnectorSource,
    session: RunnerSession,
    requirementIds: string[],
  ): Promise<Record<string, ConnectorRequirementRecord>> {
    const ctx = this.requirementContext(sourceRecord);
    const results = await session.check(requirementIds, ctx);
    const updates: Record<string, ConnectorRequirementRecord> = {};
    for (const id of requirementIds) {
      const result = results[id] ?? null;
      const status: ConnectorRequirementStatus = result === null
        ? {
          status: "error",
          message: `Connector ${registration.manifest.id} does not implement requirement handler: ${id}`,
        }
        : normalizeRequirementStatus(result);
      updates[id] = { ...status, lastCheckedAt: Date.now() };
    }
    return this.persistRequirementRecords(sourceRecord.id, updates);
  }

  private persistRequirementRecords(
    instanceId: string,
    updates: Record<string, ConnectorRequirementRecord>,
  ): Record<string, ConnectorRequirementRecord> {
    const current = this.store.get(instanceId)?.requirementsStatus ?? {};
    const merged = { ...current, ...updates };
    this.store.setRequirementsStatus(instanceId, merged);
    return merged;
  }

  // Unified setup evaluator: ready requires source identity + auth + active
  // platform requirements all satisfied. Demotes ready sources whose
  // requirements regressed; promotes setup sources once everything passes.
  private async refreshSetupStatus(
    instanceId: string,
    opts: { reconcileTransition?: boolean; allowIdentityResolution?: boolean } = {},
  ): Promise<ConnectorSource> {
    let sourceRecord = this.store.get(instanceId);
    if (!sourceRecord) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(sourceRecord.connectorId);
    const manifest = registration.manifest;
    const requiresAuth = (manifest.auth ?? { type: "none" }).type !== "none";

    let authReady = true;
    if (requiresAuth) {
      // Secret-store reads are asynchronous. Re-read the Source afterwards so
      // concurrent config writes cannot promote or demote readiness from a
      // stale snapshot. If authRef itself changed, evaluate the latest ref.
      while (true) {
        const evaluatedAuthRef = sourceRecord.authRef;
        authReady = Boolean(
          evaluatedAuthRef && (await this.authManager.hasToken(evaluatedAuthRef)),
        );
        const latest = this.store.get(instanceId);
        if (!latest) {
          throw new Error(`Connector Source not found: ${instanceId}`);
        }
        sourceRecord = latest;
        if (sourceRecord.authRef === evaluatedAuthRef) break;
      }
    }

    const requirementsReady = this.requirementsSatisfiedFor(manifest, sourceRecord);
    const configReady = this.configSatisfiedFor(manifest, sourceRecord.config);
    const otherGatesReady = requirementsReady && authReady && configReady;

    // Identity is the final setup gate. Automatic recovery uses the same
    // Connector-scoped mutation as every explicit trigger, but never recurses
    // while a mutation already owns the exclusion.
    if (
      manifest.source.identity === "connector"
      && sourceRecord.identityStatus !== "resolved"
      && otherGatesReady
      && opts.allowIdentityResolution !== false
      && !this.identityMutations.has(sourceRecord.connectorId)
    ) {
      const resolved = await this.withIdentityMutation(instanceId);
      if (opts.reconcileTransition && resolved.setupStatus === "ready") {
        this.requestRuntimeReconcile(instanceId, "readiness_changed");
      }
      return resolved;
    }

    const identityReady = identityPairResolved(sourceRecord, manifest.source.identity);
    const eligible = identityReady && otherGatesReady;

    if (sourceRecord.setupStatus === "ready" && !eligible) {
      const refreshed = this.store.update(instanceId, { setupStatus: "setup" });
      if (opts.reconcileTransition) {
        this.requestRuntimeReconcile(instanceId, "readiness_changed");
      }
      return refreshed;
    }
    if (sourceRecord.setupStatus === "setup" && eligible) {
      const refreshed = this.store.update(instanceId, { setupStatus: "ready" });
      if (opts.reconcileTransition) {
        this.requestRuntimeReconcile(instanceId, "readiness_changed");
      }
      return refreshed;
    }
    return sourceRecord;
  }

  // Auth gets the same run-time recheck as requirements: a token deleted or
  // invalidated after ready must block the run up front, not fail lazily
  // inside connector code. Checked before the trust import since it needs no
  // connector code.
  private async assertRunAuth(
    registration: Registration,
    sourceRecord: ConnectorSource,
  ): Promise<void> {
    const auth = registration.manifest.auth ?? { type: "none" };
    if (auth.type === "none") return;
    if (sourceRecord.authRef && (await this.authManager.hasToken(sourceRecord.authRef))) return;
    this.store.update(sourceRecord.id, { setupStatus: "setup" });
    throw new Error(
      `Connector ${sourceRecord.connectorId} credentials are missing; reconnect the Source`,
    );
  }

  private async assertRunRequirements(
    registration: Registration,
    sourceRecord: ConnectorSource,
    session: RunnerSession,
  ): Promise<void> {
    const requirementIds = activePlatformRequirements(registration.manifest, this.platform);
    if (requirementIds.length === 0) return;

    const records = await this.evaluateRequirements(registration, sourceRecord, session, requirementIds);
    const unsatisfied = requirementIds.filter((id) => records[id]?.status !== "satisfied");
    if (unsatisfied.length > 0) {
      this.store.update(sourceRecord.id, { setupStatus: "setup" });
      throw new Error(
        `Connector ${sourceRecord.connectorId} requirements not satisfied: ${unsatisfied.join(", ")}`,
      );
    }
  }

  private createRun(instanceId: string, opts?: { trigger?: ConnectorRunTrigger }): ActiveRunIntent {
    if (this.activeRuns.has(instanceId)) {
      throw new Error(`Connector Source already running: ${instanceId}`);
    }

    const sourceRecord = this.store.get(instanceId);
    if (!sourceRecord) {
      throw new Error(`Connector Source not found: ${instanceId}`);
    }
    if (this.updatingConnectorIds.has(sourceRecord.connectorId)) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${sourceRecord.connectorId} is updating`,
      );
    }
    if (this.identityMutations.has(sourceRecord.connectorId)) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${sourceRecord.connectorId} has an identity mutation in progress`,
      );
    }
    const trigger = opts?.trigger ?? "manual";
    if (trigger !== "manual" && isSourcePaused(sourceRecord)) {
      throw new Error(`Connector source is paused: ${instanceId}`);
    }
    if (sourceRecord.setupStatus !== "ready") {
      throw new Error(`Connector Source is not set up: ${instanceId}`);
    }

    const registration = this.requireRegistration(sourceRecord.connectorId);
    const ownership = this.ownershipFor(sourceRecord, registration.manifest);
    if (ownership !== "here") {
      throw new Error(
        ownership === "device-unknown"
          ? `Device identity unavailable: ${this.deviceIdentity.status === "unavailable" ? this.deviceIdentity.reason : "unknown"}`
          : `Connector Source belongs to another device: ${instanceId}`,
      );
    }
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${sourceRecord.connectorId} is not supported on ${this.platform}`);
    }
    if (!this.configSatisfiedFor(
      registration.manifest,
      mergeConfig(schemaDefaults(registration.manifest), sourceRecord.config),
    )) {
      this.store.update(instanceId, { setupStatus: "setup" });
      throw new Error(`Connector ${sourceRecord.connectorId} required configuration is missing`);
    }

    const controller = new AbortController();
    const runRecord = this.store.createRun({
      sourceRecord,
      trigger,
    });
    this.store.setStatus(instanceId, "running");

    let resolveIdentityBarrier: (() => void) | undefined;
    const active: ActiveRunIntent = {
      instanceId,
      runId: runRecord.id,
      trigger,
      controller,
      attemptController: undefined,
      runtimeGeneration: 0,
      signal: controller.signal,
      promise: Promise.resolve(),
      attemptSettled: undefined,
      identityBarrier: undefined,
      abort() {
        controller.abort();
        this.attemptController?.abort();
      },
      invalidateRuntime() {
        this.runtimeGeneration += 1;
        this.attemptController?.abort();
      },
      holdForIdentityMutation() {
        if (!this.identityBarrier) {
          this.identityBarrier = new Promise<void>((resolve) => {
            resolveIdentityBarrier = resolve;
          });
        }
        this.runtimeGeneration += 1;
        this.attemptController?.abort();
        return this.attemptSettled ?? Promise.resolve();
      },
      releaseIdentityBarrier() {
        resolveIdentityBarrier?.();
        resolveIdentityBarrier = undefined;
        this.identityBarrier = undefined;
      },
      waitForIdentityMutation() {
        return this.identityBarrier ?? Promise.resolve();
      },
    };
    this.activeRuns.set(instanceId, active);
    active.promise = this.executeRunIntent(active, runRecord.id);
    active.promise.catch(() => {});
    return active;
  }

  private async executeRunIntent(active: ActiveRunIntent, runRecordId: string): Promise<void> {
    try {
      while (!active.signal.aborted) {
        await active.waitForIdentityMutation();
        if (active.signal.aborted) break;
        // A mutation can install a barrier after waitForIdentityMutation()
        // snapshots "none" but before this continuation runs. Re-enter the
        // wait instead of treating that mutation's temporary setup state as a
        // reason to terminate the higher-level run intent.
        if (active.identityBarrier) continue;
        const sourceRecord = this.store.get(active.instanceId);
        if (!sourceRecord) {
          active.abort();
          this.store.finishRun(runRecordId, "aborted");
          return;
        }
        const registration = this.requireRegistration(sourceRecord.connectorId);
        if (!this.canContinueRunIntent(active, sourceRecord, registration.manifest)) {
          active.abort();
          this.store.setStatus(
            active.instanceId,
            "idle",
            sourceRecord.identityStatus === "error" ? sourceRecord.lastError : undefined,
          );
          this.store.finishRun(runRecordId, "aborted");
          return;
        }

        const attemptGeneration = active.runtimeGeneration;
        const attemptController = new AbortController();
        active.attemptController = attemptController;
        let settleAttempt!: () => void;
        const attemptSettled = new Promise<void>((resolve) => {
          settleAttempt = resolve;
        });
        active.attemptSettled = attemptSettled;
        if (active.signal.aborted) attemptController.abort();

        let attemptResult:
          | { ok: true }
          | { ok: false; error: unknown };
        let session: RunnerSession | undefined;
        let producer: ProducerBinding | undefined;
        try {
          await this.assertRunAuth(registration, sourceRecord);
          // The attempt signal is bound from the very first phase: a runtime
          // input generation change can replace a hanging import/check as well
          // as a connector that has already entered run(context).
          const opened = await this.openTrustedSession(registration, attemptController.signal);
          session = opened.session;
          producer = opened.producer;
          await this.assertRunRequirements(registration, sourceRecord, session);
          await session.run({
            config: mergeConfig(schemaDefaults(registration.manifest), sourceRecord.config),
            signal: attemptController.signal,
            capabilities: this.buildRunCapabilities(registration, sourceRecord, producer),
          });
          attemptResult = { ok: true };
        } catch (err) {
          attemptResult = { ok: false, error: err };
        } finally {
          await session?.close().catch(() => {});
          settleAttempt();
          if (active.attemptSettled === attemptSettled) {
            active.attemptSettled = undefined;
          }
          if (active.attemptController === attemptController) {
            active.attemptController = undefined;
          }
        }

        if (active.signal.aborted) {
          this.store.setStatus(active.instanceId, "idle");
          this.store.finishRun(runRecordId, "aborted");
          return;
        }

        // Runtime inputs are persisted before invalidation. If config or an
        // explicit credential connection changed during this attempt, discard
        // its outcome and start once from the latest stored generation.
        if (active.runtimeGeneration !== attemptGeneration) {
          continue;
        }

        if (!attemptResult.ok) {
          const message = attemptResult.error instanceof Error
            ? attemptResult.error.message
            : String(attemptResult.error);
          this.store.setStatus(active.instanceId, "error", message);
          this.store.finishRun(runRecordId, "error", message);
          throw attemptResult.error;
        }

        this.store.setStatus(active.instanceId, "idle");
        this.store.finishRun(runRecordId, "success");
        return;
      }

      this.store.setStatus(active.instanceId, "idle");
      this.store.finishRun(runRecordId, "aborted");
    } finally {
      if (this.activeRuns.get(active.instanceId) === active) {
        this.activeRuns.delete(active.instanceId);
      }
    }
  }

  private canContinueRunIntent(
    active: ActiveRunIntent,
    sourceRecord: ConnectorSource,
    manifest: ConnectorManifest,
  ): boolean {
    if (this.updatingConnectorIds.has(sourceRecord.connectorId)) return false;
    if (active.trigger !== "manual" && isSourcePaused(sourceRecord)) return false;
    if (sourceRecord.setupStatus !== "ready") return false;
    if (!isPlatformSupported(manifest, this.platform)) return false;
    if (this.ownershipFor(sourceRecord, manifest) !== "here") return false;
    return this.configSatisfiedFor(
      manifest,
      mergeConfig(schemaDefaults(manifest), sourceRecord.config),
    );
  }

  // Opens a runner session for trusted connector code. Workspace packages are
  // re-verified (hash/trust) and then executed in a separate runner process;
  // manually registered definitions run in-process. Trust always passes before
  // any connector code is loaded anywhere.
  private async openTrustedSession(
    registration: Registration,
    abortSignal?: AbortSignal,
  ): Promise<OpenedTrustedSession> {
    if (!registration.package) {
      if (registration.definition) {
        return {
          session: new InProcessRunnerSession(registration.definition),
          producer: registration.producer,
        };
      }
      throw new Error(`Connector ${registration.manifest.id} has no package entry`);
    }

    const current = await this.registry.loadPackage(registration.package.dir);
    registration.manifest = current.manifest;
    registration.package = current;
    registration.trust = current.trust;
    this.store.setTrustForConnector(
      current.connectorId,
      trustStatusForSource(current.trust),
      current.contentHash,
    );

    if (!current.trust.runnable) {
      throw new Error(`Connector ${current.connectorId} is not trusted: ${current.trust.status}`);
    }
    await this.packageArchiveStore.requireExists(current.contentHash);

    const producer = createProducerBinding(
      this.producerDescriptorStore,
      createConnectorProducerDescriptor(
        current.connectorId,
        current.contentHash,
        this.systemIdentity,
      ),
    );

    const session = new ProcessRunnerSession({
      entryPath: current.entryPath,
      contentHash: current.contentHash,
      cwd: current.dir,
      connectorId: current.connectorId,
      sourceIdentityKind: current.manifest.source.identity,
      killGraceMs: this.runnerKillGraceMs,
      commandTimeoutMs: this.runnerCommandTimeoutMs,
    });
    await session.open(abortSignal);
    return { session, producer };
  }

  private buildRunCapabilities(
    registration: Registration,
    sourceRecord: ConnectorSource,
    producer: ProducerBinding | undefined,
  ): RunnerCapabilities {
    if (!identityPairResolved(sourceRecord, registration.manifest.source.identity)) {
      throw new Error(`Connector Source identity is not resolved: ${sourceRecord.id}`);
    }
    if (!producer) {
      throw new Error(
        `Connector ${sourceRecord.connectorId} requires an explicit Producer context`,
      );
    }
    const boundGuard = createBoundConnectorGuard(
      this.guard,
      sourceRecord.connectorId,
      producer,
      sourceRecord.sourceKey ?? undefined,
    );
    const stateHandle = createConnectorStateHandle(this.store, sourceRecord.id);
    const authSpec = registration.manifest.auth ?? { type: "none" };
    const authHandle = this.authManager.createHandle(authSpec, sourceRecord);
    const blobStore = new ContentBlobStore(this.workspacePath);
    return {
      authType: runtimeAuthType(authSpec),
      ...(authHandle.type === "managedProvider"
        ? { providerOrigin: authHandle.providerOrigin }
        : {}),
      writeEvent: (event) => boundGuard.writeEvent(event as Parameters<typeof boundGuard.writeEvent>[0]),
      writeEvents: (events) => boundGuard.writeEvents(events as Parameters<typeof boundGuard.writeEvents>[0]),
      writeTextBlob: async (input) => blobStore.writeText(normalizeTextBlobInput(input)),
      stateGet: () => stateHandle.get(),
      stateSet: (value) => stateHandle.set(value),
      authGetToken: () => authHandle.type === "none"
        ? Promise.reject(new Error("Connector does not use auth"))
        : authHandle.getToken(),
      warningSet: async (value) => {
        this.store.setWarning(sourceRecord.id, value as ConnectorWarningInput);
      },
      warningClear: async (key) => {
        if (typeof key !== "string") throw new Error("Connector warning key must be a string");
        this.store.clearWarning(sourceRecord.id, key);
	      },
	    };
	  }

  private buildSourceIdentityCapabilities(
    registration: Registration,
    sourceRecord: ConnectorSource,
  ): RunnerSourceIdentityCapabilities {
    const authSpec = registration.manifest.auth ?? { type: "none" as const };
    const authHandle = this.authManager.createHandle(authSpec, sourceRecord);
    return {
      authType: runtimeAuthType(authSpec),
      authGetToken: () => authHandle.type === "none"
        ? Promise.reject(new Error("Connector does not use auth"))
        : authHandle.getToken(),
      ...(authHandle.type === "managedProvider"
        ? { providerOrigin: authHandle.providerOrigin }
        : {}),
    };
  }

	  private buildConfigUiCapabilities(instanceId: string): RunnerConfigUiCapabilities {
	    const stateHandle = createConnectorStateHandle(this.store, instanceId);
	    return {
	      configGet: async () => this.store.get(instanceId)?.config,
	      configReplace: async (value) => {
	        const next = normalizeJsonObject(value, "Connector config replacement");
	        await this.configureSource(instanceId, { config: next });
	      },
	      configPatch: async (value) => {
	        const patch = normalizeConfigPatch(value);
	        const current = this.store.get(instanceId)?.config;
	        const next: JsonObject = isObject(current) ? { ...(current as JsonObject) } : {};
	        for (const key of patch.remove ?? []) {
	          delete next[key];
	        }
	        Object.assign(next, patch.set ?? {});
	        await this.configureSource(instanceId, { config: next });
	        return this.store.get(instanceId)?.config;
	      },
	      stateGet: () => stateHandle.get(),
	      stateSet: (value) => stateHandle.set(value),
	    };
	  }

	  private async stopConfigUiSessionsForSource(instanceId: string): Promise<void> {
	    const sessionIds = [...this.activeConfigUiSessions.values()]
	      .filter((session) => session.instanceId === instanceId)
	      .map((session) => session.id);
	    await Promise.all(sessionIds.map((id) => this.stopConfigUiSession(id)));
	  }

	  private requireRegistration(connectorId: string): Registration {
    validateConnectorId(connectorId);
    const registration = this.registrations.get(connectorId);
    if (!registration) {
      throw new Error(`Connector is not registered: ${connectorId}`);
    }
    return registration;
  }

  private configSatisfiedFor(manifest: ConnectorManifest, config: unknown): boolean {
    return missingRequiredConfigFields(manifest, mergeConfig(schemaDefaults(manifest), config)).length === 0;
  }

  private ownershipFor(
    sourceRecord: ConnectorSource,
    manifest: ConnectorManifest,
  ): ConnectorOwnership {
    if (manifest.source.identity !== "device") return "here";
    if (this.deviceIdentity.status === "unavailable") return "device-unknown";
    return sourceRecord.sourceKey === this.deviceIdentity.value ? "here" : "other-device";
  }
}

// Author defaults declared in the manifest config schema. They form the base
// layer of the run-time config merge (schema defaults -> stored Source config),
// so connector code reads merged values directly.
function schemaDefaults(manifest: ConnectorManifest): Record<string, unknown> | undefined {
  const schema = manifest.config;
  if (!schema) return undefined;
  const defaults: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    if (field.default !== undefined) defaults[key] = field.default;
  }
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function mergeConfig(...configs: unknown[]): unknown {
  const objects = configs.filter(isObject) as Record<string, unknown>[];
  if (objects.length === configs.filter((value) => value !== undefined).length) {
    return Object.assign({}, ...objects);
  }
  const last = [...configs].reverse().find((value) => value !== undefined);
  return last;
}

function missingRequiredConfigFields(manifest: ConnectorManifest, config: unknown): string[] {
  const schema = manifest.config;
  if (!schema) return [];
  const values = isObject(config) ? config : {};
  const missing: string[] = [];
  for (const [key, field] of Object.entries(schema)) {
    if (field.required === false) continue;
    const value = values[key];
    const present = field.type === "string"
      ? typeof value === "string" && value.trim().length > 0
      : field.type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : typeof value === "boolean";
    const allowed = !field.options
      || field.options.some((option) => option.value === value);
    if (!present || !allowed) missing.push(key);
  }
  return missing;
}

function newConfigUiSessionId(): string {
  return `cfgui-${ulid()}`;
}

function validateConfigUiUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Connector config UI returned an invalid URL");
  }
  const localhost = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]"
    || parsed.hostname === "::1";
  if (parsed.protocol !== "http:" || !localhost) {
    throw new Error("Connector config UI URL must be an http localhost URL");
  }
  const token = parsed.searchParams.get("token");
  if (!token || token.length < 16) {
    throw new Error("Connector config UI URL must include a random token query parameter");
  }
}

function normalizeJsonObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  assertJsonValue(value, label);
  return value as JsonObject;
}

function normalizeConfigPatch(value: unknown): ConnectorConfigPatch {
  const input = normalizeJsonObject(value, "Connector config patch");
  const patch: ConnectorConfigPatch = {};
  if (input.set !== undefined) {
    patch.set = normalizeJsonObject(input.set, "Connector config patch.set");
  }
  if (input.remove !== undefined) {
    if (!Array.isArray(input.remove)) {
      throw new Error("Connector config patch.remove must be an array of keys");
    }
    patch.remove = input.remove.map((key) => {
      if (typeof key !== "string" || !key.trim()) {
        throw new Error("Connector config patch.remove keys must be non-empty strings");
      }
      return key;
    });
  }
  return patch;
}

function normalizeTextBlobInput(value: unknown): {
  text: string;
  mediaType?: "text/plain; charset=utf-8" | "application/json";
} {
  const input = normalizeJsonObject(value, "Connector text blob");
  if (typeof input.text !== "string") {
    throw new Error("Connector text blob requires a text string");
  }
  if (input.variant !== undefined) {
    throw new Error("Connector text blob variant is not supported");
  }
  if (input.mediaType !== undefined
    && input.mediaType !== "text/plain; charset=utf-8"
    && input.mediaType !== "application/json") {
    throw new Error("Connector text blob mediaType must be text/plain with UTF-8 charset or application/json");
  }
  return {
    text: input.text,
    mediaType: input.mediaType,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function identityPairResolved(
  sourceRecord: Pick<ConnectorSource, "identityStatus" | "sourceKey">,
  identityKind: ConnectorSourceIdentityKind,
): boolean {
  if (sourceRecord.identityStatus !== "resolved") return false;
  return identityKind === "single"
    ? sourceRecord.sourceKey === null
    : sourceRecord.sourceKey !== null;
}

function normalizeDeviceLabel(value: string): string | undefined {
  const label = value.trim();
  return label && label.length <= 128 ? label : undefined;
}

function isSourceIdentityConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const message = "message" in error && typeof error.message === "string"
    ? error.message
    : "";
  return message.includes("UNIQUE constraint failed")
    && message.includes("connector_sources.connector_id")
    && message.includes("connector_sources.source_key");
}

function normalizeRequirementStatus(status: ConnectorRequirementStatus): ConnectorRequirementStatus {
  const valid = new Set<ConnectorRequirementState>(["satisfied", "missing", "pending", "error"]);
  if (!status || !valid.has(status.status)) {
    return {
      status: "error",
      message: `Requirement handler returned an invalid status: ${JSON.stringify(status)}`,
    };
  }
  return {
    status: status.status,
    message: typeof status.message === "string" ? status.message : undefined,
  };
}

function validateScheduleInput(scheduleCron: string | null | undefined): void {
  if (scheduleCron !== undefined && scheduleCron !== null) {
    validateConnectorSchedule(scheduleCron);
  }
}
