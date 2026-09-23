import { GuardEngine, GuardServiceError } from "./engine";
import type { GuardRpcMethod } from "./protocol";
import { Worker } from "node:worker_threads";

type RpcId = string | number;

interface ExecutorDispatchMessage {
  type: "executor.dispatch";
  id: RpcId;
  method: GuardRpcMethod;
  params: unknown;
}

interface ExecutorShutdownMessage {
  type: "executor.shutdown";
}

/** Run inside the disposable child that exclusively owns data.db. */
export function runGuardExecutorWorker(workspacePath: string): void {
  if (typeof process.send !== "function") {
    throw new GuardServiceError("GUARD_EXECUTOR_IPC", "Guard executor requires an IPC channel");
  }
  const parentWatchdog = startParentWatchdog(process.ppid);
  const engine = new GuardEngine({ workspacePath });
  engine.health();
  let busy = false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    void parentWatchdog.terminate();
    engine.close();
  };

  process.on("message", (message: unknown) => {
    if (isShutdownMessage(message)) {
      if (busy) return;
      close();
      process.exit(0);
    }
    if (!isDispatchMessage(message)) return;
    if (busy) {
      process.send?.({
        type: "executor.result",
        id: message.id,
        error: {
          code: "GUARD_REENTRANT",
          message: "Guard executor received concurrent work",
        },
      });
      return;
    }

    busy = true;
    try {
      const result = engine.dispatch(message.method, message.params);
      process.send?.({ type: "executor.result", id: message.id, result });
    } catch (error) {
      process.send?.({
        type: "executor.result",
        id: message.id,
        error: workerError(error),
      });
    } finally {
      busy = false;
    }
  });

  process.once("disconnect", () => {
    close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    close();
    process.exit(0);
  });
  process.send({ type: "executor.ready" });
}

/**
 * Keep parent-death containment independent of the SQLite-owning JS thread.
 * A SIGKILL of the outer Guard closes IPC, but DatabaseSync could otherwise
 * keep this orphan alive until an unbounded query returns. This tiny worker
 * remains schedulable and kills the whole executor process as soon as its
 * original parent disappears or the watchdog itself fails.
 */
function startParentWatchdog(expectedParentPid: number): { terminate(): Promise<number> } {
  if (!Number.isSafeInteger(expectedParentPid) || expectedParentPid <= 1) {
    throw new GuardServiceError("GUARD_EXECUTOR_PARENT", "Guard executor has no valid parent process");
  }
  const ready = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const watchdog = new Worker(`
    "use strict";
    const { workerData } = require("node:worker_threads");
    const ready = workerData.ready;
    const expectedParentPid = workerData.expectedParentPid;
    const killSelf = () => {
      try { process.kill(process.pid, "SIGKILL"); }
      catch { process.exit(70); }
    };
    setInterval(() => {
      if (process.ppid !== expectedParentPid) return killSelf();
      try { process.kill(expectedParentPid, 0); }
      catch { killSelf(); }
    }, 100);
    Atomics.store(ready, 0, 1);
    Atomics.notify(ready, 0);
  `, {
    eval: true,
    workerData: { expectedParentPid, ready },
  });
  if (Atomics.wait(ready, 0, 0, 2_000) === "timed-out" || Atomics.load(ready, 0) !== 1) {
    void watchdog.terminate();
    throw new GuardServiceError(
      "GUARD_EXECUTOR_PARENT",
      "Guard executor parent-death watchdog failed to start",
    );
  }
  let closing = false;
  const failClosed = () => {
    if (closing) return;
    try { process.kill(process.pid, "SIGKILL"); } catch { process.exit(70); }
  };
  watchdog.once("error", failClosed);
  watchdog.once("exit", failClosed);
  watchdog.unref();
  return {
    terminate() {
      closing = true;
      return watchdog.terminate();
    },
  };
}

function isDispatchMessage(value: unknown): value is ExecutorDispatchMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ExecutorDispatchMessage>;
  return message.type === "executor.dispatch"
    && (typeof message.id === "string" || typeof message.id === "number")
    && typeof message.method === "string"
    && message.params !== null
    && typeof message.params === "object";
}

function isShutdownMessage(value: unknown): value is ExecutorShutdownMessage {
  return Boolean(value && typeof value === "object"
    && (value as ExecutorShutdownMessage).type === "executor.shutdown");
}

function workerError(error: unknown): { code: string; message: string } {
  if (error instanceof GuardServiceError) {
    return { code: error.code, message: error.message };
  }
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      errcode?: unknown;
      errstr?: unknown;
      message?: unknown;
    };
    const code = typeof candidate.code === "string"
      ? candidate.code
      : typeof candidate.errcode === "number"
        ? `SQLITE_${candidate.errcode}`
        : "GUARD_INTERNAL";
    const detail = typeof candidate.errstr === "string" ? ` (${candidate.errstr})` : "";
    return {
      code,
      message: typeof candidate.message === "string"
        ? `${candidate.message}${detail}`
        : `Guard operation failed${detail}`,
    };
  }
  return { code: "GUARD_INTERNAL", message: String(error) };
}
