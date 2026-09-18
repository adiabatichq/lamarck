// HTTP client for core runtime. Electron provides the production URL; browser
// dev keeps a default so `npm run dev` can still talk to a standalone core.

import type {
  ContentBlobRef,
  MutationResult,
  ResolveContentRefResult,
  SqlParams,
  SqlStatement,
  TransactionStatementResult,
} from "@lamarck/system/protocol";

export type {
  ContentBlobRef,
  MutationResult,
  ResolveContentRefResult,
  SqlBlob,
  SqlParam,
  SqlParams,
  SqlScalar,
  SqlStatement,
  TransactionStatementResult,
} from "@lamarck/system/protocol";

let cachedCoreBaseUrl: string | null = null;
let coreUrlEpoch = 0;
export const CORE_READ_TIMEOUT_MS = 15_000;
type Host = NonNullable<Window["lamarckHost"]>;
type HostRead = "getCoreBaseUrl" | "getCoreToken" | "getCoreRuntimeState" | "getAppRuntimeStates";
type HostReply<K extends HostRead> = { value: Awaited<ReturnType<Host[K]>>; epoch: number };
const pendingHostReads = new WeakMap<Host, Map<HostRead, Promise<unknown>>>();
const coreTokens = new WeakMap<Host, string>();
const runtimeStates = new WeakMap<Host, HostCoreRuntimeState>();
const runtimeListeners = new Set<() => void>();
let unsubscribeRuntime: (() => void) | undefined;

function readHost<K extends HostRead>(method: K): Promise<HostReply<K>> {
  const host = window.lamarckHost!;
  let pending = pendingHostReads.get(host);
  if (!pending) pendingHostReads.set(host, pending = new Map());
  const existing = pending.get(method);
  if (existing) return existing as Promise<HostReply<K>>;
  // invoke cannot be aborted. Keep its slot until the physical call settles,
  // even after the shared deadline rejects; retries then fail without growing
  // another IPC call or another chain of callbacks on the stalled operation.
  const epoch = coreUrlEpoch;
  const result = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      "Core did not respond within 15 seconds. You can retry the connection.",
    )), CORE_READ_TIMEOUT_MS);
    const finish = () => { clearTimeout(timeout); pending!.delete(method); };
    Promise.resolve().then<unknown>(() => host[method]()).then(
      value => { finish(); resolve({ value, epoch }); },
      error => { finish(); reject(error); },
    );
  });
  pending.set(method, result);
  return result as Promise<HostReply<K>>;
}

export function subscribeCoreRuntime(listener: () => void): () => void {
  const host = window.lamarckHost;
  runtimeListeners.add(listener);
  if (host && !unsubscribeRuntime) {
    runtimeStates.delete(host); // We may have missed events while unmounted.
    unsubscribeRuntime = host.onCoreRuntimeState(state => {
      const current = runtimeStates.get(host);
      if (current && state.generation < current.generation) return;
      clearCoreBaseUrlCache();
      runtimeStates.set(host, state);
      for (const notify of runtimeListeners) notify();
    });
  }
  return () => {
    runtimeListeners.delete(listener);
    if (!runtimeListeners.size) {
      unsubscribeRuntime?.();
      unsubscribeRuntime = undefined;
      if (host) runtimeStates.delete(host);
    }
  };
}

async function getCoreRuntimeState(fresh = false): Promise<HostCoreRuntimeState | null> {
  const host = window.lamarckHost;
  if (!host) return null;
  const cached = runtimeStates.get(host);
  if (cached?.phase === "ready" && !fresh) return cached;
  const { value: state, epoch } = await readHost("getCoreRuntimeState");
  // A notification received during IPC is more recent than its reply.
  const current = runtimeStates.get(host);
  if (current && (epoch !== coreUrlEpoch || current.generation > state.generation)) return current;
  runtimeStates.set(host, state);
  return state;
}

export async function getAppRuntimeStates(): ReturnType<Host["getAppRuntimeStates"]> {
  return window.lamarckHost ? (await readHost("getAppRuntimeStates")).value : [];
}

export async function getCoreBaseUrl(): Promise<string> {
  if (cachedCoreBaseUrl) return cachedCoreBaseUrl;
  if (window.lamarckHost) {
    const { value: hostBase, epoch } = await readHost("getCoreBaseUrl");
    if (!hostBase) throw new Error("Electron host returned an empty Core URL.");
    if (epoch === coreUrlEpoch) cachedCoreBaseUrl = hostBase;
    return hostBase;
  }
  const resolved = import.meta.env.VITE_LAMARCK_CORE_URL ?? "http://localhost:3000";
  cachedCoreBaseUrl = resolved;
  return resolved;
}

export function clearCoreBaseUrlCache(): void {
  coreUrlEpoch += 1;
  cachedCoreBaseUrl = null;
}

export async function getCoreToken(): Promise<string> {
  const host = window.lamarckHost;
  const token = host && (coreTokens.get(host) ?? (await readHost("getCoreToken")).value);
  if (!token) throw new Error("Core API requires the Electron host security token.");
  coreTokens.set(host!, token);
  return token;
}

async function coreHeaders(options?: RequestInit): Promise<Headers> {
  const headers = new Headers(options?.headers);
  headers.set("Authorization", `Bearer ${await getCoreToken()}`);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

async function request<T>(path: string, options?: RequestInit, readOnly = false): Promise<T> {
  const method = options?.method?.toUpperCase() ?? "GET";
  if (!readOnly && method !== "GET" && method !== "HEAD") {
    return performRequest(path, options);
  }

  const controller = new AbortController();
  const cancel = () => controller.abort(options?.signal?.reason);
  const timeout = setTimeout(() => controller.abort(new Error(
    "Core did not respond within 15 seconds. You can retry the connection.",
  )), CORE_READ_TIMEOUT_MS);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  options?.signal?.addEventListener("abort", cancel, { once: true });
  if (options?.signal?.aborted) cancel();
  try {
    // Include Host URL/token resolution and response-body consumption in the
    // deadline. Abort alone cannot settle a stalled Host IPC call.
    return await Promise.race([
      aborted,
      performRequest<T>(path, { ...options, signal: controller.signal }),
    ]);
  } finally {
    clearTimeout(timeout);
    options?.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

async function performRequest<T>(path: string, options?: RequestInit): Promise<T> {
  options?.signal?.throwIfAborted();
  const base = await getCoreBaseUrl();
  options?.signal?.throwIfAborted();
  const headers = await coreHeaders(options);
  options?.signal?.throwIfAborted();
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const failure = data.error;
    const message = typeof failure === "string"
      ? failure
      : failure && typeof failure === "object" && typeof failure.message === "string"
        ? failure.message
        : `HTTP ${res.status}`;
    const error = new Error(message);
    Object.assign(error, {
      status: res.status,
      ...(failure && typeof failure === "object" && typeof failure.code === "string"
        ? { code: failure.code }
        : {}),
    });
    throw error;
  }
  return data as T;
}

export interface DataSchemaSnapshot {
  tables: Array<{
    name: string;
    sql: string;
    columns: Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;
  }>;
  indexes: Array<{ name: string; table: string; sql: string | null }>;
}

export interface WorkspaceInfo {
  path: string;
}

export function getWorkspace(): Promise<WorkspaceInfo> {
  return request("/api/workspace");
}

// -- Lamarck identity --

export interface LamarckSessionView {
  status: "signed_out" | "signed_in" | "expired";
  userId?: string;
  sessionId?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  apiOrigin?: string;
  appOrigin?: string;
}

export interface LamarckLoginStart {
  authorizationUrl: string;
  attemptId: string;
  redirectUri: string;
  expiresAt: number;
}

export function getLamarckSession(signal?: AbortSignal): Promise<LamarckSessionView> {
  return request("/api/identity/session", { signal });
}

export function startLamarckLogin(): Promise<LamarckLoginStart> {
  return request("/api/identity/login/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function logoutLamarckSession(): Promise<{ ok: true }> {
  return request("/api/identity/logout", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export interface VfsCommandResult {
  success: boolean;
  exitCode: number;
  stdoutBase64: string;
  stderrBase64: string;
}

export function vfsCommand(
  command: string,
  options?: { stdin?: { encoding: "utf8" | "base64"; data: string }; stdout?: "capture" | "ignore"; author?: string },
): Promise<VfsCommandResult> {
  return request("/api/vfs/command", {
    method: "POST",
    body: JSON.stringify(options === undefined ? { command } : { command, options }),
  });
}

export interface D1HistoryExclusion {
  path: string;
  prefix: boolean;
}

export function listD1HistoryExclusions(): Promise<{ exclusions: D1HistoryExclusion[] }> {
  return request("/api/vfs/history-exclusions");
}

export function addD1HistoryExclusion(rule: string): Promise<{ exclusion: D1HistoryExclusion }> {
  return request("/api/vfs/history-exclusions", {
    method: "POST",
    body: JSON.stringify({ path: rule }),
  });
}

export function removeD1HistoryExclusion(rule: string): Promise<{ ok: true; removed: boolean }> {
  return request("/api/vfs/history-exclusions", {
    method: "DELETE",
    body: JSON.stringify({ path: rule }),
  });
}

// -- Apps --

export interface AppInfo {
  schemaVersion: 1;
  id: string;
  path: string;
  version: string | null;
  packageDirty: boolean;
  manifestHealth:
    | { status: "valid" }
    | { status: "invalid"; message: string };
  versionHealth:
    | { status: "healthy" }
    | { status: "unversioned" }
    | { status: "unavailable"; message: string };
  name: string;
  description: string;
  createdFrom?: {
    packageId: string;
    releaseId: string;
  };
  runtime?: {
    ui?: {
      command: string[];
      port: number;
    };
    services?: Record<string, { command: string[] }>;
    jobs?: Record<string, { command: string[] }>;
  };
  permissions?: {
    writes: {
      files: string[];
      tables: string[];
    };
  };
}

export function listApps(signal?: AbortSignal): Promise<{ apps: AppInfo[] }> {
  return request("/api/apps", { signal });
}

export interface AppVersionRecordV1 {
  schemaVersion: 1;
  appId: string;
  version: string;
  parentVersion: string | null;
  trigger: "save" | "activate" | "restore";
  createdAt: number;
  message?: string;
  author?: string;
  restoredFrom?: string;
}

export interface AppVersionPage {
  versions: AppVersionRecordV1[];
  nextCursor: string | null;
}

export function listAppVersions(
  appId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<AppVersionPage> {
  const query = new URLSearchParams();
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const suffix = query.size > 0 ? `?${query}` : "";
  return request(`/api/apps/${encodeURIComponent(appId)}/versions${suffix}`);
}

export function restoreAppVersion(
  appId: string,
  version: string,
): Promise<{ version: string; created: boolean; record: AppVersionRecordV1 }> {
  return request(`/api/apps/${encodeURIComponent(appId)}/restore`, {
    method: "POST",
    body: JSON.stringify({ version }),
  });
}

export interface AppVersionHistoryRebuildResultV1 {
  schemaVersion: 1;
  outcome: "healthy" | "reconstructed" | "reset";
  currentVersion: string | null;
}

export function rebuildAppVersionHistory(
  appId: string,
): Promise<AppVersionHistoryRebuildResultV1> {
  return request(`/api/apps/${encodeURIComponent(appId)}/version-history/rebuild`, {
    method: "POST",
    body: JSON.stringify({ confirmed: true }),
  });
}

export function createApp(
  id: string,
  name: string,
  description: string,
): Promise<{ ok: true; id: string }> {
  return request("/api/apps", {
    method: "POST",
    body: JSON.stringify({ id, name, description }),
  });
}

export type MarketplacePackageKind = "app" | "connector";
export type MarketplaceLifecycleAction =
  | "create"
  | "install"
  | "update"
  | "already-installed";

export interface MarketplacePreparedPackage {
  stageId: string;
  kind: MarketplacePackageKind;
  packageId: string;
  releaseId: string;
  contentHash: string;
  origin: "Official";
  name: string;
  description: string;
  action: MarketplaceLifecycleAction;
  localIdConflict: boolean;
}

export function prepareMarketplacePackage(
  kind: MarketplacePackageKind,
  packageId: string,
): Promise<MarketplacePreparedPackage> {
  return request("/api/marketplace/prepare", {
    method: "POST",
    body: JSON.stringify({ kind, packageId }),
  });
}

export function applyMarketplacePackage(
  stageId: string,
  localId?: string,
): Promise<{
  ok: true;
  kind: MarketplacePackageKind;
  id: string;
  disposition: MarketplaceLifecycleAction;
}> {
  return request(`/api/marketplace/stages/${encodeURIComponent(stageId)}/apply`, {
    method: "POST",
    body: JSON.stringify(localId === undefined ? {} : { localId }),
  });
}

export function cancelMarketplacePackage(stageId: string): Promise<{ ok: true }> {
  return request(`/api/marketplace/stages/${encodeURIComponent(stageId)}`, {
    method: "DELETE",
  });
}

export async function archiveApp(appId: string): Promise<{ ok: true; id: string }> {
  if (window.lamarckHost) return window.lamarckHost.archiveApp(appId);
  return request(`/api/apps/${encodeURIComponent(appId)}/archive`, {
    method: "POST",
  });
}

// -- Query / Mutate (system bridge for components) --

export function query(sql: string, params?: SqlParams, signal?: AbortSignal): Promise<{ rows: unknown[] }> {
  return request("/api/query", {
    method: "POST",
    body: JSON.stringify({ sql, params }),
    signal,
  }, true);
}

export function resolveContentRef(ref: ContentBlobRef): Promise<ResolveContentRefResult> {
  return request("/api/content-ref/resolve", {
    method: "POST",
    body: JSON.stringify({ ref }),
  }, true);
}

export function mutate(sql: string, params?: SqlParams): Promise<MutationResult> {
  return request("/api/mutate", {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
}

export function transaction(statements: SqlStatement[]): Promise<TransactionStatementResult[]> {
  return request("/api/transaction", {
    method: "POST",
    body: JSON.stringify({ statements }),
  });
}

export function inspectDataSchema(signal?: AbortSignal): Promise<DataSchemaSnapshot> {
  return request("/api/schema/inspect", { signal });
}

// -- Connectors --

export type ConnectorTrust =
  | "official"
  | "custom"
  | "modified"
  | "untrusted"
  | "missing"
  | "invalid";

export type ConnectorRequirementState =
  | "satisfied"
  | "missing"
  | "pending"
  | "error"
  | "unknown";

export type ConnectorAuthType =
  | "none"
  | "apiKey"
  | "oauth2-public"
  | "managedProvider";

export interface ConnectorRequirementView {
  id: string;
  status: ConnectorRequirementState;
  message?: string;
  lastCheckedAt?: number;
}

export interface ConnectorWarningRecord {
  key: string;
  message: string;
  details?: unknown;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ConnectorRunRecordView {
  id: string;
  sourceId: string;
  connectorId: string;
  sourceKey: string | null;
  trigger: "manual" | "schedule" | "watch";
  status: "running" | "success" | "error" | "aborted";
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
}

export type ConnectorSourceIdentityKind = "single" | "device" | "connector";
export type ConnectorIdentityStatus =
  | "unresolved"
  | "resolved"
  | "conflict"
  | "changed"
  | "error";
export type ConnectorOwnership = "here" | "other-device" | "device-unknown";

export type ConnectorSetupPendingReason = "identity" | "auth" | "requirements" | "config";

export interface ConnectorConfigFieldView {
  type: "string" | "number" | "boolean";
  label: string;
  default?: string | number | boolean;
  options?: Array<{ value: string | number | boolean; label: string }>;
  required?: boolean;
}

export interface ConnectorConfigPanelView {
  label: string;
  description?: string;
}

export interface InstalledConnectorView {
  connectorId: string;
  name: string;
  description: string;
  mode: "watch" | "poll" | "manual";
  identityKind: ConnectorSourceIdentityKind;
  supported: boolean;
  packageTrust: ConnectorTrust;
  packageHash?: string;
  updateAvailable?: boolean;
}

export interface ConnectorSourceView {
  id: string;
  connectorId: string;
  connectorName: string;
  sourceKey: string | null;
  displayName: string | null;
  suggestedLabel: string | null;
  identityKind: ConnectorSourceIdentityKind;
  identityStatus: ConnectorIdentityStatus;
  ownership: ConnectorOwnership;
  ownershipReason?: string;
  conflictSourceId?: string;
  // Core resolves the same shown-name precedence used by the shell:
  // displayName -> suggestedLabel -> connectorName.
  name: string;
  description?: string;
  mode: "watch" | "poll" | "manual" | "unknown";
  // Observed runtime activity/health. Source lifecycle comes only from
  // pausedAt/resumeAt; setupPending is the independent readiness condition.
  status: "idle" | "running" | "error";
  setupStatus: "setup" | "ready";
  pausedAt?: number;
  resumeAt?: number;
  packageTrust: ConnectorTrust;
  authType: ConnectorAuthType;
  authStatus?: string;
  authAttention?: "refresh_failed" | "redirect_uri_changed";
  authReady: boolean;
  oauthRedirectUri?: string;
  setupPending: ConnectorSetupPendingReason[];
  source: string | null;
  running: boolean;
  supported: boolean;
  scheduleCron?: string;
  nextRunAt?: number;
  packageHash?: string;
  requirements: ConnectorRequirementView[];
  lastError?: string;
  warnings?: ConnectorWarningRecord[];
  lastRunAt?: number;
  recentRuns?: ConnectorRunRecordView[];
  // Config schema declared by the connector manifest (user-facing fields).
  configSchema?: Record<string, ConnectorConfigFieldView>;
  // Current user override/payload values stored on the Source. Manifest
  // config fields use top-level primitive keys; custom config panels may store
  // opaque nested payloads beside them.
  config?: Record<string, unknown>;
  configPanels?: Record<string, ConnectorConfigPanelView>;
}

export function listConnectors(signal?: AbortSignal): Promise<{
  sources: ConnectorSourceView[];
  connectors: ConnectorSourceView[];
  packages: InstalledConnectorView[];
}> {
  return request("/api/connectors", { signal });
}

export function approveConnector(connectorId: string): Promise<{ ok: true }> {
  return request(`/api/connectors/${encodeURIComponent(connectorId)}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function checkConnectorRequirements(
  sourceId: string,
): Promise<{ requirements: Record<string, ConnectorRequirementView> }> {
  return request(
    `/api/connectors/sources/${encodeURIComponent(sourceId)}/requirements/check`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function requestConnectorRequirement(
  sourceId: string,
  requirementId: string,
): Promise<{ requirement: ConnectorRequirementView }> {
  return request(
    `/api/connectors/sources/${encodeURIComponent(sourceId)}/requirements/${encodeURIComponent(requirementId)}/request`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function restartConnectorSource(
  sourceId: string,
): Promise<{ sourceRecord: ConnectorSourceRow }> {
  return request(
    `/api/connectors/sources/${encodeURIComponent(sourceId)}/restart`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

// Trigger an explicit run using the latest stored Source config.
export function runConnectorSource(sourceId: string): Promise<{ ok: true }> {
  return request(
    `/api/connectors/sources/${encodeURIComponent(sourceId)}/run`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

// Mutation endpoints return the raw Source row (no name/setupPending/
// requirements enrichment — those only come from listConnectors). Callers
// should refresh the list after a mutation instead of consuming this shape.
export interface ConnectorSourceRow {
  id: string;
  connectorId: string;
  sourceKey: string | null;
  identityStatus: ConnectorIdentityStatus;
  displayName: string | null;
  suggestedLabel: string | null;
  status: "idle" | "running" | "error";
  setupStatus: "setup" | "ready";
  pausedAt?: number;
  resumeAt?: number;
  scheduleCron?: string;
  nextRunAt?: number;
  lastError?: string;
  warnings?: ConnectorWarningRecord[];
  lastRunAt?: number;
}

export function updateConnectorSource(
  sourceId: string,
  input: {
    displayName?: string | null;
    scheduleCron?: string | null;
    config?: Record<string, unknown>;
  },
): Promise<{ sourceRecord: ConnectorSourceRow }> {
  return request(`/api/connectors/sources/${encodeURIComponent(sourceId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function startConnectorConfigPanel(
  sourceId: string,
  panelId: string,
): Promise<{ sessionId: string; url: string }> {
  return request(
    `/api/connectors/sources/${encodeURIComponent(sourceId)}/config-panels/${encodeURIComponent(panelId)}/start`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function stopConnectorConfigPanelSession(sessionId: string): Promise<{ ok: true; stopped: boolean }> {
  return request(`/api/connectors/config-ui-sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export function createConnectorSource(
  connectorId: string,
  displayName?: string,
): Promise<{ sourceRecord: ConnectorSourceRow }> {
  return request(`/api/connectors/${encodeURIComponent(connectorId)}/sources`, {
    method: "POST",
    body: JSON.stringify(displayName ? { displayName } : {}),
  });
}

export function retryConnectorSourceIdentity(
  sourceId: string,
): Promise<{ sourceRecord: ConnectorSourceRow }> {
  return request(
    `/api/connectors/sources/${encodeURIComponent(sourceId)}/identity/retry`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function removeConnectorSource(sourceId: string): Promise<{ ok: true }> {
  return request(`/api/connectors/sources/${encodeURIComponent(sourceId)}`, {
    method: "DELETE",
  });
}

export function pauseConnectorSource(
  sourceId: string,
  durationMs?: number,
): Promise<{ sourceRecord: ConnectorSourceRow }> {
  return request(`/api/connectors/sources/${encodeURIComponent(sourceId)}/pause`, {
    method: "POST",
    body: JSON.stringify(durationMs === undefined ? {} : { durationMs }),
  });
}

export function resumeConnectorSource(
  sourceId: string,
): Promise<{ sourceRecord: ConnectorSourceRow }> {
  return request(`/api/connectors/sources/${encodeURIComponent(sourceId)}/resume`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function disconnectConnectorSource(
  sourceId: string,
): Promise<{ sourceRecord: ConnectorSourceView }> {
  return request(`/api/connectors/sources/${encodeURIComponent(sourceId)}/disconnect`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function connectConnectorSource(
  sourceId: string,
  token: string,
): Promise<{ sourceRecord: ConnectorSourceRow }> {
  return request(`/api/connectors/sources/${encodeURIComponent(sourceId)}/connect`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export interface OAuthStartResult {
  authorizationUrl: string;
  attemptId: string;
  redirectUri?: string;
  expiresAt: number;
}

export type OAuthAttemptStatus = "pending" | "connected" | "failed" | "expired";

export interface OAuthAttemptResult {
  status: OAuthAttemptStatus;
  credentialId?: string;
  error?: string;
}

export function startConnectorAuth(
  sourceId: string,
  opts: { replacePending?: boolean } = {},
): Promise<OAuthStartResult> {
  return request(`/api/connectors/sources/${encodeURIComponent(sourceId)}/auth/start`, {
    method: "POST",
    body: JSON.stringify({ replacePending: opts.replacePending === true }),
  });
}

export function getConnectorAuthAttempt(
  sourceId: string,
  attemptId: string,
): Promise<OAuthAttemptResult> {
  return request(
    `/api/connectors/sources/${encodeURIComponent(sourceId)}/auth/attempts/${encodeURIComponent(attemptId)}`,
  );
}

export function cancelConnectorAuthAttempt(
  sourceId: string,
  attemptId: string,
): Promise<{ ok: true; cancelled: boolean }> {
  return request(
    `/api/connectors/sources/${encodeURIComponent(sourceId)}/auth/attempts/${encodeURIComponent(attemptId)}`,
    { method: "DELETE" },
  );
}

export function removeConnector(connectorId: string): Promise<{ ok: true; removed: boolean }> {
  return request(`/api/connectors/${encodeURIComponent(connectorId)}`, {
    method: "DELETE",
  });
}

// -- Schema lifecycle approval --

export interface SchemaRequest {
  id: string;
  ddl: string[];
  author?: string;
  context?: string;
  createdAt: number;
  beforeSchema: DataSchemaSnapshot;
  afterSchema: DataSchemaSnapshot;
  status: "pending" | "applied" | "rejected" | "stale" | "failed";
  error?: string;
}

export function listSchemaRequests(signal?: AbortSignal): Promise<{ requests: SchemaRequest[] }> {
  return request("/api/schema/requests", { signal });
}

export function approveSchemaRequest(
  id: string,
): Promise<{ request: SchemaRequest }> {
  return request(`/api/schema/requests/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function rejectSchemaRequest(id: string): Promise<{ request: SchemaRequest }> {
  return request(`/api/schema/requests/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// AI access is managed only by the trusted System Console.
export type { AiSourceInput, ManagedAiSource, AiOptions, AiAccessSource } from '@lamarck/system/protocol';
export function listAiSources(): Promise<import('@lamarck/system/protocol').AiOptions & { sources: import('@lamarck/system/protocol').ManagedAiSource[] }> {
  return request('/api/ai/sources');
}
export function saveAiSource(input: import('@lamarck/system/protocol').AiSourceInput, id?: string): Promise<import('@lamarck/system/protocol').ManagedAiSource> {
  return request('/api/ai/sources', { method: 'POST', body: JSON.stringify({ ...input, ...(id ? { id } : {}) }) });
}
export function removeAiSource(id: string): Promise<{ ok: true }> {
  return request(`/api/ai/sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
export interface AiLoginStatus { status: 'pending' | 'ready' | 'cancelled' | 'failed'; url?: string; message?: string }
export function aiSourceLogin(id: string, action: 'login' | 'login-status' | 'cancel-login', signal?: AbortSignal): Promise<AiLoginStatus> {
  return request(`/api/ai/sources/${encodeURIComponent(id)}/${action}`, { method: action === 'login-status' ? 'GET' : 'POST', ...(action === 'login-status' ? { signal } : { body: '{}' }) });
}

export type CoreStatus = "checking" | "connected" | "offline";

export interface CoreFailureState {
  status: "checking" | "offline";
  error: string | null;
}

export interface HostCoreRuntimeState {
  generation: number;
  phase: "starting" | "ready" | "restarting" | "failed";
  error: string | null;
}

export function coreResponseDisposition(
  before: HostCoreRuntimeState,
  after: HostCoreRuntimeState,
): "publish" | "retry" | "unavailable" {
  if (
    before.phase === "ready"
    && after.phase === "ready"
    && before.generation === after.generation
  ) return "publish";
  if (after.phase === "ready") return "retry";
  return "unavailable";
}

/**
 * A failed Core request is not itself proof that startup failed. The Shell is
 * created before Keychain access and Core startup, so the Host's explicit
 * runtime phase is authoritative. It also distinguishes startup from an HTTP
 * failure after Core was already ready.
 */
export async function resolveCoreRequestFailure(
  requestError: unknown,
  getRuntimeState?: () => Promise<HostCoreRuntimeState>,
): Promise<CoreFailureState> {
  if (getRuntimeState) {
    try {
      const runtime = await getRuntimeState();
      if (runtime.phase === "starting" || runtime.phase === "restarting") {
        return { status: "checking", error: null };
      }
      if (runtime.phase === "failed" && runtime.error?.trim()) {
        return { status: "offline", error: runtime.error };
      }
    } catch {
      // If the Host cannot report its state, preserve the original request
      // failure instead of claiming startup is merely pending.
    }
  }

  return {
    status: "offline",
    error: errorMessage(requestError),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns the inventory's connection and generation checks for every Shell view. */
export async function readAppInventory(signal: AbortSignal): Promise<
  { status: "connected"; apps: AppInfo[]; error: null } | (CoreFailureState & { apps: AppInfo[] })
> {
  try {
    const before = await getCoreRuntimeState();
    signal.throwIfAborted();
    if (before && before.phase !== "ready") {
      return { apps: [], ...await resolveCoreRequestFailure(
        new Error(before.error ?? "Core runtime is starting"), async () => before,
      ) };
    }
    const result = await listApps(signal);
    // Keep the authoritative post-read check: a delayed notification must not
    // let an old runtime's inventory retain native App authority.
    const after = await getCoreRuntimeState(true);
    signal.throwIfAborted();
    if (before && after) {
      const disposition = coreResponseDisposition(before, after);
      if (disposition === "retry") {
        clearCoreBaseUrlCache();
        return { apps: [], status: "checking", error: null };
      }
      if (disposition === "unavailable") {
        return { apps: [], ...await resolveCoreRequestFailure(
          new Error(after.error ?? "Core runtime generation changed"), async () => after,
        ) };
      }
    }
    return { ...result, status: "connected", error: null };
  } catch (error) {
    signal.throwIfAborted();
    return { apps: [], ...await resolveCoreRequestFailure(error, window.lamarckHost
      ? async () => (await getCoreRuntimeState(true))! : undefined) };
  }
}
