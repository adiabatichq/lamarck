import { describe, expect, test, vi } from "vitest";
import { BuildProgressQueue, CapacityExhaustedError, VmCapacityCoordinator, parseGuestCapacity } from "./capacity-coordinator";
import type { CapsuleStorageBudgetLike } from "./storage-budget";
const MiB = 1024 ** 2, GiB = 1024 ** 3;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Build progress scheduling", () => {
  test("cached D bypasses queued Build C while A/B retain both slots; Builds then resume FIFO", async () => {
    const queue = new BuildProgressQueue(), signal = new AbortController().signal;
    const a = await queue.acquire(async () => {}, signal), b = await queue.acquire(async () => {}, signal);
    const order: string[] = [];
    const c = queue.acquire(async () => { order.push("C"); }, signal);
    const d = queue.acquire(async () => { order.push("D"); }, signal, false);
    const e = queue.acquire(async () => { order.push("E"); }, signal);
    await tick(); expect(order).toEqual(["D"]);
    (await d)(); await tick(); expect(order).toEqual(["D"]);
    a(); const releaseC = await c; expect(order).toEqual(["D", "C"]);
    b(); const releaseE = await e; expect(order).toEqual(["D", "C", "E"]);
    releaseC(); releaseC(); releaseE();
  });

  test.each([false, true])("cached bypass still waits for capacity and has a finite outcome (capacity returns: %s)", async available => {
    const queue = new BuildProgressQueue(), signal = new AbortController().signal;
    const a = await queue.acquire(async () => {}, signal), b = await queue.acquire(async () => {}, signal);
    const c = queue.acquire(async () => {}, signal);
    let capacity = false;
    const admit = vi.fn(async () => { if (!capacity) throw new CapacityExhaustedError("RAM occupied"); });
    const d = queue.acquire(admit, signal, false);
    const outcome = d.then(release => release, error => error);
    await tick(); await tick(); expect(admit).toHaveBeenCalledTimes(1);
    capacity = available; a(); const releaseC = await c;
    await tick(); b(); releaseC();
    const result = await outcome;
    if (available) result(); else expect(result).toBeInstanceOf(CapacityExhaustedError);
    const attempts = admit.mock.calls.length;
    await tick(); expect(admit).toHaveBeenCalledTimes(attempts);
  });

  test.each(["failure", "cancel", "cancel-during-admission"])("non-head %s preserves C and wakes the next cached launch", async mode => {
    const queue = new BuildProgressQueue(), signal = new AbortController().signal, abort = new AbortController();
    const a = await queue.acquire(async () => {}, signal), b = await queue.acquire(async () => {}, signal);
    const admitC = vi.fn(async () => {}), c = queue.acquire(admitC, signal);
    let rejectAdmission!: (error: Error) => void;
    const admitD = vi.fn(async () => {
      if (mode === "failure") throw new Error("admission failed");
      if (mode === "cancel") throw new CapacityExhaustedError("RAM occupied");
      await new Promise<void>((_resolve, reject) => { rejectAdmission = reject; });
    });
    const d = queue.acquire(admitD, abort.signal, false).catch(error => error);
    await tick();
    const admitE = vi.fn(async () => {}), e = queue.acquire(admitE, signal, false);
    await tick();
    if (mode !== "failure") abort.abort(new Error("cancelled"));
    if (mode === "cancel-during-admission") rejectAdmission(abort.signal.reason);
    expect(await d).toBeInstanceOf(Error);
    await tick(); expect(admitE).toHaveBeenCalledTimes(1); expect(admitC).not.toHaveBeenCalled();
    const attempts = admitD.mock.calls.length;
    (await e)(); await tick(); expect(admitD).toHaveBeenCalledTimes(attempts);
    a(); (await c)(); b(); expect(admitC).toHaveBeenCalledTimes(1);
  });

  test("a release during pending non-head admission wakes its capacity retry without spinning", async () => {
    const queue = new BuildProgressQueue(), signal = new AbortController().signal;
    const a = await queue.acquire(async () => {}, signal), b = await queue.acquire(async () => {}, signal);
    const c = queue.acquire(async () => {}, signal);
    let rejectAdmission!: (error: Error) => void;
    const admit = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectAdmission = reject; }))
      .mockResolvedValue(undefined);
    const d = queue.acquire(admit, signal, false);
    await tick(); expect(admit).toHaveBeenCalledTimes(1);
    a(); rejectAdmission(new CapacityExhaustedError("stale capacity observation"));
    const releaseC = await c;
    await tick(); expect(admit).toHaveBeenCalledTimes(2);
    (await d)(); releaseC(); b();
  });

  test("cached candidates can prepare concurrently without consuming Build execution slots", async () => {
    const queue = new BuildProgressQueue();
    const releases = await Promise.all(Array.from({ length: 10 }, () => queue.acquire(async () => {}, new AbortController().signal, false)));
    const build = await queue.acquire(async () => {}, new AbortController().signal);
    releases.forEach(release => release()); build();
  });
  test("ten simultaneous requests complete with at most two active Builds", async () => {
    const queue = new BuildProgressQueue();
    let active = 0, peak = 0;
    const completed: number[] = [];
    await Promise.all(Array.from({ length: 10 }, (_, i) => (async () => {
      const release = await queue.acquire(async () => {}, new AbortController().signal);
      active++; peak = Math.max(peak, active); await tick(); completed.push(i); active--; release();
    })()));
    expect(peak).toBe(2); expect(completed).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });

  test("pressure reduces concurrency to one and retries only after finite work releases capacity", async () => {
    const queue = new BuildProgressQueue();
    const releaseFirst = await queue.acquire(async () => {}, new AbortController().signal);
    let capacity = false;
    const admit = vi.fn(async () => { if (!capacity) throw new CapacityExhaustedError("occupied"); });
    const second = queue.acquire(admit, new AbortController().signal);
    await tick(); await tick(); expect(admit).toHaveBeenCalledTimes(1);
    capacity = true; releaseFirst(); (await second)(); expect(admit).toHaveBeenCalledTimes(2);
  });

  test("genuine exhaustion has a finite outcome without waiting for an App to close", async () => {
    const queue = new BuildProgressQueue();
    const admit = vi.fn(async () => { throw new CapacityExhaustedError("Runtime capacity exhausted"); });
    await expect(queue.acquire(admit, new AbortController().signal)).rejects.toThrow(/Runtime/);
    expect(admit).toHaveBeenCalledTimes(1);
  });

  test("queued cancellation does not start work", async () => {
    const queue = new BuildProgressQueue();
    const signal = new AbortController();
    const first = await queue.acquire(async () => {}, new AbortController().signal);
    const second = await queue.acquire(async () => {}, new AbortController().signal);
    const admit = vi.fn(async () => {});
    const third = queue.acquire(admit, signal.signal);
    const observed = expect(third).rejects.toThrow(/cancel/);
    signal.abort(new Error("cancelled")); await observed;
    first(); second(); await tick(); expect(admit).not.toHaveBeenCalled();
  });

  test("non-head cancellation during admission returns ownership so the caller can release the grant", async () => {
    const queue = new BuildProgressQueue();
    const signal = new AbortController();
    const a = await queue.acquire(async () => {}, new AbortController().signal);
    const b = await queue.acquire(async () => {}, new AbortController().signal);
    const admitC = vi.fn(async () => {}), c = queue.acquire(admitC, new AbortController().signal);
    let done!: () => void;
    const request = queue.acquire(() => new Promise<void>((resolve) => { done = resolve; }), signal.signal, false);
    signal.abort(new Error("cancelled")); done(); const release = await request; release(); release();
    expect(admitC).not.toHaveBeenCalled();
    a(); (await c)(); b();
    // No phantom finite owner may leave an exhausted request waiting forever.
    await expect(queue.acquire(async () => { throw new CapacityExhaustedError("full"); }, new AbortController().signal))
      .rejects.toThrow("full");
  });
});

function fixture() {
  const state = { diskBudgetBytes: 3400 * MiB, memoryBudgetBytes: 3556 * MiB, memoryCeilingBytes: 3556 * MiB, reservedMemoryBytes: 0,
    runtimeMemoryBytes: 0, sharedBuildMemoryBytes: 512 * MiB, reservedDiskBytes: 0,
    totalBytes: 3940 * MiB, usableMemoryBytes: 3940 * MiB, availableBytes: 3000 * MiB, filesystemBytes: 4000 * MiB, freeDiskBytes: 3500 * MiB };
  const operations: string[] = [];
  let now = 0;
  const request = vi.fn(async (op: string, body: Record<string, number | string>) => {
    operations.push(op);
    if (op === "resources.memory.prepare") state.memoryBudgetBytes = Number(body.memoryBytes);
    if (op === "resources.memory.commit") state.memoryBudgetBytes = Math.min(Number(body.memoryBytes), state.totalBytes - 384 * MiB);
    if (op === "resources.launch.reserve") {
      state.reservedMemoryBytes += Math.max(Number(body.runtimeMemoryBytes), Number(body.buildMemoryBytes));
      state.runtimeMemoryBytes += Number(body.runtimeMemoryBytes);
    }
    return op === "resources.disk.grow" ? { ...state, stateCapacityBytes: Number(body.bytes) } : { ...state };
  });
  const helper = { setMemory: vi.fn(async (bytes: number) => {
    operations.push("balloon.command"); state.usableMemoryBytes = bytes - (4 * GiB - state.totalBytes); return bytes;
  }),
    growState: vi.fn(async (bytes: number) => { operations.push("backing.durable"); return bytes; }),
    acknowledgeState: vi.fn(async (bytes: number) => { operations.push("growth.commit"); return bytes; }) };
  const settle = vi.fn(async () => { operations.push("storage.settle"); });
  const storage = { reserveStateGrowth: vi.fn(async () => { operations.push("storage.reserve"); return { settle }; }) } as unknown as CapsuleStorageBudgetLike;
  const coordinator = new VmCapacityCoordinator({ request } as never, helper, storage, "/test/state.raw", 4 * GiB, 4 * GiB, () => now);
  return { coordinator, state, helper, request, operations, storage, settle, time: (value: number) => { now = value; } };
}

describe("single VM capacity acknowledgement", () => {
  test("concurrent preparations grow from usable filesystem budget and publish each reservation before the next", async () => {
    const f = fixture(); f.state.reservedDiskBytes = 2800 * MiB;
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (op, body) => {
      if (op === "resources.disk.grow") f.state.diskBudgetBytes += 950 * MiB;
      return request(op, body);
    });
    const held: number[] = [];
    await Promise.all([1, 2].map(() => f.coordinator.withDiskAdmission(400 * MiB, async () => {
      await tick(); f.state.reservedDiskBytes += 400 * MiB; held.push(f.state.reservedDiskBytes);
      expect(f.state.reservedDiskBytes).toBeLessThanOrEqual(f.state.diskBudgetBytes);
    })));
    expect(held).toEqual([3200 * MiB, 3600 * MiB]);
    expect(f.helper.growState).toHaveBeenCalledExactlyOnceWith(5 * GiB);
  });

  test("in-flight import commitments are held until completion and release is idempotent", async () => {
    const f = fixture(); f.state.reservedDiskBytes = 2800 * MiB;
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (op, body) => {
      if (op === "resources.disk.grow") f.state.diskBudgetBytes += 950 * MiB;
      return request(op, body);
    });
    const release = await f.coordinator.reserveImport(500 * MiB);
    await f.coordinator.withDiskAdmission(400 * MiB, async () => {});
    expect(f.helper.growState).toHaveBeenCalledTimes(1);
    release(); release();
    await f.coordinator.withDiskAdmission(1200 * MiB, async () => {});
    expect(f.helper.growState).toHaveBeenCalledTimes(1);
  });
  test("idle reclamation has hysteresis, preserves cache headroom, and fences admissions before ballooning", async () => {
    const f = fixture();
    f.state.reservedMemoryBytes = 1024 * MiB; f.state.runtimeMemoryBytes = 1024 * MiB;
    await f.coordinator.observeIdle(); expect(f.helper.setMemory).not.toHaveBeenCalled();
    f.time(31_000); await f.coordinator.observeIdle();
    expect(f.operations.indexOf("resources.memory.prepare")).toBeLessThan(f.operations.indexOf("balloon.command"));
    expect(f.helper.setMemory).toHaveBeenCalledWith(1856 * MiB);
    expect(f.state.memoryBudgetBytes).toBeGreaterThanOrEqual(1280 * MiB);
    f.time(32_000); await f.coordinator.observeIdle(); expect(f.helper.setMemory).toHaveBeenCalledTimes(1);
  });

  test("supply cannot promise more than the latest target", async () => {
    const f = fixture();
    f.state.memoryBudgetBytes = 256 * MiB; // MemTotal still reflects the pre-shrink size.
    await f.coordinator.reserveLaunch("launch", 256 * MiB, 512 * MiB);
    expect(f.helper.setMemory).toHaveBeenCalledWith(1344 * MiB);
    expect(f.state.memoryBudgetBytes).toBe(804 * MiB);
    expect(f.state.reservedMemoryBytes).toBe(512 * MiB);
  });

  test("disk growth acquires backing first, commits after Guest ack, and does no work below its high-water", async () => {
    const f = fixture();
    await expect(f.coordinator.growState(4.2 * GiB)).resolves.toBe(5 * GiB);
    expect(f.operations).toEqual(["storage.reserve", "backing.durable", "resources.disk.grow", "growth.commit", "storage.settle"]);
    await f.coordinator.growState(4.1 * GiB); expect(f.helper.growState).toHaveBeenCalledTimes(1);
  });

  test("unchanged MemTotal cannot acknowledge pages still held in the balloon", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.state.memoryBudgetBytes = 256 * MiB;
      f.state.usableMemoryBytes = 640 * MiB;
      f.helper.setMemory.mockImplementation(async bytes => bytes);
      const waiting = f.coordinator.reserveLaunch("delayed", 256 * MiB, 512 * MiB);
      const rejected = expect(waiting).rejects.toThrow(/did not become available/);
      await vi.advanceTimersByTimeAsync(5_100); await rejected;
      expect(f.operations).not.toContain("resources.launch.reserve");
      expect(f.operations).not.toContain("resources.memory.commit");
    } finally { vi.useRealTimers(); }
  });

  test("a pre-inflation reading cannot acknowledge a newer target while the old shrink is still in flight", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.state.memoryBudgetBytes = 256 * MiB;
      f.helper.setMemory.mockImplementation(async bytes => bytes);
      const waiting = f.coordinator.reserveLaunch("transition", 256 * MiB, 512 * MiB);
      await vi.advanceTimersByTimeAsync(100);
      expect(f.operations).not.toContain("resources.memory.commit");
      f.state.usableMemoryBytes = 1188 * MiB;
      await vi.advanceTimersByTimeAsync(100); await waiting;
      expect(f.state.reservedMemoryBytes).toBe(512 * MiB);
    } finally { vi.useRealTimers(); }
  });

  test("reconciles a launch whose successful reservation reply was lost", async () => {
    const f = fixture();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (op, body) => {
      const result = await request(op, body);
      if (op === "resources.launch.reserve") throw new Error("reply lost");
      return result;
    });
    await expect(f.coordinator.reserveLaunch("candidate", 256 * MiB, 512 * MiB)).rejects.toThrow("reply lost");
    expect(f.operations.slice(-2)).toEqual(["resources.launch.reserve", "resources.launch.release"]);
  });

  test("measured pressure admits one Build and rejects another until that Build retires", async () => {
    const f = fixture();
    Object.assign(f.state, { ioPressureAvg10: 20 });
    await f.coordinator.reserveLaunch("first", 256 * MiB, 512 * MiB);
    await expect(f.coordinator.reserveLaunch("second", 256 * MiB, 512 * MiB)).rejects.toThrow(/one concurrent Build/);
    await f.coordinator.releaseLaunch("first");
    await f.coordinator.reserveLaunch("second", 256 * MiB, 512 * MiB);
    expect(f.operations.filter(op => op === "resources.launch.reserve")).toHaveLength(2);
  });

  test("Host disk exhaustion never exposes more Guest capacity", async () => {
    const f = fixture(); f.helper.growState.mockRejectedValueOnce(new Error("ENOSPC"));
    await expect(f.coordinator.growState(5 * GiB)).rejects.toThrow("ENOSPC");
    expect(f.request).not.toHaveBeenCalled(); expect(f.settle).toHaveBeenCalledTimes(1);
    expect(f.coordinator.stateDiskBytes).toBe(4 * GiB);
  });

  test("lost Guest ack retains backing and retries the same idempotent growth", async () => {
    const f = fixture(); f.request.mockRejectedValueOnce(new Error("ack lost"));
    await expect(f.coordinator.growState(5 * GiB)).rejects.toThrow("ack lost");
    expect(f.settle).toHaveBeenCalledTimes(1);
    await f.coordinator.growState(5 * GiB);
    expect(f.helper.growState).toHaveBeenNthCalledWith(2, 5 * GiB);
    expect(f.coordinator.stateDiskBytes).toBe(5 * GiB);
  });

  test("rejects an inconsistent or unbounded Guest acknowledgement", () => {
    const f = fixture();
    expect(() => parseGuestCapacity({ ...f.state, memoryBudgetBytes: 5 * GiB })).toThrow(/Inconsistent/);
    expect(() => parseGuestCapacity({ ...f.state, totalBytes: Infinity })).toThrow(/Invalid/);
  });
});
