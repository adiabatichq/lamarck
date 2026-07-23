const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

/**
 * Version of the private Host/Guest storage policy. This is deliberately
 * independent from the public App manifest and from the transport protocol.
 */
export const CAPSULE_STORAGE_PLAN_VERSION = 1 as const;

/** Every disposable filesystem capacity is rounded to this boundary. */
export const CAPSULE_STORAGE_ALIGNMENT_BYTES = 64 * MEBIBYTE;
/** Free space which is never promised to an App, Build, or Guest CAS blob. */
export const CAPSULE_GUEST_FILESYSTEM_RESERVE_BYTES = 2 * GIBIBYTE;

export const CAPSULE_BUILD_FIXED_OVERHEAD_BYTES = 512 * MEBIBYTE;
export const CAPSULE_COLD_DEPENDENCY_EXPANSION_FACTOR = 4;
export const CAPSULE_BUILD_SCRATCH_MIN_BYTES = 1 * GIBIBYTE;
export const CAPSULE_BUILD_SCRATCH_MAX_BYTES = 8 * GIBIBYTE;
export const CAPSULE_ARTIFACT_OUTPUT_MIN_BYTES = 256 * MEBIBYTE;
export const CAPSULE_ARTIFACT_OUTPUT_MAX_BYTES = 4 * GIBIBYTE;
export const CAPSULE_RUNTIME_SCRATCH_MIN_BYTES = 512 * MEBIBYTE;
export const CAPSULE_RUNTIME_SCRATCH_MAX_BYTES = 2 * GIBIBYTE;
export const CAPSULE_STORAGE_INPUT_MAX_BYTES = 8 * GIBIBYTE;

/** State-disk growth remains bounded by the Host aggregate storage policy. */
export const CAPSULE_STATE_CAPACITY_MIN_BYTES = 4 * GIBIBYTE;
export const CAPSULE_STATE_CAPACITY_MAX_BYTES = 64 * GIBIBYTE;

export type CapsuleBuildStorageInput =
  | {
    mode: "cold";
    packageBytes: number;
    dependencyBytes: number;
  }
  | {
    mode: "warm";
    packageBytes: number;
    baseArtifactBytes: number;
  };

export interface CapsuleBuildStoragePlan {
  readonly version: typeof CAPSULE_STORAGE_PLAN_VERSION;
  readonly scratchBytes: number;
  readonly artifactOutputBytes: number;
}

export interface CapsuleRuntimeStoragePlan {
  readonly version: typeof CAPSULE_STORAGE_PLAN_VERSION;
  readonly scratchBytes: number;
}

/** A Guest-CAS identity. Callers include the blob kind in `key`. */
export interface CapsuleRetainedBlob {
  readonly key: string;
  readonly bytes: number;
}

/** Existing live Runtime storage which a Build or new Runtime must coexist with. */
export interface CapsuleLiveRuntimeStorageLease {
  readonly artifact: CapsuleRetainedBlob;
  readonly scratchBytes: number;
}

export interface CapsuleStateCapacityPlan {
  readonly version: typeof CAPSULE_STORAGE_PLAN_VERSION;
  /** Exact worst-case bytes which may coexist for the requested operation. */
  readonly peakBytes: number;
  /** `peakBytes` rounded up to the bounded state-disk growth alignment. */
  readonly stateDiskBytes: number;
}

export class CapsuleStoragePlanError extends Error {
  readonly code = "CAPSULE_STORAGE_PLAN_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CapsuleStoragePlanError";
  }
}

/**
 * Derive the only accepted Build filesystem policy from authenticated input
 * lengths. A cold dependency bundle is compressed, so its planning weight is
 * four times its transferred length. Inputs whose complete peak cannot fit in
 * the bounded Build volume are rejected instead of being silently clamped.
 */
export function createCapsuleBuildStoragePlan(
  input: CapsuleBuildStorageInput,
): CapsuleBuildStoragePlan {
  const packageBytes = inputBytes(input.packageBytes, "packageBytes");
  const inputWorkingBytes = input.mode === "cold"
    ? safeAdd(
        packageBytes,
        safeMultiply(
          inputBytes(input.dependencyBytes, "dependencyBytes"),
          CAPSULE_COLD_DEPENDENCY_EXPANSION_FACTOR,
          "expanded dependency bytes",
        ),
        "Build working input",
      )
    : safeAdd(
        packageBytes,
        inputBytes(input.baseArtifactBytes, "baseArtifactBytes"),
        "Build working input",
      );
  const artifactOutputBytes = alignStorageBytes(Math.max(
    CAPSULE_ARTIFACT_OUTPUT_MIN_BYTES,
    Math.min(CAPSULE_ARTIFACT_OUTPUT_MAX_BYTES, inputWorkingBytes),
  ));
  const requiredScratchBytes = safeAdd(
    CAPSULE_BUILD_FIXED_OVERHEAD_BYTES,
    inputWorkingBytes,
    artifactOutputBytes,
    "Build scratch",
  );
  const scratchBytes = alignStorageBytes(Math.max(
    CAPSULE_BUILD_SCRATCH_MIN_BYTES,
    requiredScratchBytes,
  ));
  if (scratchBytes > CAPSULE_BUILD_SCRATCH_MAX_BYTES) {
    throw new CapsuleStoragePlanError(
      `Build inputs require ${scratchBytes} scratch bytes; maximum is ${CAPSULE_BUILD_SCRATCH_MAX_BYTES}`,
    );
  }
  return Object.freeze({
    version: CAPSULE_STORAGE_PLAN_VERSION,
    scratchBytes,
    artifactOutputBytes,
  });
}

export function createCapsuleRuntimeStoragePlan(
  artifactBytesValue: number,
): CapsuleRuntimeStoragePlan {
  const artifactBytes = inputBytes(artifactBytesValue, "artifactBytes");
  const scratchBytes = alignStorageBytes(Math.max(
    CAPSULE_RUNTIME_SCRATCH_MIN_BYTES,
    Math.min(CAPSULE_RUNTIME_SCRATCH_MAX_BYTES, artifactBytes),
  ));
  return Object.freeze({ version: CAPSULE_STORAGE_PLAN_VERSION, scratchBytes });
}

/** Recompute and require the exact Host-selected Build plan. */
export function requireCapsuleBuildStoragePlan(
  input: CapsuleBuildStorageInput,
  supplied: CapsuleBuildStoragePlan,
): CapsuleBuildStoragePlan {
  const expected = createCapsuleBuildStoragePlan(input);
  requireVersion(supplied.version);
  if (
    supplied.scratchBytes !== expected.scratchBytes
    || supplied.artifactOutputBytes !== expected.artifactOutputBytes
  ) {
    throw new CapsuleStoragePlanError("Build storage plan does not match its authenticated inputs");
  }
  return expected;
}

/** Recompute and require the exact Host-selected Runtime plan. */
export function requireCapsuleRuntimeStoragePlan(
  artifactBytes: number,
  supplied: CapsuleRuntimeStoragePlan,
): CapsuleRuntimeStoragePlan {
  const expected = createCapsuleRuntimeStoragePlan(artifactBytes);
  requireVersion(supplied.version);
  if (supplied.scratchBytes !== expected.scratchBytes) {
    throw new CapsuleStoragePlanError("Runtime storage plan does not match its authenticated artifact");
  }
  return expected;
}

/**
 * Compute the state-disk capacity needed at the Build peak. Imported blobs and
 * existing Runtime artifact leases are content-addressed and counted once by
 * key; Runtime scratch is always private and therefore counted per lease.
 * The candidate artifact output is charged in full because its digest is not
 * known before sealing and it temporarily coexists with Build scratch.
 */
export function createCapsuleBuildStateCapacityPlan(input: {
  readonly build: CapsuleBuildStorageInput;
  readonly retainedImportBlobs: readonly CapsuleRetainedBlob[];
  readonly liveRuntimeLeases: readonly CapsuleLiveRuntimeStorageLease[];
}): CapsuleStateCapacityPlan & { readonly buildPlan: CapsuleBuildStoragePlan } {
  const buildPlan = createCapsuleBuildStoragePlan(input.build);
  const retainedBlobBytes = uniqueRetainedBlobBytes([
    ...input.retainedImportBlobs,
    ...input.liveRuntimeLeases.map((lease) => lease.artifact),
  ]);
  const liveRuntimeScratchBytes = sumRuntimeScratch(input.liveRuntimeLeases);
  const peakBytes = safeAdd(
    CAPSULE_GUEST_FILESYSTEM_RESERVE_BYTES,
    retainedBlobBytes,
    liveRuntimeScratchBytes,
    buildPlan.scratchBytes,
    buildPlan.artifactOutputBytes,
    "Guest Build state peak",
  );
  return Object.freeze({
    version: CAPSULE_STORAGE_PLAN_VERSION,
    peakBytes,
    stateDiskBytes: boundedStateCapacity(peakBytes),
    buildPlan,
  });
}

/** Compute the state-disk capacity needed after adding one Runtime lease. */
export function createCapsuleRuntimeStateCapacityPlan(input: {
  readonly artifact: CapsuleRetainedBlob;
  readonly liveRuntimeLeases: readonly CapsuleLiveRuntimeStorageLease[];
}): CapsuleStateCapacityPlan & { readonly runtimePlan: CapsuleRuntimeStoragePlan } {
  const artifact = retainedBlob(input.artifact, "artifact");
  const runtimePlan = createCapsuleRuntimeStoragePlan(artifact.bytes);
  const leases = [
    ...input.liveRuntimeLeases,
    { artifact, scratchBytes: runtimePlan.scratchBytes },
  ];
  const peakBytes = safeAdd(
    CAPSULE_GUEST_FILESYSTEM_RESERVE_BYTES,
    uniqueRetainedBlobBytes(leases.map((lease) => lease.artifact)),
    sumRuntimeScratch(leases),
    "Guest Runtime state peak",
  );
  return Object.freeze({
    version: CAPSULE_STORAGE_PLAN_VERSION,
    peakBytes,
    stateDiskBytes: boundedStateCapacity(peakBytes),
    runtimePlan,
  });
}

export function alignStorageBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CapsuleStoragePlanError("storage byte count must be a nonnegative safe integer");
  }
  const remainder = value % CAPSULE_STORAGE_ALIGNMENT_BYTES;
  return remainder === 0
    ? value
    : safeAdd(value, CAPSULE_STORAGE_ALIGNMENT_BYTES - remainder, "aligned storage bytes");
}

function boundedStateCapacity(peakBytes: number): number {
  const capacity = alignStorageBytes(Math.max(CAPSULE_STATE_CAPACITY_MIN_BYTES, peakBytes));
  if (capacity > CAPSULE_STATE_CAPACITY_MAX_BYTES) {
    throw new CapsuleStoragePlanError(
      `Guest state peak ${capacity} exceeds the ${CAPSULE_STATE_CAPACITY_MAX_BYTES} byte bound`,
    );
  }
  return capacity;
}

function uniqueRetainedBlobBytes(values: readonly CapsuleRetainedBlob[]): number {
  const retained = new Map<string, number>();
  for (let index = 0; index < values.length; index += 1) {
    const value = retainedBlob(values[index]!, `retained blob ${index}`);
    const existing = retained.get(value.key);
    if (existing !== undefined && existing !== value.bytes) {
      throw new CapsuleStoragePlanError(`retained blob ${value.key} has inconsistent byte lengths`);
    }
    retained.set(value.key, value.bytes);
  }
  return safeAdd(...retained.values(), "retained Guest blobs");
}

function sumRuntimeScratch(values: readonly CapsuleLiveRuntimeStorageLease[]): number {
  return safeAdd(...values.map((lease, index) => {
    retainedBlob(lease.artifact, `live Runtime ${index} artifact`);
    const expected = createCapsuleRuntimeStoragePlan(lease.artifact.bytes);
    if (lease.scratchBytes !== expected.scratchBytes) {
      throw new CapsuleStoragePlanError(`live Runtime ${index} has a noncanonical scratch lease`);
    }
    return lease.scratchBytes;
  }), "live Runtime scratch");
}

function retainedBlob(value: CapsuleRetainedBlob, label: string): CapsuleRetainedBlob {
  if (
    !value
    || typeof value.key !== "string"
    || value.key.length < 1
    || value.key.length > 512
    || value.key.includes("\0")
  ) {
    throw new CapsuleStoragePlanError(`${label} key is invalid`);
  }
  return { key: value.key, bytes: inputBytes(value.bytes, `${label} bytes`) };
}

function requireVersion(value: number): void {
  if (value !== CAPSULE_STORAGE_PLAN_VERSION) {
    throw new CapsuleStoragePlanError(
      `unsupported storage plan version ${String(value)}`,
    );
  }
}

function inputBytes(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > CAPSULE_STORAGE_INPUT_MAX_BYTES
  ) {
    throw new CapsuleStoragePlanError(
      `${label} must be between 1 and ${CAPSULE_STORAGE_INPUT_MAX_BYTES} bytes`,
    );
  }
  return value;
}

function safeMultiply(value: number, factor: number, label: string): number {
  const result = value * factor;
  if (!Number.isSafeInteger(result)) {
    throw new CapsuleStoragePlanError(`${label} exceeds the safe integer range`);
  }
  return result;
}

function safeAdd(...valuesAndLabel: [...number[], string]): number {
  const label = valuesAndLabel.pop() as string;
  let result = 0;
  for (const value of valuesAndLabel as number[]) {
    if (!Number.isSafeInteger(value) || value < 0 || result > Number.MAX_SAFE_INTEGER - value) {
      throw new CapsuleStoragePlanError(`${label} exceeds the safe integer range`);
    }
    result += value;
  }
  return result;
}
