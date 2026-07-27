import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { ulid } from "../utils/ulid";
import { assertJsonValue } from "../json";
import { ContentBlobStore } from "../blob-store";
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
  ConnectorWarningInput,
  JsonObject,
} from "./types";

export interface ConnectorRequirementView {
  id: string;
  status: ConnectorRequirementState | "unknown";
  message?: string;
  lastCheckedAt?: number;
}

export type ConnectorSetupPendingReason = "integration_key" | "auth" | "requirements" | "config";
export type ConnectorRuntimeReconcileReason = "config_changed" | "credential_connected";

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
  configOverride: unknown;
  controller: AbortController;
  attemptController: AbortController | undefined;
  runtimeGeneration: number;
  signal: AbortSignal;
  promise: Promise<void>;
  abort(): void;
  invalidateRuntime(): void;
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
  private activeRuns = new Map<string, ActiveRunIntent>();
  private runtimeReconcileListeners = new Set<(
    instanceId: string,
    reason: ConnectorRuntimeReconcileReason,
  ) => void>();
  private reconciledAuthAttemptIds = new Set<string>();
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
    validateConnectorDefinition(definition as ConnectorDefinition);
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
    const sources = this.store.list().filter((source) => source.connectorId === connectorId);
    if (sources.length > 0) {
      if (normalized.integrations.mode !== registration.manifest.integrations.mode) {
        throw new ConnectorLifecycleConflictError(
          `Connector ${connectorId} cannot change integrations.mode while Sources exist`,
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

    this.updatingConnectorIds.add(connectorId);
    try {
      for (const source of sources) {
        const active = this.activeRuns.get(source.id);
        if (active) {
          active.abort();
          await active.promise.catch(() => {});
        }
        await this.stopConfigUiSessionsForIntegration(source.id);
      }
      return await update();
    } finally {
      this.updatingConnectorIds.delete(connectorId);
    }
  }

  async approveCurrentPackage(connectorId: string): Promise<ConnectorManifest> {
    const registration = this.requireRegistration(connectorId);
    if (!registration.package) {
      throw new Error(`Connector ${connectorId} was not loaded from a workspace package`);
    }
    const current = await this.registry.loadPackage(registration.package.dir);
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
	    const active = this.activeRuns.get(instanceId);
	    if (active) {
	      active.abort();
	      await active.promise.catch(() => {});
    }
	    await this.stopConfigUiSessionsForIntegration(instanceId);
    this.authManager.cancelAttemptsForIntegration(instanceId, { removed: true });
    await this.authManager.deleteIntegrationCredentials(instanceId, integration.authRef);
    this.store.delete(instanceId);
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
    const generation = this.authManager.currentIntegrationAuthGeneration(existing.id);
    await this.authManager.setToken(authRef, token.trim(), {
      ownerType: "connector",
      ownerId: existing.id,
      generation,
    });
    return this.connectIntegration<TConfig, TState>(instanceId, { authRef });
  }

  startOAuthIntegration(
    instanceId: string,
    input: { redirectUri: string },
  ): OAuthStartResult {
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
    return this.authManager.startOAuth(existing, auth, input);
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
      return this.authManager.startOAuth(existing, auth, input);
    }
    if (isManagedProviderAuthSpec(auth)) {
      return this.authManager.startManagedProvider(existing, auth, {
        appOrigin: this.managedProviderAppOrigin,
      });
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
    const registration = this.requireRegistration(input.connectorId);
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${input.connectorId} is not supported on ${this.platform}`);
    }

    const mode = registration.manifest.integrations.mode;
    const existingForIdentity = input.id
      ? this.store.get(input.id)
      : this.store.getByIdentity(input.connectorId, input.integrationKey || undefined);
    const setupStatus = validateIntegrationLifecycle({
      connectorId: input.connectorId,
      mode,
      integrationKey: input.integrationKey,
      setupStatus: input.setupStatus,
      requiresAuth: (registration.manifest.auth ?? { type: "none" }).type !== "none",
      authReady: false,
      requirementsSatisfied: this.requirementsSatisfiedFor(registration.manifest, existingForIdentity),
      configSatisfied: this.configSatisfiedFor(registration.manifest, input.config ?? existingForIdentity?.config),
    });
    const scheduleCron = input.scheduleCron === undefined
      ? registration.manifest.runtime.defaultSchedule
      : input.scheduleCron ?? undefined;
    if (scheduleCron !== undefined) {
      validateConnectorSchedule(scheduleCron);
    }
    const packageHash = input.packageHash ?? registration.package?.contentHash;
    const trustStatus = input.trustStatus ?? trustStatusForIntegration(registration.trust);

    return this.store.ensure<TConfig, TState>({
      ...input,
      setupStatus,
      scheduleCron,
      packageHash,
      trustStatus,
    });
  }

  addIntegration<TConfig = unknown, TState = unknown>(
    input: Omit<EnsureIntegrationInput<TConfig>, "id">,
  ): ConnectorIntegration<TConfig, TState> {
    const registration = this.requireRegistration(input.connectorId);
    const existing = this.store.list().filter((source) => source.connectorId === input.connectorId);
    if (registration.manifest.integrations.mode === "singleton" && existing.length > 0) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${input.connectorId} already has its singleton Source`,
      );
    }
    const integrationKey = input.integrationKey?.trim();
    if (integrationKey && this.store.getByIdentity(input.connectorId, integrationKey)) {
      throw new ConnectorLifecycleConflictError(
        `Connector ${input.connectorId} already has Source ${integrationKey}`,
      );
    }

    // Force a new row id so unnamed setup drafts for a multiple-Source
    // Connector do not collapse into the first NULL-key draft.
    return this.ensureIntegration<TConfig, TState>({
      ...input,
      id: newIntegrationId(),
    });
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
    const persisted = this.persistIntegrationUpdate<TConfig, TState>(instanceId, input);
    let refreshed: ConnectorIntegration;
    try {
      refreshed = await this.refreshSetupStatus(instanceId);
    } catch (err) {
      // The config is already durable. Do not leave an active attempt on the
      // stale value just because an asynchronous readiness check failed.
      if (persisted.effectiveConfigChanged) {
        this.requestRuntimeReconcile(instanceId, "config_changed");
      }
      throw err;
    }
    if (
      persisted.effectiveConfigChanged
      || (
        input.config !== undefined
        && persisted.updated.setupStatus !== refreshed.setupStatus
      )
    ) {
      this.requestRuntimeReconcile(instanceId, "config_changed");
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
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${existing.connectorId} is not supported on ${this.platform}`);
    }
    if (input.authRef !== undefined && input.authRef !== existing.authRef) {
      throw new Error(`Connector integration ${instanceId} authRef changes must use connectIntegration`);
    }
    validateScheduleInput(input.scheduleCron);
    const mode = registration.manifest.integrations.mode;
    const requiresAuth = (registration.manifest.auth ?? { type: "none" }).type !== "none";
    const nextConfig = input.config === undefined ? existing.config : input.config;
    const previousEffectiveConfig = mergeConfig(
      schemaDefaults(registration.manifest),
      existing.config,
    );
    const requirementsSatisfied = this.requirementsSatisfiedFor(registration.manifest, existing);
    const configSatisfied = this.configSatisfiedFor(registration.manifest, nextConfig);
    const keepCurrentSetupStatus = requirementsSatisfied && configSatisfied;
    const setupStatus = validateIntegrationLifecycle({
      connectorId: existing.connectorId,
      mode,
      integrationKey: input.integrationKey ?? existing.integrationKey,
      setupStatus: input.setupStatus ?? (keepCurrentSetupStatus ? existing.setupStatus : undefined),
      requiresAuth,
      authReady: !requiresAuth || existing.setupStatus === "ready",
      requirementsSatisfied,
      configSatisfied,
    });
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
    // Validate source identity constraints without forcing ready: connect only
    // binds credentials. The unified evaluator decides ready, so auth can be
    // connected before platform requirements are granted (and vice versa).
    validateIntegrationLifecycle({
      connectorId: existing.connectorId,
      mode: registration.manifest.integrations.mode,
      integrationKey: existing.integrationKey,
      setupStatus: "setup",
      requiresAuth: true,
      authReady: true,
      requirementsSatisfied: this.requirementsSatisfiedFor(registration.manifest, existing),
    });
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

    // Disconnect is a readiness change, not Source removal: stop current use
    // of the account and delete credentials, while preserving Source identity,
    // config, checkpoint, schedule, and pause policy.
    const active = this.activeRuns.get(instanceId);
    if (active) {
      active.abort();
      await active.promise.catch(() => {});
    }
    this.authManager.cancelAttemptsForIntegration(instanceId);
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
        integrationsMode: registration.manifest.integrations.mode,
        supported: isPlatformSupported(registration.manifest, this.platform),
        packageTrust: registration.trust.status,
        packageHash: registration.package?.contentHash,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.connectorId.localeCompare(b.connectorId));
  }

  async list(): Promise<Array<ConnectorIntegration & {
    name: string;
    description?: string;
    mode: string;
    integrationsMode: "singleton" | "multiple";
    source: string | undefined;
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
      const integrationsMode = registration?.manifest.integrations.mode ?? "singleton";
      const hasSourceIdentity = Boolean(
        integration.integrationKey || integrationsMode !== "multiple",
      );
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
        if (!hasSourceIdentity) setupPending.push("integration_key");
        if (!authReady) setupPending.push("auth");
        if (!this.requirementsSatisfiedFor(registration.manifest, integration)) {
          setupPending.push("requirements");
        }
        if (!this.configSatisfiedFor(registration.manifest, integration.config)) {
          setupPending.push("config");
        }
      }

      return {
        ...integration,
        setupStatus: registration
          ? setupPending.length > 0 ? "setup" : "ready"
          : integration.setupStatus,
        name: registration?.manifest.name ?? integration.connectorId,
        ...(registration ? { description: registration.manifest.description } : {}),
        mode: registration?.manifest.runtime.mode ?? "unknown",
        integrationsMode,
        source: hasSourceIdentity
          ? sourceForConnector(integration.connectorId, integration.integrationKey)
          : undefined,
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

  async run(instanceId: string, opts?: { config?: unknown; trigger?: ConnectorRunTrigger }): Promise<void> {
    const active = this.createRun(instanceId, opts);
    await active.promise;
  }

  start(instanceId: string, opts?: { config?: unknown; trigger?: ConnectorRunTrigger }): ConnectorRunHandle {
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
  ): void {
    this.activeRuns.get(instanceId)?.invalidateRuntime();
    for (const listener of this.runtimeReconcileListeners) {
      try {
        listener(instanceId, reason);
      } catch (err) {
        console.warn("[connectors] runtime reconcile listener failed:", err);
      }
    }
  }

  private async finalizeConnectedAuthAttempt(result: OAuthAttemptView): Promise<void> {
    if (result.status !== "connected" || !result.integrationId || !result.authRef) return;
    const integration = this.store.get(result.integrationId);
    if (!integration) return;

    const attemptId = result.attemptId;
    if (attemptId) {
      if (this.reconciledAuthAttemptIds.has(attemptId)) return;
      this.reconciledAuthAttemptIds.add(attemptId);
    }

    try {
      if (integration.authRef !== result.authRef) {
        this.store.update(integration.id, { authRef: result.authRef });
      }
      await this.refreshSetupStatus(integration.id);
      this.requestRuntimeReconcile(integration.id, "credential_connected");
    } catch (err) {
      if (attemptId) this.reconciledAuthAttemptIds.delete(attemptId);
      throw err;
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

  getAuthManager(): ConnectorAuthManager {
    return this.authManager;
  }

  // Re-runs the unified setup evaluator for one integration. Use after edits
  // that can complete setup without an auth/requirement action (for example
  // setting the integration key on a no-auth connector).
  async refreshIntegrationSetup<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    return (await this.refreshSetupStatus(instanceId)) as ConnectorIntegration<TConfig, TState>;
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
      await this.refreshSetupStatus(instanceId);
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
        await this.refreshSetupStatus(instanceId);
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
      await this.refreshSetupStatus(instanceId);
      return record;
    } finally {
      await session.close();
    }
  }

  private requirementContext(integration: ConnectorIntegration): ConnectorRequirementContext {
    return {
      connectorId: integration.connectorId,
      integrationId: integration.id,
      integrationKey: integration.integrationKey,
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
  private async refreshSetupStatus(instanceId: string): Promise<ConnectorIntegration> {
    let integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(integration.connectorId);
    const manifest = registration.manifest;
    const mode = manifest.integrations.mode;
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

    const sourceReady = mode === "singleton" || Boolean(integration.integrationKey);
    const requirementsReady = this.requirementsSatisfiedFor(manifest, integration);
    const configReady = this.configSatisfiedFor(manifest, integration.config);
    const eligible = sourceReady && requirementsReady && authReady && configReady;

    if (integration.setupStatus === "ready" && !eligible) {
      return this.store.update(instanceId, { setupStatus: "setup" });
    }
    if (integration.setupStatus === "setup" && eligible) {
      return this.store.update(instanceId, { setupStatus: "ready" });
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

  private createRun(instanceId: string, opts?: { config?: unknown; trigger?: ConnectorRunTrigger }): ActiveRunIntent {
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
    const trigger = opts?.trigger ?? "manual";
    if (trigger !== "manual" && isIntegrationPaused(integration)) {
      throw new Error(`Connector source is paused: ${instanceId}`);
    }
    if (integration.setupStatus !== "ready") {
      throw new Error(`Connector integration is not set up: ${instanceId}`);
    }

    const registration = this.requireRegistration(integration.connectorId);
    const mode = registration.manifest.integrations.mode;
    if (mode === "multiple" && !integration.integrationKey) {
      throw new Error(`Connector integration requires an integration_key: ${instanceId}`);
    }
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${integration.connectorId} is not supported on ${this.platform}`);
    }
    if (!this.configSatisfiedFor(
      registration.manifest,
      mergeConfig(schemaDefaults(registration.manifest), integration.config, opts?.config),
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

    const active: ActiveRunIntent = {
      instanceId,
      trigger,
      configOverride: opts?.config,
      controller,
      attemptController: undefined,
      runtimeGeneration: 0,
      signal: controller.signal,
      promise: Promise.resolve(),
      abort() {
        controller.abort();
        this.attemptController?.abort();
      },
      invalidateRuntime() {
        this.runtimeGeneration += 1;
        this.attemptController?.abort();
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
        const integration = this.store.get(active.instanceId);
        if (!integration) {
          active.abort();
          this.store.finishRun(runRecordId, "aborted");
          return;
        }
        const registration = this.requireRegistration(integration.connectorId);
        if (!this.canContinueRunIntent(active, integration, registration.manifest)) {
          active.abort();
          this.store.setStatus(active.instanceId, "idle");
          this.store.finishRun(runRecordId, "aborted");
          return;
        }

        const attemptGeneration = active.runtimeGeneration;
        const attemptController = new AbortController();
        active.attemptController = attemptController;
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
            config: mergeConfig(
              schemaDefaults(registration.manifest),
              integration.config,
              active.configOverride,
            ),
            host: this.host,
            signal: attemptController.signal,
            capabilities: this.buildRunCapabilities(registration, integration),
          });
          attemptResult = { ok: true };
        } catch (err) {
          attemptResult = { ok: false, error: err };
        } finally {
          await session?.close().catch(() => {});
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
    if (manifest.integrations.mode === "multiple" && !integration.integrationKey) return false;
    return this.configSatisfiedFor(
      manifest,
      mergeConfig(schemaDefaults(manifest), integration.config, active.configOverride),
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
    const boundGuard = createBoundConnectorGuard(
      this.guard,
      integration.connectorId,
      integration.integrationKey,
    );
    const stateHandle = createConnectorStateHandle(this.store, integration.id);
    const authSpec = registration.manifest.auth ?? { type: "none" };
    const authHandle = this.authManager.createHandle(authSpec, integration);
    const blobStore = new ContentBlobStore(this.host.workspacePath);
    return {
      authType: runtimeAuthType(authSpec),
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
}

// Author defaults declared in the manifest config schema. They form the base
// layer of the run-time config merge (schema defaults -> integration overrides
// -> one-off run override), so connector code reads merged values directly.
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

function validateIntegrationLifecycle(opts: {
  connectorId: string;
  mode: "singleton" | "multiple";
  integrationKey?: string;
  setupStatus?: "setup" | "ready";
  requiresAuth?: boolean;
  authReady?: boolean;
  requirementsSatisfied?: boolean;
  configSatisfied?: boolean;
}): "setup" | "ready" {
  const requirementsSatisfied = opts.requirementsSatisfied ?? true;
  const configSatisfied = opts.configSatisfied ?? true;
  if (opts.mode === "singleton") {
    if (opts.integrationKey) {
      throw new Error(`Connector ${opts.connectorId} supports only one integration`);
    }
    const setupStatus = opts.setupStatus
      ?? (opts.requiresAuth || !requirementsSatisfied || !configSatisfied ? "setup" : "ready");
    if (setupStatus === "ready" && opts.requiresAuth && !opts.authReady) {
      throw new Error(`Connector ${opts.connectorId} integration requires credentials before it can be ready`);
    }
    if (setupStatus === "ready" && !requirementsSatisfied) {
      throw new Error(`Connector ${opts.connectorId} integration requires platform requirements before it can be ready`);
    }
    if (setupStatus === "ready" && !configSatisfied) {
      throw new Error(`Connector ${opts.connectorId} integration requires configuration before it can be ready`);
    }
    return setupStatus;
  }

  const setupStatus = opts.setupStatus
    ?? (opts.integrationKey && !opts.requiresAuth && requirementsSatisfied && configSatisfied ? "ready" : "setup");
  if (setupStatus === "ready" && !opts.integrationKey) {
    throw new Error(`Connector ${opts.connectorId} integration requires an integration_key before it can be ready`);
  }
  if (setupStatus === "ready" && opts.requiresAuth && !opts.authReady) {
    throw new Error(`Connector ${opts.connectorId} integration requires credentials before it can be ready`);
  }
  if (setupStatus === "ready" && !requirementsSatisfied) {
    throw new Error(`Connector ${opts.connectorId} integration requires platform requirements before it can be ready`);
  }
  if (setupStatus === "ready" && !configSatisfied) {
    throw new Error(`Connector ${opts.connectorId} integration requires configuration before it can be ready`);
  }
  return setupStatus;
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
