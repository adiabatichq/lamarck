import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { hostname } from "node:os";
import { ulid } from "../utils/ulid";
import { assertJsonValue } from "../json";
import { ContentBlobStore } from "../blob-store";
import type { DeviceIdentityState } from "../device-identity";
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
import { WorkspaceConnectorRegistry, trustStatusForIntegration } from "./registry";
import { validateConnectorDefinition } from "./runtime";
import {
  ConnectorIntegrationStore,
  createConnectorStateHandle,
  defaultAuthRef,
  isIntegrationPaused,
  newIntegrationId,
  type EnsureIntegrationInput,
  type UpdateIntegrationInput,
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
  ConnectorHostContext,
  ConnectorIntegration,
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

export type ConnectorSetupPendingReason = "identity" | "auth" | "requirements" | "config";
export type ConnectorRuntimeReconcileReason =
  | "config_changed"
  | "credential_connected"
  | "source_created"
  | "readiness_changed";

export class ConnectorLifecycleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorLifecycleConflictError";
  }
}

interface Registration {
  manifest: ConnectorManifest;
  definition?: ConnectorDefinition;
  package?: ConnectorPackageRecord;
  trust: ConnectorPackageTrust;
}

interface ActiveRunIntent {
  instanceId: string;
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
  releaseIdentityMutation(): void;
  waitForIdentityMutation(): Promise<void>;
}

interface IdentityMutationClaim {
  sourceId: string;
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
  host: ConnectorHostContext;
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

export interface ConnectIntegrationInput {
  authRef?: string;
}

type NonConfigIntegrationUpdateInput = Omit<UpdateIntegrationInput<never>, "config">;

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
  private store: ConnectorIntegrationStore;
  private authManager: ConnectorAuthManager;
  private platform: ConnectorPlatform;
  private runnerKillGraceMs: number | undefined;
  private runnerCommandTimeoutMs: number | undefined;
  private guard: ConnectorHostGuard;
  private host: ConnectorHostContext;
  private registry: WorkspaceConnectorRegistry;
  private oauthRedirectUri: string | undefined;
  private managedProviderAppOrigin: string;
  private deviceIdentity: DeviceIdentityState;
  private deviceDisplayName: string;

  constructor(opts: ConnectorSupervisorOptions) {
    this.guard = opts.guard;
    this.host = opts.host;
    this.store = new ConnectorIntegrationStore(opts.systemDb);
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
      trustStatusForIntegration(pkg.trust),
      pkg.contentHash,
    );
    return pkg.manifest;
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
      for (const source of identitySources) {
        this.store.beginIdentityResolution(source.id);
      }
      for (const source of sources) {
        const active = this.activeRuns.get(source.id);
        if (active) {
          active.abort();
          await active.promise.catch(() => {});
        }
        await this.stopConfigUiSessionsForIntegration(source.id);
      }
      try {
        const result = await update();
        for (const source of identitySources) {
          await this.resolveSourceIdentityInClaim(source.id);
        }
        return result;
      } catch (error) {
        // The update coordinator restores the old package before returning an
        // error. Resolve against whichever trusted package is registered now;
        // if rollback itself failed, leaving unresolved is the fail-closed
        // recovery state.
        for (const source of identitySources) {
          if (!this.store.get(source.id)) continue;
          await this.resolveSourceIdentityInClaim(source.id).catch(() => {});
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
        trustStatusForIntegration(approved.trust),
        approved.contentHash,
      );
      // D0 audit: the trust decision — who approved which exact package content.
      await this.guard.writeEvent({
        type: "connector.approved",
        startedAt: Date.now(),
        payload: { connector_id: connectorId, approved_hash: approved.contentHash },
      });
      return approved.manifest;
    });
  }

  // The single Connector removal authority. Sources are cascaded before the
  // caller-provided package operation; registration, approval authority, and
  // audit state are finalized only after that operation succeeds.
  async removeConnector(
    connectorId: string,
    removePackage: () => Promise<boolean> = async () => false,
  ): Promise<boolean> {
    validateConnectorId(connectorId);
    const registration = this.registrations.get(connectorId);
    await this.removeSourcesForConnector(connectorId);
    const removedPackage = await removePackage();
    this.registry.removeApprovals(connectorId);
    if (registration) this.registrations.delete(connectorId);
    if (!registration && !removedPackage) return false;
    await this.guard.writeEvent({
      type: "connector.removed",
      startedAt: Date.now(),
      payload: { connector_id: connectorId },
    });
    return true;
  }

  // Registration-only connectors (tests/embedding) still use the same cascade.
  async unregister(connectorId: string): Promise<boolean> {
    return this.removeConnector(connectorId);
  }

  private async removeSourcesForConnector(connectorId: string): Promise<number> {
    validateConnectorId(connectorId);
    const sources = this.store.list().filter((integration) => integration.connectorId === connectorId);
    for (const source of sources) {
      await this.removeIntegration(source.id);
    }
    return sources.length;
  }

  async reconcileInstalledConnectorIds(installedConnectorIds: Iterable<string>): Promise<string[]> {
    const installed = new Set([...installedConnectorIds, ...this.registrations.keys()]);
    const orphaned = new Set(
      this.store.list()
        .filter((source) => !installed.has(source.connectorId))
        .map((source) => source.connectorId),
    );
    for (const connectorId of orphaned) {
      await this.removeSourcesForConnector(connectorId);
      this.registry.removeApprovals(connectorId);
      await this.guard.writeEvent({
        type: "connector.removed",
        startedAt: Date.now(),
        payload: { connector_id: connectorId },
      });
    }
    return [...orphaned].sort();
  }

  // Removes one Source: aborts its run, stops config UI, purges credentials,
  // config/checkpoint/schedule/run history with the row, and leaves no
  // placeholder behind. An installed connector may own zero Sources.
  async removeIntegration(instanceId: string): Promise<void> {
    const integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }

    let identityClaim = this.identityMutations.get(integration.connectorId);
    if (identityClaim && identityClaim.expiresAt === undefined) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${integration.connectorId} has an identity mutation in progress`,
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
      this.authManager.cancelAttemptsForIntegration(instanceId);
      claimedBrowserAttempt.expiresAt = undefined;
      active?.releaseIdentityMutation();
    }
	    if (active) {
	      active.abort();
	      await active.promise.catch(() => {});
    }
    await this.stopConfigUiSessionsForIntegration(instanceId);

    // Re-check after awaited cleanup: a browser callback may have moved its
    // claim into non-expiring identity finalization while removal was waiting.
    identityClaim = this.identityMutations.get(integration.connectorId);
    if (
      identityClaim
      && identityClaim !== claimedBrowserAttempt
      && identityClaim.expiresAt === undefined
    ) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${integration.connectorId} has an identity mutation in progress`,
      );
    }
    if (
      identityClaim
      && identityClaim !== claimedBrowserAttempt
      && identityClaim.sourceId === instanceId
    ) {
      this.authManager.cancelAttemptsForIntegration(instanceId);
      identityClaim.expiresAt = undefined;
      claimedBrowserAttempt = identityClaim;
    }
    this.authManager.cancelAttemptsForIntegration(instanceId, { removed: true });
    try {
      await this.authManager.deleteIntegrationCredentials(instanceId, integration.authRef);
      this.store.delete(instanceId);
    } finally {
      if (claimedBrowserAttempt) {
        this.releaseIdentityMutation(integration.connectorId, claimedBrowserAttempt);
      }
    }
  }

  // apiKey connect: store the pasted token and run the normal connect flow.
  // oauth2 uses the browser authorization flow, not this token endpoint.
  async connectIntegrationWithToken<TConfig = unknown, TState = unknown>(
    instanceId: string,
    token: string,
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
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
        const generation = this.authManager.currentIntegrationAuthGeneration(existing.id);
        await this.authManager.setToken(authRef, token.trim(), {
          ownerType: "connector",
          ownerId: existing.id,
          generation,
        });
        this.store.update(instanceId, { authRef });
      });
      this.requestRuntimeReconcile(instanceId, "credential_connected", false);
      return connected as ConnectorIntegration<TConfig, TState>;
    }

    const generation = this.authManager.currentIntegrationAuthGeneration(existing.id);
    await this.authManager.setToken(authRef, token.trim(), {
      ownerType: "connector",
      ownerId: existing.id,
      generation,
    });
    return this.connectIntegration<TConfig, TState>(instanceId, { authRef });
  }

  async startOAuthIntegration(
    instanceId: string,
    input: { redirectUri: string },
  ): Promise<OAuthStartResult> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    const auth = registration.manifest.auth ?? { type: "none" };
    if (!isOAuthAuthSpec(auth)) {
      throw new Error(`Connector ${existing.connectorId} does not use oauth2`);
    }
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${existing.connectorId} is not supported on ${this.platform}`);
    }
    return this.startBrowserAuth(existing, () => this.authManager.startOAuth(existing, auth, input));
  }

  async startAuthIntegration(
    instanceId: string,
    input: { redirectUri: string },
  ): Promise<OAuthStartResult> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
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
      );
    }
    if (isManagedProviderAuthSpec(auth)) {
      return this.startBrowserAuth(
        existing,
        () => this.authManager.startManagedProvider(existing, auth, {
          appOrigin: this.managedProviderAppOrigin,
        }),
      );
    }
    throw new Error(`Connector ${existing.connectorId} does not use browser auth`);
  }

  async getOAuthAttempt(instanceId: string, attemptId: string): Promise<OAuthAttemptView> {
    const result = await this.authManager.getOAuthAttempt(instanceId, attemptId);
    await this.finalizeConnectedAuthAttempt(result);
    return result;
  }

  async completeOAuthCallback(params: URLSearchParams): Promise<OAuthAttemptView> {
    const result = await this.authManager.completeOAuthCallback(params);
    await this.finalizeConnectedAuthAttempt(result);
    return result;
  }

  ensureIntegration<TConfig = unknown, TState = unknown>(
    input: EnsureIntegrationInput<TConfig>,
  ): ConnectorIntegration<TConfig, TState> {
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
    const trustStatus = input.trustStatus ?? trustStatusForIntegration(registration.trust);
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

    let created: ConnectorIntegration<TConfig, TState>;
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

  async addIntegration<TConfig = unknown, TState = unknown>(
    input: Omit<EnsureIntegrationInput<TConfig>, "id">,
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    const registration = this.requireRegistration(input.connectorId);
    if (this.updatingConnectorIds.has(input.connectorId)) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${input.connectorId} is updating`,
      );
    }
    const before = registration.manifest.source.identity === "single"
      ? this.store.firstForConnector(input.connectorId)
      : undefined;
    const created = this.ensureIntegration<TConfig, TState>(input);
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
    return refreshed as ConnectorIntegration<TConfig, TState>;
  }

  updateIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
    input: NonConfigIntegrationUpdateInput,
  ): ConnectorIntegration<TConfig, TState> {
    if ("config" in input) {
      throw new Error(
        `Connector integration ${instanceId} config changes must use configureIntegration`,
      );
    }
    return this.persistIntegrationUpdate<TConfig, TState>(instanceId, input).updated;
  }

  async configureIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
    input: UpdateIntegrationInput<TConfig>,
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    this.validateIntegrationUpdateInput(existing, registration, input);
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
        this.persistIntegrationUpdate<TConfig, TState>(instanceId, input);
      });
      this.requestRuntimeReconcile(instanceId, "config_changed", false);
      return refreshed as ConnectorIntegration<TConfig, TState>;
    }

    const persisted = this.persistIntegrationUpdate<TConfig, TState>(instanceId, input);
    let refreshed: ConnectorIntegration;
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
    return refreshed as ConnectorIntegration<TConfig, TState>;
  }

  private persistIntegrationUpdate<TConfig = unknown, TState = unknown>(
    instanceId: string,
    input: UpdateIntegrationInput<TConfig>,
  ): {
    updated: ConnectorIntegration<TConfig, TState>;
    effectiveConfigChanged: boolean;
  } {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    this.validateIntegrationUpdateInput(existing, registration, input);
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

  private validateIntegrationUpdateInput(
    existing: ConnectorIntegration,
    registration: Registration,
    input: UpdateIntegrationInput<unknown>,
  ): void {
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${existing.connectorId} is not supported on ${this.platform}`);
    }
    if (input.authRef !== undefined && input.authRef !== existing.authRef) {
      throw new Error(
        `Connector integration ${existing.id} authRef changes must use connectIntegration`,
      );
    }
    validateScheduleInput(input.scheduleCron);
  }

  async connectIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
    input: ConnectIntegrationInput = {},
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
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
      throw new Error(`Connector integration ${instanceId} requires credentials before it can be ready`);
    }
    if (registration.manifest.source.identity === "connector") {
      const connected = await this.withIdentityMutation(instanceId, async () => {
        this.store.update(instanceId, { authRef });
      });
      this.requestRuntimeReconcile(instanceId, "credential_connected", false);
      return connected as ConnectorIntegration<TConfig, TState>;
    }
    this.store.update(instanceId, { authRef });
    const connected = await this.refreshSetupStatus(instanceId);
    this.requestRuntimeReconcile(instanceId, "credential_connected");
    return connected as ConnectorIntegration<TConfig, TState>;
  }

  async disconnectIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    const existing = this.store.get<TConfig, TState>(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
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

    // Disconnect is a readiness change, not Source removal: stop current use
    // of the account and delete credentials, while preserving Source identity,
    // config, checkpoint, schedule, and pause policy.
    const active = this.activeRuns.get(instanceId);
    if (active) {
      active.abort();
      await active.promise.catch(() => {});
    }

    this.authManager.cancelAttemptsForIntegration(instanceId);
    if (pendingIdentityClaim?.sourceId === instanceId) {
      this.releaseIdentityMutation(existing.connectorId, pendingIdentityClaim);
    }
    await this.authManager.deleteIntegrationCredentials(instanceId, existing.authRef);
    return (await this.refreshSetupStatus(instanceId)) as ConnectorIntegration<TConfig, TState>;
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

  async list(): Promise<Array<ConnectorIntegration & {
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
	  }>> {
    return Promise.all(this.store.list().map(async (integration) => {
      const registration = this.registrations.get(integration.connectorId);
      const identityKind = registration?.manifest.source.identity ?? "single";
      const identityReady = registration
        ? identityPairResolved(integration, identityKind)
        : integration.identityStatus === "resolved";
      const activeRequirements = registration
        ? activePlatformRequirements(registration.manifest, this.platform)
        : [];
      const authSpec = registration?.manifest.auth ?? { type: "none" };
      const authType = authSpec.type;
      const credential = integration.authRef ? this.authManager.credential(integration.authRef) : undefined;
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
        || Boolean(integration.authRef && (await this.authManager.hasToken(integration.authRef)));

      const setupPending: ConnectorSetupPendingReason[] = [];
      if (registration) {
        if (!authReady) setupPending.push("auth");
        if (!this.requirementsSatisfiedFor(registration.manifest, integration)) {
          setupPending.push("requirements");
        }
        if (!this.configSatisfiedFor(registration.manifest, integration.config)) {
          setupPending.push("config");
        }
        if (!identityReady) setupPending.push("identity");
      }

      const ownership = registration
        ? this.ownershipFor(integration, registration.manifest)
        : "here";
      const connectorName = registration?.manifest.name ?? integration.connectorId;
      const conflictSourceId = integration.identityStatus === "conflict"
        && integration.lastResolvedKey
        ? this.store.getBySourceKey(integration.connectorId, integration.lastResolvedKey)?.id
        : undefined;

      return {
        ...integration,
        setupStatus: registration
          ? setupPending.length > 0 ? "setup" : "ready"
          : integration.setupStatus,
        name: integration.displayName ?? integration.suggestedLabel ?? connectorName,
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
          ? sourceForConnector(integration.connectorId, integration.sourceKey ?? undefined)
          : null,
        running: this.activeRuns.has(integration.id),
        supported: registration ? isPlatformSupported(registration.manifest, this.platform) : false,
        packageTrust: registration?.trust.status ?? "missing",
        authType,
        authStatus: credential?.status,
        authAttention,
        authReady,
        setupPending,
        requirements: activeRequirements.map((id) => ({
          id,
          status: integration.requirementsStatus?.[id]?.status ?? "unknown",
          message: integration.requirementsStatus?.[id]?.message,
          lastCheckedAt: integration.requirementsStatus?.[id]?.lastCheckedAt,
        })),
	        recentRuns: this.store.listRuns(integration.id),
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
        this.authManager.cancelAttemptsForIntegration(existing.sourceId);
        this.identityMutations.delete(connectorId);
        this.activeRuns.get(existing.sourceId)?.releaseIdentityMutation();
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
    this.activeRuns.get(claim.sourceId)?.releaseIdentityMutation();
  }

  private async drainExecutionAttemptForIdentity(instanceId: string): Promise<void> {
    const active = this.activeRuns.get(instanceId);
    if (!active) return;
    await active.holdForIdentityMutation();
  }

  private async withIdentityMutation<TConfig = unknown, TState = unknown>(
    instanceId: string,
    commit: () => Promise<void> | void = () => {},
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
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
      return await this.resolveSourceIdentityInClaim(instanceId) as ConnectorIntegration<TConfig, TState>;
    } finally {
      this.releaseIdentityMutation(existing.connectorId, claim);
    }
  }

  private async startBrowserAuth(
    integration: ConnectorIntegration,
    start: () => Promise<OAuthStartResult> | OAuthStartResult,
  ): Promise<OAuthStartResult> {
    const registration = this.requireRegistration(integration.connectorId);
    if (registration.manifest.source.identity !== "connector") {
      return await start();
    }

    const claim = this.claimIdentityMutation(integration.connectorId, integration.id);
    try {
      this.store.beginIdentityResolution(integration.id);
      await this.drainExecutionAttemptForIdentity(integration.id);
      const result = await start();
      claim.expiresAt = result.expiresAt;
      return result;
    } catch (error) {
      this.store.publishIdentityError(
        integration.id,
        sanitizeSourceIdentityError(integration.connectorId, error),
      );
      this.releaseIdentityMutation(integration.connectorId, claim);
      throw error;
    }
  }

  private async resolveSourceIdentityInClaim(
    instanceId: string,
  ): Promise<ConnectorIntegration> {
    let integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(integration.connectorId);
    if (registration.manifest.source.identity !== "connector") {
      throw new Error(`Connector ${integration.connectorId} does not resolve Source identity`);
    }
    if (!(await this.otherIdentityGatesReady(registration.manifest, integration))) {
      return await this.refreshSetupStatus(instanceId, { allowIdentityResolution: false });
    }

    const controller = new AbortController();
    let session: RunnerSession | undefined;
    try {
      session = await this.openTrustedSession(registration, controller.signal);
      integration = this.store.get(instanceId)!;
      const result = await session.resolveSourceIdentity({
        connectorId: integration.connectorId,
        config: mergeConfig(schemaDefaults(registration.manifest), integration.config),
        signal: controller.signal,
        capabilities: this.buildSourceIdentityCapabilities(registration, integration),
      });
      const validated = validateConnectorSourceIdentityResult(
        integration.connectorId,
        result,
      );
      this.store.publishSourceIdentity(
        integration.id,
        validated.key,
        validated.label,
      );
    } catch (error) {
      this.store.publishIdentityError(
        instanceId,
        sanitizeSourceIdentityError(integration.connectorId, error),
      );
    } finally {
      controller.abort();
      await session?.close().catch(() => {});
    }
    return await this.refreshSetupStatus(instanceId, { allowIdentityResolution: false });
  }

  private async otherIdentityGatesReady(
    manifest: ConnectorManifest,
    integration: ConnectorIntegration,
  ): Promise<boolean> {
    const auth = manifest.auth ?? { type: "none" as const };
    const authReady = auth.type === "none"
      || Boolean(integration.authRef && await this.authManager.hasToken(integration.authRef));
    return authReady
      && this.requirementsSatisfiedFor(manifest, integration)
      && this.configSatisfiedFor(manifest, integration.config);
  }

  private async finalizeConnectedAuthAttempt(result: OAuthAttemptView): Promise<void> {
    if (!result.integrationId) return;
    const integration = this.store.get(result.integrationId);
    if (!integration) return;
    const registration = this.requireRegistration(integration.connectorId);
    const identityClaim = registration.manifest.source.identity === "connector"
      ? this.identityMutations.get(integration.connectorId)
      : undefined;

    if (registration.manifest.source.identity === "connector") {
      if (!identityClaim || identityClaim.sourceId !== integration.id) return;
      if (result.status === "pending") return;
      if (result.status !== "connected" || !result.authRef) {
        this.releaseIdentityMutation(integration.connectorId, identityClaim);
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
      if (integration.authRef !== result.authRef) {
        this.store.update(integration.id, { authRef: result.authRef });
      }
      if (identityClaim) {
        await this.resolveSourceIdentityInClaim(integration.id);
      } else {
        await this.refreshSetupStatus(integration.id);
      }
      this.requestRuntimeReconcile(
        integration.id,
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
        this.releaseIdentityMutation(integration.connectorId, identityClaim);
      }
    }
  }

  async pauseIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
    durationMs?: number,
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    const existing = this.store.get<TConfig, TState>(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
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
      active.abort();
      await active.promise.catch(() => {});
    }
    return this.store.get<TConfig, TState>(instanceId)!;
  }

  resumeIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): ConnectorIntegration<TConfig, TState> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    this.requireRegistration(existing.connectorId);
    return this.store.resume(instanceId) as ConnectorIntegration<TConfig, TState>;
  }

  resumeExpiredPauses(now = Date.now()): number {
    return this.store.resumeExpired(now);
  }

	  async startConfigUi(
	    instanceId: string,
	    panelId: string,
	  ): Promise<{ sessionId: string; url: string }> {
	    const integration = this.store.get(instanceId);
	    if (!integration) {
	      throw new Error(`Connector integration not found: ${instanceId}`);
	    }
	    const registration = this.requireRegistration(integration.connectorId);
	    if (!isPlatformSupported(registration.manifest, this.platform)) {
	      throw new Error(`Connector ${integration.connectorId} is not supported on ${this.platform}`);
	    }
	    if (!registration.manifest.configPanels?.[panelId]) {
	      throw new Error(`Connector ${integration.connectorId} does not declare config panel: ${panelId}`);
	    }

	    const controller = new AbortController();
	    let session: RunnerSession | undefined;
	    try {
	      session = await this.openTrustedSession(registration, controller.signal);
	      if (!registration.manifest.configPanels?.[panelId]) {
	        throw new Error(`Connector ${integration.connectorId} does not declare config panel: ${panelId}`);
	      }
	      const config = mergeConfig(schemaDefaults(registration.manifest), integration.config);
	      const result = await session.configUi({
	        panelId,
	        config,
	        host: this.host,
	        signal: controller.signal,
	        capabilities: this.buildConfigUiCapabilities(integration.id),
	      });
	      validateConfigUiUrl(result.url);
	      const sessionId = newConfigUiSessionId();
	      this.activeConfigUiSessions.set(sessionId, {
	        id: sessionId,
	        instanceId: integration.id,
	        connectorId: integration.connectorId,
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

  getIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): ConnectorIntegration<TConfig, TState> | undefined {
    return this.store.get<TConfig, TState>(instanceId);
  }

  renameIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
    displayName: string | null,
  ): ConnectorIntegration<TConfig, TState> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    this.requireRegistration(existing.connectorId);
    if (displayName !== null && typeof displayName !== "string") {
      throw new Error("Source displayName must be a string or null");
    }
    return this.store.setDisplayName(instanceId, displayName) as ConnectorIntegration<TConfig, TState>;
  }

  async retrySourceIdentity<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    if (registration.manifest.source.identity !== "connector") {
      throw new Error(`Connector ${existing.connectorId} does not resolve Source identity`);
    }
    if (existing.identityStatus === "resolved") {
      throw new Error(`Connector Source identity is already resolved: ${instanceId}`);
    }
    const resolved = await this.withIdentityMutation<TConfig, TState>(instanceId);
    if (resolved.setupStatus === "ready") {
      this.requestRuntimeReconcile(instanceId, "readiness_changed");
    }
    return resolved;
  }

  // Startup recovery is deliberately the ordinary setup path: every durable
  // non-resolved Connector identity is retried only after the other gates pass.
  async recoverSourceIdentities(): Promise<void> {
    for (const source of this.store.list()) {
      const registration = this.registrations.get(source.connectorId);
      if (!registration) continue;
      if (
        registration.manifest.source.identity === "connector"
        && source.identityStatus !== "resolved"
        && await this.otherIdentityGatesReady(registration.manifest, source)
      ) {
        await this.withIdentityMutation(source.id);
      } else {
        await this.refreshSetupStatus(source.id, { allowIdentityResolution: false });
      }
    }
  }

  getAuthManager(): ConnectorAuthManager {
    return this.authManager;
  }

  // Re-runs the unified setup evaluator for one integration. Use after edits
  // that can complete setup without an auth/requirement action (for example
  // setting the integration key on a no-auth connector).
  async refreshIntegrationSetup<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    return (
      await this.refreshSetupStatus(instanceId, { reconcileTransition: true })
    ) as ConnectorIntegration<TConfig, TState>;
  }

  // Explicit human recovery for a crashed run. Crashed ready integrations stay
  // in error ("needs attention") by design — a connector bug should be seen,
  // not silently retried. Restart resets to idle so the scheduler picks the
  // integration up again.
  restartIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): ConnectorIntegration<TConfig, TState> {
    const integration = this.store.get<TConfig, TState>(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    this.requireRegistration(integration.connectorId);
    if (this.activeRuns.has(instanceId) || integration.status === "running") {
      throw new Error(`Connector integration is already running: ${instanceId}`);
    }
    if (integration.setupStatus !== "ready") {
      throw new Error(`Connector integration is not set up: ${instanceId}`);
    }
    if (integration.status !== "error") {
      return integration;
    }
    this.store.resetErrorToIdle(instanceId);
    return this.store.get<TConfig, TState>(instanceId)!;
  }

  async checkIntegrationRequirements(
    instanceId: string,
  ): Promise<Record<string, ConnectorRequirementRecord>> {
    const integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(integration.connectorId);
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${integration.connectorId} is not supported on ${this.platform}`);
    }
    const requirementIds = activePlatformRequirements(registration.manifest, this.platform);
    if (requirementIds.length === 0) return {};

    // Trust before handler: loading requirement handlers runs connector code,
    // so the package must pass the same trust gate as run(). Package handlers
    // execute in a separate runner process.
    const session = await this.openTrustedSession(registration);
    try {
      const records = await this.evaluateRequirements(registration, integration, session, requirementIds);
      await this.refreshSetupStatus(instanceId, { reconcileTransition: true });
      return records;
    } finally {
      await session.close();
    }
  }

  async requestIntegrationRequirement(
    instanceId: string,
    requirementId: string,
  ): Promise<ConnectorRequirementRecord> {
    const integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(integration.connectorId);
    const requirementIds = activePlatformRequirements(registration.manifest, this.platform);
    if (!requirementIds.includes(requirementId)) {
      throw new Error(
        `Connector ${integration.connectorId} has no active requirement ${requirementId} on ${this.platform}`,
      );
    }

    const session = await this.openTrustedSession(registration);
    try {
      if (!session.requirementIds().includes(requirementId)) {
        throw new Error(
          `Connector ${integration.connectorId} does not implement requirement handler: ${requirementId}`,
        );
      }

      const ctx = this.requirementContext(integration);
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

      const records = await this.evaluateRequirements(registration, integration, session, [requirementId]);
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

  private requirementContext(integration: ConnectorIntegration): ConnectorRequirementContext {
    return {
      connectorId: integration.connectorId,
      integrationId: integration.id,
      platform: this.platform,
      host: this.host,
    };
  }

  private requirementsSatisfiedFor(
    manifest: ConnectorManifest,
    integration: ConnectorIntegration | undefined,
  ): boolean {
    const requirementIds = activePlatformRequirements(manifest, this.platform);
    if (requirementIds.length === 0) return true;
    const status = integration?.requirementsStatus;
    return requirementIds.every((id) => status?.[id]?.status === "satisfied");
  }

  private async evaluateRequirements(
    registration: Registration,
    integration: ConnectorIntegration,
    session: RunnerSession,
    requirementIds: string[],
  ): Promise<Record<string, ConnectorRequirementRecord>> {
    const ctx = this.requirementContext(integration);
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
    return this.persistRequirementRecords(integration.id, updates);
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
  // platform requirements all satisfied. Demotes ready integrations whose
  // requirements regressed; promotes setup integrations once everything passes.
  private async refreshSetupStatus(
    instanceId: string,
    opts: { reconcileTransition?: boolean; allowIdentityResolution?: boolean } = {},
  ): Promise<ConnectorIntegration> {
    let integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(integration.connectorId);
    const manifest = registration.manifest;
    const requiresAuth = (manifest.auth ?? { type: "none" }).type !== "none";

    let authReady = true;
    if (requiresAuth) {
      // Secret-store reads are asynchronous. Re-read the Source afterwards so
      // concurrent config writes cannot promote or demote readiness from a
      // stale snapshot. If authRef itself changed, evaluate the latest ref.
      while (true) {
        const evaluatedAuthRef = integration.authRef;
        authReady = Boolean(
          evaluatedAuthRef && (await this.authManager.hasToken(evaluatedAuthRef)),
        );
        const latest = this.store.get(instanceId);
        if (!latest) {
          throw new Error(`Connector integration not found: ${instanceId}`);
        }
        integration = latest;
        if (integration.authRef === evaluatedAuthRef) break;
      }
    }

    const requirementsReady = this.requirementsSatisfiedFor(manifest, integration);
    const configReady = this.configSatisfiedFor(manifest, integration.config);
    const otherGatesReady = requirementsReady && authReady && configReady;

    // Identity is the final setup gate. Automatic recovery uses the same
    // Connector-scoped mutation as every explicit trigger, but never recurses
    // while a mutation already owns the exclusion.
    if (
      manifest.source.identity === "connector"
      && integration.identityStatus !== "resolved"
      && otherGatesReady
      && opts.allowIdentityResolution !== false
      && !this.identityMutations.has(integration.connectorId)
    ) {
      const resolved = await this.withIdentityMutation(instanceId);
      if (opts.reconcileTransition && resolved.setupStatus === "ready") {
        this.requestRuntimeReconcile(instanceId, "readiness_changed");
      }
      return resolved;
    }

    const identityReady = identityPairResolved(integration, manifest.source.identity);
    const eligible = identityReady && otherGatesReady;

    if (integration.setupStatus === "ready" && !eligible) {
      const refreshed = this.store.update(instanceId, { setupStatus: "setup" });
      if (opts.reconcileTransition) {
        this.requestRuntimeReconcile(instanceId, "readiness_changed");
      }
      return refreshed;
    }
    if (integration.setupStatus === "setup" && eligible) {
      const refreshed = this.store.update(instanceId, { setupStatus: "ready" });
      if (opts.reconcileTransition) {
        this.requestRuntimeReconcile(instanceId, "readiness_changed");
      }
      return refreshed;
    }
    return integration;
  }

  // Auth gets the same run-time recheck as requirements: a token deleted or
  // invalidated after ready must block the run up front, not fail lazily
  // inside connector code. Checked before the trust import since it needs no
  // connector code.
  private async assertRunAuth(
    registration: Registration,
    integration: ConnectorIntegration,
  ): Promise<void> {
    const auth = registration.manifest.auth ?? { type: "none" };
    if (auth.type === "none") return;
    if (integration.authRef && (await this.authManager.hasToken(integration.authRef))) return;
    this.store.update(integration.id, { setupStatus: "setup" });
    throw new Error(
      `Connector ${integration.connectorId} credentials are missing; reconnect the integration`,
    );
  }

  private async assertRunRequirements(
    registration: Registration,
    integration: ConnectorIntegration,
    session: RunnerSession,
  ): Promise<void> {
    const requirementIds = activePlatformRequirements(registration.manifest, this.platform);
    if (requirementIds.length === 0) return;

    const records = await this.evaluateRequirements(registration, integration, session, requirementIds);
    const unsatisfied = requirementIds.filter((id) => records[id]?.status !== "satisfied");
    if (unsatisfied.length > 0) {
      this.store.update(integration.id, { setupStatus: "setup" });
      throw new Error(
        `Connector ${integration.connectorId} requirements not satisfied: ${unsatisfied.join(", ")}`,
      );
    }
  }

  private createRun(instanceId: string, opts?: { trigger?: ConnectorRunTrigger }): ActiveRunIntent {
    if (this.activeRuns.has(instanceId)) {
      throw new Error(`Connector integration already running: ${instanceId}`);
    }

    const integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    if (this.updatingConnectorIds.has(integration.connectorId)) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${integration.connectorId} is updating`,
      );
    }
    if (this.identityMutations.has(integration.connectorId)) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${integration.connectorId} has an identity mutation in progress`,
      );
    }
    const trigger = opts?.trigger ?? "manual";
    if (trigger !== "manual" && isIntegrationPaused(integration)) {
      throw new Error(`Connector source is paused: ${instanceId}`);
    }
    if (integration.setupStatus !== "ready") {
      throw new Error(`Connector integration is not set up: ${instanceId}`);
    }

    const registration = this.requireRegistration(integration.connectorId);
    const ownership = this.ownershipFor(integration, registration.manifest);
    if (ownership !== "here") {
      throw new Error(
        ownership === "device-unknown"
          ? `Device identity unavailable: ${this.deviceIdentity.status === "unavailable" ? this.deviceIdentity.reason : "unknown"}`
          : `Connector Source belongs to another device: ${instanceId}`,
      );
    }
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${integration.connectorId} is not supported on ${this.platform}`);
    }
    if (!this.configSatisfiedFor(
      registration.manifest,
      mergeConfig(schemaDefaults(registration.manifest), integration.config),
    )) {
      this.store.update(instanceId, { setupStatus: "setup" });
      throw new Error(`Connector ${integration.connectorId} required configuration is missing`);
    }

    const controller = new AbortController();
    const runRecord = this.store.createRun({
      integration,
      trigger,
    });
    this.store.setStatus(instanceId, "running");

    let releaseIdentityBarrier: (() => void) | undefined;
    const active: ActiveRunIntent = {
      instanceId,
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
            releaseIdentityBarrier = resolve;
          });
        }
        this.runtimeGeneration += 1;
        this.attemptController?.abort();
        return this.attemptSettled ?? Promise.resolve();
      },
      releaseIdentityMutation() {
        releaseIdentityBarrier?.();
        releaseIdentityBarrier = undefined;
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
        const integration = this.store.get(active.instanceId);
        if (!integration) {
          active.abort();
          this.store.finishRun(runRecordId, "aborted");
          return;
        }
        const registration = this.requireRegistration(integration.connectorId);
        if (!this.canContinueRunIntent(active, integration, registration.manifest)) {
          active.abort();
          this.store.setStatus(
            active.instanceId,
            "idle",
            integration.identityStatus === "error" ? integration.lastError : undefined,
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
        try {
          await this.assertRunAuth(registration, integration);
          // The attempt signal is bound from the very first phase: a runtime
          // input generation change can replace a hanging import/check as well
          // as a connector that has already entered run(context).
          session = await this.openTrustedSession(registration, attemptController.signal);
          await this.assertRunRequirements(registration, integration, session);
          await session.run({
            config: mergeConfig(schemaDefaults(registration.manifest), integration.config),
            host: this.host,
            signal: attemptController.signal,
            capabilities: this.buildRunCapabilities(registration, integration),
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
    integration: ConnectorIntegration,
    manifest: ConnectorManifest,
  ): boolean {
    if (this.updatingConnectorIds.has(integration.connectorId)) return false;
    if (active.trigger !== "manual" && isIntegrationPaused(integration)) return false;
    if (integration.setupStatus !== "ready") return false;
    if (!isPlatformSupported(manifest, this.platform)) return false;
    if (this.ownershipFor(integration, manifest) !== "here") return false;
    return this.configSatisfiedFor(
      manifest,
      mergeConfig(schemaDefaults(manifest), integration.config),
    );
  }

  // Opens a runner session for trusted connector code. Workspace packages are
  // re-verified (hash/trust) and then executed in a separate runner process;
  // manually registered definitions run in-process. Trust always passes before
  // any connector code is loaded anywhere.
  private async openTrustedSession(
    registration: Registration,
    abortSignal?: AbortSignal,
  ): Promise<RunnerSession> {
    if (!registration.package) {
      if (registration.definition) return new InProcessRunnerSession(registration.definition);
      throw new Error(`Connector ${registration.manifest.id} has no package entry`);
    }

    const current = await this.registry.loadPackage(registration.package.dir);
    registration.manifest = current.manifest;
    registration.package = current;
    registration.trust = current.trust;
    this.store.setTrustForConnector(
      current.connectorId,
      trustStatusForIntegration(current.trust),
      current.contentHash,
    );

    if (!current.trust.runnable) {
      throw new Error(`Connector ${current.connectorId} is not trusted: ${current.trust.status}`);
    }

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
    return session;
  }

  private buildRunCapabilities(
    registration: Registration,
    integration: ConnectorIntegration,
  ): RunnerCapabilities {
    if (!identityPairResolved(integration, registration.manifest.source.identity)) {
      throw new Error(`Connector Source identity is not resolved: ${integration.id}`);
    }
    const boundGuard = createBoundConnectorGuard(
      this.guard,
      integration.connectorId,
      integration.sourceKey ?? undefined,
    );
    const stateHandle = createConnectorStateHandle(this.store, integration.id);
    const authSpec = registration.manifest.auth ?? { type: "none" };
    const authHandle = this.authManager.createHandle(authSpec, integration);
    const blobStore = new ContentBlobStore(this.host.workspacePath);
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
        this.store.setWarning(integration.id, value as ConnectorWarningInput);
      },
      warningClear: async (key) => {
        if (typeof key !== "string") throw new Error("Connector warning key must be a string");
        this.store.clearWarning(integration.id, key);
	      },
	    };
	  }

  private buildSourceIdentityCapabilities(
    registration: Registration,
    integration: ConnectorIntegration,
  ): RunnerSourceIdentityCapabilities {
    const authSpec = registration.manifest.auth ?? { type: "none" as const };
    const authHandle = this.authManager.createHandle(authSpec, integration);
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
	        await this.configureIntegration(instanceId, { config: next });
	      },
	      configPatch: async (value) => {
	        const patch = normalizeConfigPatch(value);
	        const current = this.store.get(instanceId)?.config;
	        const next: JsonObject = isObject(current) ? { ...(current as JsonObject) } : {};
	        for (const key of patch.remove ?? []) {
	          delete next[key];
	        }
	        Object.assign(next, patch.set ?? {});
	        await this.configureIntegration(instanceId, { config: next });
	        return this.store.get(instanceId)?.config;
	      },
	      stateGet: () => stateHandle.get(),
	      stateSet: (value) => stateHandle.set(value),
	    };
	  }

	  private async stopConfigUiSessionsForIntegration(instanceId: string): Promise<void> {
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
    integration: ConnectorIntegration,
    manifest: ConnectorManifest,
  ): ConnectorOwnership {
    if (manifest.source.identity !== "device") return "here";
    if (this.deviceIdentity.status === "unavailable") return "device-unknown";
    return integration.sourceKey === this.deviceIdentity.value ? "here" : "other-device";
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
  variant?: "redacted-text";
  mediaType?: "text/plain; charset=utf-8" | "application/json";
} {
  const input = normalizeJsonObject(value, "Connector text blob");
  if (typeof input.text !== "string") {
    throw new Error("Connector text blob requires a text string");
  }
  if (input.variant !== undefined && input.variant !== "redacted-text") {
    throw new Error("Connector text blob variant must be redacted-text");
  }
  if (input.mediaType !== undefined
    && input.mediaType !== "text/plain; charset=utf-8"
    && input.mediaType !== "application/json") {
    throw new Error("Connector text blob mediaType must be text/plain with UTF-8 charset or application/json");
  }
  return {
    text: input.text,
    variant: input.variant === undefined ? undefined : "redacted-text",
    mediaType: input.mediaType,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function identityPairResolved(
  integration: Pick<ConnectorIntegration, "identityStatus" | "sourceKey">,
  identityKind: ConnectorSourceIdentityKind,
): boolean {
  if (integration.identityStatus !== "resolved") return false;
  return identityKind === "single"
    ? integration.sourceKey === null
    : integration.sourceKey !== null;
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
    && message.includes("connector_integrations.connector_id")
    && message.includes("connector_integrations.source_key");
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
