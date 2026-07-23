import { describe, expect, test } from "vitest";
import {
  CAPSULE_ARTIFACT_OUTPUT_MAX_BYTES,
  CAPSULE_BUILD_SCRATCH_MAX_BYTES,
  CAPSULE_GUEST_FILESYSTEM_RESERVE_BYTES,
  CAPSULE_RUNTIME_SCRATCH_MIN_BYTES,
  CAPSULE_STATE_CAPACITY_MIN_BYTES,
  CAPSULE_STORAGE_PLAN_VERSION,
  CapsuleStoragePlanError,
  createCapsuleBuildStateCapacityPlan,
  createCapsuleBuildStoragePlan,
  createCapsuleRuntimeStateCapacityPlan,
  createCapsuleRuntimeStoragePlan,
  requireCapsuleBuildStoragePlan,
  requireCapsuleRuntimeStoragePlan,
} from "../src/storage-plan";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("Capsule storage plan", () => {
  test("derives a cold Build from authenticated package and compressed dependency lengths", () => {
    expect(createCapsuleBuildStoragePlan({
      mode: "cold",
      packageBytes: 64 * MIB,
      dependencyBytes: 128 * MIB,
    })).toEqual({
      version: CAPSULE_STORAGE_PLAN_VERSION,
      scratchBytes: 1_664 * MIB,
      artifactOutputBytes: 576 * MIB,
    });
  });

  test("derives warm Build and Runtime storage on the same 64 MiB alignment", () => {
    expect(createCapsuleBuildStoragePlan({
      mode: "warm",
      packageBytes: 64 * MIB,
      baseArtifactBytes: 256 * MIB,
    })).toEqual({
      version: 1,
      scratchBytes: 1_152 * MIB,
      artifactOutputBytes: 320 * MIB,
    });
    expect(createCapsuleRuntimeStoragePlan(1)).toEqual({
      version: 1,
      scratchBytes: CAPSULE_RUNTIME_SCRATCH_MIN_BYTES,
    });
    expect(createCapsuleRuntimeStoragePlan(513 * MIB)).toEqual({
      version: 1,
      scratchBytes: 576 * MIB,
    });
  });

  test("rejects inputs whose complete bounded Build peak cannot fit", () => {
    expect(() => createCapsuleBuildStoragePlan({
      mode: "cold",
      packageBytes: GIB,
      dependencyBytes: 896 * MIB,
    })).toThrowError(expect.objectContaining<Partial<CapsuleStoragePlanError>>({
      code: "CAPSULE_STORAGE_PLAN_INVALID",
    }));
    expect(() => createCapsuleBuildStoragePlan({
      mode: "cold",
      packageBytes: 0,
      dependencyBytes: 1,
    })).toThrow(/packageBytes/);
  });

  test("recomputes rather than trusting Host-selected Build and Runtime sizes", () => {
    const input = { mode: "cold" as const, packageBytes: 64 * MIB, dependencyBytes: 128 * MIB };
    const expected = createCapsuleBuildStoragePlan(input);
    expect(requireCapsuleBuildStoragePlan(input, expected)).toEqual(expected);
    expect(() => requireCapsuleBuildStoragePlan(input, {
      ...expected,
      scratchBytes: expected.scratchBytes + 64 * MIB,
    })).toThrow(/does not match/);
    expect(() => requireCapsuleBuildStoragePlan(input, {
      ...expected,
      version: 2 as 1,
    })).toThrow(/unsupported storage plan version/);

    const runtime = createCapsuleRuntimeStoragePlan(64 * MIB);
    expect(requireCapsuleRuntimeStoragePlan(64 * MIB, runtime)).toEqual(runtime);
    expect(() => requireCapsuleRuntimeStoragePlan(64 * MIB, {
      ...runtime,
      scratchBytes: runtime.scratchBytes * 2,
    })).toThrow(/does not match/);
  });

  test("computes Build state peak with explicit live leases and deduplicated retained blobs", () => {
    const artifact = { key: "artifact:shared", bytes: 256 * MIB };
    const planned = createCapsuleBuildStateCapacityPlan({
      build: { mode: "cold", packageBytes: 64 * MIB, dependencyBytes: 128 * MIB },
      retainedImportBlobs: [
        { key: "package:a", bytes: 64 * MIB },
        { key: "dependency:b", bytes: 128 * MIB },
      ],
      liveRuntimeLeases: [
        { artifact, scratchBytes: 512 * MIB },
        { artifact, scratchBytes: 512 * MIB },
      ],
    });
    expect(planned.peakBytes).toBe(
      CAPSULE_GUEST_FILESYSTEM_RESERVE_BYTES
      + 64 * MIB
      + 128 * MIB
      + 256 * MIB
      + 2 * 512 * MIB
      + 1_664 * MIB
      + 576 * MIB,
    );
    expect(planned.stateDiskBytes).toBe(planned.peakBytes);
    expect(planned.buildPlan.artifactOutputBytes).toBeLessThanOrEqual(
      CAPSULE_ARTIFACT_OUTPUT_MAX_BYTES,
    );
    expect(planned.buildPlan.scratchBytes).toBeLessThanOrEqual(
      CAPSULE_BUILD_SCRATCH_MAX_BYTES,
    );
  });

  test("computes Runtime state peak and keeps a bounded minimum capacity", () => {
    const artifact = { key: "artifact:a", bytes: 256 * MIB };
    const planned = createCapsuleRuntimeStateCapacityPlan({
      artifact,
      liveRuntimeLeases: [],
    });
    expect(planned.peakBytes).toBe(
      CAPSULE_GUEST_FILESYSTEM_RESERVE_BYTES + 256 * MIB + 512 * MIB,
    );
    expect(planned.stateDiskBytes).toBe(CAPSULE_STATE_CAPACITY_MIN_BYTES);
    expect(planned.runtimePlan.scratchBytes).toBe(512 * MIB);
  });

  test("rejects inconsistent retained CAS identities and noncanonical live leases", () => {
    expect(() => createCapsuleBuildStateCapacityPlan({
      build: { mode: "warm", packageBytes: 1, baseArtifactBytes: 1 },
      retainedImportBlobs: [
        { key: "artifact:a", bytes: 1 },
        { key: "artifact:a", bytes: 2 },
      ],
      liveRuntimeLeases: [],
    })).toThrow(/inconsistent byte lengths/);
    expect(() => createCapsuleRuntimeStateCapacityPlan({
      artifact: { key: "artifact:new", bytes: 1 },
      liveRuntimeLeases: [{
        artifact: { key: "artifact:old", bytes: 1 },
        scratchBytes: GIB,
      }],
    })).toThrow(/noncanonical scratch lease/);
  });
});
