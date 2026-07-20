// Electron main process
// - Launches the isolated Node Guard utility before the Node Core
// - First-launch: copies template/ → ~/Lamarck/
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
import { existsSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createServer } from "net";
import { join, relative, sep } from "path";
import { pathToFileURL } from "url";
import {
  CapsuleManager,
  type ReloadedBrowserBinding,
} from "./capsule/manager";
import { MacOsCapsuleBackend } from "./capsule/macos-backend";
import { SystemBroker } from "./capsule/system-broker";
import { SystemStreamServer } from "./capsule/system-stream";
import { createViewerGateway, type ViewerGatewayBinding } from "./capsule/viewer-gateway";
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

app.setName("Lamarck");

const TEMPLATE = join(__dirname, "..", "..", "template");
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
let vaultId = "";
let vaultKey = "";
let nextTerminalId = 1;
let isQuitting = false;
let shutdownComplete = false;
let runtimeQueue: Promise<void> = Promise.resolve();
let guardHeartbeatTimer: NodeJS.Timeout | null = null;
let guardHeartbeatChild: UtilityProcess | null = null;
let guardPongListener: ((message: unknown) => void) | null = null;
let guardLastPongAt = 0;
let guardPingNonce = 0;
const expectedCoreStops = new WeakSet<ChildProcess>();
const expectedGuardStops = new WeakSet<UtilityProcess>();
const exitedGuards = new WeakSet<UtilityProcess>();
const terminalSessions = new Map<string, { proc: ChildProcess; ownerWebContentsId: number }>();
const shellWebContents = new Map<number, (url: string) => boolean>();

interface AppViewerRecord {
  appId: string;
  ownerWebContentsId: number;
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
}

interface AppViewerProtocolBinding extends AppViewerOriginBinding {
  viewerId: string;
}

interface AppViewerSessionState {
  binding: AppViewerProtocolBinding | null;
}

const appViewers = new Map<string, AppViewerRecord>();
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
const capsuleStateRoot = join(app.getPath("userData"), "capsule");
const capsuleBackend = new MacOsCapsuleBackend({
  helperPath: CAPSULE_VM_HELPER,
  releaseResourcesRoot: join(__dirname, "native", "capsule-guest"),
  stateDirectory: join(capsuleStateRoot, "vm"),
  cacheDirectory: join(capsuleStateRoot, "cache"),
  artifactRoot: join(capsuleStateRoot, "artifacts"),
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

interface AppSettings {
  workspacePath?: string;
}

interface WorkspaceSettings {
  corePort?: number;
  vaultId?: string;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function loadWorkspacePath(): string {
  const fallback = join(app.getPath("home"), "Lamarck");
  try {
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8")) as AppSettings;
    if (settings.workspacePath) return settings.workspacePath;
  } catch {}
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ workspacePath: fallback }, null, 2) + "\n", "utf8");
  return fallback;
}

function workspaceSettingsPath(targetWorkspace = workspace): string {
  return join(targetWorkspace, ".lamarck", "settings.json");
}

function loadWorkspaceSettings(targetWorkspace = workspace): WorkspaceSettings {
  try {
    return JSON.parse(readFileSync(workspaceSettingsPath(targetWorkspace), "utf8")) as WorkspaceSettings;
  } catch {
    return {};
  }
}

function saveWorkspaceSettings(settings: WorkspaceSettings, targetWorkspace = workspace): void {
  const lamarckDir = join(targetWorkspace, ".lamarck");
  mkdirSync(lamarckDir, { recursive: true });
  writeFileSync(workspaceSettingsPath(targetWorkspace), JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function vaultRecordsPath(): string {
  return join(app.getPath("userData"), "vault-keys.json");
}

function loadVaultRecords(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(vaultRecordsPath(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveVaultRecords(records: Record<string, string>): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(vaultRecordsPath(), JSON.stringify(records, null, 2) + "\n", "utf8");
}

function loadOrCreateVaultKey(nextVaultId: string, opts: { allowCreate: boolean }): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage is unavailable; cannot unlock the workspace vault key");
  }
  const records = loadVaultRecords();
  const encrypted = records[nextVaultId];
  if (encrypted) {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }
  if (!opts.allowCreate) {
    throw new Error("Workspace vault is locked on this device. Import the recovery code to unlock it.");
  }
  const recoveryCode = randomBytes(32).toString("base64url");
  records[nextVaultId] = safeStorage.encryptString(recoveryCode).toString("base64");
  saveVaultRecords(records);
  return recoveryCode;
}

function importVaultKey(nextVaultId: string, recoveryCode: string): void {
  const decoded = Buffer.from(recoveryCode.trim(), "base64url");
  if (decoded.length !== 32) {
    throw new Error("Recovery code must decode to a 32-byte vault key");
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage is unavailable; cannot store the workspace vault key");
  }
  const records = loadVaultRecords();
  records[nextVaultId] = safeStorage.encryptString(recoveryCode.trim()).toString("base64");
  saveVaultRecords(records);
  vaultKey = recoveryCode.trim();
}

function saveWorkspacePath(nextWorkspace: string): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify({ workspacePath: nextWorkspace }, null, 2) + "\n",
    "utf8",
  );
}

function ensureWorkspace(targetWorkspace = workspace): void {
  if (existsSync(targetWorkspace)) return;
  console.log(`[electron] First launch — copying template to ${targetWorkspace}`);
  // Built-in connectors are bundled catalog entries installed explicitly
  // through Core. Top-level hidden state is Host-managed and recreated for the
  // new workspace, so neither belongs in the user-facing template copy.
  cpSync(TEMPLATE, targetWorkspace, {
    recursive: true,
    filter: (src) => {
      const rel = relative(TEMPLATE, src);
      const topLevel = rel.split(sep)[0] ?? "";
      return topLevel !== "connectors" && !topLevel.startsWith(".");
    },
  });
}

async function ensureWorkspaceRuntimeSettings(opts?: { rotatePort?: boolean }): Promise<void> {
  const settings = loadWorkspaceSettings();
  const createdVaultId = !settings.vaultId;
  if (!settings.vaultId) {
    settings.vaultId = randomBytes(16).toString("base64url");
  }

  if (opts?.rotatePort || !settings.corePort || !isSupportedCorePort(settings.corePort)) {
    settings.corePort = await chooseAvailableCorePort(settings.corePort);
  } else if (!(await isPortAvailable(settings.corePort))) {
    corePort = settings.corePort;
    throw new Error(
      `Core port ${settings.corePort} is already in use. Close the other app or explicitly rotate the workspace core port.`,
    );
  }

  saveWorkspaceSettings(settings);
  corePort = settings.corePort;
  vaultId = settings.vaultId;
  vaultKey = loadOrCreateVaultKey(vaultId, { allowCreate: createdVaultId });
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

function startGuardHeartbeat(child: UtilityProcess): void {
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
      coreStartError = "Guard utility became unresponsive and was terminated";
      console.error(`[electron] ${coreStartError}`);
      stopGuardHeartbeat(child);
      child.kill();
      return;
    }
    try {
      child.postMessage({ type: "ping", nonce: ++guardPingNonce });
    } catch {
      child.kill();
    }
  };
  ping();
  guardHeartbeatTimer = setInterval(ping, GUARD_HEARTBEAT_INTERVAL_MS);
}

async function startGuard(): Promise<void> {
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
  });
  child.on("exit", (code) => {
    stopGuardHeartbeat(child);
    exitedGuards.add(child);
    const expected = expectedGuardStops.has(child);
    if (guard === child) {
      guard = null;
      guardOrigin = "";
    }
    console.log(`[electron] Guard utility exited with code ${code}`);
    if (!expected && !isQuitting) {
      coreStartError = `Guard utility exited unexpectedly (code ${code})`;
      // The core must never continue without the process that exclusively owns
      // data.db. Fail closed; the existing Retry action restarts both processes.
      void stopCore();
    }
  });

  try {
    const port = await waitForGuardReady(child);
    if (guard !== child) throw new Error("Guard utility stopped during startup");
    guardOrigin = `http://127.0.0.1:${port}`;
    startGuardHeartbeat(child);
    console.log(`[electron] Guard utility ready on ${guardOrigin}`);
  } catch (error) {
    if (guard === child) await stopGuard();
    throw error;
  }
}

function startCore(): void {
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
      LAMARCK_VAULT_KEY: vaultKey,
      LAMARCK_GUARD_ORIGIN: guardOrigin,
      LAMARCK_GUARD_TOKEN: GUARD_TOKEN,
    },
  });
  core = child;
  coreStartError = null;
  child.on("error", (error) => {
    if (expectedCoreStops.has(child) || isQuitting) return;
    if (core === child) core = null;
    coreStartError = `Node Core failed to start: ${error.message}`;
    console.error(`[electron] ${coreStartError}`);
    systemBroker.unbindAll();
    detachAllAppWebContents();
    void capsuleManager.stopAll().catch((teardownError) => {
      console.error(
        `[electron] Capsule teardown after Core loss failed: ${errorMessage(teardownError)}`,
      );
    });
    void stopGuard();
  });
  child.on("exit", (code, signal) => {
    const expected = expectedCoreStops.has(child);
    console.log(`[electron] Node Core exited with code ${code}${signal ? ` (${signal})` : ""}`);
    if (core === child) core = null;
    if (!expected && !isQuitting) {
      coreStartError = `Node Core exited unexpectedly${code === null ? "" : ` (code ${code})`}`;
      // The authenticated loopback listener no longer exists. Remove every
      // local App authority before another process can reuse the port and
      // receive capabilities or the Host bearer from stale requests.
      systemBroker.unbindAll();
      detachAllAppWebContents();
      void capsuleManager.stopAll().catch((error) => {
        console.error(`[electron] Capsule teardown after Core loss failed: ${errorMessage(error)}`);
      });
      // Keep the pair lifecycle-coupled so a crashed core never leaves an
      // unreachable data.db owner behind.
      void stopGuard();
    }
  });
}

async function stopCore(): Promise<void> {
  if (!core) return;
  const child = core;
  core = null;
  expectedCoreStops.add(child);
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, PROCESS_STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

async function stopGuard(): Promise<void> {
  if (!guard) return;
  const child = guard;
  stopGuardHeartbeat(child);
  guard = null;
  guardOrigin = "";
  expectedGuardStops.add(child);

  const gracefulExit = waitForGuardExit(child, PROCESS_STOP_TIMEOUT_MS);
  try {
    child.postMessage({ type: "shutdown" });
  } catch {
    child.kill();
  }
  if (await gracefulExit) return;

  console.warn("[electron] Guard utility did not shut down in time; terminating it");
  child.kill();
  await waitForGuardExit(child, 500);
}

async function startRuntime(opts?: { rotatePort?: boolean }): Promise<void> {
  try {
    await ensureWorkspaceRuntimeSettings(opts);
    await startGuard();
    startCore();
  } catch (error) {
    coreStartError = errorMessage(error);
    await stopCore();
    await stopGuard();
    throw error;
  }
}

async function stopRuntime(): Promise<void> {
  // Revoke every App launch channel while Core is still alive, then tear down
  // the VM/backend before releasing Core and Guard authority.
  try {
    await stopAllAppViewers();
  } catch (error) {
    console.error(`[electron] App Capsule shutdown failed: ${errorMessage(error)}`);
  }
  // Core can still issue Guard requests, so always stop it before releasing
  // data.db ownership from the Guard utility.
  await stopCore();
  await stopGuard();
}

async function switchWorkspace(nextWorkspace: string): Promise<string> {
  const normalized = nextWorkspace.trim();
  if (!normalized) {
    throw new Error("Workspace path is required");
  }
  if (normalized === workspace) return workspace;
  disposeAllTerminals();
  await stopRuntime();
  workspace = normalized;
  saveWorkspacePath(workspace);
  ensureWorkspace(workspace);
  await startRuntime();
  await waitForCore();
  return workspace;
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
  const allowsUrl = shellWebContents.get(sender.id);
  if (!owner || !allowsUrl || !allowsUrl(sender.getURL()) || !allowsUrl(frameUrl)) {
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

function appPartition(appId: string, browserChannelId: string): string {
  return appViewerPartition(workspace, appId, browserChannelId);
}

function appOriginHost(appId: string, browserChannelId: string): string {
  return appViewerOriginHost(workspace, appId, browserChannelId);
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
  ownerWebContentsId: number,
): void {
  const contents = view.webContents;
  const cleanup = () => {
    if (expectedAppViewerCloses.has(contents)) return;
    void closeAppViewer(viewerId, ownerWebContentsId).catch((error) => {
      console.error(`[electron] App viewer cleanup failed: ${errorMessage(error)}`);
    });
  };
  contents.once("render-process-gone", cleanup);
  contents.once("destroyed", cleanup);
}

async function openAppViewer(sender: WebContents, appId: string): Promise<{ viewerId: string }> {
  const owner = requireShellWindow(sender);
  const opened = await capsuleManager.openViewer(appId, sender.id);
  let gateway: ViewerGatewayBinding | null = null;
  let viewerUrl: URL;
  try {
    gateway = await createViewerGateway({
      instanceId: opened.instanceId,
      originHost: appOriginHost(appId, opened.channelId),
      transport: {
        openUiStream: () => capsuleManager.openViewerStream(opened.viewerId),
      },
    });
    viewerUrl = new URL(gateway.viewerUrl);
    if (viewerUrl.protocol !== "http:" || !viewerUrl.hostname.endsWith(".localhost")) {
      throw new Error("invalid viewer origin");
    }
  } catch {
    await gateway?.close().catch(() => {});
    await capsuleManager.closeViewer(opened.viewerId, sender.id);
    throw new Error("Capsule viewer gateway could not establish a bound origin");
  }

  let view: WebContentsView | null = null;
  let cleanupSession: Session | null = null;
  const protocolPartition = appPartition(appId, opened.channelId);
  try {
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
    view.webContents.on("before-input-event", (event, input) => {
      if (!isOpenLauncherShortcut(input)) return;
      event.preventDefault();
      if (sender.isDestroyed()) return;
      // The viewer holds webContents focus; move it to the Shell first so the
      // launcher search field actually receives the keystrokes that follow.
      sender.focus();
      sender.send("shell:open-launcher");
    });
    const viewerSession = view.webContents.session;
    cleanupSession = viewerSession;
    // This is an in-memory, generation-specific partition, but clear before
    // binding as a fail-closed guard against accidental Electron session reuse.
    await clearDisposableAppViewerStorage(viewerSession);
    await configureAppWebContents(
      view,
      viewerUrl,
      gateway.proxyUrl,
      protocolPartition,
      opened.viewerId,
    );
    assertViewerAuthorityCurrent(
      opened,
      capsuleManager.getViewer(opened.viewerId, sender.id),
    );
    systemBroker.bindSender(view.webContents.id, {
      channelId: opened.channelId,
      capability: opened.capability,
    });
    owner.contentView.addChildView(view);
    const record: AppViewerRecord = {
      appId,
      ownerWebContentsId: sender.id,
      owner,
      view,
      appWebContentsId: view.webContents.id,
      viewerSession,
      protocolPartition,
      gateway,
      pendingReplacement: null,
    };
    appViewers.set(opened.viewerId, record);
    bindAppViewerCleanup(view, opened.viewerId, sender.id);
    await view.webContents.loadURL(gateway.viewerUrl);
    assertViewerAuthorityCurrent(
      opened,
      capsuleManager.getViewer(opened.viewerId, sender.id),
    );
    if (appViewers.get(opened.viewerId) !== record) {
      throw new Error("App viewer was detached while its renderer was loading");
    }
    return { viewerId: opened.viewerId };
  } catch (error) {
    if (view) systemBroker.unbindSender(view.webContents.id);
    clearAppViewerBinding(protocolPartition, opened.viewerId);
    appViewers.delete(opened.viewerId);
    if (view) {
      try { owner.contentView.removeChildView(view); } catch {}
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
    await Promise.allSettled([
      gateway.close(),
      capsuleManager.closeViewer(opened.viewerId, sender.id),
      cleanupSession
        ? clearDisposableAppViewerStorage(cleanupSession)
        : Promise.resolve(),
    ]);
    throw error;
  }
}

async function reloadAppViewer(
  record: AppViewerRecord,
  binding: ReloadedBrowserBinding,
  lifecycleGeneration: number,
): Promise<void> {
  assertCurrentAppViewer(record, binding.viewerId, lifecycleGeneration, undefined, binding);
  const previousGateway = record.gateway;
  const previousView = record.view;
  const previousSession = record.viewerSession;
  const previousProtocolPartition = record.protocolPartition;
  const previousBounds = previousView.getBounds();
  const nextProtocolPartition = appPartition(record.appId, binding.channelId);
  let committedGeneration: number | undefined;
  const nextGateway = await createViewerGateway({
    instanceId: binding.viewerId,
    originHost: appOriginHost(record.appId, binding.channelId),
    transport: {
      openUiStream: () => capsuleManager.openViewerStream(binding.viewerId),
    },
  });
  let nextView: WebContentsView | null = null;
  let nextSession: Session | null = null;
  try {
    assertCurrentAppViewer(record, binding.viewerId, lifecycleGeneration, undefined, binding);
    const nextUrl = new URL(nextGateway.viewerUrl);
    nextView = new WebContentsView({
      webPreferences: {
        preload: APP_PRELOAD,
        partition: nextProtocolPartition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        disableBlinkFeatures: "WebRTC",
      },
    });
    nextSession = nextView.webContents.session;
    const replacement: AppViewerReplacement = {
      view: nextView,
      gateway: nextGateway,
      viewerSession: nextSession,
      protocolPartition: nextProtocolPartition,
    };
    record.pendingReplacement = replacement;
    await clearDisposableAppViewerStorage(nextSession);
    await configureAppWebContents(
      nextView,
      nextUrl,
      nextGateway.proxyUrl,
      nextProtocolPartition,
      binding.viewerId,
    );
    assertCurrentAppViewer(record, binding.viewerId, lifecycleGeneration, replacement, binding);
    // Cut over browser authority by WebContents, not by rebinding the old
    // renderer. Old App code is destroyed before the replacement capability
    // exists in a renderer, and its disposable browser state is removed before
    // the new generation loads.
    systemBroker.unbindSender(previousView.webContents.id);
    expectedAppViewerCloses.add(previousView.webContents);
    try { record.owner.contentView.removeChildView(previousView); } catch {}
    if (!previousView.webContents.isDestroyed()) {
      previousView.webContents.close({ waitForBeforeUnload: false });
    }
    clearAppViewerBinding(previousProtocolPartition, binding.viewerId);
    await clearDisposableAppViewerStorage(previousSession);
    assertCurrentAppViewer(record, binding.viewerId, lifecycleGeneration, replacement, binding);
    systemBroker.bindSender(nextView.webContents.id, binding);
    await nextView.webContents.loadURL(nextGateway.viewerUrl);
    assertCurrentAppViewer(record, binding.viewerId, lifecycleGeneration, replacement, binding);
    nextView.setBounds(previousBounds);
    record.owner.contentView.addChildView(nextView);
    bindAppViewerCleanup(nextView, binding.viewerId, record.ownerWebContentsId);

    record.view = nextView;
    record.appWebContentsId = nextView.webContents.id;
    record.viewerSession = nextSession;
    record.protocolPartition = nextProtocolPartition;
    record.gateway = nextGateway;
    record.pendingReplacement = null;
    // A committed renderer receives a fresh lifecycle generation. Any stale
    // async continuation from the previous generation must now fail CAS.
    committedGeneration = appViewerLifecycle.invalidate(record.appId);
  } catch (error) {
    if (nextView) {
      if (record.pendingReplacement?.view === nextView) record.pendingReplacement = null;
      systemBroker.unbindSender(nextView.webContents.id);
      clearAppViewerBinding(nextProtocolPartition, binding.viewerId);
      expectedAppViewerCloses.add(nextView.webContents);
      try { record.owner.contentView.removeChildView(nextView); } catch {}
      if (!nextView.webContents.isDestroyed()) {
        nextView.webContents.close({ waitForBeforeUnload: false });
      }
    }
    await Promise.allSettled([
      nextGateway.close(),
      nextSession
        ? clearDisposableAppViewerStorage(nextSession)
        : Promise.resolve(),
    ]);
    throw error;
  }
  await previousGateway.close();
  assertCurrentAppViewer(record, binding.viewerId, committedGeneration!, undefined, binding);
}

function reloadAppRuntime(appId: string): Promise<{ active: boolean }> {
  return appViewerLifecycle.reload(appId, async () => {
    const initialEntry = [...appViewers.entries()].find(([, record]) => record.appId === appId);
    const initialViewerId = initialEntry?.[0];
    const initialRecord = initialEntry?.[1];
    const lifecycleGeneration = appViewerLifecycle.generation(appId);
    const result = await capsuleManager.reloadApp(appId);
    if (result.browserBindings.length === 0) return { active: result.active };

    try {
      for (const binding of result.browserBindings) {
        const record = appViewers.get(binding.viewerId);
        if (!record || record !== initialRecord) {
          throw new Error("Reloaded App viewer is no longer attached");
        }
        await reloadAppViewer(record, binding, lifecycleGeneration);
      }
      return { active: result.active };
    } catch (error) {
      // The backend has already committed the replacement generation. A Host
      // cutover failure cannot roll back to the retired workload, so remove all
      // provisional/current renderer authority and close the manager viewer.
      const cleanup = initialRecord && initialViewerId
        ? detachAppViewerRecord(initialViewerId, initialRecord)
        : [];
      if (initialRecord && initialViewerId) {
        cleanup.push(capsuleManager.closeViewer(
          initialViewerId,
          initialRecord.ownerWebContentsId,
        ));
      } else {
        // A trusted Shell caller can race reload against the final Host-side
        // attachment step of openViewer. With no owner binding to close, stop
        // the entire App identity rather than leave a manager-only generation.
        cleanup.push(capsuleManager.stopApp(appId));
      }
      await Promise.allSettled(cleanup);
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
    const current = capsuleManager.getViewer(binding.viewerId, record.ownerWebContentsId);
    if (
      !current
      || current.appId !== record.appId
      || current.viewerId !== binding.viewerId
      || current.channelId !== binding.channelId
      || current.capability !== binding.capability
    ) {
      throw new Error("Reloaded App viewer authority changed during renderer cutover");
    }
  }
  if (record.owner.isDestroyed()) throw new Error("App viewer owner was destroyed during reload");
}

async function closeAppViewer(viewerId: string, ownerWebContentsId: number): Promise<boolean> {
  const record = appViewers.get(viewerId);
  if (!record || record.ownerWebContentsId !== ownerWebContentsId) return false;
  // Invalidate and detach synchronously. Manager close starts immediately so a
  // long build is aborted, while final settlement remains ordered after an
  // already-running reload lifecycle.
  const cleanup = detachAppViewerRecord(viewerId, record);
  const managerClose = capsuleManager.closeViewer(viewerId, ownerWebContentsId);
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
  ownerWebContentsId: number,
  value: { x: number; y: number; width: number; height: number },
): void {
  const record = appViewers.get(viewerId);
  if (!record || record.ownerWebContentsId !== ownerWebContentsId) return;
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

async function closeAppViewersForOwner(ownerWebContentsId: number): Promise<void> {
  const ids = [...appViewers.entries()]
    .filter(([, record]) => record.ownerWebContentsId === ownerWebContentsId)
    .map(([viewerId]) => viewerId);
  await Promise.allSettled(ids.map((viewerId) => closeAppViewer(viewerId, ownerWebContentsId)));
}

async function stopAppViewers(appId: string): Promise<void> {
  const entries = [...appViewers.entries()]
    .filter(([, record]) => record.appId === appId)
    .map(([viewerId, record]) => ({ viewerId, ownerWebContentsId: record.ownerWebContentsId }));
  const results = await Promise.allSettled(
    entries.map(({ viewerId, ownerWebContentsId }) => closeAppViewer(viewerId, ownerWebContentsId)),
  );
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, `Could not stop App "${appId}"`);
}

async function archiveAppFromHost(appId: string): Promise<{ ok: true; id: string }> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(appId)) throw new Error("Invalid App id");
  await stopAppViewers(appId);
  await capsuleManager.stopApp(appId);
  const response = await fetch(`${coreBaseUrl()}/api/apps/${encodeURIComponent(appId)}/archive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CORE_TOKEN}` },
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; id?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Core returned HTTP ${response.status}`);
  if (body.ok !== true || body.id !== appId) throw new Error("Core returned an invalid archive response");
  return { ok: true, id: body.id };
}

function detachAllAppWebContents(): void {
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

async function waitForCore(retries = 20, delay = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    if (!core || !guard) {
      throw new Error(coreStartError ?? "Core runtime stopped during startup");
    }
    try {
      const res = await fetch(`${coreBaseUrl()}/api/apps`, {
        headers: { Authorization: `Bearer ${CORE_TOKEN}` },
      });
      if (!res.ok) throw new Error(`Core returned ${res.status}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Core server did not start in time");
}

function coreBaseUrl(): string {
  if (!core) throw new Error("Node Core is not running");
  return `http://localhost:${corePort}`;
}

async function retryCore(): Promise<{ coreBaseUrl: string }> {
  await stopRuntime();
  await startRuntime();
  await waitForCore();
  return { coreBaseUrl: coreBaseUrl() };
}

async function rotateCorePort(): Promise<{ coreBaseUrl: string }> {
  await stopRuntime();
  await startRuntime({ rotatePort: true });
  await waitForCore();
  return { coreBaseUrl: coreBaseUrl() };
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
  shellWebContents.set(win.webContents.id, allowsShellUrl);
  win.webContents.on("before-input-event", (event, input) => {
    if (!isOpenLauncherShortcut(input)) return;
    event.preventDefault();
    win.webContents.send("shell:open-launcher");
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!allowsShellUrl(url)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());

  win.on("closed", () => {
    shellWebContents.delete(win.webContents.id);
    disposeTerminalsForWebContents(win.webContents.id);
    void closeAppViewersForOwner(win.webContents.id);
  });

  if (development || process.env.LAMARCK_DEBUG_RENDERER === "1") {
    win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      console.error(`[renderer] Load failed: ${code} ${description} ${url} mainFrame=${isMainFrame}`);
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error("[renderer] Process gone:", details);
    });
    win.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.error(`[renderer] Preload failed: ${preloadPath}`, error);
    });
    win.webContents.on("did-finish-load", () => {
      console.log(`[renderer] Loaded ${win.webContents.getURL()}`);
    });
  }

  await win.loadURL(shellEntryUrl.toString());
}

app.whenReady().then(async () => {
  workspace = loadWorkspacePath();
  ipcMain.handle("auth:getCoreToken", (event) => {
    requireShellIpc(event);
    return CORE_TOKEN;
  });
  ipcMain.handle("auth:getRecoveryCode", (event) => {
    requireShellIpc(event);
    return vaultKey;
  });
  ipcMain.handle("auth:importRecoveryCode", async (event, recoveryCode: string) => {
    requireShellIpc(event);
    return enqueueRuntime(async () => {
      if (!vaultId) throw new Error("Workspace vault is not initialized");
      importVaultKey(vaultId, recoveryCode);
      await stopRuntime();
      await startRuntime();
      await waitForCore();
      return { coreBaseUrl: coreBaseUrl() };
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
  ipcMain.handle("workspace:get", (event) => {
    requireShellIpc(event);
    return workspace;
  });
  ipcMain.handle("workspace:set", async (event, nextWorkspace: string) => {
    requireShellIpc(event);
    return enqueueRuntime(async () => {
      const path = await switchWorkspace(nextWorkspace);
      return { path };
    });
  });
  ipcMain.handle("workspace:choose", async (event) => {
    requireShellIpc(event);
    const result = await dialog.showOpenDialog({
      title: "Choose Lamarck system folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { path: null };
    }
    return enqueueRuntime(async () => {
      const path = await switchWorkspace(result.filePaths[0]);
      return { path };
    });
  });
  ipcMain.handle("app-viewer:open", (event, appId: string) => {
    requireShellIpc(event);
    return openAppViewer(event.sender, appId);
  });
  ipcMain.on("app-viewer:bounds", (event, payload: {
    viewerId: string;
    bounds: { x: number; y: number; width: number; height: number };
  }) => {
    try { requireShellIpc(event); } catch { return; }
    if (!payload || typeof payload.viewerId !== "string" || !payload.bounds) return;
    setAppViewerBounds(payload.viewerId, event.sender.id, payload.bounds);
  });
  ipcMain.handle("app-viewer:close", async (event, viewerId: string) => {
    requireShellIpc(event);
    if (typeof viewerId === "string") await closeAppViewer(viewerId, event.sender.id);
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
  ensureWorkspace();
  // The shell is useful even while Core is starting or unavailable. Create the
  // window first so Keychain prompts and recovery failures never block the UI.
  if (!isQuitting) await createWindow();
  try {
    await startRuntime();
    await waitForCore();
  } catch (err) {
    coreStartError = errorMessage(err);
    console.error(`[electron] Core failed to start: ${coreStartError}`);
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
  void stopRuntime().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
