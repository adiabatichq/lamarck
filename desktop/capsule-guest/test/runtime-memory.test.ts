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

  test("holds the increment before a delayed kernel update, including a concurrent close", async () => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    let finish!: (limit: number) => void;
    const pending = grant.growMemory!(320 * MiB, () => new Promise((resolve) => { finish = resolve; }));
    expect(admission.snapshot().reservedMemoryBytes).toBe(320 * MiB);
    grant.release();
    expect(admission.snapshot().reservedMemoryBytes).toBe(320 * MiB);
    finish(320 * MiB); await pending;
    expect(admission.snapshot().reservedMemoryBytes).toBe(0);
  });

  test("failed update rolls back only on an authoritative old-limit readback", async () => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    await expect(grant.growMemory!(320 * MiB, async () => 256 * MiB)).rejects.toThrow(/did not accept/);
    expect(grant.memoryBytes).toBe(256 * MiB);
    await expect(grant.growMemory!(320 * MiB, async () => { throw new Error("lost acknowledgement"); })).rejects.toThrow(/lost/);
    expect(grant.memoryBytes).toBe(320 * MiB);
    await expect(grant.growMemory!(256 * MiB, async () => 256 * MiB)).rejects.toThrow(/cannot shrink/);
    grant.release(); expect(admission.snapshot().reservedMemoryBytes).toBe(0);
  });

  test("controller confirms kernel limits, preserves clean caches, and grows in 64 MiB increments", async () => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    let actual = 256 * MiB, working = 160 * MiB;
    const kernel = { workingBytes: async () => working, readLimit: async () => actual,
      writeLimit: vi.fn(async (bytes: number) => { expect(grant.memoryBytes).toBe(bytes); actual = bytes; }), writeHigh: vi.fn(async () => {}) };
    const controller = new RuntimeMemoryController(grant, kernel);
    await controller.start(); await controller.poll();
    expect(kernel.writeLimit).not.toHaveBeenCalled();
    working = 220 * MiB; await controller.poll();
    expect(actual).toBe(320 * MiB);
    working = 600 * MiB; await controller.poll(); await controller.poll(); await controller.poll(); await controller.poll();
    expect(actual).toBe(512 * MiB);
    await controller.stop(); grant.release();
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

  test("exhaustion denies the increment before touching the kernel", async () => {
    const admission = new GuestResourceAdmission({ diskBudgetBytes: 1, memoryBudgetBytes: 768 * MiB, sharedBuildMemoryBytes: 512 * MiB });
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    const apply = vi.fn(async () => 320 * MiB);
    await expect(grant.growMemory!(320 * MiB, apply)).rejects.toThrow(/Build reserve/);
    expect(apply).not.toHaveBeenCalled(); expect(grant.memoryBytes).toBe(256 * MiB);
  });

  test("an effective kernel grant outside the transaction is a substrate containment fault", async () => {
    const admission = capacity();
    const grant = await admission.reserve("runtime", { kind: "runtime", memoryBytes: 256 * MiB });
    await expect(grant.growMemory!(320 * MiB, async () => 1024 * MiB)).rejects.toMatchObject({ fatalGuest: true });
    expect(grant.memoryBytes).toBe(320 * MiB);
    grant.release();
  });
});
