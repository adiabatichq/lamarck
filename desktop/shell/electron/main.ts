// Electron main process
// - Launches the isolated Node Guard utility before the Node Core
// - Keeps Workspace creation and opening as explicit user actions
// - Opens renderer window

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  utilityProcess,
  WebContentsView,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Input,
  type UtilityProcess,
  type Session,
  type WebContents,
} from "electron";
import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { createServer } from "net";
import { join, resolve } from "path";
import { performance } from "perf_hooks";
import { pathToFileURL } from "url";
import {
  AppViewerBusyError,
  CapsuleManager,
  type AppViewerOwner,
  type PreparedViewerBinding,
  type ReloadedBrowserBinding,
} from "./capsule/manager";
import { MacOsCapsuleBackend } from "./capsule/macos-backend";
import { isCapsuleRestartRequiredError } from "./capsule/backend";
import { SystemBroker } from "./capsule/system-broker";
import { SystemStreamServer } from "./capsule/system-stream";
import { createViewerGateway, type ViewerGatewayBinding } from "./capsule/viewer-gateway";
import { waitForViewerHttpReady } from "./capsule/viewer-readiness";
import { clearDisposableAppViewerStorage } from "./capsule/viewer-storage";
import {
  ViewerLifecycleCoordinator,
  assertViewerAuthorityCurrent,
} from "./capsule/viewer-lifecycle";
import {
  createShellNavigationPolicy,
  appViewerOriginHost,
  appViewerPartition,
  isAllowedAppViewerNavigationUrl,
  isAllowedAppViewerUrl,
  parseAllowedExternalUrl,
  type AppViewerOriginBinding,
} from "./capsule/web-policy";
import {
  CoreRuntimeStateController,
  type CoreRuntimeState,
} from "./core-runtime-state";
import {
  isWorkspaceVaultId,
  WorkspaceVaultStateController,
  withEncryptedVaultRecord,
} from "./workspace-vault-state";
import {
  createWorkspaceVaultVerifier,
  isCanonicalWorkspaceVaultVerifier,
  normalizeRecoveryCode,
  validateWorkspaceVaultVerifier,
} from "./workspace-vault-crypto";
import {
  WorkspaceValidationError,
  initializeWorkspaceDirectory,
  inspectWorkspaceForCreate,
  inspectWorkspaceForOpen,
  type WorkspaceDescriptor,
} from "./workspace-files";
import {
  marketplaceDeepLinksFromArgv,
  parseMarketplaceDeepLink,
  type MarketplaceDeepLink,
} from "./marketplace-deep-link";
import { PACKAGE_ID_PATTERN } from "./package-id";

app.setName("Lamarck");

const CORE_ENTRY = join(__dirname, "core.mjs");
const PTY_HELPER = join(__dirname, "pty-helper.cjs");
const APP_PRELOAD = join(__dirname, "app-preload.cjs");
const CAPSULE_VM_HELPER = join(__dirname, "native", "lamarck-capsule-vm-host");
const GUARD_ENTRY = join(__dirname, "guard-service.cjs");
const CORE_PORT_MIN = 32100;
const CORE_PORT_MAX = 32102;
const CORE_TOKEN = randomBytes(32).toString("base64url");
const GUARD_TOKEN = randomBytes(32).toString("base64url");
const GUARD_START_TIMEOUT_MS = 10_000;
const GUARD_HEARTBEAT_INTERVAL_MS = 5_000;
const GUARD_HEARTBEAT_TIMEOUT_MS = 30_000;
const PROCESS_STOP_TIMEOUT_MS = 1_500;
const CORE_READY_TIMEOUT_MS = 10_000;
const CORE_READY_REQUEST_TIMEOUT_MS = 750;
const CORE_READY_RETRY_DELAY_MS = 200;
const PRIVATE_RUNTIME_ENV = [
  "LAMARCK_GUARD_ORIGIN",
  "LAMARCK_GUARD_TOKEN",
  "LAMARCK_CORE_TOKEN",
  "LAMARCK_VAULT_KEY",
] as const;
let core: ChildProcess | null = null;
let guard: UtilityProcess | null = null;
let guardOrigin = "";
let workspace = "";
let corePort = 0;
let coreStartError: string | null = null;
let activeWorkspace: WorkspaceDescriptor | null = null;
let rememberedWorkspace: RememberedWorkspace | null = null;
let workspaceSetupReason: WorkspaceSetupReason = "first-run";
let workspaceSetupDetail: string | null = null;
let workspaceSelectionNeedsPersistence = false;
const coreRuntime = new CoreRuntimeStateController(notifyCoreRuntimeState);
const workspaceVault = new WorkspaceVaultStateController();
let nextTerminalId = 1;
let isQuitting = false;
let shutdownComplete = false;
let runtimeQueue: Promise<void> = Promise.resolve();
let controlPlaneTeardownBarrier: Promise<void> = Promise.resolve();
let guardHeartbeatTimer: NodeJS.Timeout | null = null;
let guardHeartbeatChild: UtilityProcess | null = null;
let guardPongListener: ((message: unknown) => void) | null = null;
let guardLastPongAt = 0;
let guardPingNonce = 0;
const expectedCoreStops = new WeakSet<ChildProcess>();
const expectedGuardStops = new WeakSet<UtilityProcess>();
const exitedCores = new WeakSet<ChildProcess>();
const exitedGuards = new WeakSet<UtilityProcess>();
const unspawnedCoreFailures = new WeakSet<ChildProcess>();
const handledCoreLosses = new WeakSet<ChildProcess>();
const handledGuardLosses = new WeakSet<UtilityProcess>();
const terminalSessions = new Map<string, { proc: ChildProcess; ownerWebContentsId: number }>();
const MARKETPLACE_HANDOFF_QUEUE_LIMIT = 32;
const marketplaceHandoffs: MarketplaceDeepLink[] = [];
let marketplaceRendererWebContentsId: number | null = null;
let mainWindow: BrowserWindow | null = null;

interface ShellWebContentsState {
  readonly allowsUrl: (url: string) => boolean;
  currentOwner: AppViewerOwner;
  retirement: Promise<void>;
}

const shellWebContents = new Map<number, ShellWebContentsState>();

const ownsSingleInstance = app.requestSingleInstanceLock();
if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on("open-url", (event, rawUrl) => {
    event.preventDefault();
    acceptMarketplaceHandoff(rawUrl);
  });
  app.on("second-instance", (_event, argv) => {
    for (const handoff of marketplaceDeepLinksFromArgv(argv)) {
      queueMarketplaceHandoff(handoff);
    }
  });
  for (const handoff of marketplaceDeepLinksFromArgv(process.argv)) {
    queueMarketplaceHandoff(handoff, false);
  }
}

function acceptMarketplaceHandoff(rawUrl: unknown): boolean {
  try {
    return queueMarketplaceHandoff(parseMarketplaceDeepLink(rawUrl));
  } catch (error) {
    console.warn(`[electron] Rejected Marketplace URL: ${errorMessage(error)}`);
    return false;
  }
}

function queueMarketplaceHandoff(handoff: MarketplaceDeepLink, focus = true): boolean {
  if (marketplaceHandoffs.length >= MARKETPLACE_HANDOFF_QUEUE_LIMIT) {
    console.warn("[electron] Rejected Marketplace URL because the handoff queue is full");
    return false;
  }
  marketplaceHandoffs.push(handoff);
  if (focus && mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  flushMarketplaceHandoffs();
  return true;
}

function flushMarketplaceHandoffs(): void {
  if (coreRuntime.snapshot().phase !== "ready" || marketplaceHandoffs.length === 0) return;
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const contents = window.webContents;
  if (
    contents.isDestroyed()
    || marketplaceRendererWebContentsId !== contents.id
    || !shellWebContents.has(contents.id)
  ) return;
  while (marketplaceHandoffs.length > 0) {
    const handoff = marketplaceHandoffs[0];
    try {
      contents.send("marketplace:handoff", handoff);
    } catch {
      return;
    }
    marketplaceHandoffs.shift();
  }
}

function registerMarketplaceProtocolClient(): void {
  const registered = app.isPackaged
    ? app.setAsDefaultProtocolClient("lamarck")
    : typeof process.argv[1] === "string"
      ? app.setAsDefaultProtocolClient("lamarck", process.execPath, [resolve(process.argv[1])])
      : false;
  if (!registered) {
    console.warn("[electron] The lamarck:// development protocol handler could not be registered");
  }
}

interface AppViewerRecord {
  appId: string;
  ownerLease: AppViewerOwner;
  owner: BrowserWindow;
  view: WebContentsView;
  appWebContentsId: number;
  viewerSession: Session;
  protocolPartition: string;
  gateway: ViewerGatewayBinding;
  pendingReplacement: AppViewerReplacement | null;
}

interface AppViewerReplacement {
  view: WebContentsView;
  gateway: ViewerGatewayBinding;
  viewerSession: Session;
  protocolPartition: string;
  stopHealthMonitoring?(): void;
}

interface AppViewerProtocolBinding extends AppViewerOriginBinding {
  viewerId: string;
}

interface AppViewerSessionState {
  binding: AppViewerProtocolBinding | null;
}

const appViewers = new Map<string, AppViewerRecord>();
// Includes hidden first-launch renderers during the narrow interval after
// their browser authority is bound but before they can enter appViewers.
const preparedAppViewerSenderIds = new Set<number>();
const appArchiveOperations = new Map<string, Promise<{ ok: true; id: string }>>();
const appViewerSessions = new Map<string, AppViewerSessionState>();
const appViewerLifecycle = new ViewerLifecycleCoordinator();
const configuredAppWebContents = new WeakSet<WebContents>();
const expectedAppViewerCloses = new WeakSet<WebContents>();
const systemBroker = new SystemBroker({
  coreBaseUrl: () => coreBaseUrl(),
  async revokeCapability(channelId) {
    const response = await fetch(
      `${coreBaseUrl()}/api/app-runtime/channels/${encodeURIComponent(channelId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${CORE_TOKEN}` },
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Core channel revocation failed (${response.status})`);
    }
  },
});
const systemStreamServer = new SystemStreamServer(systemBroker, { unbindOnClose: false });
const capsuleCacheNamespace = app.getVersion().includes("-alpha")
  ? "ai.lamarck.desktop.alpha"
  : app.isPackaged
    ? "ai.lamarck.desktop"
    : "ai.lamarck.desktop.dev";
// Capsule state is fully reconstructable from the selected Workspace and the
// signed Guest release. Keep it in the macOS cache domain; the Workspace path
// is user-owned data and must never become a child of a disposable Host root.
const capsuleCacheRoot = join(
  app.getPath("home"),
  "Library",
  "Caches",
  capsuleCacheNamespace,
  "Capsule",
);
const capsuleBackend = new MacOsCapsuleBackend({
  helperPath: CAPSULE_VM_HELPER,
  releaseResourcesRoot: join(__dirname, "native", "capsule-guest"),
  stateDirectory: join(capsuleCacheRoot, "vm"),
  cacheDirectory: join(capsuleCacheRoot, "cache"),
  artifactRoot: join(capsuleCacheRoot, "artifacts"),
  systemStreamServer,
});
const capsuleManager = new CapsuleManager({
  backend: capsuleBackend,
  workspacePath: () => workspace,
  coreBaseUrl: () => coreBaseUrl(),
  coreToken: CORE_TOKEN,
  bindSystemSender: (senderId, binding) => systemBroker.bindSender(senderId, binding),
  unbindSystemSender: (senderId) => { systemBroker.unbindSender(senderId); },
  onBackendBoundaryLost(error) {
    console.error(`[electron] App Capsule boundary lost: ${errorMessage(error)}`);
    detachAllAppWebContents();
  },
  onUiLost(event) {
    console.error(
      `[electron] App Capsule UI ${event.appId}/${event.instanceId} stopped: ${errorMessage(event.error)}`,
    );
    const record = appViewers.get(event.viewerId);
    if (!record) return;
    const cleanup = detachAppViewerRecord(event.viewerId, record);
    return Promise.allSettled(cleanup).then((results) => {
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Unexpected App UI teardown was incomplete");
      }
    });
  },
});

interface GuardReadyMessage {
  type: "ready";
  port: number;
}

interface GuardPongMessage {
  type: "pong";
  nonce: number;
}

interface RememberedWorkspace {
  lastKnownPath: string;
  vaultId?: string;
}

type WorkspaceSetupReason = "first-run" | "missing" | "invalid";

type WorkspaceHostState =
  | {
      status: "ready";
      workspace: WorkspaceDescriptor;
    }
  | {
      status: "setup";
      reason: WorkspaceSetupReason;
      suggestedPath: string;
      previousWorkspace?: RememberedWorkspace;
      detail?: string;
    };

type WorkspaceOpenResult =
  | {
      status: "ready";
      workspace: WorkspaceDescriptor;
    }
  | {
      status: "recovery-required";
      workspace: WorkspaceDescriptor;
    };

interface AppSettings {
  activeWorkspace?: {
    vaultId?: unknown;
    lastKnownPath?: unknown;
  };
  [key: string]: unknown;
}

interface WorkspaceSettings {
  allowCodingAgentSchemaDecisions?: boolean;
  corePort?: number;
  vaultId?: string;
  vaultKeyVerifier?: string;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function loadAppSettings(): AppSettings {
  if (!existsSync(settingsPath())) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch (error) {
    throw new Error("Lamarck settings are not valid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Lamarck settings must be a JSON object");
  }
  return parsed as AppSettings;
}

function loadRememberedWorkspace(): RememberedWorkspace | null {
  const settings = loadAppSettings();
  const active = settings.activeWorkspace;
  if (active !== undefined) {
    if (
      !active
      || typeof active !== "object"
      || typeof active.lastKnownPath !== "string"
      || !active.lastKnownPath.trim()
      || !isWorkspaceVaultId(active.vaultId)
    ) {
      throw new Error("Saved active Workspace is invalid");
    }
    return {
      lastKnownPath: active.lastKnownPath,
      vaultId: active.vaultId,
    };
  }
  return null;
}

function saveActiveWorkspace(nextWorkspace: WorkspaceDescriptor): void {
  const settings = loadAppSettings();
  settings.activeWorkspace = {
    vaultId: nextWorkspace.vaultId,
    lastKnownPath: nextWorkspace.path,
  };
  mkdirSync(app.getPath("userData"), { recursive: true });
  atomicWriteText(settingsPath(), JSON.stringify(settings, null, 2) + "\n");
}

function workspaceHostState(): WorkspaceHostState {
  if (activeWorkspace) {
    return {
      status: "ready",
      workspace: { ...activeWorkspace },
    };
  }
  return {
    status: "setup",
    reason: workspaceSetupReason,
    suggestedPath: workspaceSetupReason === "invalid"
      ? ""
      : workspaceSetupReason === "missing"
        ? rememberedWorkspace?.lastKnownPath ?? join(app.getPath("home"), "Lamarck")
        : join(app.getPath("home"), "Lamarck"),
    ...(rememberedWorkspace
      ? { previousWorkspace: { ...rememberedWorkspace } }
      : {}),
    ...(workspaceSetupDetail ? { detail: workspaceSetupDetail } : {}),
  };
}

function initializeWorkspaceSelection(): WorkspaceDescriptor | null {
  workspaceSelectionNeedsPersistence = false;
  try {
    rememberedWorkspace = loadRememberedWorkspace();
  } catch (error) {
    rememberedWorkspace = null;
    workspaceSetupReason = "invalid";
    workspaceSetupDetail = errorMessage(error);
    return null;
  }
  if (!rememberedWorkspace) {
    workspaceSetupReason = "first-run";
    workspaceSetupDetail = null;
    return null;
  }

  try {
    const savedWorkspace = rememberedWorkspace;
    const descriptor = inspectWorkspaceForOpen(rememberedWorkspace.lastKnownPath);
    if (
      rememberedWorkspace.vaultId
      && rememberedWorkspace.vaultId !== descriptor.vaultId
    ) {
      throw new Error("The folder at the saved path belongs to a different Workspace");
    }
    activeWorkspace = { ...descriptor };
    workspaceSelectionNeedsPersistence = savedWorkspace.vaultId !== descriptor.vaultId
      || savedWorkspace.lastKnownPath !== descriptor.path;
    rememberedWorkspace = {
      lastKnownPath: descriptor.path,
      vaultId: descriptor.vaultId,
    };
    workspaceSetupReason = "first-run";
    workspaceSetupDetail = null;
    return descriptor;
  } catch (error) {
    activeWorkspace = null;
    workspaceSetupReason = error instanceof WorkspaceValidationError
      && error.code === "WORKSPACE_NOT_FOUND"
      ? "missing"
      : "invalid";
    workspaceSetupDetail = errorMessage(error);
    return null;
  }
}

function workspaceSettingsPath(targetWorkspace = workspace): string {
  return join(targetWorkspace, ".lamarck", "settings.json");
}

function loadWorkspaceSettings(targetWorkspace = workspace): WorkspaceSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(workspaceSettingsPath(targetWorkspace), "utf8"));
  } catch (error) {
    throw new Error("Workspace settings are not valid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workspace settings must be a JSON object");
  }
  return parsed as WorkspaceSettings;
}

function saveWorkspaceSettings(settings: WorkspaceSettings, targetWorkspace = workspace): void {
  const lamarckDir = join(targetWorkspace, ".lamarck");
  mkdirSync(lamarckDir, { recursive: true });
  atomicWriteText(
    workspaceSettingsPath(targetWorkspace),
    JSON.stringify(settings, null, 2) + "\n",
  );
}

function vaultRecordsPath(): string {
  return join(app.getPath("userData"), "vault-keys.json");
}

function loadVaultRecords(): Record<string, string> {
  if (!existsSync(vaultRecordsPath())) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(vaultRecordsPath(), "utf8"));
  } catch (error) {
    throw new Error("Workspace vault key records are not valid JSON", { cause: error });
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.values(parsed).some((value) => typeof value !== "string")
  ) {
    throw new Error("Workspace vault key records are invalid");
  }
  return parsed as Record<string, string>;
}

function saveVaultRecords(records: Record<string, string>): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  atomicWriteText(vaultRecordsPath(), JSON.stringify(records, null, 2) + "\n");
}

function deleteVaultKeyRecord(nextVaultId: string): void {
  const records = loadVaultRecords();
  if (!Object.hasOwn(records, nextVaultId)) return;
  delete records[nextVaultId];
  saveVaultRecords(records);
}

function atomicWriteText(path: string, contents: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function loadVaultKey(nextVaultId: string): Promise<string | null> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("Electron safeStorage is unavailable; cannot unlock the workspace vault key");
  }
  const records = loadVaultRecords();
  const encrypted = Object.hasOwn(records, nextVaultId)
    ? records[nextVaultId]
    : undefined;
  if (encrypted !== undefined && typeof encrypted !== "string") {
    throw new Error("Workspace vault key record is invalid");
  }
  if (encrypted) {
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"));
    if (decrypted.shouldReEncrypt) {
      saveVaultRecords(withEncryptedVaultRecord(
        records,
        nextVaultId,
        (await safeStorage.encryptStringAsync(decrypted.result)).toString("base64"),
      ));
    }
    return decrypted.result;
  }
  return null;
}

async function createVaultKey(nextVaultId: string): Promise<string> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("Electron safeStorage is unavailable; cannot create the workspace vault key");
  }
  const records = loadVaultRecords();
  if (Object.hasOwn(records, nextVaultId)) {
    throw new Error("Workspace vault ID already has a local key record");
  }
  const recoveryCode = randomBytes(32).toString("base64url");
  saveVaultRecords(withEncryptedVaultRecord(
    records,
    nextVaultId,
    (await safeStorage.encryptStringAsync(recoveryCode)).toString("base64"),
  ));
  return recoveryCode;
}

async function requireVaultKey(nextVaultId: string): Promise<string> {
  const key = await loadVaultKey(nextVaultId);
  if (!key) {
    throw new Error("Workspace vault is locked on this device. Import the recovery code to unlock it.");
  }
  return key;
}

async function importVaultKey(
  descriptor: WorkspaceDescriptor,
  recoveryCode: string,
): Promise<string> {
  const normalized = normalizeRecoveryCode(recoveryCode);
  const settings = loadWorkspaceSettings(descriptor.path);
  const verifier = requireWorkspaceVaultVerifier(settings, descriptor.vaultId);
  assertWorkspaceIdentityDoesNotConflict(descriptor, verifier);
  if (!validateWorkspaceVaultVerifier(descriptor.vaultId, normalized, verifier)) {
    throw new Error("Recovery code does not match this Workspace");
  }
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("Electron safeStorage is unavailable; cannot store the workspace vault key");
  }

  const encrypted = (await safeStorage.encryptStringAsync(normalized)).toString("base64");
  const currentDescriptor = inspectWorkspaceForOpen(descriptor.path);
  if (currentDescriptor.vaultId !== descriptor.vaultId) {
    throw new Error("Workspace ID changed while its recovery code was being imported");
  }
  const currentSettings = loadWorkspaceSettings(currentDescriptor.path);
  const currentVerifier = requireWorkspaceVaultVerifier(
    currentSettings,
    currentDescriptor.vaultId,
  );
  if (currentVerifier !== verifier) {
    throw new Error("Workspace vault verifier changed while its recovery code was being imported");
  }
  assertWorkspaceIdentityDoesNotConflict(currentDescriptor, currentVerifier);

  const records = loadVaultRecords();
  saveVaultRecords(withEncryptedVaultRecord(
    records,
    descriptor.vaultId,
    encrypted,
  ));
  return normalized;
}

function requireWorkspaceVaultVerifier(
  settings: WorkspaceSettings,
  expectedVaultId: string,
): string {
  if (settings.vaultId !== expectedVaultId) {
    throw new Error("Workspace ID changed while its vault key was being verified");
  }
  if (!isCanonicalWorkspaceVaultVerifier(settings.vaultKeyVerifier)) {
    throw new Error("Workspace vault key verifier is missing or invalid");
  }
  return settings.vaultKeyVerifier;
}

function assertWorkspaceVaultKeyMatches(
  vaultId: string,
  vaultKey: string,
  verifier: string,
): void {
  if (!validateWorkspaceVaultVerifier(vaultId, vaultKey, verifier)) {
    throw new Error(
      "The stored vault key does not match this Workspace. Import its recovery code to continue.",
    );
  }
}

function assertWorkspaceIdentityDoesNotConflict(
  descriptor: WorkspaceDescriptor,
  verifier: string,
): void {
  if (
    !activeWorkspace
    || activeWorkspace.vaultId !== descriptor.vaultId
    || activeWorkspace.path === descriptor.path
  ) {
    return;
  }
  const activeSettings = loadWorkspaceSettings(activeWorkspace.path);
  const activeVerifier = requireWorkspaceVaultVerifier(
    activeSettings,
    activeWorkspace.vaultId,
  );
  if (activeVerifier !== verifier) {
    throw new Error(
      "Another folder uses the active Workspace ID with a different vault identity",
    );
  }
}

async function requireVerifiedWorkspaceVaultKey(
  descriptor: WorkspaceDescriptor,
): Promise<string> {
  const settings = loadWorkspaceSettings(descriptor.path);
  const verifier = requireWorkspaceVaultVerifier(settings, descriptor.vaultId);
  assertWorkspaceIdentityDoesNotConflict(descriptor, verifier);
  const vaultKey = await requireVaultKey(descriptor.vaultId);
  assertWorkspaceVaultKeyMatches(descriptor.vaultId, vaultKey, verifier);
  return vaultKey;
}

async function initializeWorkspace(path: string): Promise<WorkspaceDescriptor> {
  inspectWorkspaceForCreate(path);
  const vaultId = randomBytes(16).toString("base64url");
  if (!isWorkspaceVaultId(vaultId)) {
    throw new Error("Generated Workspace ID is invalid");
  }
  const corePort = await chooseAvailableCorePort();
  // The recoverable local key record must exist before the Workspace refers
  // to its ID. A crash may leave an unused record, but never an unrecoverable
  // initialized Workspace.
  let keyRecordCreated = false;
  let workspaceCommitted = false;
  try {
    const recoveryCode = await createVaultKey(vaultId);
    keyRecordCreated = true;
    const vaultKeyVerifier = createWorkspaceVaultVerifier(vaultId, recoveryCode);
    const initializedPath = initializeWorkspaceDirectory(path, {
      finalize(targetPath) {
        saveWorkspaceSettings({ vaultId, vaultKeyVerifier, corePort }, targetPath);
      },
    });
    workspaceCommitted = true;
    return inspectWorkspaceForOpen(initializedPath);
  } catch (error) {
    if (keyRecordCreated && !workspaceCommitted) {
      try {
        deleteVaultKeyRecord(vaultId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Workspace creation failed and its unused vault key could not be removed",
          { cause: error },
        );
      }
    }
    throw error;
  }
}

async function ensureWorkspaceRuntimeSettings(opts?: {
  expectedVaultId?: string;
  rotatePort?: boolean;
}): Promise<void> {
  const targetWorkspace = workspace;
  const settings = loadWorkspaceSettings(targetWorkspace);
  if (!isWorkspaceVaultId(settings.vaultId)) {
    workspaceVault.begin(targetWorkspace);
    throw new Error("Workspace ID is missing or invalid");
  }
  if (opts?.expectedVaultId && settings.vaultId !== opts.expectedVaultId) {
    workspaceVault.begin(targetWorkspace);
    throw new Error("Workspace ID changed while it was being opened");
  }
  const nextVaultId = settings.vaultId;
  const vaultSelection = workspaceVault.begin(targetWorkspace, nextVaultId);

  if (opts?.rotatePort || !settings.corePort || !isSupportedCorePort(settings.corePort)) {
    settings.corePort = await chooseAvailableCorePort(settings.corePort);
  } else if (!(await isPortAvailable(settings.corePort))) {
    corePort = settings.corePort;
    throw new Error(
      `Core port ${settings.corePort} is already in use. Close the other app or explicitly rotate the workspace core port.`,
    );
  }
  if (!settings.vaultId || !settings.corePort) {
    throw new Error("Workspace runtime settings could not be initialized");
  }

  const nextCorePort = settings.corePort;
  const nextVaultKey = await requireVaultKey(nextVaultId);
  const verifier = requireWorkspaceVaultVerifier(settings, nextVaultId);
  assertWorkspaceVaultKeyMatches(nextVaultId, nextVaultKey, verifier);
  if (isQuitting) {
    throw new Error("Runtime startup was cancelled because Lamarck is quitting");
  }
  saveWorkspaceSettings(settings, targetWorkspace);
  if (workspace !== targetWorkspace) {
    throw new Error("Workspace changed while its vault was being unlocked");
  }
  if (!workspaceVault.unlock(vaultSelection, nextVaultKey)) {
    throw new Error("Workspace vault unlock belonged to a stale selection");
  }
  corePort = nextCorePort;
}

async function chooseAvailableCorePort(exclude?: number): Promise<number> {
  for (let port = CORE_PORT_MIN; port <= CORE_PORT_MAX; port++) {
    if (port === exclude) continue;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No free core port found in ${CORE_PORT_MIN}-${CORE_PORT_MAX}`);
}

function isSupportedCorePort(port: number): boolean {
  return port >= CORE_PORT_MIN && port <= CORE_PORT_MAX;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifyCoreRuntimeState(state: CoreRuntimeState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents;
    if (
      shellWebContents.has(contents.id)
      && !contents.isDestroyed()
    ) contents.send("core:runtimeState", state);
  }
  if (state.phase === "ready") flushMarketplaceHandoffs();
}

function markCoreStarting(): number {
  coreStartError = null;
  return coreRuntime.begin();
}

function markCoreReady(generation: number): boolean {
  const published = coreRuntime.ready(generation);
  if (published) coreStartError = null;
  return published;
}

function markCoreFailed(
  error: unknown,
  generation = coreRuntime.snapshot().generation,
): string {
  const message = errorMessage(error);
  if (coreRuntime.fail(generation, message)) coreStartError = message;
  return message;
}

function coreRuntimeState(): CoreRuntimeState {
  return coreRuntime.snapshot();
}

function unprivilegedEnvironment(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const name of PRIVATE_RUNTIME_ENV) delete env[name];
  return env;
}

function enqueueRuntime<T>(operation: () => Promise<T>): Promise<T> {
  const result = runtimeQueue.then(operation, operation);
  runtimeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function extendControlPlaneTeardownBarrier(teardown: Promise<void>): Promise<void> {
  const barrier = Promise.all([controlPlaneTeardownBarrier, teardown]).then(() => {});
  controlPlaneTeardownBarrier = barrier;
  // Observe rejection immediately even if another runtime operation keeps the
  // queue busy. The original rejected barrier remains intact for startRuntime.
  void barrier.catch(() => {});
  return barrier;
}

function latchControlPlaneRestartRequired(error: Error): void {
  extendControlPlaneTeardownBarrier(Promise.reject(error));
}

function beginUnexpectedControlPlaneTeardown(
  reason: string,
  generation: number,
  coreChild: ChildProcess | null,
  guardChild: UtilityProcess | null,
): void {
  const failure = markCoreFailed(reason, generation);
  console.error(`[electron] ${failure}`);

  // Remove every local App authority before any asynchronous process or VM
  // cleanup. Core channels belong to the failed process generation, so loss
  // mode must not depend on reaching that process to revoke them remotely.
  systemBroker.unbindAll();
  detachAllAppWebContents();
  let capsuleStop: Promise<void>;
  try {
    capsuleStop = capsuleManager.stopAll({ controlPlaneLost: true });
  } catch (error) {
    capsuleStop = Promise.reject(error);
  }

  // Guard owns data.db. Once either member of the pair becomes untrustworthy,
  // stop the exact Core generation immediately, then finish Guard teardown.
  // These calls start before the queue reservation so Retry cannot overtake
  // cleanup even when a renderer request was already waiting in the queue.
  if (guardChild) {
    expectedGuardStops.add(guardChild);
    stopGuardHeartbeat(guardChild);
  }
  const processStop = stopControlPlaneProcesses(coreChild, guardChild);
  const teardown = Promise.allSettled([capsuleStop, processStop]).then((results) => {
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Control-plane loss teardown was incomplete");
    }
  });
  const barrier = extendControlPlaneTeardownBarrier(teardown);
  void enqueueRuntime(async () => {
    try {
      await barrier;
    } catch (error) {
      console.error(`[electron] ${errorMessage(error)}`);
    }
  });
}

function beginUnexpectedGuardTeardown(
  child: UtilityProcess,
  generation: number,
  reason: string,
): void {
  if (
    handledGuardLosses.has(child)
    || expectedGuardStops.has(child)
    || isQuitting
    || guard !== child
  ) {
    return;
  }
  handledGuardLosses.add(child);
  guard = null;
  guardOrigin = "";
  beginUnexpectedControlPlaneTeardown(reason, generation, core, child);
}

function beginUnexpectedCoreTeardown(
  child: ChildProcess,
  generation: number,
  reason: string,
): void {
  if (
    handledCoreLosses.has(child)
    || expectedCoreStops.has(child)
    || isQuitting
    || core !== child
  ) {
    return;
  }
  handledCoreLosses.add(child);
  core = null;
  beginUnexpectedControlPlaneTeardown(reason, generation, child, guard);
}

function isGuardReadyMessage(message: unknown): message is GuardReadyMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<GuardReadyMessage>;
  return candidate.type === "ready"
    && Number.isInteger(candidate.port)
    && Number(candidate.port) > 0
    && Number(candidate.port) <= 65_535;
}

function waitForGuardReady(child: UtilityProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, port?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(port!);
    };
    const onMessage = (message: unknown) => {
      if (!isGuardReadyMessage(message)) return;
      finish(undefined, message.port);
    };
    const onExit = (code: number) => {
      finish(new Error(`Guard utility exited before it was ready (code ${code})`));
    };
    const onError = (type: "FatalError", location: string) => {
      finish(new Error(`Guard utility ${type} at ${location}`));
    };
    const timeout = setTimeout(() => {
      finish(new Error("Guard utility did not start in time"));
    }, GUARD_START_TIMEOUT_MS);

    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function waitForGuardExit(child: UtilityProcess, timeoutMs: number): Promise<boolean> {
  if (exitedGuards.has(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function coreExitConfirmed(child: ChildProcess): boolean {
  return exitedCores.has(child)
    || unspawnedCoreFailures.has(child)
    || child.exitCode !== null
    || child.signalCode !== null;
}

function waitForCoreExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (coreExitConfirmed(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => {
      if (child.pid === undefined) {
        unspawnedCoreFailures.add(child);
        finish(true);
      }
    };
    const timeout = setTimeout(() => finish(coreExitConfirmed(child)), timeoutMs);
    child.once("exit", onExit);
    child.on("error", onError);
  });
}

function stopGuardHeartbeat(child?: UtilityProcess): void {
  if (child && guardHeartbeatChild !== child) return;
  if (guardHeartbeatTimer) clearInterval(guardHeartbeatTimer);
  if (guardHeartbeatChild && guardPongListener) {
    guardHeartbeatChild.off("message", guardPongListener);
  }
  guardHeartbeatTimer = null;
  guardHeartbeatChild = null;
  guardPongListener = null;
}

function startGuardHeartbeat(child: UtilityProcess, generation: number): void {
  stopGuardHeartbeat();
  guardHeartbeatChild = child;
  guardLastPongAt = Date.now();
  guardPongListener = (message: unknown) => {
    const candidate = message as Partial<GuardPongMessage> | null;
    if (candidate?.type === "pong" && Number.isSafeInteger(candidate.nonce)) {
      guardLastPongAt = Date.now();
    }
  };
  child.on("message", guardPongListener);

  const ping = () => {
    if (guard !== child || expectedGuardStops.has(child) || isQuitting) {
      stopGuardHeartbeat(child);
      return;
    }
    if (Date.now() - guardLastPongAt > GUARD_HEARTBEAT_TIMEOUT_MS) {
      beginUnexpectedGuardTeardown(
        child,
        generation,
        "Guard utility became unresponsive and was terminated",
      );
      stopGuardHeartbeat(child);
      return;
    }
    try {
      child.postMessage({ type: "ping", nonce: ++guardPingNonce });
    } catch (error) {
      beginUnexpectedGuardTeardown(
        child,
        generation,
        `Guard utility heartbeat failed: ${errorMessage(error)}`,
      );
    }
  };
  ping();
  guardHeartbeatTimer = setInterval(ping, GUARD_HEARTBEAT_INTERVAL_MS);
}

async function startGuard(generation: number): Promise<void> {
  if (guard) throw new Error("Guard utility is already running");

  console.log("[electron] Starting Node Guard utility...");
  const child = utilityProcess.fork(GUARD_ENTRY, [workspace], {
    env: {
      PORT: "0",
      LAMARCK_GUARD_TOKEN: GUARD_TOKEN,
    },
    serviceName: "Lamarck Guard",
    stdio: "inherit",
  });
  guard = child;
  guardOrigin = "";

  child.on("error", (type, location, report) => {
    console.error(`[electron] Guard utility ${type} at ${location}\n${report}`);
    beginUnexpectedGuardTeardown(
      child,
      generation,
      `Guard utility ${type} at ${location}`,
    );
  });
  child.on("exit", (code) => {
    stopGuardHeartbeat(child);
    exitedGuards.add(child);
    const expected = expectedGuardStops.has(child);
    console.log(`[electron] Guard utility exited with code ${code}`);
    if (!expected && !isQuitting) {
      beginUnexpectedGuardTeardown(
        child,
        generation,
        `Guard utility exited unexpectedly (code ${code})`,
      );
    } else if (guard === child) {
      guard = null;
      guardOrigin = "";
    }
  });

  try {
    const port = await waitForGuardReady(child);
    if (guard !== child) throw new Error("Guard utility stopped during startup");
    guardOrigin = `http://127.0.0.1:${port}`;
    startGuardHeartbeat(child, generation);
    console.log(`[electron] Guard utility ready on ${guardOrigin}`);
  } catch (error) {
    if (guard === child) await stopGuard();
    throw error;
  }
}

function startCore(generation: number): void {
  if (!guard || !guardOrigin) {
    throw new Error("Cannot start core before the Guard utility is ready");
  }

  console.log(`[electron] Starting Node Core on port ${corePort}...`);
  const child = spawn(process.execPath, [CORE_ENTRY, workspace], {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(corePort),
      LAMARCK_CORE_TOKEN: CORE_TOKEN,
      LAMARCK_VAULT_KEY: workspaceVault.requireKey(workspace),
      LAMARCK_GUARD_ORIGIN: guardOrigin,
      LAMARCK_GUARD_TOKEN: GUARD_TOKEN,
    },
  });
  core = child;
  child.on("error", (error) => {
    if (child.pid === undefined) unspawnedCoreFailures.add(child);
    beginUnexpectedCoreTeardown(
      child,
      generation,
      `Node Core failed to start: ${error.message}`,
    );
  });
  child.on("exit", (code, signal) => {
    exitedCores.add(child);
    const expected = expectedCoreStops.has(child);
    console.log(`[electron] Node Core exited with code ${code}${signal ? ` (${signal})` : ""}`);
    if (!expected && !isQuitting) {
      beginUnexpectedCoreTeardown(
        child,
        generation,
        `Node Core exited unexpectedly${code === null ? "" : ` (code ${code})`}`,
      );
    } else if (core === child) {
      core = null;
    }
  });
}

async function stopCore(child: ChildProcess | null = core): Promise<void> {
  if (!child) return;
  if (core === child) core = null;
  expectedCoreStops.add(child);
  if (coreExitConfirmed(child)) return;
  const gracefulExit = waitForCoreExit(child, PROCESS_STOP_TIMEOUT_MS);
  try {
    child.kill();
  } catch {}
  if (await gracefulExit) return;

  console.warn("[electron] Node Core did not shut down in time; terminating it");
  try {
    child.kill("SIGKILL");
  } catch {}
  if (await waitForCoreExit(child, 500)) return;
  const failure = new Error(
    "Node Core termination was not confirmed; restart Lamarck before retrying",
  );
  latchControlPlaneRestartRequired(failure);
  throw failure;
}

async function stopGuard(child: UtilityProcess | null = guard): Promise<void> {
  if (!child) return;
  stopGuardHeartbeat(child);
  if (guard === child) {
    guard = null;
    guardOrigin = "";
  }
  expectedGuardStops.add(child);
  if (exitedGuards.has(child)) return;

  const gracefulExit = waitForGuardExit(child, PROCESS_STOP_TIMEOUT_MS);
  try {
    child.postMessage({ type: "shutdown" });
  } catch {
    try {
      child.kill();
    } catch {}
  }
  if (await gracefulExit) return;

  console.warn("[electron] Guard utility did not shut down in time; terminating it");
  try {
    child.kill();
  } catch {}
  if (await waitForGuardExit(child, 500)) return;
  const failure = new Error(
    "Guard utility termination was not confirmed; restart Lamarck before retrying",
  );
  latchControlPlaneRestartRequired(failure);
  throw failure;
}

async function stopControlPlaneProcesses(
  coreChild: ChildProcess | null = core,
  guardChild: UtilityProcess | null = guard,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await stopCore(coreChild);
  } catch (error) {
    failures.push(error);
  }
  // Guard owns data.db. Always attempt to release it after Core teardown,
  // including when Core termination could not be confirmed.
  try {
    await stopGuard(guardChild);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 0) return;
  const failure = failures.length === 1
    ? failures[0]
    : new AggregateError(failures, "Control-plane process teardown was incomplete");
  latchControlPlaneRestartRequired(
    failure instanceof Error ? failure : new Error(errorMessage(failure)),
  );
  throw failure;
}

async function startRuntime(opts?: {
  expectedVaultId?: string;
  rotatePort?: boolean;
}): Promise<number> {
  // A Retry may already be queued when process loss is observed. Join the
  // exact old-generation teardown here so no new Core or Guard can overlap it.
  await controlPlaneTeardownBarrier;
  const generation = markCoreStarting();
  try {
    await ensureWorkspaceRuntimeSettings(opts);
    if (isQuitting) throw new Error("Runtime startup was cancelled because Lamarck is quitting");
    await startGuard(generation);
    if (isQuitting) throw new Error("Runtime startup was cancelled because Lamarck is quitting");
    startCore(generation);
    return generation;
  } catch (error) {
    markCoreFailed(error, generation);
    try {
      await stopControlPlaneProcesses();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Runtime startup failed and control-plane cleanup was incomplete",
      );
    }
    throw error;
  }
}

async function stopRuntime(): Promise<void> {
  // Revoke every App launch channel while Core is still alive, then tear down
  // the VM/backend before releasing Core and Guard authority.
  let capsuleFailure: unknown;
  try {
    await stopAllAppViewers();
  } catch (error) {
    capsuleFailure = error;
    console.error(`[electron] App Capsule shutdown failed: ${errorMessage(error)}`);
  }
  // Core can still issue Guard requests, so always stop it before releasing
  // data.db ownership from the Guard utility.
  let processFailure: unknown;
  try {
    await stopControlPlaneProcesses();
  } catch (error) {
    processFailure = error;
    console.error(`[electron] Control-plane shutdown failed: ${errorMessage(error)}`);
  }
  // A workspace switch or runtime retry must not start another authority
  // generation after Capsule teardown became ambiguous. Process exit may
  // continue, but in-process reuse is fail-closed.
  const failures = [capsuleFailure, processFailure].filter(
    (failure) => failure !== undefined,
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Runtime shutdown was incomplete");
  }
}

async function activateWorkspace(
  candidate: WorkspaceDescriptor,
): Promise<WorkspaceDescriptor> {
  if (
    activeWorkspace?.path === candidate.path
    && activeWorkspace.vaultId === candidate.vaultId
    && coreRuntime.snapshot().phase === "ready"
  ) {
    return { ...activeWorkspace };
  }

  // Keychain and candidate validation happen while the current Workspace is
  // still fully available. Expected recovery is therefore not a destructive
  // switch attempt.
  await requireVerifiedWorkspaceVaultKey(candidate);
  const previous = activeWorkspace ? { ...activeWorkspace } : null;
  let oldRuntimeStopped = false;
  let candidateSelected = false;

  try {
    await stopRuntime();
    oldRuntimeStopped = true;

    // Re-read after releasing the old authority to close the inspection/start
    // race. A replaced folder can never inherit the candidate's unlocked key.
    const currentCandidate = inspectWorkspaceForOpen(candidate.path);
    if (currentCandidate.vaultId !== candidate.vaultId) {
      throw new Error("Workspace ID changed while it was being opened");
    }
    workspace = currentCandidate.path;
    workspaceVault.begin(workspace, currentCandidate.vaultId);
    candidateSelected = true;
    const generation = await startRuntime({ expectedVaultId: currentCandidate.vaultId });
    await waitForCore(generation);

    // Persistence is the commit point. The old active descriptor remains
    // authoritative until the candidate runtime is proven ready.
    saveActiveWorkspace(currentCandidate);
    activeWorkspace = { ...currentCandidate };
    workspaceSelectionNeedsPersistence = false;
    rememberedWorkspace = {
      lastKnownPath: currentCandidate.path,
      vaultId: currentCandidate.vaultId,
    };
    workspaceSetupReason = "first-run";
    workspaceSetupDetail = null;
    disposeAllTerminals();
    return { ...currentCandidate };
  } catch (error) {
    if (!oldRuntimeStopped) {
      markCoreFailed(error);
      throw error;
    }

    const failures: unknown[] = [error];
    if (candidateSelected) {
      try {
        await stopRuntime();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }

    // The persisted/active descriptor is still the previous Workspace until
    // the candidate commits. Restore the in-process selection even when
    // candidate teardown was incomplete and restarting is therefore unsafe.
    if (previous) {
      workspace = previous.path;
      workspaceVault.begin(previous.path, previous.vaultId);
    } else {
      workspace = "";
      corePort = 0;
      workspaceVault.begin("");
    }

    if (failures.length === 1 && previous) {
      try {
        const generation = await startRuntime({ expectedVaultId: previous.vaultId });
        await waitForCore(generation);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    } else if (!previous) {
      markCoreFailed(error);
    }

    if (failures.length > 1) {
      const failure = new AggregateError(
        failures,
        previous
          ? "Workspace switch failed and the previous Workspace could not be restored"
          : "Workspace startup failed and cleanup was incomplete",
      );
      markCoreFailed(failure);
      throw failure;
    }
    throw error;
  }
}

async function createWorkspace(
  path: string,
): Promise<WorkspaceDescriptor> {
  const candidate = await initializeWorkspace(path);
  return activateWorkspace(candidate);
}

async function openWorkspace(
  path: string,
  recoveryCode?: string,
): Promise<WorkspaceOpenResult> {
  const candidate = inspectWorkspaceForOpen(path);
  let key: string | null;
  if (recoveryCode?.trim()) {
    key = await importVaultKey(candidate, recoveryCode);
  } else {
    const settings = loadWorkspaceSettings(candidate.path);
    const verifier = requireWorkspaceVaultVerifier(settings, candidate.vaultId);
    assertWorkspaceIdentityDoesNotConflict(candidate, verifier);
    key = await loadVaultKey(candidate.vaultId);
    if (
      key
      && !validateWorkspaceVaultVerifier(candidate.vaultId, key, verifier)
    ) {
      key = null;
    }
  }
  if (!key) {
    return {
      status: "recovery-required",
      workspace: candidate,
    };
  }
  return {
    status: "ready",
    workspace: await activateWorkspace(candidate),
  };
}

function createTerminal(sender: WebContents): Promise<{ id: string }> {
  const id = `terminal-${nextTerminalId++}`;
  const proc = spawn(process.execPath, [PTY_HELPER, workspace], {
    stdio: ["pipe", "pipe", "pipe"],
    env: unprivilegedEnvironment({
      ELECTRON_RUN_AS_NODE: "1",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
    }),
  });

  terminalSessions.set(id, { proc, ownerWebContentsId: sender.id });

  let terminalCreated = false;
  let terminalFinished = false;
  let resolveCreate: (value: { id: string }) => void;
  let rejectCreate: (reason: Error) => void;
  const created = new Promise<{ id: string }>((resolve, reject) => {
    resolveCreate = resolve;
    rejectCreate = reject;
  });

  const finishTerminal = (code: number | null, error?: Error) => {
    if (terminalFinished) return;
    terminalFinished = true;
    terminalSessions.delete(id);

    if (!terminalCreated) {
      rejectCreate(error ?? new Error(`Terminal exited before it started (code ${code ?? "unknown"})`));
      return;
    }

    if (sender.isDestroyed()) return;
    try {
      if (error) {
        sender.send("terminal:data", {
          id,
          data: `\r\n\x1b[31m~ Terminal failed: ${error.message} ~\x1b[0m\r\n`,
        });
      }
      sender.send("terminal:exit", { id, code });
    } catch {}
  };

  proc.stdout?.on("data", (data) => {
    if (!sender.isDestroyed()) sender.send("terminal:data", { id, data: data.toString("utf8") });
  });
  proc.stderr?.on("data", (data) => {
    if (!sender.isDestroyed()) sender.send("terminal:data", { id, data: data.toString("utf8") });
  });
  proc.stdin?.on("error", () => {});
  proc.once("spawn", () => {
    terminalCreated = true;
    resolveCreate({ id });
  });
  proc.once("error", (error) => finishTerminal(null, error));
  proc.once("exit", (code) => finishTerminal(code));

  return created;
}

function getTerminalForSender(id: string, sender: WebContents) {
  const session = terminalSessions.get(id);
  if (!session || session.ownerWebContentsId !== sender.id) return null;
  return session;
}

function disposeTerminal(id: string): void {
  const session = terminalSessions.get(id);
  if (!session) return;
  terminalSessions.delete(id);
  try { session.proc.kill(); } catch {}
}

function disposeTerminalsForWebContents(webContentsId: number): void {
  for (const [id, session] of terminalSessions) {
    if (session.ownerWebContentsId === webContentsId) {
      disposeTerminal(id);
    }
  }
}

function disposeAllTerminals(): void {
  for (const id of terminalSessions.keys()) {
    disposeTerminal(id);
  }
}

function requireShellWindow(sender: WebContents, frameUrl = sender.getURL()): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(sender);
  const state = shellWebContents.get(sender.id);
  if (
    !owner
    || !state
    || !state.allowsUrl(sender.getURL())
    || !state.allowsUrl(frameUrl)
  ) {
    throw new Error("Host Shell WebContents required");
  }
  return owner;
}

function isOpenLauncherShortcut(input: Input): boolean {
  return input.type === "keyDown"
    && input.key.toLowerCase() === "k"
    && (input.meta || input.control)
    && !input.alt;
}

function requireShellIpc(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow {
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Host Shell main frame required");
  }
  return requireShellWindow(event.sender, event.senderFrame.url);
}

function requireShellRendererOwner(
  event: IpcMainEvent | IpcMainInvokeEvent,
): AppViewerOwner {
  requireShellIpc(event);
  const owner = shellWebContents.get(event.sender.id)?.currentOwner;
  if (!owner) throw new Error("Host Shell renderer owner is unavailable");
  return owner;
}

function assertShellRendererOwnerCurrent(
  sender: WebContents,
  owner: AppViewerOwner,
): void {
  const state = shellWebContents.get(owner.webContentsId);
  if (
    sender.id !== owner.webContentsId
    || sender.isDestroyed()
    || !state
    || !sameAppViewerOwner(state.currentOwner, owner)
  ) {
    throw new Error("Shell renderer was replaced during App viewer launch");
  }
}

async function awaitShellRendererRetirement(
  sender: WebContents,
  owner: AppViewerOwner,
): Promise<void> {
  const state = shellWebContents.get(owner.webContentsId);
  if (!state) throw new Error("Host Shell renderer owner is unavailable");
  const retirement = state.retirement;
  await retirement;
  assertShellRendererOwnerCurrent(sender, owner);
}

function sameAppViewerOwner(left: AppViewerOwner, right: AppViewerOwner): boolean {
  return left.webContentsId === right.webContentsId
    && left.rendererGeneration === right.rendererGeneration;
}

function appPartition(appId: string, browserChannelId: string): string {
  return appViewerPartition(currentWorkspaceVaultId(), appId, browserChannelId);
}

function appOriginHost(appId: string, browserChannelId: string): string {
  return appViewerOriginHost(currentWorkspaceVaultId(), appId, browserChannelId);
}

function currentWorkspaceVaultId(): string {
  const selection = workspaceVault.current(workspace);
  if (!selection?.vaultId) throw new Error("Workspace ID is unavailable");
  return selection.vaultId;
}

async function configureAppWebContents(
  view: WebContentsView,
  viewerUrl: URL,
  proxyUrl: string,
  protocolPartition: string,
  viewerId: string,
): Promise<void> {
  const contents = view.webContents;
  const viewerSession = contents.session;
  let state = appViewerSessions.get(protocolPartition);
  if (!state) {
    state = { binding: null };
    appViewerSessions.set(protocolPartition, state);
    const boundState = state;
    viewerSession.setPermissionCheckHandler(() => false);
    viewerSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    viewerSession.webRequest.onBeforeRequest((details, callback) => {
      const current = boundState.binding;
      const allowed = current && (
        details.resourceType === "mainFrame"
          ? isAllowedAppViewerNavigationUrl(details.url, current)
          : isAllowedAppViewerUrl(details.url, current)
      );
      callback({ cancel: !allowed });
    });
    viewerSession.on("will-download", (event) => event.preventDefault());
  }

  // Route every HTTP/WebSocket path through this viewer's Host-owned proxy.
  // `<-loopback>` removes Chromium's implicit localhost bypass, so App code
  // cannot address arbitrary Host listeners directly.
  await viewerSession.setProxy({
    proxyRules: proxyUrl,
    proxyBypassRules: "<-loopback>",
  });
  await viewerSession.closeAllConnections();
  await viewerSession.clearHostResolverCache();

  state.binding = {
    viewerId,
    protocol: viewerUrl.protocol,
    host: viewerUrl.host,
  };

  if (!configuredAppWebContents.has(contents)) {
    configuredAppWebContents.add(contents);
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!state?.binding || !isAllowedAppViewerNavigationUrl(url, state.binding)) {
        event.preventDefault();
      }
    });
    contents.on("will-redirect", (event, url) => {
      if (!state?.binding || !isAllowedAppViewerNavigationUrl(url, state.binding)) {
        event.preventDefault();
      }
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  }
}

function clearAppViewerBinding(protocolPartition: string, viewerId: string): void {
  const state = appViewerSessions.get(protocolPartition);
  if (!state || (state.binding && state.binding.viewerId !== viewerId)) return;
  state.binding = null;
  appViewerSessions.delete(protocolPartition);
}

function bindAppViewerCleanup(
  view: WebContentsView,
  viewerId: string,
  owner: AppViewerOwner,
): void {
  const contents = view.webContents;
  const cleanup = () => {
    if (expectedAppViewerCloses.has(contents)) return;
    void closeAppViewer(viewerId, owner).catch((error) => {
      console.error(`[electron] App viewer cleanup failed: ${errorMessage(error)}`);
    });
  };
  contents.once("render-process-gone", cleanup);
  contents.once("destroyed", cleanup);
}

async function loadAppViewerDocument(
  view: WebContentsView,
  viewerUrl: string,
  authoritySignal?: AbortSignal,
  onUnexpectedMainResponse?: (response: {
    statusCode: number;
    statusLine: string;
  }) => void,
): Promise<() => void> {
  const contents = view.webContents;
  const viewerSession = contents.session;
  const expectedOrigin = new URL(viewerUrl).origin;
  let resolveMainResponse!: (
    value: { statusCode: number; statusLine: string },
  ) => void;
  const mainResponse = new Promise<{ statusCode: number; statusLine: string }>((resolve) => {
    resolveMainResponse = resolve;
  });
  let capturedInitialResponse = false;
  const responseListener = (details: Electron.OnCompletedListenerDetails) => {
    if (details.webContentsId !== contents.id || details.resourceType !== "mainFrame") return;
    try {
      if (new URL(details.url).origin !== expectedOrigin) return;
    } catch {
      return;
    }
    const response = {
      statusCode: details.statusCode,
      statusLine: details.statusLine,
    };
    if (!capturedInitialResponse) {
      capturedInitialResponse = true;
      resolveMainResponse(response);
      return;
    }
    if (response.statusCode < 200 || response.statusCode > 299) {
      onUnexpectedMainResponse?.(response);
    }
  };
  viewerSession.webRequest.onCompleted(responseListener);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      if (!contents.isDestroyed()) contents.stop();
      reject(new Error("App viewer document did not finish within 8000ms"));
    }, 8_000);
  });
  let abortListener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    if (!authoritySignal) return;
    abortListener = () => {
      if (!contents.isDestroyed()) contents.stop();
      reject(
        authoritySignal.reason instanceof Error
          ? authoritySignal.reason
          : new Error("App viewer document load was cancelled"),
      );
    };
    if (authoritySignal.aborted) abortListener();
    else authoritySignal.addEventListener("abort", abortListener, { once: true });
  });
  let finalMainResponse: { statusCode: number; statusLine: string } | null = null;
  let keepResponseMonitor = false;
  try {
    await Promise.race([
      Promise.all([
        contents.loadURL(viewerUrl),
        mainResponse,
      ]).then(([, response]) => {
        finalMainResponse = response;
      }),
      deadline,
      cancelled,
    ]);
    if (!finalMainResponse) {
      throw new Error("App viewer document completed without an HTTP response");
    }
    const { statusCode, statusLine } = finalMainResponse;
    if (statusCode < 200 || statusCode > 299) {
      throw new Error(
        `App viewer document failed before publication: ${statusLine || `HTTP ${statusCode}`}`,
      );
    }
    keepResponseMonitor = true;
    return () => viewerSession.webRequest.onCompleted(null);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (authoritySignal && abortListener) {
      authoritySignal.removeEventListener("abort", abortListener);
    }
    if (!keepResponseMonitor) viewerSession.webRequest.onCompleted(null);
  }
}

interface PreparedAppViewerSurface extends AppViewerReplacement {
  viewerId: string;
  assertHealthy(): void;
  stopHealthMonitoring(): void;
}

interface PrepareAppViewerSurfaceOptions {
  appId: string;
  binding: PreparedViewerBinding;
  shellContents: WebContents;
  assertHostCurrent(): void;
  onCreated?(surface: PreparedAppViewerSurface): void;
}

async function prepareAppViewerSurface(
  options: PrepareAppViewerSurfaceOptions,
): Promise<PreparedAppViewerSurface> {
  const { appId, binding, shellContents } = options;
  const protocolPartition = appPartition(appId, binding.channelId);
  let gateway: ViewerGatewayBinding | null = null;
  let view: WebContentsView | null = null;
  let viewerSession: Session | null = null;
  let rendererFailure: Error | null = null;
  let healthMonitoring = false;
  let authorityAbortMonitoring = false;
  let preparedAuthoritySenderId: number | null = null;
  let mainFrameNavigationStarted = false;
  let stopResponseMonitor: (() => void) | null = null;
  const onAuthorityAborted = () => {
    if (!view) return;
    // A prepared first-launch renderer is not registered in appViewers yet.
    // Revoke its browser authority in the same abort call stack as Manager
    // stopAll/boundary loss instead of waiting for async verification cleanup.
    systemBroker.unbindSender(view.webContents.id);
  };
  const stopAuthorityAbortMonitoring = () => {
    if (authorityAbortMonitoring) {
      authorityAbortMonitoring = false;
      binding.signal.removeEventListener("abort", onAuthorityAborted);
    }
    if (preparedAuthoritySenderId !== null) {
      preparedAppViewerSenderIds.delete(preparedAuthoritySenderId);
      preparedAuthoritySenderId = null;
    }
  };
  const markUnhealthy = (error: Error) => {
    if (!healthMonitoring || rendererFailure) return;
    rendererFailure = error;
    binding.invalidate(error);
  };
  const onRenderProcessGone = (
    _event: Electron.Event,
    details: Electron.RenderProcessGoneDetails,
  ) => {
    markUnhealthy(
      new Error(`Prepared App viewer renderer exited before publication: ${details.reason}`),
    );
  };
  const onDestroyed = () => {
    markUnhealthy(new Error("Prepared App viewer renderer was destroyed before publication"));
  };
  const onDidFailLoad = (
    _event: Electron.Event,
    errorCode: number,
    errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame) return;
    markUnhealthy(
      new Error(
        `Prepared App viewer navigation failed before publication `
        + `(${errorCode}): ${errorDescription}`,
      ),
    );
  };
  const onDidStartNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    if (!mainFrameNavigationStarted) {
      mainFrameNavigationStarted = true;
      return;
    }
    markUnhealthy(
      new Error(
        `Prepared App viewer started another navigation before publication: ${details.url}`,
      ),
    );
  };
  const assertHealthy = () => {
    if (rendererFailure) throw rendererFailure;
    if (!view || view.webContents.isDestroyed()) {
      throw new Error("Prepared App viewer renderer is no longer available");
    }
  };
  const stopHealthMonitoring = () => {
    stopAuthorityAbortMonitoring();
    if (!healthMonitoring) return;
    healthMonitoring = false;
    stopResponseMonitor?.();
    stopResponseMonitor = null;
    if (!view) return;
    view.webContents.removeListener("render-process-gone", onRenderProcessGone);
    view.webContents.removeListener("destroyed", onDestroyed);
    view.webContents.removeListener("did-fail-load", onDidFailLoad);
    view.webContents.removeListener("did-start-navigation", onDidStartNavigation);
  };
  try {
    binding.assertCurrent();
    options.assertHostCurrent();
    gateway = await createViewerGateway({
      instanceId: binding.instanceId,
      originHost: appOriginHost(appId, binding.channelId),
      transport: {
        openUiStream: (instanceId) => {
          if (instanceId !== binding.instanceId) {
            throw new Error("App viewer gateway candidate identity changed");
          }
          return binding.openUiStream();
        },
      },
    });
    const viewerUrl = new URL(gateway.viewerUrl);
    if (viewerUrl.protocol !== "http:" || !viewerUrl.hostname.endsWith(".localhost")) {
      throw new Error("Capsule viewer gateway did not establish a bound origin");
    }
    binding.assertCurrent();
    options.assertHostCurrent();

    view = new WebContentsView({
      webPreferences: {
        preload: APP_PRELOAD,
        partition: protocolPartition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        disableBlinkFeatures: "WebRTC",
      },
    });
    healthMonitoring = true;
    view.webContents.on("render-process-gone", onRenderProcessGone);
    view.webContents.on("destroyed", onDestroyed);
    view.webContents.on("did-fail-load", onDidFailLoad);
    view.webContents.on("did-start-navigation", onDidStartNavigation);
    view.webContents.on("before-input-event", (event, input) => {
      if (!isOpenLauncherShortcut(input)) return;
      event.preventDefault();
      if (shellContents.isDestroyed()) return;
      shellContents.focus();
      shellContents.send("shell:open-launcher");
    });
    viewerSession = view.webContents.session;
    const surface: PreparedAppViewerSurface = {
      view,
      gateway,
      viewerSession,
      protocolPartition,
      viewerId: binding.viewerId,
      assertHealthy,
      stopHealthMonitoring,
    };
    options.onCreated?.(surface);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    view.setVisible(false);

    await clearDisposableAppViewerStorage(viewerSession);
    binding.assertCurrent();
    options.assertHostCurrent();
    await configureAppWebContents(
      view,
      viewerUrl,
      gateway.proxyUrl,
      protocolPartition,
      binding.viewerId,
    );
    binding.assertCurrent();
    options.assertHostCurrent();
    await waitForViewerHttpReady({
      request: (signal) => viewerSession!.fetch(gateway!.viewerUrl, {
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.any([signal, binding.signal]),
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
      assertCurrent: () => {
        binding.assertCurrent();
        options.assertHostCurrent();
      },
    });
    binding.assertCurrent();
    options.assertHostCurrent();
    binding.signal.addEventListener("abort", onAuthorityAborted, { once: true });
    authorityAbortMonitoring = true;
    preparedAuthoritySenderId = view.webContents.id;
    preparedAppViewerSenderIds.add(preparedAuthoritySenderId);
    systemBroker.bindSender(view.webContents.id, binding);
    binding.assertCurrent();
    options.assertHostCurrent();
    stopResponseMonitor = await loadAppViewerDocument(
      view,
      gateway.viewerUrl,
      binding.signal,
      ({ statusCode, statusLine }) => {
        markUnhealthy(
          new Error(
            `Prepared App viewer navigation became unhealthy before publication: `
            + `${statusLine || `HTTP ${statusCode}`}`,
          ),
        );
      },
    );
    assertHealthy();
    binding.assertCurrent();
    options.assertHostCurrent();
    return surface;
  } catch (error) {
    stopHealthMonitoring();
    if (view) {
      systemBroker.unbindSender(view.webContents.id);
      expectedAppViewerCloses.add(view.webContents);
      if (!view.webContents.isDestroyed()) {
        view.webContents.close({ waitForBeforeUnload: false });
      }
    }
    clearAppViewerBinding(protocolPartition, binding.viewerId);
    const cleanup = await Promise.allSettled([
      gateway?.close() ?? Promise.resolve(),
      viewerSession
        ? clearDisposableAppViewerStorage(viewerSession)
        : Promise.resolve(),
    ]);
    const cleanupFailures = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Prepared App viewer and its Host resources both failed",
      );
    }
    throw error;
  }
}

async function disposePreparedAppViewerSurface(
  surface: PreparedAppViewerSurface,
  owner?: BrowserWindow,
): Promise<void> {
  surface.stopHealthMonitoring();
  systemBroker.unbindSender(surface.view.webContents.id);
  clearAppViewerBinding(surface.protocolPartition, surface.viewerId);
  expectedAppViewerCloses.add(surface.view.webContents);
  if (owner) {
    try { owner.contentView.removeChildView(surface.view); } catch {}
  }
  if (!surface.view.webContents.isDestroyed()) {
    surface.view.webContents.close({ waitForBeforeUnload: false });
  }
  const results = await Promise.allSettled([
    surface.gateway.close(),
    clearDisposableAppViewerStorage(surface.viewerSession),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "App viewer surface cleanup failed");
  }
}

async function openAppViewer(
  sender: WebContents,
  ownerLease: AppViewerOwner,
  appId: string,
): Promise<{ viewerId: string }> {
  const owner = requireShellWindow(sender);
  assertShellRendererOwnerCurrent(sender, ownerLease);
  let opened: Awaited<ReturnType<CapsuleManager["openViewer"]>> | null = null;
  let preparedSurface: PreparedAppViewerSurface | null = null;
  try {
    opened = await capsuleManager.openViewer(appId, ownerLease, async (binding) => {
      preparedSurface = await prepareAppViewerSurface({
        appId,
        binding,
        shellContents: sender,
        assertHostCurrent: () => {
          if (owner.isDestroyed() || sender.isDestroyed()) {
            throw new Error("App viewer owner was destroyed during launch");
          }
          assertShellRendererOwnerCurrent(sender, ownerLease);
        },
      });
    });
    assertShellRendererOwnerCurrent(sender, ownerLease);
    const surface = preparedSurface as PreparedAppViewerSurface | null;
    if (!surface) throw new Error("App viewer committed without a prepared renderer");
    assertViewerAuthorityCurrent(
      opened,
      capsuleManager.getViewer(opened.viewerId, ownerLease),
    );
    surface.assertHealthy();
    assertShellRendererOwnerCurrent(sender, ownerLease);
    const record: AppViewerRecord = {
      appId,
      ownerLease,
      owner,
      view: surface.view,
      appWebContentsId: surface.view.webContents.id,
      viewerSession: surface.viewerSession,
      protocolPartition: surface.protocolPartition,
      gateway: surface.gateway,
      pendingReplacement: null,
    };
    appViewers.set(opened.viewerId, record);
    bindAppViewerCleanup(surface.view, opened.viewerId, ownerLease);
    if (appViewers.get(opened.viewerId) !== record) {
      throw new Error("App viewer was detached while its renderer was loading");
    }
    surface.assertHealthy();
    surface.stopHealthMonitoring();
    surface.assertHealthy();
    assertShellRendererOwnerCurrent(sender, ownerLease);
    owner.contentView.addChildView(surface.view);
    return { viewerId: opened.viewerId };
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    const surface = preparedSurface as PreparedAppViewerSurface | null;
    if (surface) {
      try {
        await disposePreparedAppViewerSurface(surface, owner);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      preparedSurface = null;
    }
    if (opened) {
      appViewers.delete(opened.viewerId);
      try {
        await capsuleManager.closeViewer(opened.viewerId, ownerLease);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        `${errorMessage(error)}; App viewer launch cleanup also failed`,
      );
    }
    throw error;
  }
}

async function prepareReloadedAppViewer(
  record: AppViewerRecord,
  binding: PreparedViewerBinding,
  lifecycleGeneration: number,
): Promise<PreparedAppViewerSurface> {
  let created: PreparedAppViewerSurface | null = null;
  try {
    const surface = await prepareAppViewerSurface({
      appId: record.appId,
      binding,
      shellContents: record.owner.webContents,
      onCreated: (replacement) => {
        created = replacement;
        record.pendingReplacement = replacement;
      },
      assertHostCurrent: () => {
        appViewerLifecycle.assertCurrent(record.appId, lifecycleGeneration);
        if (appViewers.get(binding.viewerId) !== record) {
          throw new Error("App viewer was detached during reload");
        }
        if (created && record.pendingReplacement !== created) {
          throw new Error("App viewer replacement was superseded");
        }
        if (record.owner.isDestroyed()) {
          throw new Error("App viewer owner was destroyed during reload");
        }
      },
    });
    return surface;
  } catch (error) {
    if (created && record.pendingReplacement === created) {
      record.pendingReplacement = null;
    }
    throw error;
  }
}

function commitReloadedAppViewer(
  record: AppViewerRecord,
  binding: ReloadedBrowserBinding,
  lifecycleGeneration: number,
  replacement: PreparedAppViewerSurface,
): { cleanup: Promise<void> } {
  if (record.pendingReplacement !== replacement) {
    throw new Error("App viewer replacement was superseded before commit");
  }
  assertCurrentAppViewer(record, binding.viewerId, lifecycleGeneration, replacement, binding);
  const previousGateway = record.gateway;
  const previousView = record.view;
  const previousSession = record.viewerSession;
  const previousProtocolPartition = record.protocolPartition;
  const previousBounds = previousView.getBounds();
  const previousVisible = previousView.getVisible();
  replacement.assertHealthy();
  replacement.view.setBounds(previousBounds);
  bindAppViewerCleanup(replacement.view, binding.viewerId, record.ownerLease);
  replacement.assertHealthy();
  replacement.stopHealthMonitoring();
  replacement.assertHealthy();
  record.owner.contentView.addChildView(replacement.view);
  replacement.view.setVisible(previousVisible);

  record.view = replacement.view;
  record.appWebContentsId = replacement.view.webContents.id;
  record.viewerSession = replacement.viewerSession;
  record.protocolPartition = replacement.protocolPartition;
  record.gateway = replacement.gateway;
  record.pendingReplacement = null;
  // A committed renderer receives a fresh lifecycle generation. Any stale
  // async continuation from the previous generation must now fail CAS.
  const committedGeneration = appViewerLifecycle.invalidate(record.appId);

  // The candidate document is already fully loaded. Retire the old renderer
  // only after the new one is attached, so transient startup responses and
  // failed candidate loads never blank the last-known-good UI.
  systemBroker.unbindSender(previousView.webContents.id);
  expectedAppViewerCloses.add(previousView.webContents);
  try { record.owner.contentView.removeChildView(previousView); } catch {}
  if (!previousView.webContents.isDestroyed()) {
    previousView.webContents.close({ waitForBeforeUnload: false });
  }
  clearAppViewerBinding(previousProtocolPartition, binding.viewerId);
  assertCurrentAppViewer(record, binding.viewerId, committedGeneration, undefined, binding);
  const cleanup = Promise.allSettled([
    Promise.resolve().then(() => previousGateway.close()),
    Promise.resolve().then(() => clearDisposableAppViewerStorage(previousSession)),
  ]).then((results) => {
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      console.error("[electron] Previous App viewer cleanup failed", ...failures);
    }
  });
  return { cleanup };
}

function reloadAppRuntime(appId: string): Promise<{ active: boolean }> {
  return appViewerLifecycle.reload(appId, async () => {
    const initialEntry = [...appViewers.entries()].find(([, record]) => record.appId === appId);
    const initialViewerId = initialEntry?.[0];
    const initialRecord = initialEntry?.[1];
    const lifecycleGeneration = appViewerLifecycle.generation(appId);
    let preparedSurface: PreparedAppViewerSurface | null = null;
    let backendCommitted = false;
    try {
      const result = await capsuleManager.reloadApp(
        appId,
        async (binding) => {
          const record = appViewers.get(binding.viewerId);
          if (!record || record !== initialRecord) {
            throw new Error("Reloaded App viewer is no longer attached");
          }
          preparedSurface = await prepareReloadedAppViewer(
            record,
            binding,
            lifecycleGeneration,
          );
        },
        (binding) => {
          backendCommitted = true;
          const record = appViewers.get(binding.viewerId);
          const surface = preparedSurface as PreparedAppViewerSurface | null;
          if (!record || record !== initialRecord || !surface) {
            throw new Error("Reloaded App viewer was not prepared for renderer commit");
          }
          const publication = commitReloadedAppViewer(
            record,
            binding,
            lifecycleGeneration,
            surface,
          );
          preparedSurface = null;
          return publication;
        },
      );
      if (!backendCommitted) return { active: result.active };
      return { active: result.active };
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      const surface = preparedSurface as PreparedAppViewerSurface | null;
      if (surface && initialRecord) {
        if (initialRecord.pendingReplacement === surface) {
          initialRecord.pendingReplacement = null;
        }
        try {
          await disposePreparedAppViewerSurface(surface, initialRecord.owner);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        preparedSurface = null;
      }
      // Before Manager commit, verifier or Candidate failure leaves the
      // previous Runtime, authority, activation, and renderer untouched.
      if (!backendCommitted) {
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            [error, ...cleanupFailures],
            `${errorMessage(error)}; prepared renderer cleanup also failed`,
          );
        }
        throw error;
      }

      // A failure in the final no-I/O Electron attachment happens after the
      // backend commit. Remove all authority rather than expose mismatched
      // Runtime and renderer generations.
      const cleanup = initialRecord && initialViewerId
        ? detachAppViewerRecord(initialViewerId, initialRecord)
        : [];
      if (initialRecord && initialViewerId) {
        cleanup.push(capsuleManager.closeViewer(
          initialViewerId,
          initialRecord.ownerLease,
        ));
      } else {
        // A trusted Shell caller can race reload against the final Host-side
        // attachment step of openViewer. With no owner binding to close, stop
        // the entire App identity rather than leave a manager-only generation.
        cleanup.push(capsuleManager.stopApp(appId));
      }
      const cleanupResults = await Promise.allSettled(cleanup);
      cleanupFailures.push(...cleanupResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason));
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `${errorMessage(error)}; committed renderer cleanup also failed`,
        );
      }
      throw error;
    }
  });
}

function assertCurrentAppViewer(
  record: AppViewerRecord,
  viewerId: string,
  lifecycleGeneration: number,
  replacement?: AppViewerReplacement,
  binding?: ReloadedBrowserBinding,
): void {
  appViewerLifecycle.assertCurrent(record.appId, lifecycleGeneration);
  if (appViewers.get(viewerId) !== record) {
    throw new Error("App viewer was detached during reload");
  }
  if (replacement && record.pendingReplacement !== replacement) {
    throw new Error("App viewer replacement was superseded");
  }
  if (binding) {
    const current = capsuleManager.getViewer(binding.viewerId, record.ownerLease);
    if (
      !current
      || current.appId !== record.appId
      || current.viewerId !== binding.viewerId
      || current.instanceId !== binding.instanceId
      || current.channelId !== binding.channelId
      || current.capability !== binding.capability
    ) {
      throw new Error("Reloaded App viewer authority changed during renderer cutover");
    }
  }
  if (record.owner.isDestroyed()) throw new Error("App viewer owner was destroyed during reload");
  assertShellRendererOwnerCurrent(record.owner.webContents, record.ownerLease);
}

async function closeAppViewer(viewerId: string, owner: AppViewerOwner): Promise<boolean> {
  const record = appViewers.get(viewerId);
  if (!record || !sameAppViewerOwner(record.ownerLease, owner)) return false;
  // Invalidate and detach synchronously. Manager close starts immediately so a
  // long build is aborted, while final settlement remains ordered after an
  // already-running reload lifecycle.
  const cleanup = detachAppViewerRecord(viewerId, record);
  const managerClose = capsuleManager.closeViewer(viewerId, owner);
  return appViewerLifecycle.runExclusive(record.appId, async () => {
    const results = await Promise.allSettled([...cleanup, managerClose]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    return true;
  });
}

function detachAppViewerRecord(
  viewerId: string,
  record: AppViewerRecord,
): Promise<unknown>[] {
  if (appViewers.get(viewerId) !== record) return [];
  appViewers.delete(viewerId);
  appViewerLifecycle.invalidate(record.appId);

  const cleanup: Promise<unknown>[] = [];
  const sessions = new Set<Session>();
  const captureCleanup = (operation: () => unknown | Promise<unknown>) => {
    try {
      cleanup.push(Promise.resolve(operation()));
    } catch (error) {
      cleanup.push(Promise.reject(error));
    }
  };
  const detachView = (
    view: WebContentsView,
    viewerSession: Session,
    protocolPartition: string,
  ) => {
    const contents = view.webContents;
    sessions.add(viewerSession);
    clearAppViewerBinding(protocolPartition, viewerId);
    expectedAppViewerCloses.add(contents);
    captureCleanup(() => systemBroker.unbindSender(contents.id));
    captureCleanup(() => record.owner.contentView.removeChildView(view));
    captureCleanup(() => {
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    });
  };

  detachView(record.view, record.viewerSession, record.protocolPartition);
  captureCleanup(() => record.gateway.close());
  const pending = record.pendingReplacement;
  record.pendingReplacement = null;
  if (pending) {
    pending.stopHealthMonitoring?.();
    detachView(pending.view, pending.viewerSession, pending.protocolPartition);
    captureCleanup(() => pending.gateway.close());
  }
  for (const viewerSession of sessions) {
    captureCleanup(() => clearDisposableAppViewerStorage(viewerSession));
  }
  return cleanup;
}

function setAppViewerBounds(
  viewerId: string,
  owner: AppViewerOwner,
  value: { x: number; y: number; width: number; height: number },
): void {
  const record = appViewers.get(viewerId);
  if (!record || !sameAppViewerOwner(record.ownerLease, owner)) return;
  const numbers = [value?.x, value?.y, value?.width, value?.height];
  if (!numbers.every((number) => Number.isFinite(number))) return;
  const contentBounds = record.owner.getContentBounds();
  const x = Math.max(0, Math.round(value.x));
  const y = Math.max(0, Math.round(value.y));
  const width = Math.max(0, Math.min(Math.round(value.width), contentBounds.width - x));
  const height = Math.max(0, Math.min(Math.round(value.height), contentBounds.height - y));
  record.view.setBounds({ x, y, width, height });
  record.view.setVisible(width > 0 && height > 0);
}

async function closeAppViewersForOwner(owner: AppViewerOwner): Promise<void> {
  const ids = [...appViewers.entries()]
    .filter(([, record]) => sameAppViewerOwner(record.ownerLease, owner))
    .map(([viewerId]) => viewerId);
  const published = ids.map((viewerId) => closeAppViewer(viewerId, owner));
  const managerCleanup = capsuleManager.closeOwner(owner);
  await Promise.allSettled([...published, managerCleanup]);
}

async function stopAppViewers(appId: string): Promise<void> {
  const entries = [...appViewers.entries()]
    .filter(([, record]) => record.appId === appId)
    .map(([viewerId, record]) => ({ viewerId, owner: record.ownerLease }));
  const results = await Promise.allSettled(
    entries.map(({ viewerId, owner }) => closeAppViewer(viewerId, owner)),
  );
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, `Could not stop App "${appId}"`);
}

function archiveAppFromHost(appId: string): Promise<{ ok: true; id: string }> {
  if (!PACKAGE_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
  const existing = appArchiveOperations.get(appId);
  if (existing) return existing;

  // This fence is established synchronously and remains active through the
  // Core move, so an open/reload cannot race the retirement boundary.
  capsuleManager.beginAppRetirement(appId);
  let tracked!: Promise<{ ok: true; id: string }>;
  const operation = (async () => {
    try {
      await stopAppViewers(appId);
      await capsuleManager.retireApp(appId);
      const response = await fetch(`${coreBaseUrl()}/api/apps/${encodeURIComponent(appId)}/archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CORE_TOKEN}` },
      });
      const body = await response.json().catch(() => ({})) as {
        ok?: boolean;
        id?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? `Core returned HTTP ${response.status}`);
      if (body.ok !== true || body.id !== appId) {
        throw new Error("Core returned an invalid archive response");
      }
      return { ok: true as const, id: body.id };
    } finally {
      capsuleManager.finishAppRetirement(appId);
    }
  });
  tracked = operation().finally(() => {
    if (appArchiveOperations.get(appId) === tracked) appArchiveOperations.delete(appId);
  });
  appArchiveOperations.set(appId, tracked);
  return tracked;
}

function detachAllAppWebContents(): void {
  // A Manager operation can commit immediately before its Promise continuation
  // publishes the first renderer into appViewers. Revoke that hidden browser
  // authority synchronously too; the continuation will observe the missing
  // Manager generation and finish the remaining surface cleanup.
  for (const senderId of preparedAppViewerSenderIds) {
    preparedAppViewerSenderIds.delete(senderId);
    systemBroker.unbindSender(senderId);
  }
  const entries = [...appViewers.entries()];
  for (const [viewerId, record] of entries) {
    for (const cleanup of detachAppViewerRecord(viewerId, record)) {
      void cleanup.catch((error) => {
        console.error(`[electron] App viewer cleanup failed: ${errorMessage(error)}`);
      });
    }
  }
}

async function stopAllAppViewers(): Promise<void> {
  detachAllAppWebContents();
  await capsuleManager.stopAll();
}

async function waitForCore(
  generation: number,
): Promise<void> {
  const deadline = performance.now() + CORE_READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const expectedCore = core;
    const expectedGuard = guard;
    if (!expectedCore || !expectedGuard) {
      const failure = new Error(
        coreRuntime.snapshot().error
        ?? coreStartError
        ?? "Core runtime stopped during startup",
      );
      markCoreFailed(failure, generation);
      throw failure;
    }
    const request = new AbortController();
    const remaining = Math.max(1, deadline - performance.now());
    const requestTimeout = setTimeout(
      () => request.abort(),
      Math.min(CORE_READY_REQUEST_TIMEOUT_MS, remaining),
    );
    try {
      const res = await fetch(`${coreBaseUrl()}/api/apps`, {
        headers: { Authorization: `Bearer ${CORE_TOKEN}` },
        signal: request.signal,
      });
      if (!res.ok) throw new Error(`Core returned ${res.status}`);
      const state = coreRuntime.snapshot();
      if (
        state.generation !== generation
        || state.phase !== "starting"
        || core !== expectedCore
        || guard !== expectedGuard
      ) {
        throw new Error("Core readiness belonged to a stale runtime generation");
      }
      if (!markCoreReady(generation)) {
        throw new Error("Core readiness could not publish its runtime generation");
      }
      return;
    } catch (error) {
      const state = coreRuntime.snapshot();
      if (state.generation !== generation) throw error;
      if (state.phase === "failed") {
        throw new Error(state.error ?? "Core runtime failed during startup");
      }
    } finally {
      clearTimeout(requestTimeout);
    }
    const retryDelay = Math.min(
      CORE_READY_RETRY_DELAY_MS,
      Math.max(0, deadline - performance.now()),
    );
    if (retryDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  const failure = new Error("Core server did not start in time");
  markCoreFailed(failure, generation);
  throw failure;
}

function coreBaseUrl(): string {
  if (!core) throw new Error("Node Core is not running");
  return `http://localhost:${corePort}`;
}

async function retryCore(): Promise<{ coreBaseUrl: string }> {
  markCoreStarting();
  try {
    await stopRuntime();
    const generation = await startRuntime();
    await waitForCore(generation);
    return { coreBaseUrl: coreBaseUrl() };
  } catch (error) {
    markCoreFailed(error);
    throw error;
  }
}

async function rotateCorePort(): Promise<{ coreBaseUrl: string }> {
  markCoreStarting();
  try {
    await stopRuntime();
    const generation = await startRuntime({ rotatePort: true });
    await waitForCore(generation);
    return { coreBaseUrl: coreBaseUrl() };
  } catch (error) {
    markCoreFailed(error);
    throw error;
  }
}

async function createWindow(): Promise<void> {
  const development = process.env.NODE_ENV === "development";
  const shellEntryUrl = development
    ? new URL("http://127.0.0.1:5173/")
    : new URL(pathToFileURL(join(__dirname, "..", "dist", "index.html")).toString());
  const allowsShellUrl = createShellNavigationPolicy(shellEntryUrl, development);
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Lamarck",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });
  mainWindow = win;
  const shellContents = win.webContents;
  const shellWebContentsId = shellContents.id;
  const shellState: ShellWebContentsState = {
    allowsUrl: allowsShellUrl,
    currentOwner: Object.freeze({
      webContentsId: shellWebContentsId,
      rendererGeneration: 0,
    }),
    retirement: Promise.resolve(),
  };
  shellWebContents.set(shellWebContentsId, shellState);
  const replaceShellRenderer = () => {
    marketplaceRendererWebContentsId = null;
    const retiredOwner = shellState.currentOwner;
    shellState.currentOwner = Object.freeze({
      webContentsId: shellWebContentsId,
      rendererGeneration: retiredOwner.rendererGeneration + 1,
    });
    // closeAppViewersForOwner synchronously fences Manager opens before its
    // first await. New-generation IPC waits for this retirement settlement.
    const cleanup = closeAppViewersForOwner(retiredOwner);
    shellState.retirement = Promise.allSettled([
      shellState.retirement,
      cleanup,
    ]).then(() => {});
  };
  shellContents.on("before-input-event", (event, input) => {
    if (!isOpenLauncherShortcut(input)) return;
    event.preventDefault();
    if (!shellContents.isDestroyed()) shellContents.send("shell:open-launcher");
  });
  shellContents.setWindowOpenHandler(() => ({ action: "deny" }));
  shellContents.on("will-navigate", (event, url) => {
    if (!allowsShellUrl(url)) event.preventDefault();
  });
  shellContents.on("will-attach-webview", (event) => event.preventDefault());
  shellContents.on("did-start-navigation", (details) => {
    if (details.isSameDocument || !details.isMainFrame) return;
    replaceShellRenderer();
  });
  shellContents.on("render-process-gone", () => {
    replaceShellRenderer();
  });

  win.on("closed", () => {
    // Electron destroys BrowserWindow before emitting "closed". Only use the
    // identifier captured while the window and its WebContents were alive.
    shellWebContents.delete(shellWebContentsId);
    marketplaceRendererWebContentsId = null;
    mainWindow = null;
    disposeTerminalsForWebContents(shellWebContentsId);
    const cleanup = closeAppViewersForOwner(shellState.currentOwner);
    void Promise.allSettled([shellState.retirement, cleanup]);
  });

  if (development || process.env.LAMARCK_DEBUG_RENDERER === "1") {
    shellContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    shellContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      console.error(`[renderer] Load failed: ${code} ${description} ${url} mainFrame=${isMainFrame}`);
    });
    shellContents.on("render-process-gone", (_event, details) => {
      console.error("[renderer] Process gone:", details);
    });
    shellContents.on("preload-error", (_event, preloadPath, error) => {
      console.error(`[renderer] Preload failed: ${preloadPath}`, error);
    });
    shellContents.on("did-finish-load", () => {
      console.log(`[renderer] Loaded ${shellContents.getURL()}`);
    });
  }

  await win.loadURL(shellEntryUrl.toString());
}

app.whenReady().then(async () => {
  if (!ownsSingleInstance) return;
  registerMarketplaceProtocolClient();
  const initialWorkspace = initializeWorkspaceSelection();
  if (initialWorkspace) {
    workspace = initialWorkspace.path;
    workspaceVault.begin(initialWorkspace.path, initialWorkspace.vaultId);
  } else {
    workspace = "";
    workspaceVault.begin("");
  }
  ipcMain.handle("auth:getCoreToken", (event) => {
    requireShellIpc(event);
    return CORE_TOKEN;
  });
  ipcMain.handle("auth:getRecoveryCode", (event) => {
    requireShellIpc(event);
    return workspaceVault.recoveryCode(workspace);
  });
  ipcMain.handle("auth:importRecoveryCode", async (event, recoveryCode: string) => {
    requireShellIpc(event);
    return enqueueRuntime(async () => {
      const targetWorkspace = workspace;
      const selection = workspaceVault.current(targetWorkspace);
      if (!selection?.vaultId) throw new Error("Workspace vault is not initialized");
      const descriptor = inspectWorkspaceForOpen(targetWorkspace);
      if (descriptor.vaultId !== selection.vaultId) {
        throw new Error("Workspace ID changed while its recovery code was being imported");
      }
      const importedKey = await importVaultKey(descriptor, recoveryCode);
      if (!workspaceVault.unlock(selection, importedKey)) {
        throw new Error("Workspace changed while its recovery code was being imported");
      }
      markCoreStarting();
      try {
        await stopRuntime();
        const generation = await startRuntime({ expectedVaultId: descriptor.vaultId });
        await waitForCore(generation);
        return { coreBaseUrl: coreBaseUrl() };
      } catch (error) {
        markCoreFailed(error);
        throw error;
      }
    });
  });
  ipcMain.handle("core:getBaseUrl", (event) => {
    requireShellIpc(event);
    return coreBaseUrl();
  });
  ipcMain.handle("core:getStartError", (event) => {
    requireShellIpc(event);
    return coreStartError;
  });
  ipcMain.handle("core:getRuntimeState", (event) => {
    requireShellIpc(event);
    return coreRuntimeState();
  });
  ipcMain.handle("core:retry", (event) => {
    requireShellIpc(event);
    return enqueueRuntime(retryCore);
  });
  ipcMain.handle("core:rotatePort", (event) => {
    requireShellIpc(event);
    return enqueueRuntime(rotateCorePort);
  });
  ipcMain.handle("shell:openExternal", (event, rawUrl: string) => {
    requireShellIpc(event);
    const externalUrl = parseAllowedExternalUrl(rawUrl);
    return shell.openExternal(externalUrl.toString());
  });
  ipcMain.handle("marketplace:rendererReady", (event) => {
    requireShellIpc(event);
    marketplaceRendererWebContentsId = event.sender.id;
    flushMarketplaceHandoffs();
    return { ok: true as const };
  });
  ipcMain.handle("workspace:getState", (event) => {
    requireShellIpc(event);
    return workspaceHostState();
  });
  ipcMain.handle("workspace:choose", async (
    event,
    purpose: "create" | "open",
  ) => {
    const owner = requireShellIpc(event);
    if (purpose !== "create" && purpose !== "open") {
      throw new Error("Workspace chooser purpose must be create or open");
    }
    const hostState = workspaceHostState();
    const result = await dialog.showOpenDialog(owner, {
      title: purpose === "create"
        ? "Choose an empty folder for a new Workspace"
        : "Open an existing Lamarck Workspace",
      defaultPath: hostState.status === "setup"
        ? hostState.suggestedPath
        : activeWorkspace?.path,
      properties: purpose === "create"
        ? ["openDirectory", "createDirectory"]
        : ["openDirectory"],
    });
    return {
      path: result.canceled || result.filePaths.length === 0
        ? null
        : result.filePaths[0],
    };
  });
  ipcMain.handle("workspace:create", (event, payload: { path?: unknown }) => {
    requireShellIpc(event);
    if (
      !payload
      || typeof payload.path !== "string"
    ) {
      throw new Error("Create Workspace request is invalid");
    }
    const nextPath = payload.path;
    return enqueueRuntime(async () => ({
      status: "ready" as const,
      workspace: await createWorkspace(nextPath),
    }));
  });
  ipcMain.handle("workspace:open", (event, payload: {
    path?: unknown;
    recoveryCode?: unknown;
  }) => {
    requireShellIpc(event);
    if (
      !payload
      || typeof payload.path !== "string"
      || (
        payload.recoveryCode !== undefined
        && typeof payload.recoveryCode !== "string"
      )
    ) {
      throw new Error("Open Workspace request is invalid");
    }
    return enqueueRuntime(() => openWorkspace(
      payload.path as string,
      payload.recoveryCode as string | undefined,
    ));
  });
  ipcMain.handle("app-viewer:open", async (event, appId: string) => {
    const owner = requireShellRendererOwner(event);
    try {
      await awaitShellRendererRetirement(event.sender, owner);
      const opened = await openAppViewer(event.sender, owner, appId);
      return { ok: true as const, viewerId: opened.viewerId };
    } catch (error) {
      return {
        ok: false as const,
        error: {
          code: isCapsuleRestartRequiredError(error)
            ? "CAPSULE_RESTART_REQUIRED"
            : error instanceof AppViewerBusyError
              ? "APP_VIEWER_BUSY"
              : "APP_VIEWER_OPEN_FAILED",
          message: errorMessage(error),
          restartRequired: isCapsuleRestartRequiredError(error),
        },
      };
    }
  });
  ipcMain.on("app-viewer:bounds", (event, payload: {
    viewerId: string;
    bounds: { x: number; y: number; width: number; height: number };
  }) => {
    let owner: AppViewerOwner;
    try { owner = requireShellRendererOwner(event); } catch { return; }
    if (!payload || typeof payload.viewerId !== "string" || !payload.bounds) return;
    setAppViewerBounds(payload.viewerId, owner, payload.bounds);
  });
  ipcMain.handle("app-viewer:close", async (event, viewerId: string) => {
    const owner = requireShellRendererOwner(event);
    if (typeof viewerId === "string") await closeAppViewer(viewerId, owner);
    return { ok: true };
  });
  ipcMain.handle("app-runtime:reload", async (event, appId: string) => {
    requireShellIpc(event);
    return reloadAppRuntime(appId);
  });
  ipcMain.handle("app-runtime:archive", async (event, appId: string) => {
    requireShellIpc(event);
    return archiveAppFromHost(appId);
  });
  ipcMain.handle("app-system:invoke", (event, serializedRequest: unknown) => {
    return systemBroker.invokeSerialized(event.sender.id, serializedRequest);
  });
  ipcMain.handle("terminal:create", (event) => {
    requireShellIpc(event);
    return createTerminal(event.sender);
  });
  ipcMain.on("terminal:input", (event, payload: { id: string; data: string }) => {
    try { requireShellIpc(event); } catch { return; }
    const session = getTerminalForSender(payload.id, event.sender);
    if (!session?.proc.stdin?.writable) return;
    session.proc.stdin.write(payload.data);
  });
  ipcMain.on("terminal:resize", (event, payload: { id: string; cols: number; rows: number }) => {
    try { requireShellIpc(event); } catch { return; }
    const session = getTerminalForSender(payload.id, event.sender);
    if (!session?.proc.stdin?.writable) return;
    session.proc.stdin.write("\x01" + JSON.stringify({ cols: payload.cols, rows: payload.rows }));
  });
  ipcMain.handle("terminal:dispose", (event, id: string) => {
    requireShellIpc(event);
    const session = getTerminalForSender(id, event.sender);
    if (!session) return { ok: true };
    disposeTerminal(id);
    return { ok: true };
  });
  let releaseInitialStartup!: () => void;
  const shellReady = new Promise<void>((resolve) => {
    releaseInitialStartup = resolve;
  });
  // Reserve the first runtime-queue position before renderer IPC becomes
  // usable, but do not touch Keychain until the Shell window is present.
  const initialStartup = initialWorkspace
    ? enqueueRuntime(async () => {
        await shellReady;
        if (isQuitting) {
          throw new Error("Runtime startup was cancelled because Lamarck is quitting");
        }
        const generation = await startRuntime({ expectedVaultId: initialWorkspace.vaultId });
        await waitForCore(generation);
        if (workspaceSelectionNeedsPersistence) {
          saveActiveWorkspace(initialWorkspace);
          workspaceSelectionNeedsPersistence = false;
        }
      })
    : null;
  // The shell is useful even while Core is starting or unavailable. Create the
  // window first so Keychain prompts and recovery failures never block the UI.
  try {
    if (!isQuitting) await createWindow();
  } finally {
    releaseInitialStartup();
  }
  if (initialStartup) {
    try {
      await initialStartup;
    } catch (err) {
      const failure = markCoreFailed(err);
      console.error(`[electron] Core failed to start: ${failure}`);
    }
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (isQuitting) return;
  isQuitting = true;
  disposeAllTerminals();
  void stopRuntime()
    .catch((error) => {
      console.error(`[electron] Runtime shutdown required process exit: ${errorMessage(error)}`);
    })
    .finally(() => {
      shutdownComplete = true;
      // Runtime authority is fully torn down above. Use Electron's immediate
      // exit path without re-entering before-quit.
      app.exit(0);
    });
});
