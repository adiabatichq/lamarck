import { fork, type ChildProcess } from "node:child_process";
import { GuardServiceError } from "./engine";
import type { GuardRpcMethod } from "./protocol";

type RpcId = string | number;

interface ExecutorReadyMessage {
  type: "executor.ready";
}

interface ExecutorResultMessage {
  type: "executor.result";
  id: RpcId;
  result?: unknown;
  error?: { code: string; message: string };
}

interface ExecutorDispatchMessage {
  type: "executor.dispatch";
  id: RpcId;
  method: GuardRpcMethod;
  params: unknown;
}

interface ExecutorShutdownMessage {
  type: "executor.shutdown";
}

interface PendingDispatch {
  cancelError: GuardServiceError | null;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

interface ActiveDispatch {
  readonly id: RpcId;
  readonly child: ChildProcess;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cancelError: GuardServiceError | null;
  settled: boolean;
}

const EXECUTOR_START_TIMEOUT_MS = 10_000;
const EXECUTOR_STOP_TIMEOUT_MS = 2_000;
const EARLY_CANCELLATION_TTL_MS = 65_000;
const MAX_EARLY_CANCELLATIONS = 1024;

/**
 * Serial process boundary around the synchronous node:sqlite owner.
 *
 * Node 24 exposes neither sqlite3_interrupt() nor a VM progress handler. A
 * timer in Guard's HTTP process therefore cannot preempt DatabaseSync. The
 * executor child is the sole data.db owner; cancelling or timing out an active
 * call SIGKILLs that owner and waits for process exit (and SQLite rollback)
 * before the serial queue is allowed to continue with a fresh owner.
 */
export class GuardProcessExecutor {
  readonly #entryPath: string;
  readonly #workspacePath: string;
  readonly #hardExecutionLimitMs: number;
  readonly #workerFactory?: () => ChildProcess;
  readonly #pending = new Map<RpcId, PendingDispatch>();
  readonly #earlyCancellations = new Map<RpcId, number>();
  #child: ChildProcess | null = null;
  #starting: Promise<ChildProcess> | null = null;
  #active: ActiveDispatch | null = null;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(opts: {
    entryPath: string;
    workspacePath: string;
    hardExecutionLimitMs: number;
    /** Process factory injection used by deterministic executor state tests. */
    workerFactory?: () => ChildProcess;
  }) {
    this.#entryPath = opts.entryPath;
    this.#workspacePath = opts.workspacePath;
    this.#hardExecutionLimitMs = positiveInteger(
      opts.hardExecutionLimitMs,
      "hardExecutionLimitMs",
    );
    this.#workerFactory = opts.workerFactory;
  }

  async start(): Promise<void> {
    this.#assertOpen();
    await this.#ensureWorker();
  }

  get ready(): boolean {
    return !this.#closed && this.#child !== null && !hasExited(this.#child);
  }

  get pid(): number | undefined {
    return this.ready ? this.#child?.pid : undefined;
  }

  dispatch(
    id: RpcId,
    method: GuardRpcMethod,
    params: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.#assertOpen();
    this.#pruneEarlyCancellations();
    if (this.#pending.has(id)) {
      throw new GuardServiceError("GUARD_DUPLICATE_ID", `Guard RPC id is already active: ${id}`);
    }
    if (this.#earlyCancellations.delete(id)) {
      throw new GuardServiceError("GUARD_ABORTED", "Guard operation was cancelled before admission");
    }

    const timeoutMs = Math.min(
      opts.timeoutMs === undefined
        ? this.#hardExecutionLimitMs
        : positiveInteger(opts.timeoutMs, "timeoutMs"),
      this.#hardExecutionLimitMs,
    );
    const deadline = Date.now() + timeoutMs;
    const pending: PendingDispatch = {
      cancelError: null,
      signal: opts.signal,
    };
    if (opts.signal) {
      pending.onAbort = () => {
        this.cancel(
          id,
          new GuardServiceError("GUARD_ABORTED", "Guard operation was cancelled"),
        );
      };
      opts.signal.addEventListener("abort", pending.onAbort, { once: true });
    }
    this.#pending.set(id, pending);
    if (opts.signal?.aborted) pending.onAbort?.();

    const operation = this.#tail.then(() =>
      this.#executeQueued(id, method, params, pending, deadline)
    );
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation.finally(() => {
      pending.signal?.removeEventListener("abort", pending.onAbort!);
      this.#pending.delete(id);
    });
  }

  cancel(
    id: RpcId,
    error = new GuardServiceError("GUARD_ABORTED", "Guard operation was cancelled"),
  ): boolean {
    const pending = this.#pending.get(id);
    if (!pending) {
      // The authenticated cancellation request may overtake the original RPC
      // on another loopback connection. Retain a small, expiring tombstone so
      // that reordering can never execute work after its actor was revoked.
      this.#recordEarlyCancellation(id);
      return true;
    }
    pending.cancelError ??= error;
    if (this.#active?.id === id) {
      this.#terminateActive(pending.cancelError);
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closedError = new GuardServiceError("GUARD_CLOSED", "Guard service is closing");
    for (const id of this.#pending.keys()) this.cancel(id, closedError);
    await this.#tail;

    const child = this.#child;
    if (!child || hasExited(child)) return;
    const exited = waitForExit(child, EXECUTOR_STOP_TIMEOUT_MS);
    try {
      child.send({ type: "executor.shutdown" } satisfies ExecutorShutdownMessage, () => {});
    } catch {}
    if (await exited) return;
    child.kill("SIGKILL");
    await waitForExit(child, EXECUTOR_STOP_TIMEOUT_MS);
  }

  #recordEarlyCancellation(id: RpcId): void {
    this.#pruneEarlyCancellations();
    while (this.#earlyCancellations.size >= MAX_EARLY_CANCELLATIONS) {
      const oldest = this.#earlyCancellations.keys().next().value as RpcId | undefined;
      if (oldest === undefined) break;
      this.#earlyCancellations.delete(oldest);
    }
    this.#earlyCancellations.set(id, Date.now() + EARLY_CANCELLATION_TTL_MS);
  }

  #pruneEarlyCancellations(): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.#earlyCancellations) {
      if (expiresAt > now) continue;
      this.#earlyCancellations.delete(id);
    }
  }

  async #executeQueued(
    id: RpcId,
    method: GuardRpcMethod,
    params: unknown,
    pending: PendingDispatch,
    deadline: number,
  ): Promise<unknown> {
    if (pending.cancelError) throw pending.cancelError;
    const beforeStart = deadline - Date.now();
    if (beforeStart <= 0) throw deadlineError();

    const child = await this.#ensureWorker();
    if (pending.cancelError) throw pending.cancelError;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw deadlineError();

    return new Promise<unknown>((resolve, reject) => {
      if (this.#active) {
        reject(new GuardServiceError("GUARD_REENTRANT", "Guard executor admitted concurrent work"));
        return;
      }
      const active: ActiveDispatch = {
        id,
        child,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#terminateActive(deadlineError());
        }, remaining),
        cancelError: null,
        settled: false,
      };
      active.timer.unref?.();
      this.#active = active;

      try {
        child.send({
          type: "executor.dispatch",
          id,
          method,
          params,
        } satisfies ExecutorDispatchMessage, (error) => {
          if (error && this.#active === active) {
            this.#terminateActive(new GuardServiceError(
              "GUARD_EXECUTOR_IPC",
              `Guard executor IPC failed: ${error.message}`,
            ));
          }
        });
      } catch (error) {
        this.#terminateActive(new GuardServiceError(
          "GUARD_EXECUTOR_IPC",
          `Guard executor IPC failed: ${errorMessage(error)}`,
        ));
      }
      if (pending.cancelError) this.#terminateActive(pending.cancelError);
    });
  }

  async #ensureWorker(): Promise<ChildProcess> {
    this.#assertOpen();
    if (this.#child && !hasExited(this.#child)) return this.#child;
    if (this.#starting) return this.#starting;

    const starting = this.#spawnWorker();
    this.#starting = starting;
    try {
      const child = await starting;
      this.#child = child;
      return child;
    } finally {
      if (this.#starting === starting) this.#starting = null;
    }
  }

  #spawnWorker(): Promise<ChildProcess> {
    const child = this.#workerFactory?.() ?? fork(
      this.#entryPath,
      [this.#workspacePath],
      {
        env: executorEnvironment(),
        execArgv: [],
        serialization: "json",
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );

    child.on("message", (message) => this.#onWorkerMessage(child, message));
    child.on("exit", (code, signal) => this.#onWorkerExit(child, code, signal));
    child.on("error", (error) => {
      if (this.#active?.child === child) {
        this.#terminateActive(new GuardServiceError(
          "GUARD_EXECUTOR_ERROR",
          `Guard executor failed: ${error.message}`,
        ));
      }
    });

    return new Promise<ChildProcess>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("message", onReady);
        child.off("exit", onEarlyExit);
        child.off("error", onEarlyError);
        if (error) reject(error);
        else resolve(child);
      };
      const onReady = (message: unknown) => {
        if (isReadyMessage(message)) finish();
      };
      const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(new GuardServiceError(
          "GUARD_EXECUTOR_START",
          `Guard executor exited before readiness (${exitDetail(code, signal)})`,
        ));
      };
      const onEarlyError = (error: Error) => finish(new GuardServiceError(
        "GUARD_EXECUTOR_START",
        `Guard executor failed to start: ${error.message}`,
      ));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new GuardServiceError(
          "GUARD_EXECUTOR_START",
          "Guard executor did not become ready in time",
        ));
      }, EXECUTOR_START_TIMEOUT_MS);
      timer.unref?.();
      child.on("message", onReady);
      child.once("exit", onEarlyExit);
      child.once("error", onEarlyError);
    });
  }

  #onWorkerMessage(child: ChildProcess, message: unknown): void {
    if (!isResultMessage(message)) return;
    const active = this.#active;
    if (!active || active.child !== child || active.id !== message.id) return;
    // Cancellation/deadline wins once observed. An IPC result may already be
    // queued while SIGKILL is in flight; accepting it would both revive revoked
    // authority and release the serial queue before SQLite rollback/process
    // exit. Ignore every late result and let #onWorkerExit settle the request.
    if (active.cancelError) return;
    if (message.error) {
      this.#finishActive(active, undefined, new GuardServiceError(
        message.error.code,
        message.error.message,
      ));
      return;
    }
    this.#finishActive(active, message.result);
  }

  #onWorkerExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.#child === child) this.#child = null;
    const active = this.#active;
    if (!active || active.child !== child) return;
    this.#finishActive(
      active,
      undefined,
      active.cancelError ?? new GuardServiceError(
        "GUARD_EXECUTOR_EXIT",
        `Guard executor exited during an operation (${exitDetail(code, signal)})`,
      ),
    );
  }

  #terminateActive(error: GuardServiceError): void {
    const active = this.#active;
    if (!active || active.settled) return;
    active.cancelError ??= error;
    if (!hasExited(active.child)) active.child.kill("SIGKILL");
  }

  #finishActive(active: ActiveDispatch, result?: unknown, error?: Error): void {
    if (active.settled) return;
    active.settled = true;
    clearTimeout(active.timer);
    if (this.#active === active) this.#active = null;
    if (error) active.reject(error);
    else active.resolve(result);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new GuardServiceError("GUARD_CLOSED", "Guard service is closed");
    }
  }
}

function isReadyMessage(value: unknown): value is ExecutorReadyMessage {
  return Boolean(value && typeof value === "object" && (value as ExecutorReadyMessage).type === "executor.ready");
}

function isResultMessage(value: unknown): value is ExecutorResultMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ExecutorResultMessage>;
  return message.type === "executor.result"
    && (typeof message.id === "string" || typeof message.id === "number")
    && (message.error === undefined || (
      typeof message.error?.code === "string"
      && typeof message.error?.message === "string"
    ));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GuardServiceError("GUARD_CONFIG", `Guard: ${label} must be a positive integer`);
  }
  return value;
}

function deadlineError(): GuardServiceError {
  return new GuardServiceError("GUARD_DEADLINE", "Guard operation exceeded its execution deadline");
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

function exitDetail(code: number | null, signal: NodeJS.Signals | null): string {
  return code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function executorEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TZ: process.env.TZ,
    ELECTRON_RUN_AS_NODE: "1",
    LAMARCK_GUARD_EXECUTOR_WORKER: "1",
  };
}
