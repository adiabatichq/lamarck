import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { runFixedCommand } from "../src/fixed-command";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
});

describe("fixed privileged command timeout", () => {
  test("waits for observed child close before allowing caller cleanup", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    let settled = false;
    const outcome = runFixedCommand("/usr/bin/fixed-helper", [], { timeoutMs: 100 }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(settled).toBe(false);

    child.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(settled).toBe(false);

    child.stdout.end();
    child.stderr.end();
    child.emit("close", null, "SIGKILL");
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/usr/bin/fixed-helper timed out after 100ms",
    );
  });

  test("kills on abort but does not settle before observed child close", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();
    let settled = false;
    const outcome = runFixedCommand("/usr/bin/fixed-helper", [], {
      signal: controller.signal,
    }).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );

    controller.abort(new Error("Build cancelled"));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(settled).toBe(false);
    child.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null, "SIGKILL");
    await expect(outcome).resolves.toMatchObject({ message: "Build cancelled" });
  });
});
