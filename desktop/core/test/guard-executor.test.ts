import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { GuardProcessExecutor } from "../src/guard-service/executor";

type RpcId = string | number;

interface DispatchMessage {
  type: "executor.dispatch";
  id: RpcId;
  method: string;
  params: unknown;
}

class FakeExecutorChild extends EventEmitter {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killedWith: NodeJS.Signals | null = null;
  readonly dispatches: DispatchMessage[] = [];
  readonly #dispatchWaiters: Array<(message: DispatchMessage) => void> = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
    queueMicrotask(() => this.emit("message", { type: "executor.ready" }));
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    if (isDispatchMessage(message)) {
      this.dispatches.push(message);
      this.#dispatchWaiters.shift()?.(message);
    } else if (isShutdownMessage(message)) {
      queueMicrotask(() => this.emitExit(0, null));
    }
    callback?.(null);
    return true;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith = signal;
    // Deliberately do not emit exit. The test controls the interval in which a
    // result already queued on IPC races with SIGKILL/process rollback.
    return true;
  }

  waitForDispatch(): Promise<DispatchMessage> {
    const existing = this.dispatches[0];
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.#dispatchWaiters.push(resolve));
  }

  emitResult(id: RpcId, result: unknown): void {
    this.emit("message", { type: "executor.result", id, result });
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (code !== null) this.exitCode = code;
    if (signal !== null) this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

describe("GuardProcessExecutor cancellation ordering", () => {
  test("ignores a cancelled owner's late result until process exit and rollback", async () => {
    const children: FakeExecutorChild[] = [];
    const executor = new GuardProcessExecutor({
      entryPath: "/unused/guard-service.cjs",
      workspacePath: "/unused/workspace",
      hardExecutionLimitMs: 5_000,
      workerFactory: () => {
        const child = new FakeExecutorChild(10_000 + children.length);
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });

    await executor.start();
    const firstChild = children[0];
    const controller = new AbortController();
    let firstSettled = false;
    const first = executor.dispatch("first", "query", {}, {
      signal: controller.signal,
    }).finally(() => {
      firstSettled = true;
    });
    await firstChild.waitForDispatch();

    const second = executor.dispatch("second", "query", {});
    controller.abort();
    expect(firstChild.killedWith).toBe("SIGKILL");

    // Simulate an executor result that was queued immediately before SIGKILL.
    // Revocation must win, and the next actor must not run before actual exit.
    firstChild.emitResult("first", [{ incorrectlyAccepted: true }]);
    await delay(0);
    expect(firstSettled).toBe(false);
    expect(children).toHaveLength(1);

    firstChild.emitExit(null, "SIGKILL");
    await expect(first).rejects.toMatchObject({ code: "GUARD_ABORTED" });

    while (children.length < 2) await delay(0);
    const secondChild = children[1];
    await secondChild.waitForDispatch();
    secondChild.emitResult("second", [{ ok: true }]);
    await expect(second).resolves.toEqual([{ ok: true }]);

    await executor.close();
  });
});

function isDispatchMessage(value: unknown): value is DispatchMessage {
  return Boolean(value && typeof value === "object"
    && (value as DispatchMessage).type === "executor.dispatch");
}

function isShutdownMessage(value: unknown): value is { type: "executor.shutdown" } {
  return Boolean(value && typeof value === "object"
    && (value as { type?: unknown }).type === "executor.shutdown");
}
