import type { JsonValue } from "../json";

export type MaybePromise<T> = T | Promise<T>;
export type { JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ConnectorRuntimeMode = "watch" | "poll" | "manual";
export type ConnectorPlatform =
  | "darwin"
  | "linux"
  | "windows"
  | "ios"
  | "android"
  | "cloud";

export type ConnectorOAuthPublicAuthSpec = {
  type: "oauth2-public";
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope?: string[];
};

export type ConnectorManagedProviderAuthSpec = {
  type: "managedProvider";
  providerId: string;
};

export type ConnectorOAuthDirectAuthSpec = ConnectorOAuthPublicAuthSpec;

export type ConnectorOAuthAuthSpec = ConnectorOAuthDirectAuthSpec;

export type ConnectorRuntimeAuthType = "none" | "apiKey" | "oauth2" | "managedProvider";

export type ConnectorAuthSpec =
  | { type: "none" }
  | { type: "apiKey"; label?: string }
  | ConnectorOAuthAuthSpec
  | ConnectorManagedProviderAuthSpec;

export function isOAuthAuthSpec(auth: ConnectorAuthSpec): auth is ConnectorOAuthAuthSpec {
  return auth.type === "oauth2-public";
}

export function isDirectOAuthAuthSpec(auth: ConnectorAuthSpec): auth is ConnectorOAuthDirectAuthSpec {
  return auth.type === "oauth2-public";
}

export function isManagedProviderAuthSpec(auth: ConnectorAuthSpec): auth is ConnectorManagedProviderAuthSpec {
  return auth.type === "managedProvider";
}

export function isDirectOAuthAuthType(type: string): boolean {
  return type === "oauth2-public";
}

export function runtimeAuthType(auth: ConnectorAuthSpec): ConnectorRuntimeAuthType {
  if (auth.type === "none" || auth.type === "apiKey") return auth.type;
  if (auth.type === "managedProvider") return "managedProvider";
  return "oauth2";
}

export interface ConnectorRuntimeSpec {
  mode: ConnectorRuntimeMode;
  defaultSchedule?: string;
}

export type ConnectorIntegrationMode = "singleton" | "multiple";

export interface ConnectorIntegrationsSpec {
  mode: ConnectorIntegrationMode;
}

export interface ConnectorPlatformSpec {
  requirements?: string[];
}

export type ConnectorPlatformsSpec = Partial<Record<ConnectorPlatform, ConnectorPlatformSpec>>;

export type ConnectorConfigFieldType = "string" | "number" | "boolean";

export interface ConnectorConfigOption {
  value: string | number | boolean;
  label: string;
}

// One user-facing config field, keyed by name in ConnectorManifest.config.
// `default` is the author default (shown to the user, applied by the host).
// Config fields are setup-required by default; a default value satisfies the
// setup gate, otherwise the user must supply a valid override. Set
// `required: false` for genuinely optional fields.
export interface ConnectorConfigField {
  type: ConnectorConfigFieldType;
  label: string;
  default?: JsonValue;
  options?: ConnectorConfigOption[];
  required?: boolean;
}

export interface ConnectorConfigPanel {
  label: string;
  description?: string;
}

export interface ConnectorManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  description: string;
  // Package-relative JSON file containing the connector's declared D0 output
  // event types and payload JSON Schemas.
  eventCatalog: string;
  entry: string;
  runtime: ConnectorRuntimeSpec;
  // Required: source identity cardinality is an explicit author decision.
  // The parser rejects manifests that omit it; there is no singleton default.
  integrations: ConnectorIntegrationsSpec;
  platforms?: ConnectorPlatformsSpec;
  auth?: ConnectorAuthSpec;
  // Config schema: user-facing fields (type/label/default). Author defaults live
  // here (shown to the user, applied by the host); user-chosen values are
  // overrides in integration config. Internal constants stay in code, undeclared.
  config?: Record<string, ConnectorConfigField>;
  // Optional connector-owned config panels for settings too rich for the
  // primitive manifest config form. The shell opens a trusted connector child
  // process for each panel; the connector owns the UI and any complex payload
  // schema stored in integration config.
  configPanels?: Record<string, ConnectorConfigPanel>;
}

export interface ConnectorEventTypeDefinition {
  description: string;
  payloadSchema: JsonObject | boolean;
}

export interface ConnectorEventCatalog {
  catalogVersion: 1;
  eventTypes: Record<string, ConnectorEventTypeDefinition>;
}

export interface ConnectorEventInput {
  type: string;
  externalId: string;
  startedAt: number;
  endedAt?: number;
  payload: JsonValue;
}

export interface ConnectorTextBlobInput {
  text: string;
  variant?: "redacted-text";
  mediaType?: "text/plain; charset=utf-8" | "application/json";
}

export interface ConnectorTextBlobResult {
  ref: JsonObject;
  bytes: number;
  compressedBytes: number;
}

export interface BoundConnectorGuard {
  writeEvent(event: ConnectorEventInput): Promise<{ id: string }>;
  writeEvents(events: ConnectorEventInput[]): Promise<{ ids: string[] }>;
  writeTextBlob?(input: ConnectorTextBlobInput): Promise<ConnectorTextBlobResult>;
}

export type ConnectorAuthHandle =
  | { type: "none" }
  | {
      type: "apiKey" | "oauth2" | "managedProvider";
      getToken(): Promise<string>;
    };

export interface ConnectorStateHandle<TState = unknown> {
  get(): Promise<TState | undefined>;
  set(state: TState): Promise<void>;
}

export interface ConnectorWarningInput {
  key: string;
  message: string;
  details?: JsonValue;
}

export interface ConnectorWarningRecord extends ConnectorWarningInput {
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ConnectorWarningsHandle {
  set(warning: ConnectorWarningInput): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface ConnectorHostContext {
  workspacePath: string;
  lamarckApiOrigin?: string;
}

export interface ConnectorRunContext<TConfig = unknown, TState = unknown> {
  guard: BoundConnectorGuard;
  auth: ConnectorAuthHandle;
  state: ConnectorStateHandle<TState>;
  warnings: ConnectorWarningsHandle;
  config: TConfig;
  host: ConnectorHostContext;
  signal: AbortSignal;
}

export interface ConnectorConfigPatch {
  set?: JsonObject;
  remove?: string[];
}

export interface ConnectorConfigHandle<TConfig = unknown> {
  get(): Promise<TConfig | undefined>;
  replace(config: JsonObject): Promise<void>;
  patch(patch: ConnectorConfigPatch): Promise<TConfig | undefined>;
}

export interface ConnectorConfigUiContext<TConfig = unknown, TState = unknown> {
  panelId: string;
  config: TConfig;
  configStore: ConnectorConfigHandle<TConfig>;
  state: ConnectorStateHandle<TState>;
  host: ConnectorHostContext;
  signal: AbortSignal;
}

export interface ConnectorConfigUiResult {
  url: string;
}

export type ConnectorRequirementState = "satisfied" | "missing" | "pending" | "error";

export interface ConnectorRequirementStatus {
  status: ConnectorRequirementState;
  message?: string;
}

export interface ConnectorRequirementRecord extends ConnectorRequirementStatus {
  lastCheckedAt: number;
}

export interface ConnectorRequirementContext {
  connectorId: string;
  integrationId: string;
  integrationKey: string | undefined;
  platform: ConnectorPlatform;
  host: ConnectorHostContext;
}

export interface ConnectorRequirementHandler {
  label: string;
  description?: string;
  check(ctx: ConnectorRequirementContext): MaybePromise<ConnectorRequirementStatus>;
  request?(ctx: ConnectorRequirementContext): MaybePromise<ConnectorRequirementStatus>;
}

export interface ConnectorDefinition<TConfig = unknown, TState = unknown> {
  run(context: ConnectorRunContext<TConfig, TState>): MaybePromise<void>;
  configUi?(context: ConnectorConfigUiContext<TConfig, TState>): MaybePromise<ConnectorConfigUiResult>;
  requirements?: Record<string, ConnectorRequirementHandler>;
}

export interface ConnectorIntegration<TConfig = unknown, TState = unknown> {
  id: string;
  connectorId: string;
  integrationKey: string | undefined;
  // Source lifecycle is intentionally separate from observed runtime state.
  // pausedAt + resumeAt describe the only mutable lifecycle policy:
  //   both absent              -> active
  //   pausedAt only            -> paused until explicitly resumed
  //   pausedAt + future resume -> timed pause
  pausedAt: number | undefined;
  resumeAt: number | undefined;
  status: ConnectorIntegrationStatus;
  setupStatus: ConnectorSetupStatus;
  trustStatus: ConnectorTrustStatus;
  scheduleCron: string | undefined;
  nextRunAt: number | undefined;
  packageHash: string | undefined;
  config: TConfig | undefined;
  syncState: TState | undefined;
  requirementsStatus: Record<string, ConnectorRequirementRecord> | undefined;
  authRef: string | undefined;
  lastError: string | undefined;
  warnings: ConnectorWarningRecord[] | undefined;
  lastRunAt: number | undefined;
  createdAt: number;
  updatedAt: number;
}

// Observed execution state only. Setup readiness lives in setupStatus and
// Active/Paused lifecycle policy lives in pausedAt/resumeAt.
export type ConnectorIntegrationStatus = "idle" | "running" | "error";
export type ConnectorRunStatus = "running" | "success" | "error" | "aborted";
export type ConnectorRunTrigger = "manual" | "schedule" | "watch";

export interface ConnectorRunRecord {
  id: string;
  integrationId: string;
  connectorId: string;
  integrationKey: string | undefined;
  trigger: ConnectorRunTrigger;
  status: ConnectorRunStatus;
  startedAt: number;
  endedAt: number | undefined;
  durationMs: number | undefined;
  error: string | undefined;
}

export type ConnectorSetupStatus = "setup" | "ready";
export type ConnectorTrustStatus = "official" | "custom" | "modified" | "untrusted" | "missing";

export type ConnectorPackageTrustStatus = ConnectorTrustStatus | "invalid";

export interface ConnectorPackageTrust {
  status: ConnectorPackageTrustStatus;
  runnable: boolean;
  badge: "Official" | "Custom" | "Modified" | "Untrusted" | "Missing" | "Invalid";
  reason?: string;
}

export interface ConnectorOfficialCatalogEntry {
  id: string;
  hash: string;
  version?: string;
}

export interface ConnectorPackageRecord {
  connectorId: string;
  dir: string;
  manifest: ConnectorManifest;
  eventCatalog: ConnectorEventCatalog;
  entryPath: string;
  contentHash: string;
  trust: ConnectorPackageTrust;
}

// Installed Connector package state, independent of whether it currently owns
// any Sources. This is the Connector half of the public lifecycle model.
export interface InstalledConnectorView {
  connectorId: string;
  name: string;
  description: string;
  mode: ConnectorRuntimeMode;
  integrationsMode: "singleton" | "multiple";
  supported: boolean;
  packageTrust: ConnectorPackageTrustStatus;
  packageHash: string | undefined;
}

export interface ConnectorRunHandle {
  instanceId: string;
  signal: AbortSignal;
  promise: Promise<void>;
  abort(): void;
}

export function defineConnector<TConfig = unknown, TState = unknown>(
  definition: ConnectorDefinition<TConfig, TState>,
): ConnectorDefinition<TConfig, TState> {
  return definition;
}
