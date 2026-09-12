import { describe, expect, test, vi } from "vitest";
import {
  createCapsuleBuildStoragePlan,
  createCapsuleRuntimeStoragePlan,
} from "@lamarck/capsule";
import { GuestResourceAdmission } from "../src/resource-admission";

describe("Guest-wide resource admission", () => {
  test("accounts App, Build, CAS and workload reservations against shared budgets", async () => {
    const admission = new GuestResourceAdmission({
      diskBudgetBytes: 1_000,
      memoryBudgetBytes: 1_000,
    });
    const app = await admission.reserve("app:a", { diskBytes: 400 });
    const build = await admission.reserve("build:b", { diskBytes: 500, memoryBytes: 600 });
    const workload = await admission.reserve("workload:w", { memoryBytes: 400 });

    await expect(admission.reserve("blob:package:x", { diskBytes: 101 })).rejects.toMatchObject({
      code: "CAPSULE_RESOURCE_EXHAUSTED",
    });
    await expect(admission.reserve("workload:x", { memoryBytes: 1 })).rejects.toMatchObject({
      code: "CAPSULE_RESOURCE_EXHAUSTED",
    });
    expect(admission.snapshot()).toMatchObject({
      reservedDiskBytes: 900,
      reservedMemoryBytes: 1_000,
      reservations: 3,
    });

    build.release();
    const replacement = await admission.reserve("blob:package:x", { diskBytes: 101 });
    expect(admission.snapshot().reservedDiskBytes).toBe(501);
    app.release();
    workload.release();
    replacement.release();
    expect(admission.snapshot().reservations).toBe(0);
  });

  test("serializes concurrent reservations so capacity cannot be overcommitted", async () => {
    const admission = new GuestResourceAdmission({
      diskBudgetBytes: 100,
      memoryBudgetBytes: 100,
    });
    const results = await Promise.allSettled([
      admission.reserve("app:first", { diskBytes: 60 }),
      admission.reserve("app:second", { diskBytes: 60 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(admission.snapshot().reservedDiskBytes).toBe(60);
  });

  test("admits exactly the shared plan for a replacement Build beside a live Runtime", async () => {
    const buildPlan = createCapsuleBuildStoragePlan({
      mode: "cold",
      packageBytes: 64 * 1024 * 1024,
      dependencyBytes: 64 * 1024 * 1024,
    });
    const runtimePlan = createCapsuleRuntimeStoragePlan(128 * 1024 * 1024);
    const inputBytes = 128 * 1024 * 1024;
    const total = runtimePlan.scratchBytes
      + inputBytes
      + buildPlan.scratchBytes
      + buildPlan.artifactOutputBytes;
    const admission = new GuestResourceAdmission({
      diskBudgetBytes: total,
      memoryBudgetBytes: 1,
    });
    const liveApp = await admission.reserve("app:live", {
      diskBytes: runtimePlan.scratchBytes,
    });
    const inputs = await admission.reserve("blob:inputs", { diskBytes: inputBytes });
    const build = await admission.reserve("build:replacement", {
      diskBytes: buildPlan.scratchBytes,
    });
    const output = await admission.reserve("blob:output", {
      diskBytes: buildPlan.artifactOutputBytes,
    });

    expect(admission.snapshot().reservedDiskBytes).toBe(total);
    await expect(admission.reserve("build:overcommit", {
      diskBytes: 64 * 1024 * 1024,
    })).rejects.toMatchObject({ code: "CAPSULE_RESOURCE_EXHAUSTED" });

    output.release();
    build.release();
    inputs.release();
    liveApp.release();
    expect(admission.snapshot().reservations).toBe(0);
  });
});

const MiB = 1024 ** 2;
async function tenApps() {
  const admission = new GuestResourceAdmission({ diskBudgetBytes: 1_000, memoryBudgetBytes: Math.floor(3555.9 * MiB), sharedBuildMemoryBytes: 512 * MiB });
  const apps = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    admission.reserve(`app${i}`, { kind: "runtime", memoryBytes: (i === 9 ? 512 : 256) * MiB })));
  const replacement = { workloadKey: "app0", ownerKey: "owner" };
  return { admission, apps, replacement };
}

describe("replacement commitments", () => {
  test.each([0, 512])("the measured ten-App case reuses a %i MiB phase reservation until retirement", async buildMiB => {
    const { admission: a, apps, replacement } = await tenApps();
    a.reserveLaunch("update", 256 * MiB, buildMiB * MiB, replacement);
    const peak = (2816 + Math.max(256, buildMiB)) * MiB;
    expect(a.snapshot()).toMatchObject({ reservedMemoryBytes: peak, projectedRuntimeMemoryBytes: 2816 * MiB });
    if (buildMiB) {
      const build = await a.reserve("build", { kind: "build", memoryBytes: 512 * MiB, launchKey: "update", ownerKey: "owner" });
      await expect(a.reserve("early", { kind: "runtime", memoryBytes: 256 * MiB, launchKey: "update", ownerKey: "owner" })).rejects.toThrow(/phase|grant/);
      expect(() => a.releaseLaunch("update")).toThrow(/cleanup/);
      build.release();
    }
    const candidate = await a.reserve("candidate", { kind: "runtime", memoryBytes: 256 * MiB, launchKey: "update", ownerKey: "owner" });
    expect(a.snapshot().reservedMemoryBytes).toBe(peak);
    expect(() => a.releaseLaunch("update")).toThrow(/cleanup/);
    apps[0]!.release(); // Only authoritative termination permits this.
    a.releaseLaunch("update"); a.releaseLaunch("update");
    expect(a.snapshot()).toMatchObject({ reservedMemoryBytes: 2816 * MiB, projectedRuntimeMemoryBytes: 2816 * MiB, reservations: 10 });
    candidate.release(); apps.forEach(app => app.release());
    expect(a.snapshot().reservations).toBe(0);
  });

  test("rejects extra permanent capacity, oversized updates and double claims without changing the ledger", async () => {
    const { admission: a, replacement } = await tenApps();
    const baseline = a.snapshot();
    expect(() => a.reserveLaunch("extra", 256 * MiB, 0)).toThrow(/Build reserve/);
    expect(() => a.reserveLaunch("large", 512 * MiB, 512 * MiB, replacement)).toThrow(/Build reserve/);
    expect(() => a.reserveLaunch("stale", 256 * MiB, 0, { ...replacement, workloadKey: "missing" })).toThrow(/active/);
    expect(a.snapshot()).toEqual(baseline);
    a.reserveLaunch("first", 256 * MiB, 512 * MiB, replacement);
    const held = a.snapshot();
    expect(() => a.reserveLaunch("second", 256 * MiB, 0, replacement)).toThrow(/claimed/);
    await expect(a.reserve("wrong-app", { kind: "runtime", memoryBytes: 256 * MiB, launchKey: "first", ownerKey: "other" })).rejects.toThrow(/identity/);
    expect(a.snapshot()).toEqual(held);
    a.releaseLaunch("first");
    expect(a.snapshot()).toEqual(baseline);
  });

  test.each(["old", "candidate"])("%s growth accounts for both rollback and commit; ambiguous readback keeps the larger grant", async target => {
    const { admission: a, apps, replacement } = await tenApps();
    a.reserveLaunch("update", 256 * MiB, 512 * MiB, replacement);
    const candidate = await a.reserve("candidate", { kind: "runtime", memoryBytes: 256 * MiB, launchKey: "update", ownerKey: "owner" });
    const grant = target === "old" ? apps[0]! : candidate;
    await expect(grant.growMemory!(320 * MiB, async () => { throw new Error("readback lost"); })).rejects.toThrow(/lost/);
    expect(grant.memoryBytes).toBe(320 * MiB);
    expect(a.snapshot()).toMatchObject({ projectedRuntimeMemoryBytes: 2880 * MiB, reservedMemoryBytes: (target === "old" ? 3392 : 3328) * MiB });
    const apply = vi.fn(async () => 512 * MiB);
    await expect(grant.growMemory!(512 * MiB, apply)).rejects.toThrow(/Build reserve|supplied/);
    expect(apply).not.toHaveBeenCalled();
    candidate.release(); a.releaseLaunch("update"); // Abort preserves the old grant.
    expect(a.snapshot().reservedMemoryBytes).toBe((target === "old" ? 2880 : 2816) * MiB);
  });

  test("two cached candidates coexist, while a Build waits for actual overlap capacity", async () => {
    const { admission: a, apps, replacement } = await tenApps();
    a.reserveLaunch("first", 256 * MiB, 0, replacement);
    a.reserveLaunch("second", 256 * MiB, 0, { ...replacement, workloadKey: "app1" });
    expect(a.snapshot()).toMatchObject({ reservedMemoryBytes: 3328 * MiB, projectedRuntimeMemoryBytes: 2816 * MiB });
    expect(() => a.reserveLaunch("third", 256 * MiB, 512 * MiB, { ...replacement, workloadKey: "app2" })).toThrow(/supplied/);
    const candidate = await a.reserve("candidate", { kind: "runtime", memoryBytes: 256 * MiB, launchKey: "first", ownerKey: "owner" });
    apps[0]!.release(); a.releaseLaunch("first"); a.releaseLaunch("second");
    a.reserveLaunch("third", 256 * MiB, 512 * MiB, { ...replacement, workloadKey: "app2" });
    expect(a.snapshot().reservedMemoryBytes).toBe(3328 * MiB);
    a.releaseLaunch("third"); candidate.release();
  });

  test("a live old grant is retained through delayed growth and exit; prepared candidates cannot be claimed", async () => {
    const { admission: a, apps, replacement } = await tenApps();
    a.reserveLaunch("update", 256 * MiB, 0, replacement);
    const candidate = await a.reserve("candidate", { kind: "runtime", memoryBytes: 256 * MiB, launchKey: "update", ownerKey: "owner" });
    expect(() => a.reserveLaunch("nested", 256 * MiB, 0, { ...replacement, workloadKey: "candidate" })).toThrow(/active/);
    let finish!: (value: number) => void;
    const growing = apps[0]!.growMemory!(320 * MiB, () => new Promise(resolve => { finish = resolve; }));
    apps[0]!.release();
    expect(() => a.releaseLaunch("update")).toThrow(/cleanup/);
    expect(a.snapshot().reservedMemoryBytes).toBe(3136 * MiB);
    finish(256 * MiB); await expect(growing).rejects.toThrow(/accept/);
    a.releaseLaunch("update");
    expect(a.snapshot().reservedMemoryBytes).toBe(2816 * MiB);
    candidate.release();
  });
});
