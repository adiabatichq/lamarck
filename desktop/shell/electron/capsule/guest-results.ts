import type { GuestEvent } from "../../../capsule/src/protocol/types";
import {
  validateArtifactDigest,
  validateOpaqueId,
} from "../../../capsule/src/protocol/validate";
import type { CapsuleGuestRuntimeExpectation } from "./guest-release";

const MAX_BLOB_BYTES = 8 * 1024 * 1024 * 1024;

export class CapsuleGuestResultError extends Error {
  constructor(readonly path: string, message: string, options?: ErrorOptions) {
    super(`${path}: ${message}`, options);
    this.name = "CapsuleGuestResultError";
  }
}

export type BlobImportPrepareResult =
  | { alreadyPresent: true }
  | { alreadyPresent: false; ready: true };

export interface SealedGuestArtifactDescriptor {
  format: "erofs-v1";
  digest: string;
  bytes: number;
  imageDigest: string;
  runtimeAbi: "capsule-node-v1";
  architecture: "arm64" | "x64";
  libc: string;
  nodeVersion: string;
  nodeModulesAbi: string;
  sourceDigest: string;
  installDigest: string;
  dependencyDigest?: string;
  fileCount: number;
}

export interface BuildDescriptorExpectation extends CapsuleGuestRuntimeExpectation {
  imageDigest: string;
  sourceDigest: string;
  installDigest: string;
  dependencyDigest?: string;
}

export interface BlobEventExpectation {
  blobHandle: string;
  digest: string;
  bytes: number;
}

export interface BuildEventExpectation {
  appHandle: string;
  buildHandle: string;
}

export interface WorkloadEventExpectation {
  appHandle: string;
  workloadHandle: string;
}

export interface WorkloadReadyEventExpectation extends WorkloadEventExpectation {
  port: number;
}

export function parseBlobImportPrepareResult(value: unknown): BlobImportPrepareResult {
  const object = plainObject(value, "result");
  if (object.alreadyPresent === true) {
    exactFields(object, "result", ["alreadyPresent"]);
    return { alreadyPresent: true };
  }
  exactFields(object, "result", ["alreadyPresent", "ready"]);
  literal(object.alreadyPresent, false, "result.alreadyPresent");
  literal(object.ready, true, "result.ready");
  return { alreadyPresent: false, ready: true };
}

export function parseBlobExportPrepareResult(value: unknown): { ready: true } {
  return trueObject(value, "ready");
}

export function parseBlobImportReleaseResult(value: unknown): { released: boolean } {
  const object = exactObject(value, "result", ["released"]);
  return { released: boolean(object.released, "result.released") };
}

export function parseBuildPrepareResult(value: unknown): { prepared: true } {
  return trueObject(value, "prepared");
}

export function parseBuildCancelResult(value: unknown): { cancelled: true } {
  return trueObject(value, "cancelled");
}

export function parseBuildOutputReleaseResult(value: unknown): { released: true } {
  return trueObject(value, "released");
}

export function parseAppPrepareResult(
  value: unknown,
): { prepared: true; reused?: true } {
  return trueWithOptionalReuse(value, "prepared");
}

export function parseAppStopResult(value: unknown): { stopped: true; reused?: true } {
  return trueWithOptionalReuse(value, "stopped");
}

export function parseWorkloadPrepareResult(
  value: unknown,
): { awaitingStreams: boolean; reused?: true } {
  const object = plainObject(value, "result");
  exactFields(object, "result", ["awaitingStreams"], ["reused"]);
  const awaitingStreams = boolean(object.awaitingStreams, "result.awaitingStreams");
  if (object.reused === undefined && awaitingStreams !== true) {
    invalid("result.awaitingStreams", "a newly prepared workload must await its streams");
  }
  if (object.reused !== undefined) literal(object.reused, true, "result.reused");
  return {
    awaitingStreams,
    ...(object.reused === true ? { reused: true as const } : {}),
  };
}

export function parseWorkloadStartResult(value: unknown): { started: true } {
  return trueObject(value, "started");
}

export function parseWorkloadStopResult(value: unknown): { stopped: true } {
  return trueObject(value, "stopped");
}

export function parseViewerAttachResult(value: unknown): { ready: true } {
  return trueObject(value, "ready");
}

export function parseViewerDetachResult(value: unknown): { detached: true } {
  return trueObject(value, "detached");
}

export function parseVmDrainResult(value: unknown): { drained: true } {
  return trueObject(value, "drained");
}

export function parsePingResult(value: unknown, expectedNonce: number): { nonce: number } {
  const object = exactObject(value, "result", ["nonce"]);
  const nonce = boundedInteger(object.nonce, "result.nonce", 0, Number.MAX_SAFE_INTEGER);
  if (nonce !== expectedNonce) invalid("result.nonce", "ping nonce does not match the request");
  return { nonce };
}

export function parseBuildDescriptor(
  value: unknown,
  expected: BuildDescriptorExpectation,
): SealedGuestArtifactDescriptor {
  const object = exactObject(
    value,
    "descriptor",
    [
      "format",
      "digest",
      "bytes",
      "imageDigest",
      "runtimeAbi",
      "architecture",
      "libc",
      "nodeVersion",
      "nodeModulesAbi",
      "sourceDigest",
      "installDigest",
      "fileCount",
    ],
    ["dependencyDigest"],
  );
  literal(object.format, "erofs-v1", "descriptor.format");
  literal(object.runtimeAbi, "capsule-node-v1", "descriptor.runtimeAbi");
  const descriptor: SealedGuestArtifactDescriptor = {
    format: "erofs-v1",
    digest: artifactDigest(object.digest, "descriptor.digest"),
    bytes: boundedInteger(object.bytes, "descriptor.bytes", 1, MAX_BLOB_BYTES),
    imageDigest: artifactDigest(object.imageDigest, "descriptor.imageDigest"),
    runtimeAbi: "capsule-node-v1",
    architecture: stringEnum(object.architecture, ["arm64", "x64"] as const, "descriptor.architecture"),
    libc: boundedPatternedString(object.libc, "descriptor.libc", /^[a-z][a-z0-9.-]{0,63}$/),
    nodeVersion: boundedPatternedString(
      object.nodeVersion,
      "descriptor.nodeVersion",
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
    ),
    nodeModulesAbi: boundedPatternedString(
      object.nodeModulesAbi,
      "descriptor.nodeModulesAbi",
      /^(?:0|[1-9]\d{0,5})$/,
    ),
    sourceDigest: artifactDigest(object.sourceDigest, "descriptor.sourceDigest"),
    installDigest: artifactDigest(object.installDigest, "descriptor.installDigest"),
    fileCount: boundedInteger(object.fileCount, "descriptor.fileCount", 1, 10_000_000),
    ...(object.dependencyDigest === undefined
      ? {}
      : { dependencyDigest: artifactDigest(object.dependencyDigest, "descriptor.dependencyDigest") }),
  };

  assertEqual(descriptor.imageDigest, expected.imageDigest, "descriptor.imageDigest", "verified Guest image");
  assertEqual(descriptor.runtimeAbi, expected.runtimeAbi, "descriptor.runtimeAbi", "runtime ABI");
  assertEqual(descriptor.architecture, expected.architecture, "descriptor.architecture", "architecture");
  assertEqual(descriptor.libc, expected.libc, "descriptor.libc", "libc ABI");
  assertEqual(descriptor.nodeVersion, expected.nodeVersion, "descriptor.nodeVersion", "Node version");
  assertEqual(
    descriptor.nodeModulesAbi,
    expected.nodeModulesAbi,
    "descriptor.nodeModulesAbi",
    "Node modules ABI",
  );
  assertEqual(descriptor.sourceDigest, expected.sourceDigest, "descriptor.sourceDigest", "source package");
  assertEqual(
    descriptor.installDigest,
    expected.installDigest,
    "descriptor.installDigest",
    "npm install inputs",
  );
  if (descriptor.dependencyDigest !== expected.dependencyDigest) {
    invalid("descriptor.dependencyDigest", "dependency bundle provenance does not match the build request");
  }
  return descriptor;
}

export function correlateBlobImportedEvent(
  event: GuestEvent,
  expected: BlobEventExpectation,
): BlobEventExpectation {
  return parseCorrelatedBlobEvent(event, "blob.imported", expected, false);
}

export function correlateBlobExportedEvent(
  event: GuestEvent,
  expected: BlobEventExpectation,
): BlobEventExpectation {
  return parseCorrelatedBlobEvent(event, "blob.exported", expected, false);
}

export function correlateBlobFailedEvent(
  event: GuestEvent,
  expected: BlobEventExpectation,
): BlobEventExpectation & { message: string } {
  return parseCorrelatedBlobEvent(event, "blob.failed", expected, true);
}

export function correlateBuildCompletedEvent(
  event: GuestEvent,
  expected: BuildDescriptorExpectation,
): SealedGuestArtifactDescriptor {
  eventType(event, "build.completed");
  // The v1 build-completed body intentionally carries immutable artifact and
  // source provenance rather than a caller-chosen build handle.
  return parseBuildDescriptor(event.body, expected);
}

export function correlateBuildProgressEvent(
  event: GuestEvent,
  expected: BuildEventExpectation,
): BuildEventExpectation & { phase: "materializing" } {
  eventType(event, "build.progress");
  const object = exactObject(event.body, "event.body", ["appHandle", "buildHandle", "phase"]);
  const result = {
    appHandle: opaqueId(object.appHandle, "event.body.appHandle"),
    buildHandle: opaqueId(object.buildHandle, "event.body.buildHandle"),
    phase: stringEnum(object.phase, ["materializing"] as const, "event.body.phase"),
  };
  correlateBuildIdentity(result, expected);
  return result;
}

export function correlateBuildFailedEvent(
  event: GuestEvent,
  expected: BuildEventExpectation,
): BuildEventExpectation & { message: string } {
  eventType(event, "build.failed");
  const object = exactObject(event.body, "event.body", ["appHandle", "buildHandle", "message"]);
  const result = {
    appHandle: opaqueId(object.appHandle, "event.body.appHandle"),
    buildHandle: opaqueId(object.buildHandle, "event.body.buildHandle"),
    message: message(object.message, "event.body.message"),
  };
  correlateBuildIdentity(result, expected);
  return result;
}

export function correlateWorkloadStartedEvent(
  event: GuestEvent,
  expected: WorkloadEventExpectation,
): WorkloadEventExpectation {
  eventType(event, "workload.started");
  const result = workloadIdentity(event.body);
  correlateWorkloadIdentity(result, expected);
  return result;
}

export function correlateWorkloadReadyEvent(
  event: GuestEvent,
  expected: WorkloadReadyEventExpectation,
): WorkloadReadyEventExpectation {
  eventType(event, "workload.ready");
  const object = exactObject(event.body, "event.body", ["appHandle", "workloadHandle", "port"]);
  const result = {
    appHandle: opaqueId(object.appHandle, "event.body.appHandle"),
    workloadHandle: opaqueId(object.workloadHandle, "event.body.workloadHandle"),
    port: boundedInteger(object.port, "event.body.port", 1, 65_535),
  };
  correlateWorkloadIdentity(result, expected);
  assertEqual(result.port, expected.port, "event.body.port", "viewer port");
  return result;
}

export function correlateWorkloadFaultedEvent(
  event: GuestEvent,
  expected: WorkloadEventExpectation,
): WorkloadEventExpectation & { message: string } {
  eventType(event, "workload.faulted");
  const object = exactObject(event.body, "event.body", ["appHandle", "workloadHandle", "message"]);
  const result = {
    appHandle: opaqueId(object.appHandle, "event.body.appHandle"),
    workloadHandle: opaqueId(object.workloadHandle, "event.body.workloadHandle"),
    message: message(object.message, "event.body.message"),
  };
  correlateWorkloadIdentity(result, expected);
  return result;
}

export function correlateWorkloadExitedEvent(
  event: GuestEvent,
  expected: WorkloadEventExpectation,
): WorkloadEventExpectation & { exitCode: number | null; signal: string | null } {
  eventType(event, "workload.exited");
  const object = exactObject(event.body, "event.body", [
    "appHandle",
    "workloadHandle",
    "exitCode",
    "signal",
  ]);
  const exitCode = object.exitCode === null
    ? null
    : boundedInteger(object.exitCode, "event.body.exitCode", 0, 255);
  const signal = object.signal === null
    ? null
    : boundedPatternedString(object.signal, "event.body.signal", /^SIG[A-Z0-9]{1,28}$/);
  if (exitCode === null && signal === null) {
    invalid("event.body", "workload exit must report an exit code or signal");
  }
  const result = {
    appHandle: opaqueId(object.appHandle, "event.body.appHandle"),
    workloadHandle: opaqueId(object.workloadHandle, "event.body.workloadHandle"),
    exitCode,
    signal,
  };
  correlateWorkloadIdentity(result, expected);
  return result;
}

function parseCorrelatedBlobEvent(
  event: GuestEvent,
  expectedType: "blob.imported" | "blob.exported",
  expected: BlobEventExpectation,
  withMessage: false,
): BlobEventExpectation;
function parseCorrelatedBlobEvent(
  event: GuestEvent,
  expectedType: "blob.failed",
  expected: BlobEventExpectation,
  withMessage: true,
): BlobEventExpectation & { message: string };
function parseCorrelatedBlobEvent(
  event: GuestEvent,
  expectedType: "blob.imported" | "blob.exported" | "blob.failed",
  expected: BlobEventExpectation,
  withMessage: boolean,
): BlobEventExpectation & { message?: string } {
  eventType(event, expectedType);
  const fields = withMessage
    ? ["blobHandle", "digest", "bytes", "message"] as const
    : ["blobHandle", "digest", "bytes"] as const;
  const object = exactObject(event.body, "event.body", fields);
  const result = {
    blobHandle: opaqueId(object.blobHandle, "event.body.blobHandle"),
    digest: artifactDigest(object.digest, "event.body.digest"),
    bytes: boundedInteger(object.bytes, "event.body.bytes", 1, MAX_BLOB_BYTES),
    ...(withMessage ? { message: message(object.message, "event.body.message") } : {}),
  };
  assertEqual(result.blobHandle, expected.blobHandle, "event.body.blobHandle", "blob handle");
  assertEqual(result.digest, expected.digest, "event.body.digest", "blob digest");
  assertEqual(result.bytes, expected.bytes, "event.body.bytes", "blob size");
  return result;
}

function trueObject<TKey extends string>(value: unknown, key: TKey): Record<TKey, true> {
  const object = exactObject(value, "result", [key]);
  literal(object[key], true, `result.${key}`);
  return { [key]: true } as Record<TKey, true>;
}

function trueWithOptionalReuse<TKey extends "prepared" | "stopped">(
  value: unknown,
  key: TKey,
): Record<TKey, true> & { reused?: true } {
  const object = exactObject(value, "result", [key], ["reused"]);
  literal(object[key], true, `result.${key}`);
  if (object.reused !== undefined) literal(object.reused, true, "result.reused");
  return {
    [key]: true,
    ...(object.reused === true ? { reused: true } : {}),
  } as Record<TKey, true> & { reused?: true };
}

function workloadIdentity(value: unknown): WorkloadEventExpectation {
  const object = exactObject(value, "event.body", ["appHandle", "workloadHandle"]);
  return {
    appHandle: opaqueId(object.appHandle, "event.body.appHandle"),
    workloadHandle: opaqueId(object.workloadHandle, "event.body.workloadHandle"),
  };
}

function correlateBuildIdentity(
  actual: BuildEventExpectation,
  expected: BuildEventExpectation,
): void {
  assertEqual(actual.appHandle, expected.appHandle, "event.body.appHandle", "App handle");
  assertEqual(actual.buildHandle, expected.buildHandle, "event.body.buildHandle", "build handle");
}

function correlateWorkloadIdentity(
  actual: WorkloadEventExpectation,
  expected: WorkloadEventExpectation,
): void {
  assertEqual(actual.appHandle, expected.appHandle, "event.body.appHandle", "App handle");
  assertEqual(
    actual.workloadHandle,
    expected.workloadHandle,
    "event.body.workloadHandle",
    "workload handle",
  );
}

function eventType<T extends GuestEvent["type"]>(event: GuestEvent, expected: T): void {
  if (event.type !== expected) invalid("event.type", `expected ${expected}`);
}

function exactObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const object = plainObject(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, "unknown field");
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      invalid(`${path}.${key}`, "required field is missing");
    }
  }
  return object;
}

function exactFields(
  object: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, "unknown field");
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      invalid(`${path}.${key}`, "required field is missing");
    }
  }
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "expected a plain object");
  return value as Record<string, unknown>;
}

function artifactDigest(value: unknown, path: string): string {
  try {
    return validateArtifactDigest(value, path);
  } catch (cause) {
    invalid(path, cause instanceof Error ? cause.message : "invalid digest");
  }
}

function opaqueId(value: unknown, path: string): string {
  try {
    return validateOpaqueId(value, path);
  } catch (cause) {
    invalid(path, cause instanceof Error ? cause.message : "invalid opaque ID");
  }
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(path, `expected an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function boundedPatternedString(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || !pattern.test(value)) {
    invalid(path, "invalid string value");
  }
  return value;
}

function message(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024) {
    invalid(path, "expected a nonempty message of at most 1024 characters");
  }
  return value;
}

function stringEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    invalid(path, `expected one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "expected a boolean");
  return value;
}

function literal<T extends string | number | boolean>(value: unknown, expected: T, path: string): void {
  if (value !== expected) invalid(path, `expected ${JSON.stringify(expected)}`);
}

function assertEqual<T>(actual: T, expected: T, path: string, description: string): void {
  if (actual !== expected) invalid(path, `${description} does not match Host-authoritative provenance`);
}

function invalid(path: string, message: string): never {
  throw new CapsuleGuestResultError(path, message);
}
