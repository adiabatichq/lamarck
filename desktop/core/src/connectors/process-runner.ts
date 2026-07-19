// process-runner — host side of the connector runner process.
//
// RunnerSession is the supervisor's uniform surface for executing trusted
// connector code. ProcessRunnerSession spawns a Node child per session and
// brokers every capability call over IPC, so connector code never shares the
// core process: a crash, busy loop, or ignored AbortSignal is contained and
// force-killable. InProcessRunnerSession serves manually registered
// definitions (tests, embedding) with the same semantics in-process.
//
// Liveness rules: every bounded command (load/check/request) has a timeout
// that kills the child on expiry; outside run() the session abort signal
// hard-kills the child in any phase (including a hanging top-level import);
// during run() abort is cooperative first (abort message, then SIGKILL after
// the grace period). Force-kill is always SIGKILL — SIGTERM is catchable and
// therefore not an enforcement mechanism.

import { fileURLToPath } from "url";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ConnectorConfigPatch,
  ConnectorConfigUiResult,
  ConnectorDefinition,
  ConnectorHostContext,
  ConnectorRequirementContext,
  ConnectorRequirementStatus,
  ConnectorRuntimeAuthType,
  ConnectorTextBlobResult,
} from "./types";
import type { HostToRunnerMessage, RunnerToHostMessage } from "./runner-protocol";

export interface RunnerCapabilities {
  authType: ConnectorRuntimeAuthType;
  writeEvent(event: unknown): Promise<unknown>;
  writeEvents(events: unknown): Promise<unknown>;
  writeTextBlob(input: unknown): Promise<unknown>;
  stateGet(): Promise<unknown>;
  stateSet(value: unknown): Promise<void>;
  authGetToken(): Promise<string>;
  warningSet(value: unknown): Promise<void>;
  warningClear(key: unknown): Promise<void>;
}

export interface RunnerConfigUiCapabilities {
  configGet(): Promise<unknown>;
  configReplace(value: unknown): Promise<void>;
  configPatch(value: ConnectorConfigPatch): Promise<unknown>;
  stateGet(): Promise<unknown>;
  stateSet(value: unknown): Promise<void>;
}

export interface RunnerRunOptions {
  config: unknown;
  host: ConnectorHostContext;
  signal: AbortSignal;
  capabilities: RunnerCapabilities;
}

export interface RunnerConfigUiOptions {
  panelId: string;
  config: unknown;
  host: ConnectorHostContext;
  signal: AbortSignal;
  capabilities: RunnerConfigUiCapabilities;
}

export interface RunnerSession {
  requirementIds(): string[];
  check(
    ids: string[],
    ctx: ConnectorRequirementContext,
  ): Promise<Record<string, ConnectorRequirementStatus | null>>;
  request(id: string, ctx: ConnectorRequirementContext): Promise<ConnectorRequirementStatus | null>;
  run(opts: RunnerRunOptions): Promise<void>;
  configUi(opts: RunnerConfigUiOptions): Promise<ConnectorConfigUiResult>;
  close(): Promise<void>;
}

// ── In-process session (manually registered definitions) ───────────────

export class InProcessRunnerSession implements RunnerSession {
  constructor(private definition: ConnectorDefinition) {}

  requirementIds(): string[] {
    return Object.keys(this.definition.requirements ?? {});
  }

  async check(
    ids: string[],
    ctx: ConnectorRequirementContext,
  ): Promise<Record<string, ConnectorRequirementStatus | null>> {
    const records: Record<string, ConnectorRequirementStatus | null> = {};
    for (const id of ids) {
      const handler = this.definition.requirements?.[id];
      if (!handler) {
        records[id] = null;
        continue;
      }
      try {
        records[id] = await handler.check(ctx);
      } catch (err) {
        records[id] = { status: "error", message: errorMessage(err) };
      }
    }
    return records;
  }

  async request(
    id: string,
    ctx: ConnectorRequirementContext,
  ): Promise<ConnectorRequirementStatus | null> {
    const handler = this.definition.requirements?.[id];
    if (!handler) return null;
    try {
      return handler.request ? await handler.request(ctx) : await handler.check(ctx);
    } catch (err) {
      return { status: "error", message: errorMessage(err) };
    }
  }

  async run(opts: RunnerRunOptions): Promise<void> {
    const caps = opts.capabilities;
    await this.definition.run({
      guard: {
        writeEvent: (event) => caps.writeEvent(event) as Promise<{ id: string }>,
        writeEvents: (events) => caps.writeEvents(events) as Promise<{ ids: string[] }>,
        writeTextBlob: (input) => caps.writeTextBlob(input) as Promise<ConnectorTextBlobResult>,
      },
      state: {
        get: () => caps.stateGet(),
        set: (value) => caps.stateSet(value),
      },
      warnings: {
        set: (warning) => caps.warningSet(warning),
        clear: (key) => caps.warningClear(key),
      },
      auth: caps.authType === "none"
        ? { type: "none" }
        : { type: caps.authType as "apiKey" | "oauth2" | "managedProvider", getToken: () => caps.authGetToken() },
      config: opts.config,
      host: opts.host,
      signal: opts.signal,
    });
  }

  async configUi(opts: RunnerConfigUiOptions): Promise<ConnectorConfigUiResult> {
    if (!this.definition.configUi) {
      throw new Error("Connector does not implement configUi(context)");
    }
    return await this.definition.configUi({
      panelId: opts.panelId,
      config: opts.config,
      configStore: {
        get: () => opts.capabilities.configGet(),
        replace: (value) => opts.capabilities.configReplace(value),
        patch: (value) => opts.capabilities.configPatch(value),
      },
      state: {
        get: () => opts.capabilities.stateGet(),
        set: (value) => opts.capabilities.stateSet(value),
      },
      host: opts.host,
      signal: opts.signal,
    });
  }

  async close(): Promise<void> {}
}

// ── Process session (workspace package connectors) ─────────────────────

const RUNNER_CHILD_PATH = resolveRunnerChildPath();
const DEFAULT_KILL_GRACE_MS = 3_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const CONNECTOR_OS_ENV_KEYS = [
  // Executable and user-directory discovery used by bundled Connectors.
  "PATH",
  "HOME",
  // Temporary-directory conventions across POSIX and Windows.
  "TMPDIR",
  "TMP",
  "TEMP",
  // Standard locale categories and time-zone context.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "__CF_USER_TEXT_ENCODING",
  // Minimal Windows process and user-directory context.
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

function connectorRunnerEnvironment(source = process.env): NodeJS.ProcessEnv {
  // Start empty: Connector configuration, credentials, and capabilities are
  // brokered inputs, never ambient Host process state. In particular this
  // excludes unknown secrets, proxy/Git/SSH variables, and NODE_OPTIONS.
  const env: NodeJS.ProcessEnv = {};
  for (const key of CONNECTOR_OS_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }

  // The Electron executable is intentionally used as a plain Node runtime.
  // Do not let private Host environment choose a different child mode.
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

export interface ProcessRunnerSessionOptions {
  entryPath: string;
  contentHash: string;
  cwd: string;
  /** Test/embedding override; production uses the bundled Node runner. */
  runnerEntryPath?: string;
  /** Test/embedding override; production inherits the current Node 24 binary. */
  runnerExecPath?: string;
  killGraceMs?: number;
  // Bounded commands (spawn handshake, load, check, request) fail and kill
  // the child after this long. run() is unbounded by design.
  commandTimeoutMs?: number;
}

interface PendingCommand {
  expect: Set<RunnerToHostMessage["type"]>;
  resolve(message: RunnerToHostMessage): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class ProcessRunnerSession implements RunnerSession {
  private proc: ChildProcess | undefined;
  private pending: PendingCommand | undefined;
  private inbox: RunnerToHostMessage[] = [];
  private capabilities: (RunnerCapabilities | RunnerConfigUiCapabilities) | undefined;
  private reqIds: string[] = [];
  private exited = false;
  private killGraceMs: number;
  private commandTimeoutMs: number;
  private abortSignal: AbortSignal | undefined;
  private onSessionAbort = () => {
    this.forceKill();
  };

  constructor(private opts: ProcessRunnerSessionOptions) {
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  // signal: aborting it kills the child in any phase, including a hanging
  // top-level import during load.
  async open(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Connector run was aborted");
    }
    this.abortSignal = signal;
    signal?.addEventListener("abort", this.onSessionAbort, { once: true });

    this.proc = fork(this.opts.runnerEntryPath ?? RUNNER_CHILD_PATH, [], {
      cwd: this.opts.cwd,
      execPath: this.opts.runnerExecPath,
      // Connector packages receive only the Host-constructed OS allowlist.
      // Connector authority itself is available exclusively over brokered IPC.
      env: connectorRunnerEnvironment(),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "json",
    });
    this.proc.on("message", (message) => {
      this.onMessage(message as RunnerToHostMessage);
    });
    this.proc.once("exit", (exitCode) => {
      this.exited = true;
      this.failPending(new Error(`Connector runner exited unexpectedly (code ${exitCode ?? "unknown"})`));
    });
    this.proc.once("error", (error) => {
      if (!this.exited) {
        this.exited = true;
        this.failPending(error);
      }
    });

    try {
      await this.expect(["hello"]);
      const loaded = await this.command(
        { type: "load", entryPath: this.opts.entryPath, contentHash: this.opts.contentHash },
        ["loaded", "load-error"],
      );
      if (loaded.type === "load-error") {
        throw new Error(loaded.message);
      }
      if (loaded.type === "loaded") {
        this.reqIds = loaded.requirementIds;
      }
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  requirementIds(): string[] {
    return this.reqIds;
  }

  async check(
    ids: string[],
    ctx: ConnectorRequirementContext,
  ): Promise<Record<string, ConnectorRequirementStatus | null>> {
    const reply = await this.command({ type: "check", ids, ctx }, ["checked"]);
    return reply.type === "checked" ? reply.records : {};
  }

  async request(
    id: string,
    ctx: ConnectorRequirementContext,
  ): Promise<ConnectorRequirementStatus | null> {
    const reply = await this.command({ type: "request", id, ctx }, ["requested"]);
    return reply.type === "requested" ? reply.status : null;
  }

  async run(opts: RunnerRunOptions): Promise<void> {
    this.capabilities = opts.capabilities;
    // run() owns abort handling for its duration: the session-level listener
    // would SIGKILL immediately and defeat the cooperative grace period, so it
    // steps aside until the run settles.
    this.abortSignal?.removeEventListener("abort", this.onSessionAbort);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      this.send({ type: "abort" });
      // The abort message is cooperative inside the child; the kill is not.
      killTimer = setTimeout(() => {
        this.forceKill();
      }, this.killGraceMs);
    };

    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const hasConfig = opts.config !== undefined;
      const reply = await this.command(
        {
          type: "run",
          config: hasConfig ? opts.config : null,
          configSet: hasConfig,
          host: opts.host,
          authType: opts.capabilities.authType,
        },
        ["done", "run-error"],
        { timeoutMs: 0 }, // runs are unbounded
      );
      if (reply.type === "run-error") {
        throw new Error(reply.message);
      }
    } catch (err) {
      // A kill after an ignored abort surfaces as an unexpected exit; treat it
      // as a completed abort rather than a connector failure.
      if (opts.signal.aborted) return;
      throw err;
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      this.capabilities = undefined;
      if (!this.exited && this.abortSignal && !this.abortSignal.aborted) {
        this.abortSignal.addEventListener("abort", this.onSessionAbort, { once: true });
      }
    }
  }

  async configUi(opts: RunnerConfigUiOptions): Promise<ConnectorConfigUiResult> {
    this.capabilities = opts.capabilities;
    this.abortSignal?.removeEventListener("abort", this.onSessionAbort);
    const onAbort = () => {
      this.send({ type: "abort" });
      this.forceKill();
    };

    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const hasConfig = opts.config !== undefined;
      const reply = await this.command(
        {
          type: "configUi",
          panelId: opts.panelId,
          config: hasConfig ? opts.config : null,
          configSet: hasConfig,
          host: opts.host,
        },
        ["config-ui-ready", "config-ui-error"],
      );
      if (reply.type === "config-ui-error") {
        throw new Error(reply.message);
      }
      if (reply.type !== "config-ui-ready") {
        throw new Error("Connector config UI did not return a URL");
      }
      return { url: reply.url };
    } catch (err) {
      this.capabilities = undefined;
      if (opts.signal.aborted) {
        throw new Error("Connector config UI was aborted");
      }
      throw err;
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      if (!this.exited && this.abortSignal && !this.abortSignal.aborted) {
        this.abortSignal.addEventListener("abort", this.onSessionAbort, { once: true });
      }
    }
  }

  async close(): Promise<void> {
    this.abortSignal?.removeEventListener("abort", this.onSessionAbort);
    const proc = this.proc;
    if (!proc) return;
    if (this.exited) return;
    if (!this.exited) {
      // The child has no shutdown obligations (state writes complete over RPC
      // before done), so closing is always a hard kill.
      this.forceKill();
    }
    await waitForChildSettlement(proc, Math.max(this.killGraceMs, 1_000));
  }

  private forceKill(): void {
    if (!this.exited) {
      this.proc?.kill("SIGKILL");
    }
  }

  private send(message: HostToRunnerMessage): void {
    this.proc?.send(message);
  }

  private failPending(err: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private expect(types: Array<RunnerToHostMessage["type"]>): Promise<RunnerToHostMessage> {
    return this.await(types);
  }

  private command(
    message: HostToRunnerMessage,
    expect: Array<RunnerToHostMessage["type"]>,
    opts?: { timeoutMs?: number },
  ): Promise<RunnerToHostMessage> {
    if (this.exited) {
      return Promise.reject(new Error("Connector runner process has exited"));
    }
    const promise = this.await(expect, opts);
    this.send(message);
    return promise;
  }

  private await(
    expect: Array<RunnerToHostMessage["type"]>,
    opts?: { timeoutMs?: number },
  ): Promise<RunnerToHostMessage> {
    const expectSet = new Set(expect);
    // Drain the inbox first so replies that landed before we started waiting
    // are not lost.
    const buffered = this.inbox.findIndex((msg) => expectSet.has(msg.type));
    if (buffered !== -1) {
      const [msg] = this.inbox.splice(buffered, 1);
      return Promise.resolve(msg);
    }
    if (this.exited) {
      return Promise.reject(new Error("Connector runner process has exited"));
    }

    const timeoutMs = opts?.timeoutMs ?? this.commandTimeoutMs;
    return new Promise<RunnerToHostMessage>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending = undefined;
          this.forceKill();
          reject(new Error(`Connector runner timed out waiting for ${[...expectSet].join("/")}`));
        }, timeoutMs)
        : undefined;
      this.pending = {
        expect: expectSet,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      };
    });
  }

  private onMessage(message: RunnerToHostMessage): void {
    if (message.type === "rpc") {
      void this.dispatchRpc(message.id, message.method, message.params);
      return;
    }
    const pending = this.pending;
    if (pending && pending.expect.has(message.type)) {
      this.pending = undefined;
      pending.resolve(message);
      return;
    }
    this.inbox.push(message);
  }

  private async dispatchRpc(id: number, method: string, params: unknown): Promise<void> {
    const caps = this.capabilities;
    try {
      if (!caps) {
        throw new Error("Connector capability call outside an active connector command");
      }
      let value: unknown;
      switch (method) {
        case "writeEvent":
          if (!("writeEvent" in caps)) throw new Error("Connector capability unavailable: writeEvent");
          value = await caps.writeEvent(params);
          break;
        case "writeEvents":
          if (!("writeEvents" in caps)) throw new Error("Connector capability unavailable: writeEvents");
          value = await caps.writeEvents(params);
          break;
        case "writeTextBlob":
          if (!("writeTextBlob" in caps)) throw new Error("Connector capability unavailable: writeTextBlob");
          value = await caps.writeTextBlob(params);
          break;
        case "stateGet":
          if (!("stateGet" in caps)) throw new Error("Connector capability unavailable: stateGet");
          value = await caps.stateGet();
          break;
        case "stateSet":
          if (!("stateSet" in caps)) throw new Error("Connector capability unavailable: stateSet");
          value = await caps.stateSet(params);
          break;
        case "authGetToken":
          if (!("authGetToken" in caps)) throw new Error("Connector capability unavailable: authGetToken");
          value = await caps.authGetToken();
          break;
        case "warningSet":
          if (!("warningSet" in caps)) throw new Error("Connector capability unavailable: warningSet");
          value = await caps.warningSet(params);
          break;
        case "warningClear":
          if (!("warningClear" in caps)) throw new Error("Connector capability unavailable: warningClear");
          value = await caps.warningClear(params);
          break;
        case "configGet":
          if (!("configGet" in caps)) throw new Error("Connector capability unavailable: configGet");
          value = await caps.configGet();
          break;
        case "configReplace":
          if (!("configReplace" in caps)) throw new Error("Connector capability unavailable: configReplace");
          value = await caps.configReplace(params);
          break;
        case "configPatch":
          if (!("configPatch" in caps)) throw new Error("Connector capability unavailable: configPatch");
          value = await caps.configPatch(params as ConnectorConfigPatch);
          break;
        default:
          throw new Error(`Unknown connector capability: ${method}`);
      }
      this.send({ type: "rpc-result", id, ok: true, value });
    } catch (err) {
      this.send({ type: "rpc-result", id, ok: false, error: errorMessage(err) });
    }
  }
}

function resolveRunnerChildPath(): string {
  if (process.env.LAMARCK_CONNECTOR_RUNNER_ENTRY) {
    return process.env.LAMARCK_CONNECTOR_RUNNER_ENTRY;
  }
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "connector-runner.cjs"),
    fileURLToPath(new URL("../../dist/connector-runner.cjs", import.meta.url)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function waitForChildSettlement(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off("error", finish);
      proc.off("exit", finish);
      proc.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    proc.once("error", finish);
    proc.once("exit", finish);
    proc.once("close", finish);
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
