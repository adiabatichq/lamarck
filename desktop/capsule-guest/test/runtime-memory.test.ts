import { performance } from "node:perf_hooks";
import { describe, expect, test, vi } from "vitest";
import { GuestResourceAdmission, usableGuestMemory } from "../src/resource-admission";
import { RuntimeMemoryController } from "../src/runtime-memory";
const MiB = 1024 ** 2;
const capacity = () => new GuestResourceAdmission({ diskBudgetBytes: 10_000, memoryBudgetBytes: 3556 * MiB, sharedBuildMemoryBytes: 512 * MiB });

describe("enforced Runtime grants and complete launch reservations", () => {
  test("usable capacity excludes balloon pages even when MemTotal is unchanged", () => {
    const full = { totalBytes: 3940 * MiB, availableBytes: 500 * MiB, balloonBytes: 3072 * MiB };
    expect(usableGuestMemory(full, 3940 * MiB)).toBe(860 * MiB);
    expect(usableGuestMemory({ ...full, totalBytes: 868 * MiB }, 3940 * MiB)).toBe(860 * MiB);
    expect(usableGuestMemory({ ...full, balloonBytes: 0 }, 3940 * MiB)).toBe(3940 * MiB);
  });
  test("ten lightweight Runtimes preserve a shared Build, and real overlap admits only one Build", async () => {
    const admission = capacity();
    for (let i = 0; i < 10; i++) await admission.reserve(`app${i}`, { kind: "runtime", memoryBytes: 256 * MiB });
    const first = admission.reserveLaunch("candidate1", 256 * MiB, 512 * MiB);
    expect(() => admission.reserveLaunch("candidate2", 256 * MiB, 512 * MiB)).toThrow(/shared Build reserve|supply|supplied/);
    expect(admission.snapshot().reservedMemoryBytes).toBe(3072 * MiB);
    const build = await admission.reserve("build", { kind: "build", memoryBytes: 512 * MiB, launchKey: "candidate1" });
    expect(admission.snapshot().reservedMemoryBytes).toBe(3072 * MiB);
    build.release();
    const runtime = await admission.reserve("new", { kind: "runtime", memoryBytes: 256 * MiB, launchKey: "candidate1" });
    first.release();
    expect(admission.snapshot().reservedMemoryBytes).toBe(2816 * MiB);
    runtime.release();
    expect(admission.snapshot().reservedMemoryBytes).toBe(2560 * MiB);
  });

  test("does not grant or inflate the budget merely because supply was requested", async () => {
    const admission = capacity();
    admission.prepareMemoryCapacity(512 * MiB);
    await expect(admission.reserve("large", { memoryBytes: 600 * MiB })).rejects.toThrow(/supplied/);
    admission.acknowledgeMemoryCapacity(768 * MiB);
    await admission.reserve("large", { memoryBytes: 600 * MiB });
    expect(() => admission.prepareMemoryCapacity(512 * MiB)).toThrow(/commitment/);
    admission.acknowledgeMemoryCapacity(8 * 1024 * MiB);
    expect(admission.snapshot().memoryBudgetBytes).toBe(3556 * MiB);
  });

  test.each([192, 320])("holds the larger grant during a delayed kernel update and concurrent close (%i MiB)", async (target) => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    let finish!: (limit: number) => void;
    const pending = grant.resizeMemory!(target * MiB, () => new Promise((resolve) => { finish = resolve; }));
    expect(admission.snapshot().reservedMemoryBytes).toBe(Math.max(256, target) * MiB);
    grant.release();
    expect(admission.snapshot().reservedMemoryBytes).toBe(Math.max(256, target) * MiB);
    finish(target * MiB); await pending;
    expect(admission.snapshot().reservedMemoryBytes).toBe(0);
  });

  test("failed update rolls back only on an authoritative old-limit readback", async () => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    await expect(grant.resizeMemory!(320 * MiB, async () => 256 * MiB)).rejects.toThrow(/did not accept/);
    expect(grant.memoryBytes).toBe(256 * MiB);
    await expect(grant.resizeMemory!(320 * MiB, async () => { throw new Error("lost acknowledgement"); })).rejects.toThrow(/lost/);
    expect(grant.memoryBytes).toBe(320 * MiB);
    await expect(grant.resizeMemory!(256 * MiB, async () => { throw new Error("shrink acknowledgement lost"); })).rejects.toThrow(/lost/);
    expect(grant.memoryBytes).toBe(320 * MiB);
    await grant.resizeMemory!(256 * MiB, async () => 256 * MiB);
    expect(grant.memoryBytes).toBe(256 * MiB);
    grant.release(); expect(admission.snapshot().reservedMemoryBytes).toBe(0);
  });

  test("controller confirms kernel limits, preserves clean caches, and grows in 64 MiB increments", async () => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    let now = 0, actual = 256 * MiB, working = 160 * MiB;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const kernel = { workingBytes: async () => working,
      measure: async () => ({ usageBytes: Math.max(220 * MiB, working), anonBytes: working,
        kernelBytes: 0, pressureTotalUs: 0, highEvents: 0, maxEvents: 0 }), readLimit: async () => actual,
      writeLimit: vi.fn(async (bytes: number) => { expect(grant.memoryBytes).toBe(bytes); actual = bytes; }), writeHigh: vi.fn(async () => {}) };
    const controller = new RuntimeMemoryController(grant, kernel);
    const sample = async () => { now += 250; await controller.poll(); };
    try {
      await controller.start(); await sample(); await sample();
      expect(kernel.writeLimit).not.toHaveBeenCalled();
      working = 220 * MiB; await sample();
      expect(actual).toBe(256 * MiB);
      await sample();
      expect(actual).toBe(320 * MiB);
      for (let target = 384 * MiB; target <= 2048 * MiB; target += 64 * MiB) {
        working = actual; await sample();
        expect(actual).toBe(target - 64 * MiB);
        await sample();
        expect(actual).toBe(target);
      }
      working = actual; await sample(); await sample();
      expect(actual).toBe(2048 * MiB);
      expect(kernel.writeLimit).toHaveBeenCalledTimes(28);
    } finally {
      await controller.stop(); grant.release(); clock.mockRestore(); vi.useRealTimers();
    }
    expect(admission.snapshot().reservedMemoryBytes).toBe(0);
  });

  test("cancellation while sampling never raises a stopped workload limit", async () => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    let sample!: (used: number) => void;
    const writeLimit = vi.fn(async () => {});
    const controller = new RuntimeMemoryController(grant, { workingBytes: () => new Promise((resolve) => { sample = resolve; }),
      readLimit: async () => 256 * MiB, writeLimit, writeHigh: async () => {} });
    const polling = controller.poll();
    const stopped = controller.stop(); sample(400 * MiB);
    await Promise.all([polling, stopped]);
    expect(writeLimit).not.toHaveBeenCalled(); grant.release();
  });

  test.each([true, false])("pressure notifications respect available capacity and close (available: %s)", async (available) => {
    const admission = available ? capacity() : new GuestResourceAdmission({
      diskBudgetBytes: 1, memoryBudgetBytes: 768 * MiB, sharedBuildMemoryBytes: 512 * MiB });
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    let now = 0, actual = 256 * MiB, highEvents = 0, notify!: () => void;
    const stopWatch = vi.fn();
    const measure = vi.fn(async () => ({ usageBytes: 230 * MiB, anonBytes: 220 * MiB,
      kernelBytes: 0, pressureTotalUs: 0, highEvents, maxEvents: 0 }));
    const writeLimit = vi.fn(async (bytes: number) => { actual = bytes; });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const controller = new RuntimeMemoryController(grant, {
      workingBytes: async () => 230 * MiB, measure, readLimit: async () => actual,
      writeLimit, writeHigh: async () => {},
      watchPressure: (observe) => { notify = observe; return stopWatch; },
    });
    try {
      await controller.start(); await controller.poll();
      now = 60; highEvents++; notify(); await controller.poll();
      expect(actual).toBe((available ? 320 : 256) * MiB);
      expect(writeLimit).toHaveBeenCalledTimes(available ? 1 : 0);
      const observations = measure.mock.calls.length;
      now = available ? 70 : 200; highEvents++; notify();
      expect(measure).toHaveBeenCalledTimes(observations);
      await controller.stop();
      expect(stopWatch).toHaveBeenCalledOnce();
      now = 1000; notify(); await controller.poll();
      expect(measure).toHaveBeenCalledTimes(observations);
    } finally {
      await controller.stop(); grant.release(); clock.mockRestore(); vi.useRealTimers();
    }
    expect(admission.snapshot().reservedMemoryBytes).toBe(0);
  });

  test("exhaustion denies the increment before touching the kernel", async () => {
    const admission = new GuestResourceAdmission({ diskBudgetBytes: 1, memoryBudgetBytes: 768 * MiB, sharedBuildMemoryBytes: 512 * MiB });
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    const apply = vi.fn(async () => 320 * MiB);
    await expect(grant.resizeMemory!(320 * MiB, apply)).rejects.toThrow(/Build reserve/);
    expect(apply).not.toHaveBeenCalled(); expect(grant.memoryBytes).toBe(256 * MiB);
  });

  test("an effective kernel grant outside the transaction is a substrate containment fault", async () => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    await expect(grant.resizeMemory!(320 * MiB, async () => 1024 * MiB)).rejects.toMatchObject({ fatalGuest: true });
    expect(grant.memoryBytes).toBe(320 * MiB);
    grant.release();
  });

  test.each(["clean", "dirty", "burst", "partial", "stop"] as const)("idle file-cache recovery handles %s without overcommitting", async scenario => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    let now = 0, actual = 256 * MiB, usage = 170 * MiB, observations = 0;
    let finish!: () => void;
    const reclaimCache = vi.fn(async () => {
      if (scenario === "stop") await new Promise<void>(resolve => { finish = resolve; });
      usage = (scenario === "partial" ? 165 : 145) * MiB;
    });
    const kernel = {
      measure: async () => {
        if (now >= 10_000 && ++observations > 1 && scenario === "burst") usage = 230 * MiB;
        return { usageBytes: usage, anonBytes: 138 * MiB, kernelBytes: 6 * MiB,
          inactiveFileBytes: 26 * MiB, dirtyFileBytes: scenario === "dirty" ? MiB : 0, writebackFileBytes: 0,
          pressureTotalUs: 0, highEvents: 0, maxEvents: 0 };
      },
      workingBytes: async () => usage,
      readLimit: async () => actual,
      writeLimit: vi.fn(async (bytes: number) => { actual = bytes; }),
      writeHigh: vi.fn(async () => {}), reclaimCache,
    };
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const controller = new RuntimeMemoryController(grant, kernel);
    try {
      for (now = 0; now < 10_000; now += 250) await controller.poll();
      expect(reclaimCache).not.toHaveBeenCalled();
      const pending = controller.poll();
      if (scenario === "stop") {
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        const stopped = controller.stop();
        expect(grant.memoryBytes).toBe(256 * MiB);
        finish(); await stopped;
      }
      await pending;
      expect(reclaimCache).toHaveBeenCalledTimes(["dirty", "burst"].includes(scenario) ? 0 : 1);
      expect(grant.memoryBytes).toBe((scenario === "clean" ? 192 : scenario === "partial" ? 208 : scenario === "dirty" ? 224 : 256) * MiB);
      expect(actual).toBe(grant.memoryBytes);
    } finally { await controller.stop(); grant.release(); clock.mockRestore(); }
  });

  test("unused capacity stays charged until a smaller kernel limit is confirmed", async () => {
    const admission = new GuestResourceAdmission({ diskBudgetBytes: 1, memoryBudgetBytes: 448 * MiB });
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    let finish!: (limit: number) => void;
    const pending = grant.resizeMemory!(192 * MiB, () => new Promise(resolve => { finish = resolve; }));
    expect(admission.snapshot().reservedMemoryBytes).toBe(256 * MiB);
    await expect(admission.reserve("another", { kind: "runtime", memoryBytes: 256 * MiB })).rejects.toThrow(/supplied/);
    finish(192 * MiB); await pending;
    expect(admission.snapshot().reservedMemoryBytes).toBe(192 * MiB);
    const another = await admission.reserve("another", { kind: "runtime", memoryBytes: 256 * MiB });
    expect(admission.snapshot().reservedMemoryBytes).toBe(448 * MiB);
    another.release();
    grant.release();
  });

  test("stable usage can return a partial step without weakening the 20 percent headroom", async () => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    let now = 0, actual = 256 * MiB;
    const kernel = { workingBytes: async () => 170 * MiB, readLimit: async () => actual,
      writeLimit: async (bytes: number) => { actual = bytes; }, writeHigh: async () => {} };
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const controller = new RuntimeMemoryController(grant, kernel);
    try {
      for (now = 0; now < 10_000; now += 250) await controller.poll();
      expect(grant.memoryBytes).toBe(256 * MiB);
      await controller.poll();
      expect(grant.memoryBytes).toBe(224 * MiB);
      expect(admission.snapshot().reservedMemoryBytes).toBe(actual);
      expect(170 * MiB).toBeLessThanOrEqual(actual * 0.8);
    } finally { await controller.stop(); grant.release(); clock.mockRestore(); }
  });

  test.each(["steady", "recent-peak", "new-burst"] as const)("returns unused compilation headroom after one idle window (%s)", async scenario => {
    const admission = capacity();
    const others = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      admission.reserve(`small${i}`, { kind: "runtime", memoryBytes: 192 * MiB })));
    const grant = await admission.reserve("compiled", { kind: "runtime", memoryBytes: 1408 * MiB });
    let now = 0, actual = 1408 * MiB, used = 600 * MiB;
    const kernel = { workingBytes: async () => scenario === "new-burst" && now >= 10_000 ? 1200 * MiB : used,
      readLimit: async () => actual,
      writeLimit: async (bytes: number) => { actual = bytes; }, writeHigh: async () => {} };
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const controller = new RuntimeMemoryController(grant, kernel);
    try {
      for (now = 0; now < 10_000; now += 250) {
        used = (scenario === "recent-peak" && now === 5_000 ? 820 : 600) * MiB;
        await controller.poll();
      }
      expect(() => admission.reserveLaunch("next", 256 * MiB, 0)).toThrow(/Build reserve/);
      expect(actual).toBe(1408 * MiB);
      await controller.poll();
      expect(actual).toBe((scenario === "steady" ? 752 : scenario === "recent-peak" ? 1040 : 1408) * MiB);
      expect(grant.memoryBytes).toBe(actual);
      if (scenario !== "new-burst") {
        const next = admission.reserveLaunch("next", 256 * MiB, 0);
        expect(admission.snapshot().projectedRuntimeMemoryBytes).toBeLessThanOrEqual(3044 * MiB);
        next.release();
      }
    } finally { await controller.stop(); grant.release(); others.forEach(lease => lease.release()); clock.mockRestore(); }
  });

  test("unpressured cache refill does not immediately undo idle shrink; real pressure still grows", async () => {
    const grant = await capacity().reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    let now = 0, actual = 256 * MiB, usage = 140 * MiB, highEvents = 0;
    const kernel = { workingBytes: async () => usage,
      measure: async () => ({ usageBytes: usage, anonBytes: 140 * MiB, kernelBytes: 0,
        pressureTotalUs: 0, highEvents, maxEvents: 0 }), readLimit: async () => actual,
      writeLimit: async (bytes: number) => { actual = bytes; }, writeHigh: async () => {} };
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const controller = new RuntimeMemoryController(grant, kernel);
    try {
      for (now = 0; now <= 10_000; now += 250) await controller.poll();
      expect(actual).toBe(192 * MiB);
      usage = 165 * MiB;
      await controller.poll(); now += 250; await controller.poll();
      expect(actual).toBe(192 * MiB);
      highEvents++; now += 250; await controller.poll();
      expect(actual).toBe(256 * MiB);
    } finally { await controller.stop(); grant.release(); clock.mockRestore(); }
  });

  test("a live launch phase cannot return its future Runtime commitment", async () => {
    const admission = capacity();
    const launch = admission.reserveLaunch("launch", 256 * MiB, 512 * MiB);
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB, launchKey: "launch" });
    const apply = vi.fn(async () => 192 * MiB);
    await expect(grant.resizeMemory!(192 * MiB, apply)).rejects.toThrow(/independent Runtime/);
    expect(apply).not.toHaveBeenCalled();
    expect(admission.snapshot().reservedMemoryBytes).toBe(512 * MiB);
    launch.release(); await grant.resizeMemory!(192 * MiB, apply);
    expect(admission.snapshot().reservedMemoryBytes).toBe(192 * MiB);
    grant.release();
  });

  test.each(["idle", "pressure", "burst", "lost-readback", "stop"] as const)("idle reduction handles %s without prematurely releasing capacity", async (scenario) => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    let now = 0, actual = 256 * MiB, usage = 140 * MiB;
    let finish!: (used: number) => void;
    const writeLimit = vi.fn(async (bytes: number) => { actual = bytes; });
    const writeHigh = vi.fn(async () => {});
    const kernel = {
      measure: async () => ({ usageBytes: usage, anonBytes: usage, kernelBytes: 0,
        pressureTotalUs: 0, highEvents: scenario === "pressure" && now >= 5_000 ? 1 : 0, maxEvents: 0 }),
      workingBytes: () => scenario === "stop" ? new Promise<number>(resolve => { finish = resolve; })
        : Promise.resolve((scenario === "burst" ? 190 : 140) * MiB),
      readLimit: async () => {
        if (scenario === "lost-readback" && actual === 192 * MiB) throw new Error("lost readback");
        return actual;
      }, writeLimit, writeHigh,
    };
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const controller = new RuntimeMemoryController(grant, kernel);
    try {
      for (now = 0; now < 10_000; now += 250) await controller.poll();
      expect(writeLimit).not.toHaveBeenCalled();
      const pending = controller.poll();
      if (scenario === "stop") {
        await Promise.resolve(); await Promise.resolve();
        const stopped = controller.stop(); finish(140 * MiB);
        await stopped;
      }
      await pending;
      expect(grant.memoryBytes).toBe((scenario === "idle" ? 192 : 256) * MiB);
      expect(writeLimit).toHaveBeenCalledTimes(["idle", "lost-readback"].includes(scenario) ? 1 : 0);
      if (scenario === "idle") {
        // A returned step can be borrowed again when real working memory grows.
        usage = 180 * MiB; now += 500; await controller.poll(); now += 250; await controller.poll();
        expect(grant.memoryBytes).toBe(256 * MiB);
        usage = 140 * MiB;
        for (let i = 0; i < 39; i++) { now += 250; await controller.poll(); }
        expect(grant.memoryBytes).toBe(256 * MiB);
      } else if (scenario === "pressure") {
        now = 15_000; await controller.poll();
        expect(grant.memoryBytes).toBe(256 * MiB);
        now += 250; await controller.poll();
        expect(grant.memoryBytes).toBe(192 * MiB);
      } else if (scenario === "lost-readback") {
        now += 250; await controller.poll();
        expect(actual).toBe(256 * MiB);
        expect(grant.memoryBytes).toBe(256 * MiB);
      }
    } finally { await controller.stop(); grant.release(); clock.mockRestore(); }
    expect(admission.snapshot().reservedMemoryBytes).toBe(0);
  });
});
