import { describe, expect, test } from "vitest";
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
});
