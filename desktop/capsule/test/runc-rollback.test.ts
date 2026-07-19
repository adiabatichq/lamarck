import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import {
  RuncCommandTimeoutError,
  runAuthoritativeRuncRollback,
  runAuthoritativeRuncStop,
  waitForRuncCommandResult,
} from "../src/oci/runc-driver";

const CONTAINER = `w-${"a".repeat(32)}`;
const CGROUP = `/sys/fs/cgroup/lamarck/apps/a-${"b".repeat(32)}/workloads/${CONTAINER}`;

describe("runc launch rollback", () => {
  test("stops the foreground creator before the final empty-cgroup proof", async () => {
    const order: string[] = [];
    await runAuthoritativeRuncRollback({
      containerId: CONTAINER,
      cgroupPath: CGROUP,
      timeoutMs: 5_000,
      operations: {
        killCgroup: vi.fn(async () => { order.push("cgroup.kill"); }),
        stopForeground: vi.fn(async () => { order.push("foreground.stop"); }),
        waitCgroupEmpty: vi.fn(async () => { order.push("cgroup.empty"); }),
        deleteContainer: vi.fn(async () => { order.push("runc.delete"); }),
      },
    });
    expect(order).toEqual([
      "cgroup.kill",
      "foreground.stop",
      "cgroup.empty",
      "runc.delete",
    ]);
  });

  test("attempts every safe stage and turns any failed proof into a fatal Guest error", async () => {
    const foreground = vi.fn(async () => undefined);
    const wait = vi.fn(async () => { throw new Error("still populated"); });
    const remove = vi.fn(async () => undefined);
    await expect(runAuthoritativeRuncRollback({
      containerId: CONTAINER,
      cgroupPath: CGROUP,
      timeoutMs: 5_000,
      operations: {
        killCgroup: vi.fn(async () => { throw new Error("kill denied"); }),
        stopForeground: foreground,
        waitCgroupEmpty: wait,
        deleteContainer: remove,
      },
    })).rejects.toMatchObject({
      code: "CAPSULE_RUNC_CONTAINMENT_FAILED",
      fatalGuest: true,
      storageMayBeInUse: true,
    });
    expect(foreground).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  test("turns a timed-out runc delete into fatal containment failure", async () => {
    await expect(runAuthoritativeRuncRollback({
      containerId: CONTAINER,
      cgroupPath: CGROUP,
      timeoutMs: 5_000,
      operations: {
        killCgroup: vi.fn(async () => undefined),
        stopForeground: vi.fn(async () => undefined),
        waitCgroupEmpty: vi.fn(async () => undefined),
        deleteContainer: vi.fn(async () => {
          throw new RuncCommandTimeoutError(100);
        }),
      },
    })).rejects.toMatchObject({
      code: "CAPSULE_RUNC_CONTAINMENT_FAILED",
      fatalGuest: true,
      storageMayBeInUse: true,
    });
  });
});

describe("bounded runc command settlement", () => {
  test("rejects on timeout even when SIGKILL never produces exit", async () => {
    const child = new StuckChild();
    const pending = waitForRuncCommandResult(child as unknown as ChildProcess, 100, true);
    await expect(pending).rejects.toMatchObject({
      code: "CAPSULE_RUNC_COMMAND_TIMEOUT",
      timeoutMs: 100,
    });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    // A late event must not change the already-failed command outcome.
    child.emit("exit", 0, null);
  });
});

describe("runc authoritative stop", () => {
  test("stops the foreground creator before accepting populated=0", async () => {
    const order: string[] = [];
    await runAuthoritativeRuncStop({
      containerId: CONTAINER,
      cgroupPath: CGROUP,
      timeoutMs: 5_000,
      operations: {
        killCgroup: vi.fn(async () => { order.push("cgroup.kill"); }),
        stopForeground: vi.fn(async () => { order.push("foreground.stop"); }),
        waitCgroupEmpty: vi.fn(async () => { order.push("cgroup.empty"); }),
      },
    });
    expect(order).toEqual(["cgroup.kill", "foreground.stop", "cgroup.empty"]);
  });

  test("attempts every containment stage and makes a missing proof fatal", async () => {
    const foreground = vi.fn(async () => undefined);
    const wait = vi.fn(async () => { throw new Error("still populated"); });
    await expect(runAuthoritativeRuncStop({
      containerId: CONTAINER,
      cgroupPath: CGROUP,
      timeoutMs: 5_000,
      operations: {
        killCgroup: vi.fn(async () => { throw new Error("kill denied"); }),
        stopForeground: foreground,
        waitCgroupEmpty: wait,
      },
    })).rejects.toMatchObject({
      code: "CAPSULE_RUNC_CONTAINMENT_FAILED",
      fatalGuest: true,
      storageMayBeInUse: true,
    });
    expect(foreground).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });
});

class StuckChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => false);
}
