import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  CapsuleStorageAdmissionError,
  CapsuleStorageBudget,
  normalizeCapsuleStorageError,
} from "./storage-budget";

const APP_A = "a".repeat(64);
const APP_B = "b".repeat(64);

describe("Host-wide Capsule storage admission", () => {
  test("shares one aggregate quota while preserving per-App attribution", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-budget-"));
    const budget = new CapsuleStorageBudget({
      roots: [root],
      aggregateBytes: 100,
      perAppBytes: 70,
      filesystemReserveBytes: 10,
      dependencies: { availableBytes: async () => 1_000 },
    });
    const firstPath = join(root, "first");
    const first = await budget.reserve({ owner: APP_A, scope: "artifact-cas", bytes: 60 });
    await writeFile(firstPath, Buffer.alloc(60));
    await first.commit(60, firstPath);

    await expect(budget.reserve({
      owner: APP_A,
      scope: "package-snapshot",
      bytes: 11,
    })).rejects.toMatchObject({ code: "CAPSULE_STORAGE_EXHAUSTED" });

    const secondPath = join(root, "second");
    const second = await budget.reserve({ owner: APP_B, scope: "dependency-cache", bytes: 40 });
    await writeFile(secondPath, Buffer.alloc(40));
    await second.commit(40, secondPath);
    await expect(budget.reserve({
      owner: APP_B,
      scope: "dependency-cache",
      bytes: 1,
    })).rejects.toMatchObject({ code: "CAPSULE_STORAGE_EXHAUSTED" });

    expect(await budget.snapshot()).toMatchObject({
      usedBytes: 100,
      reservedBytes: 0,
      ownerUsedBytes: { [APP_A]: 60, [APP_B]: 40 },
    });
  });

  test("serializes concurrent reservations so only one race winner fits", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-budget-race-"));
    const budget = new CapsuleStorageBudget({
      roots: [root],
      aggregateBytes: 100,
      perAppBytes: 100,
      filesystemReserveBytes: 0,
      dependencies: { availableBytes: async () => 1_000 },
    });
    const results = await Promise.allSettled([
      budget.reserve({ owner: APP_A, scope: "artifact-cas", bytes: 60 }),
      budget.reserve({ owner: APP_B, scope: "artifact-cas", bytes: 60 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await budget.snapshot()).reservedBytes).toBe(60);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status === "fulfilled") await winner.value.release();
    expect((await budget.snapshot()).reservedBytes).toBe(0);
  });

  test("keeps the complete reservation until a CAS loser removes its temporary bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-budget-release-"));
    const budget = new CapsuleStorageBudget({
      roots: [root],
      aggregateBytes: 100,
      perAppBytes: 100,
      filesystemReserveBytes: 0,
      dependencies: { availableBytes: async () => 1_000 },
    });
    const reservation = await budget.reserve({ owner: APP_A, scope: "artifact-cas", bytes: 75 });
    expect((await budget.snapshot()).reservedBytes).toBe(75);
    await reservation.commit(0);
    expect(await budget.snapshot()).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
  });

  test("rejects reservations that would cross the filesystem safety reserve", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-budget-fs-"));
    const budget = new CapsuleStorageBudget({
      roots: [root],
      aggregateBytes: 1_000,
      perAppBytes: 1_000,
      filesystemReserveBytes: 100,
      dependencies: { availableBytes: async () => 149 },
    });
    await expect(budget.reserve({
      owner: APP_A,
      scope: "package-snapshot",
      bytes: 50,
    })).rejects.toThrow("fixed Host filesystem reserve");
  });

  test("accounts existing managed files and releases committed bytes through GC", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-budget-existing-"));
    const ownerDirectory = join(root, APP_A);
    await mkdir(ownerDirectory);
    const path = join(ownerDirectory, "cached");
    await writeFile(path, Buffer.alloc(20));
    const budget = new CapsuleStorageBudget({
      roots: [root],
      aggregateBytes: 100,
      perAppBytes: 50,
      filesystemReserveBytes: 0,
      dependencies: { availableBytes: async () => 1_000 },
    });
    expect((await budget.snapshot()).usedBytes).toBe(20);
    await budget.claim({ owner: APP_A, scope: "artifact-cas", path, bytes: 20 });
    expect((await budget.snapshot()).ownerUsedBytes).toEqual({ [APP_A]: 20 });
    await expect(budget.remove(root, { recursive: true })).rejects.toThrow("outside managed roots");
    expect(await budget.remove(ownerDirectory, { recursive: true })).toBe(20);
    expect(await budget.snapshot()).toMatchObject({ usedBytes: 0, ownerUsedBytes: {} });
  });

  test("normalizes native ENOSPC and EDQUOT failures", () => {
    for (const code of ["ENOSPC", "EDQUOT"]) {
      const native = Object.assign(new Error(code), { code });
      const normalized = normalizeCapsuleStorageError(native, "storage write failed");
      expect(normalized).toBeInstanceOf(CapsuleStorageAdmissionError);
      expect(normalized).toMatchObject({ code: "CAPSULE_STORAGE_EXHAUSTED" });
    }
  });

  test("keeps a rejected commit reserved until the writer explicitly releases it", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-budget-commit-"));
    const existing = join(root, "existing");
    await writeFile(existing, Buffer.alloc(10));
    const budget = new CapsuleStorageBudget({
      roots: [root],
      aggregateBytes: 100,
      perAppBytes: 100,
      filesystemReserveBytes: 0,
      dependencies: { availableBytes: async () => 1_000 },
    });
    const reservation = await budget.reserve({
      owner: APP_A,
      scope: "artifact-cas",
      bytes: 10,
    });
    await expect(reservation.commit(10, existing)).rejects.toThrow("already committed");
    expect((await budget.snapshot()).reservedBytes).toBe(10);
    await reservation.release();
    expect(await budget.snapshot()).toMatchObject({ usedBytes: 10, reservedBytes: 0 });
  });
});
