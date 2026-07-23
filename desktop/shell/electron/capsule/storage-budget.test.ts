import { mkdir, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
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

  test("accounts an exact helper-side fixed-file replacement without Electron unlinking it", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-budget-replace-"));
    const state = join(root, "state.raw");
    await writeFile(state, Buffer.alloc(10));
    const existingPhysicalBytes = Number((await stat(state, { bigint: true })).blocks * 512n);
    const stateDiskBytes = 8 * 1024;
    const budget = new CapsuleStorageBudget({
      roots: [root],
      aggregateBytes: 32 * 1024,
      perAppBytes: 32 * 1024,
      filesystemReserveBytes: 0,
      dependencies: { availableBytes: async () => 100_000 },
    });

    const replacement = await budget.reserveStateDisk({
      owner: "host",
      path: state,
      stateDiskBytes,
      existingPhysicalBytes,
      additionalPhysicalBytes: stateDiskBytes,
      peakPhysicalBytes: existingPhysicalBytes + stateDiskBytes,
    });
    expect(await budget.snapshot()).toMatchObject({
      usedBytes: existingPhysicalBytes,
      reservedBytes: stateDiskBytes,
    });

    // This rename stands in for the Swift helper's lock-held atomic
    // publication. CapsuleStorageBudget only admits and reconciles it.
    const priorInode = (await stat(state)).ino;
    const staged = join(root, ".state.raw.creating");
    await writeFile(staged, Buffer.alloc(stateDiskBytes));
    await rename(staged, state);
    expect((await stat(state)).ino).not.toBe(priorInode);
    await replacement.commit();
    const replacementPhysicalBytes = Number((await stat(state, { bigint: true })).blocks * 512n);
    expect(await budget.snapshot()).toMatchObject({
      usedBytes: replacementPhysicalBytes,
      reservedBytes: 0,
      ownerUsedBytes: { host: replacementPhysicalBytes },
    });
  });

  test("reconciles helper-removed creating residue before exact peak admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-budget-state-residue-"));
    const state = join(root, "state.raw");
    const staged = join(root, ".state.raw.creating");
    await writeFile(state, Buffer.alloc(4 * 1024));
    await writeFile(staged, Buffer.alloc(8 * 1024));
    const existingPhysicalBytes = Number((await stat(state, { bigint: true })).blocks * 512n);
    const budget = new CapsuleStorageBudget({
      roots: [root],
      aggregateBytes: 32 * 1024,
      perAppBytes: 32 * 1024,
      filesystemReserveBytes: 0,
      dependencies: { availableBytes: async () => 100_000 },
    });

    // Force startup discovery while the prior helper residue still exists,
    // then model the new helper's lock-held validated reconciliation.
    expect((await budget.snapshot()).usedBytes).toBeGreaterThan(existingPhysicalBytes);
    await unlink(staged);

    const reservation = await budget.reserveStateDisk({
      owner: "host",
      path: state,
      stateDiskBytes: 8 * 1024,
      existingPhysicalBytes,
      additionalPhysicalBytes: 8 * 1024,
      peakPhysicalBytes: existingPhysicalBytes + 8 * 1024,
    });
    expect(await budget.snapshot()).toMatchObject({
      usedBytes: existingPhysicalBytes,
      reservedBytes: 8 * 1024,
    });
    await reservation.release();
  });

  test("reconcile-only startup does not reserve an unused replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-budget-state-reconcile-only-"));
    const state = join(root, "state.raw");
    await writeFile(state, Buffer.alloc(16 * 1024));
    const existingPhysicalBytes = Number((await stat(state, { bigint: true })).blocks * 512n);
    let freeSpaceChecks = 0;
    const budget = new CapsuleStorageBudget({
      roots: [root],
      aggregateBytes: existingPhysicalBytes + 1,
      perAppBytes: existingPhysicalBytes + 1,
      filesystemReserveBytes: 0,
      dependencies: {
        availableBytes: async () => {
          freeSpaceChecks += 1;
          return 0;
        },
      },
    });

    await budget.reconcileStateDisk({
      owner: "host",
      path: state,
      existingPhysicalBytes,
    });
    expect(freeSpaceChecks).toBe(0);
    expect(await budget.snapshot()).toMatchObject({
      usedBytes: existingPhysicalBytes,
      reservedBytes: 0,
    });
  });

  test("separates strict successful commit from failed-attempt reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-budget-state-outcome-"));
    const state = join(root, "state.raw");
    const stateDiskBytes = 8 * 1024;
    const budget = new CapsuleStorageBudget({
      roots: [root],
      aggregateBytes: 32 * 1024,
      perAppBytes: 32 * 1024,
      filesystemReserveBytes: 0,
      dependencies: { availableBytes: async () => 100_000 },
    });
    const reservation = await budget.reserveStateDisk({
      owner: "host",
      path: state,
      stateDiskBytes,
      existingPhysicalBytes: 0,
      additionalPhysicalBytes: stateDiskBytes,
      peakPhysicalBytes: stateDiskBytes,
    });

    await expect(reservation.commit()).rejects.toThrow("did not publish");
    await writeFile(state, Buffer.from([1]));
    await truncate(state, stateDiskBytes);
    await expect(reservation.commit()).rejects.toThrow("not fully allocated");
    await reservation.reconcileFailure();
    expect(await budget.snapshot()).toMatchObject({ reservedBytes: 0 });
  });

  test("never settles a state reservation while creating residue remains", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-budget-state-temp-"));
    const state = join(root, "state.raw");
    const staged = join(root, ".state.raw.creating");
    const stateDiskBytes = 8 * 1024;
    const budget = new CapsuleStorageBudget({
      roots: [root],
      aggregateBytes: 32 * 1024,
      perAppBytes: 32 * 1024,
      filesystemReserveBytes: 0,
      dependencies: { availableBytes: async () => 100_000 },
    });
    const reservation = await budget.reserveStateDisk({
      owner: "host",
      path: state,
      stateDiskBytes,
      existingPhysicalBytes: 0,
      additionalPhysicalBytes: stateDiskBytes,
      peakPhysicalBytes: stateDiskBytes,
    });
    await writeFile(staged, Buffer.alloc(stateDiskBytes));

    await expect(reservation.commit()).rejects.toThrow("temporary disk exists");
    await expect(reservation.reconcileFailure()).rejects.toThrow("temporary disk exists");
    await expect(reservation.release()).rejects.toThrow("temporary disk exists");
    expect((await budget.snapshot()).reservedBytes).toBe(stateDiskBytes);
    await unlink(staged);
    await reservation.release();
  });
});
