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

export async function getCoreBaseUrl(): Promise<string> {
  if (cachedCoreBaseUrl) return cachedCoreBaseUrl;

  // In Electron, a rejected host call means Core is still starting or failed
  // to start. Do not turn that transient state into the browser-dev fallback:
  // caching localhost:3000 here strands the packaged shell there even after
  // Core becomes ready on its persisted workspace port.
  if (window.lamarckHost) {
    const hostBase = await window.lamarckHost.getCoreBaseUrl();
    if (!hostBase) throw new Error("Electron host returned an empty Core URL.");
    cachedCoreBaseUrl = hostBase;
    return hostBase;
  }

  const resolved = import.meta.env.VITE_LAMARCK_CORE_URL
    ?? "http://localhost:3000";
  cachedCoreBaseUrl = resolved;
  return resolved;
}

export function clearCoreBaseUrlCache(): void {
  cachedCoreBaseUrl = null;
}

export async function getCoreToken(): Promise<string> {
  const token = await window.lamarckHost?.getCoreToken();
  if (!token) {
    throw new Error("Core API requires the Electron host security token.");
  }
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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const base = await getCoreBaseUrl();
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: await coreHeaders(options),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    Object.assign(error, { status: res.status });
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

export function getLamarckSession(): Promise<LamarckSessionView> {
  return request("/api/identity/session");
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
  manifestVersion: 1;
  id: string;
  name: string;
  description: string;
  createdFrom?: {
    packageId: string;
    releaseId: string;
  };
  runtime: {
    ui?: {
      command: string[];
      port: number;
    };
    services?: Record<string, { command: string[] }>;
    jobs?: Record<string, { command: string[] }>;
  };
  permissions: {
    writes: {
      files: string[];
      tables: string[];
    };
  };
}

export function listApps(): Promise<{ apps: AppInfo[] }> {
  return request("/api/apps");
}

export function getAppSource(appId: string): Promise<Record<string, string>> {
  return request(`/api/apps/${encodeURIComponent(appId)}/source`);
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

export function saveAppFile(
  appId: string,
  filename: string,
  content: string,
): Promise<{ ok: true }> {
  return request(`/api/apps/${encodeURIComponent(appId)}/files/${encodeURIComponent(filename)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

// -- Query / Mutate (system bridge for components) --

export function query(sql: string, params?: SqlParams): Promise<{ rows: unknown[] }> {
  return request("/api/query", {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
}

export function resolveContentRef(ref: ContentBlobRef): Promise<ResolveContentRefResult> {
  return request("/api/content-ref/resolve", {
    method: "POST",
    body: JSON.stringify({ ref }),
  });
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

export function inspectDataSchema(): Promise<DataSchemaSnapshot> {
  return request("/api/schema/inspect");
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

export function listConnectors(): Promise<{
  sources: ConnectorSourceView[];
  connectors: ConnectorSourceView[];
  packages: InstalledConnectorView[];
}> {
  return request("/api/connectors");
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
  kind: "promote" | "demote";
  ddl: string[];
  requestedBy: string;
  createdAt: number;
  beforeSchema: unknown;
  status: "pending" | "applied" | "rejected" | "failed";
  error?: string;
}

export function listSchemaRequests(): Promise<{ requests: SchemaRequest[] }> {
  return request("/api/schema/requests");
}

export function approveSchemaRequest(
  id: string,
  remember = false,
): Promise<{ request: SchemaRequest }> {
  return request(`/api/schema/requests/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify({ remember }),
  });
}

export function rejectSchemaRequest(id: string): Promise<{ request: SchemaRequest }> {
  return request(`/api/schema/requests/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
