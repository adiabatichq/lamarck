import { MAX_CONTROL_FRAME_BYTES } from "./codec";
import {
  CAPSULE_ARTIFACT_OUTPUT_MAX_BYTES,
  CAPSULE_ARTIFACT_OUTPUT_MIN_BYTES,
  CAPSULE_BUILD_SCRATCH_MAX_BYTES,
  CAPSULE_BUILD_SCRATCH_MIN_BYTES,
  CAPSULE_RUNTIME_SCRATCH_MAX_BYTES,
  CAPSULE_RUNTIME_SCRATCH_MIN_BYTES,
  CAPSULE_STORAGE_PLAN_VERSION,
  requireCapsuleBuildStoragePlan,
  requireCapsuleRuntimeStoragePlan,
} from "../storage-plan";
import {
  CAPSULE_PROTOCOL_VERSION,
  type AppPrepareBody,
  type ArtifactAdoptionReceipt,
  type AppStopBody,
  type BlobExportPrepareBody,
  type BlobImportPrepareBody,
  type BlobImportReleaseBody,
  type BuildCancelBody,
  type BuildOutputReleaseBody,
  type BuildPrepareBody,
  type BuildStartBody,
  type ControlResponse,
  type DataStreamPrelude,
  type GuestHello,
  type GuestReady,
  type HostInitialize,
  type HostRequest,
  type JsonValue,
  type PingBody,
  type StreamKind,
  type WorkloadKind,
  type WorkloadPrepareBody,
  type WorkloadStartBody,
  type WorkloadStopBody,
  type ViewerAttachBody,
  type ViewerDetachBody,
} from "./types";

export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const STREAM_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const APP_OWNER_KEY_PATTERN = /^[a-f0-9]{64}$/;

export type ProtocolValidationErrorCode =
  | "PROTOCOL_INVALID_TYPE"
  | "PROTOCOL_UNKNOWN_FIELD"
  | "PROTOCOL_MISSING_FIELD"
  | "PROTOCOL_INVALID_VALUE"
  | "PROTOCOL_UNSUPPORTED_VERSION"
  | "PROTOCOL_UNSUPPORTED_OPERATION";

export class ProtocolValidationError extends Error {
  readonly code: ProtocolValidationErrorCode;
  readonly path: string;

  constructor(code: ProtocolValidationErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ProtocolValidationError";
    this.code = code;
    this.path = path;
  }
}

export function parseGuestHello(value: unknown): GuestHello {
  const object = exactObject(value, "$", [
    "type",
    "protocolVersion",
    "bootId",
    "imageDigest",
    "supervisorVersion",
    "architecture",
    "features",
  ]);
  literal(object.type, "guest.hello", "$.type");
  protocolVersion(object.protocolVersion, "$.protocolVersion");
  const architecture = stringEnum(object.architecture, ["arm64", "x64"] as const, "$.architecture");
  const features = stringArray(object.features, "$.features", 32, 64);
  for (let index = 0; index < features.length; index += 1) {
    if (!/^[a-z][a-z0-9.-]*$/.test(features[index]!)) {
      invalid(`$.features[${index}]`, "feature names must be lowercase identifiers");
    }
  }
  return {
    type: "guest.hello",
    protocolVersion: CAPSULE_PROTOCOL_VERSION,
    bootId: opaqueId(object.bootId, "$.bootId"),
    imageDigest: artifactDigest(object.imageDigest, "$.imageDigest"),
    supervisorVersion: boundedString(object.supervisorVersion, "$.supervisorVersion", 1, 64),
    architecture,
    features,
  };
}

export function parseHostInitialize(value: unknown): HostInitialize {
  const object = exactObject(value, "$", [
    "type",
    "protocolVersion",
    "sessionId",
    "expectedImageDigest",
    "maxControlFrameBytes",
  ]);
  literal(object.type, "host.initialize", "$.type");
  protocolVersion(object.protocolVersion, "$.protocolVersion");
  return {
    type: "host.initialize",
    protocolVersion: CAPSULE_PROTOCOL_VERSION,
    sessionId: sessionId(object.sessionId, "$.sessionId"),
    expectedImageDigest: artifactDigest(object.expectedImageDigest, "$.expectedImageDigest"),
    maxControlFrameBytes: boundedInteger(
      object.maxControlFrameBytes,
      "$.maxControlFrameBytes",
      1_024,
      MAX_CONTROL_FRAME_BYTES,
    ),
  };
}

export function parseGuestReady(value: unknown): GuestReady {
  const object = exactObject(value, "$", ["type", "protocolVersion", "bootId", "sessionId"]);
  literal(object.type, "guest.ready", "$.type");
  protocolVersion(object.protocolVersion, "$.protocolVersion");
  return {
    type: "guest.ready",
    protocolVersion: CAPSULE_PROTOCOL_VERSION,
    bootId: opaqueId(object.bootId, "$.bootId"),
    sessionId: sessionId(object.sessionId, "$.sessionId"),
  };
}

export function parseDataStreamPrelude(value: unknown): DataStreamPrelude {
  const object = exactObject(value, "$", ["protocolVersion", "sessionId", "ticket", "kind"]);
  protocolVersion(object.protocolVersion, "$.protocolVersion");
  return {
    protocolVersion: CAPSULE_PROTOCOL_VERSION,
    sessionId: sessionId(object.sessionId, "$.sessionId"),
    ticket: streamTicket(object.ticket, "$.ticket"),
    kind: stringEnum(
      object.kind,
      [
        "sdk",
        "cli",
        "viewer",
        "package-in",
        "dependency-in",
        "artifact-in",
        "artifact-out",
        "logs",
      ] as const,
      "$.kind",
    ),
  };
}

export function parseArtifactAdoptionReceipt(value: unknown): ArtifactAdoptionReceipt {
  const object = exactObject(value, "$", [
    "type",
    "protocolVersion",
    "sessionId",
    "ticket",
    "digest",
    "bytes",
  ]);
  literal(object.type, "artifact.adopted", "$.type");
  protocolVersion(object.protocolVersion, "$.protocolVersion");
  return {
    type: "artifact.adopted",
    protocolVersion: CAPSULE_PROTOCOL_VERSION,
    sessionId: sessionId(object.sessionId, "$.sessionId"),
    ticket: streamTicket(object.ticket, "$.ticket"),
    digest: artifactDigest(object.digest, "$.digest"),
    bytes: boundedInteger(object.bytes, "$.bytes", 1, 8 * 1024 * 1024 * 1024),
  };
}

export function parseHostRequest(value: unknown): HostRequest {
  const object = exactObject(value, "$", ["v", "sessionId", "kind", "requestId", "op", "body"]);
  protocolVersion(object.v, "$.v");
  literal(object.kind, "request", "$.kind");
  const base = {
    v: CAPSULE_PROTOCOL_VERSION,
    sessionId: sessionId(object.sessionId, "$.sessionId"),
    kind: "request" as const,
    requestId: opaqueId(object.requestId, "$.requestId"),
  };

  switch (object.op) {
    case "ping":
      return { ...base, op: "ping", body: parsePingBody(object.body) };
    case "blob.import.prepare":
      return { ...base, op: "blob.import.prepare", body: parseBlobImportPrepareBody(object.body) };
    case "blob.import.release":
      return { ...base, op: "blob.import.release", body: parseBlobImportReleaseBody(object.body) };
    case "blob.export.prepare":
      return { ...base, op: "blob.export.prepare", body: parseBlobExportPrepareBody(object.body) };
    case "build.prepare":
      return { ...base, op: "build.prepare", body: parseBuildPrepareBody(object.body) };
    case "build.start":
      return { ...base, op: "build.start", body: parseBuildStartBody(object.body) };
    case "build.cancel":
      return { ...base, op: "build.cancel", body: parseBuildCancelBody(object.body) };
    case "build.output.release":
      return { ...base, op: "build.output.release", body: parseBuildOutputReleaseBody(object.body) };
    case "app.prepare":
      return { ...base, op: "app.prepare", body: parseAppPrepareBody(object.body) };
    case "app.stop":
      return { ...base, op: "app.stop", body: parseAppStopBody(object.body) };
    case "workload.prepare":
      return { ...base, op: "workload.prepare", body: parseWorkloadPrepareBody(object.body) };
    case "workload.start":
      return { ...base, op: "workload.start", body: parseWorkloadStartBody(object.body) };
    case "workload.stop":
      return { ...base, op: "workload.stop", body: parseWorkloadStopBody(object.body) };
    case "viewer.attach":
      return { ...base, op: "viewer.attach", body: parseViewerAttachBody(object.body) };
    case "viewer.detach":
      return { ...base, op: "viewer.detach", body: parseViewerDetachBody(object.body) };
    case "vm.drain":
      exactObject(object.body, "$.body", []);
      return { ...base, op: "vm.drain", body: {} };
    default:
      throw new ProtocolValidationError(
        "PROTOCOL_UNSUPPORTED_OPERATION",
        "$.op",
        `unsupported operation ${JSON.stringify(object.op)}`,
      );
  }
}

export function parseHostRequestForSession(value: unknown, activeSessionValue: unknown): HostRequest {
  const request = parseHostRequest(value);
  const activeSessionId = sessionId(activeSessionValue, "activeSessionId");
  if (request.sessionId !== activeSessionId) {
    invalid("$.sessionId", "request belongs to another Guest session");
  }
  return request;
}

export function parseControlResponse(value: unknown): ControlResponse {
  const preliminary = plainObject(value, "$", "control response must be an object");
  if (preliminary.ok === true) {
    const object = exactObject(value, "$", ["v", "sessionId", "kind", "requestId", "ok", "result"]);
    protocolVersion(object.v, "$.v");
    literal(object.kind, "response", "$.kind");
    literal(object.ok, true, "$.ok");
    if (!isJsonValue(object.result)) invalid("$.result", "result must be a JSON value");
    return {
      v: CAPSULE_PROTOCOL_VERSION,
      sessionId: sessionId(object.sessionId, "$.sessionId"),
      kind: "response",
      requestId: opaqueId(object.requestId, "$.requestId"),
      ok: true,
      result: object.result,
    };
  }

  const object = exactObject(value, "$", ["v", "sessionId", "kind", "requestId", "ok", "error"]);
  protocolVersion(object.v, "$.v");
  literal(object.kind, "response", "$.kind");
  literal(object.ok, false, "$.ok");
  const error = exactObject(object.error, "$.error", ["code", "message"]);
  const code = boundedString(error.code, "$.error.code", 1, 64);
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) invalid("$.error.code", "invalid error code");
  return {
    v: CAPSULE_PROTOCOL_VERSION,
    sessionId: sessionId(object.sessionId, "$.sessionId"),
    kind: "response",
    requestId: opaqueId(object.requestId, "$.requestId"),
    ok: false,
    error: {
      code,
      message: boundedString(error.message, "$.error.message", 1, 1_024),
    },
  };
}

export function validateOpaqueId(value: unknown, path = "value"): string {
  return opaqueId(value, path);
}

export function validateSessionId(value: unknown, path = "value"): string {
  return sessionId(value, path);
}

export function validateStreamTicket(value: unknown, path = "value"): string {
  return streamTicket(value, path);
}

export function validateArtifactDigest(value: unknown, path = "value"): string {
  return artifactDigest(value, path);
}

export function validateArgv(value: unknown, path = "value"): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    invalid(path, "argv must contain between 1 and 128 arguments");
  }
  return value.map((argument, index) => {
    const result = boundedString(argument, `${path}[${index}]`, 1, 4_096);
    if (result.includes("\0")) invalid(`${path}[${index}]`, "arguments cannot contain NUL");
    return result;
  });
}

export function validateCapsuleCwd(value: unknown, path = "value"): string {
  const cwd = boundedString(value, path, 4, 1_024);
  if (cwd !== "/app" && !cwd.startsWith("/app/")) {
    invalid(path, "working directory must be /app or a child of /app");
  }
  if (cwd.includes("\0") || cwd.includes("//")) invalid(path, "invalid working directory");
  const segments = cwd.split("/");
  if (segments.includes(".") || segments.includes("..")) {
    invalid(path, "working directory cannot contain traversal segments");
  }
  return cwd;
}

export function validateEnvironment(value: unknown, path = "value"): Record<string, string> {
  const object = plainObject(value, path, "environment must be an object");
  const entries = Object.entries(object);
  if (entries.length > 64) invalid(path, "environment cannot contain more than 64 entries");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, rawValue] of entries) {
    const keyPath = `${path}.${key}`;
    if (key.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      invalid(keyPath, "invalid environment key");
    }
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      invalid(keyPath, "reserved object key");
    }
    if (key.startsWith("LAMARCK_")) {
      invalid(keyPath, "reserved Host environment key");
    }
    const stringValue = boundedString(rawValue, keyPath, 0, 8_192);
    if (stringValue.includes("\0")) invalid(keyPath, "environment values cannot contain NUL");
    result[key] = stringValue;
  }
  return result;
}

export function validateMappedHostId(value: unknown, path = "value"): number {
  // The value is the base of a full 65,536-ID user-namespace range.
  return boundedInteger(value, path, 100_000, 2_147_418_112);
}

function parsePingBody(value: unknown): PingBody {
  const object = exactObject(value, "$.body", ["nonce"]);
  return { nonce: boundedInteger(object.nonce, "$.body.nonce", 0, Number.MAX_SAFE_INTEGER) };
}

function parseAppPrepareBody(value: unknown): AppPrepareBody {
  const object = exactObject(value, "$.body", [
    "ownerKey",
    "appHandle",
    "artifactDigest",
    "artifactBytes",
    "artifactBlobHandle",
    "mappedHostUid",
    "mappedHostGid",
    "storagePlanVersion",
    "scratchBytes",
  ]);
  storagePlanVersion(object.storagePlanVersion, "$.body.storagePlanVersion");
  const artifactBytes = boundedInteger(
    object.artifactBytes,
    "$.body.artifactBytes",
    1,
    8 * 1024 * 1024 * 1024,
  );
  const scratchBytes = boundedInteger(
    object.scratchBytes,
    "$.body.scratchBytes",
    CAPSULE_RUNTIME_SCRATCH_MIN_BYTES,
    CAPSULE_RUNTIME_SCRATCH_MAX_BYTES,
  );
  requireRuntimeStoragePlan(artifactBytes, scratchBytes, "$.body.scratchBytes");
  return {
    ownerKey: appOwnerKey(object.ownerKey, "$.body.ownerKey"),
    appHandle: opaqueId(object.appHandle, "$.body.appHandle"),
    artifactDigest: artifactDigest(object.artifactDigest, "$.body.artifactDigest"),
    artifactBytes,
    artifactBlobHandle: opaqueId(object.artifactBlobHandle, "$.body.artifactBlobHandle"),
    mappedHostUid: validateMappedHostId(object.mappedHostUid, "$.body.mappedHostUid"),
    mappedHostGid: validateMappedHostId(object.mappedHostGid, "$.body.mappedHostGid"),
    storagePlanVersion: CAPSULE_STORAGE_PLAN_VERSION,
    scratchBytes,
  };
}

function parseBlobImportPrepareBody(value: unknown): BlobImportPrepareBody {
  const object = exactObject(value, "$.body", [
    "ownerKey",
    "blobHandle",
    "blobKind",
    "format",
    "digest",
    "bytes",
    "streamTicket",
  ]);
  const blobKind = stringEnum(object.blobKind, ["package", "dependency", "artifact"] as const, "$.body.blobKind");
  const format = stringEnum(
    object.format,
    ["capsule-tree-v1", "npm-dependency-bundle-v1", "erofs-v1"] as const,
    "$.body.format",
  );
  if (
    (blobKind === "package" && format !== "capsule-tree-v1")
    || (blobKind === "dependency" && format !== "npm-dependency-bundle-v1")
    || (blobKind === "artifact" && format !== "erofs-v1")
  ) {
    invalid("$.body.format", `format ${format} is not valid for ${blobKind}`);
  }
  return {
    ownerKey: appOwnerKey(object.ownerKey, "$.body.ownerKey"),
    blobHandle: opaqueId(object.blobHandle, "$.body.blobHandle"),
    blobKind,
    format,
    digest: artifactDigest(object.digest, "$.body.digest"),
    bytes: boundedInteger(object.bytes, "$.body.bytes", 1, 8 * 1024 * 1024 * 1024),
    streamTicket: streamTicket(object.streamTicket, "$.body.streamTicket"),
  };
}

function parseBlobExportPrepareBody(value: unknown): BlobExportPrepareBody {
  const object = exactObject(value, "$.body", [
    "ownerKey",
    "buildHandle",
    "blobHandle",
    "digest",
    "bytes",
    "streamTicket",
  ]);
  return {
    ownerKey: appOwnerKey(object.ownerKey, "$.body.ownerKey"),
    buildHandle: opaqueId(object.buildHandle, "$.body.buildHandle"),
    blobHandle: opaqueId(object.blobHandle, "$.body.blobHandle"),
    digest: artifactDigest(object.digest, "$.body.digest"),
    bytes: boundedInteger(object.bytes, "$.body.bytes", 1, 8 * 1024 * 1024 * 1024),
    streamTicket: streamTicket(object.streamTicket, "$.body.streamTicket"),
  };
}

function parseBlobImportReleaseBody(value: unknown): BlobImportReleaseBody {
  const object = exactObject(value, "$.body", [
    "ownerKey",
    "blobHandle",
    "blobKind",
    "digest",
    "bytes",
  ]);
  return {
    ownerKey: appOwnerKey(object.ownerKey, "$.body.ownerKey"),
    blobHandle: opaqueId(object.blobHandle, "$.body.blobHandle"),
    blobKind: stringEnum(
      object.blobKind,
      ["package", "dependency", "artifact"] as const,
      "$.body.blobKind",
    ),
    digest: artifactDigest(object.digest, "$.body.digest"),
    bytes: boundedInteger(object.bytes, "$.body.bytes", 1, 8 * 1024 * 1024 * 1024),
  };
}

function parseBuildPrepareBody(value: unknown): BuildPrepareBody {
  const object = exactObject(value, "$.body", [
    "ownerKey",
    "appHandle",
    "buildHandle",
    "packageDigest",
    "packageBytes",
    "packageBlobHandle",
    "installDigest",
    "mappedHostUid",
    "mappedHostGid",
    "storagePlanVersion",
    "scratchBytes",
    "artifactOutputBytes",
    "timeoutMs",
    "resources",
  ], [
    "dependencyDigest",
    "dependencyBytes",
    "dependencyBlobHandle",
    "baseArtifactDigest",
    "baseArtifactBytes",
    "baseArtifactBlobHandle",
    "baseDependencyDigest",
  ]);
  const resources = exactObject(object.resources, "$.body.resources", [
    "memoryBytes",
    "pids",
    "cpuQuotaMicros",
  ]);
  if (object.dependencyDigest !== undefined && object.baseArtifactDigest !== undefined) {
    invalid("$.body.baseArtifactDigest", "cold dependency input and warm base are mutually exclusive");
  }
  storagePlanVersion(object.storagePlanVersion, "$.body.storagePlanVersion");
  const packageBytes = boundedInteger(
    object.packageBytes,
    "$.body.packageBytes",
    1,
    8 * 1024 * 1024 * 1024,
  );
  const dependency = object.dependencyDigest === undefined
    && object.dependencyBytes === undefined
    && object.dependencyBlobHandle === undefined
    ? undefined
    : object.dependencyDigest !== undefined
      && object.dependencyBytes !== undefined
      && object.dependencyBlobHandle !== undefined
      ? {
          dependencyDigest: artifactDigest(object.dependencyDigest, "$.body.dependencyDigest"),
          dependencyBytes: boundedInteger(
            object.dependencyBytes,
            "$.body.dependencyBytes",
            1,
            8 * 1024 * 1024 * 1024,
          ),
          dependencyBlobHandle: opaqueId(
            object.dependencyBlobHandle,
            "$.body.dependencyBlobHandle",
          ),
        }
      : invalid(
          "$.body.dependencyBytes",
          "dependency digest, bytes, and blob handle must appear together",
        );
  const base = object.baseArtifactDigest === undefined
    && object.baseArtifactBytes === undefined
    && object.baseArtifactBlobHandle === undefined
    && object.baseDependencyDigest === undefined
    ? undefined
    : object.baseArtifactDigest !== undefined
      && object.baseArtifactBytes !== undefined
      && object.baseArtifactBlobHandle !== undefined
      && object.baseDependencyDigest !== undefined
      ? {
          baseArtifactDigest: artifactDigest(
            object.baseArtifactDigest,
            "$.body.baseArtifactDigest",
          ),
          baseArtifactBytes: boundedInteger(
            object.baseArtifactBytes,
            "$.body.baseArtifactBytes",
            1,
            8 * 1024 * 1024 * 1024,
          ),
          baseArtifactBlobHandle: opaqueId(
            object.baseArtifactBlobHandle,
            "$.body.baseArtifactBlobHandle",
          ),
          baseDependencyDigest: artifactDigest(
            object.baseDependencyDigest,
            "$.body.baseDependencyDigest",
          ),
        }
      : invalid(
          "$.body.baseArtifactBytes",
          "base artifact and dependency provenance must appear together",
        );
  const scratchBytes = boundedInteger(
    object.scratchBytes,
    "$.body.scratchBytes",
    CAPSULE_BUILD_SCRATCH_MIN_BYTES,
    CAPSULE_BUILD_SCRATCH_MAX_BYTES,
  );
  const artifactOutputBytes = boundedInteger(
    object.artifactOutputBytes,
    "$.body.artifactOutputBytes",
    CAPSULE_ARTIFACT_OUTPUT_MIN_BYTES,
    CAPSULE_ARTIFACT_OUTPUT_MAX_BYTES,
  );
  requireBuildStoragePlan({
    mode: dependency === undefined ? "warm" : "cold",
    packageBytes,
    ...(dependency === undefined
      ? { baseArtifactBytes: base?.baseArtifactBytes }
      : { dependencyBytes: dependency.dependencyBytes }),
  }, scratchBytes, artifactOutputBytes);
  return {
    ownerKey: appOwnerKey(object.ownerKey, "$.body.ownerKey"),
    appHandle: opaqueId(object.appHandle, "$.body.appHandle"),
    buildHandle: opaqueId(object.buildHandle, "$.body.buildHandle"),
    packageDigest: artifactDigest(object.packageDigest, "$.body.packageDigest"),
    packageBytes,
    packageBlobHandle: opaqueId(object.packageBlobHandle, "$.body.packageBlobHandle"),
    installDigest: artifactDigest(object.installDigest, "$.body.installDigest"),
    ...(dependency === undefined ? {} : dependency),
    ...(base === undefined ? {} : base),
    mappedHostUid: validateMappedHostId(object.mappedHostUid, "$.body.mappedHostUid"),
    mappedHostGid: validateMappedHostId(object.mappedHostGid, "$.body.mappedHostGid"),
    storagePlanVersion: CAPSULE_STORAGE_PLAN_VERSION,
    scratchBytes,
    artifactOutputBytes,
    timeoutMs: boundedInteger(object.timeoutMs, "$.body.timeoutMs", 1_000, 10 * 60_000),
    resources: {
      memoryBytes: boundedInteger(resources.memoryBytes, "$.body.resources.memoryBytes", 64 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
      pids: boundedInteger(resources.pids, "$.body.resources.pids", 16, 4_096),
      cpuQuotaMicros: boundedInteger(resources.cpuQuotaMicros, "$.body.resources.cpuQuotaMicros", 1_000, 6_400_000),
    },
  };
}

function requireBuildStoragePlan(
  raw: {
    mode: "cold" | "warm";
    packageBytes: number;
    dependencyBytes?: number;
    baseArtifactBytes?: number;
  },
  scratchBytes: number,
  artifactOutputBytes: number,
): void {
  try {
    if (raw.mode === "cold" && raw.dependencyBytes !== undefined) {
      requireCapsuleBuildStoragePlan(
        { mode: "cold", packageBytes: raw.packageBytes, dependencyBytes: raw.dependencyBytes },
        { version: CAPSULE_STORAGE_PLAN_VERSION, scratchBytes, artifactOutputBytes },
      );
      return;
    }
    if (raw.mode === "warm" && raw.baseArtifactBytes !== undefined) {
      requireCapsuleBuildStoragePlan(
        { mode: "warm", packageBytes: raw.packageBytes, baseArtifactBytes: raw.baseArtifactBytes },
        { version: CAPSULE_STORAGE_PLAN_VERSION, scratchBytes, artifactOutputBytes },
      );
      return;
    }
    invalid("$.body", "Build requires exactly one dependency or warm base input");
  } catch (error) {
    invalid(
      "$.body.scratchBytes",
      error instanceof Error ? error.message : "invalid Build storage plan",
    );
  }
}

function requireRuntimeStoragePlan(
  artifactBytes: number,
  scratchBytes: number,
  path: string,
): void {
  try {
    requireCapsuleRuntimeStoragePlan(artifactBytes, {
      version: CAPSULE_STORAGE_PLAN_VERSION,
      scratchBytes,
    });
  } catch (error) {
    invalid(path, error instanceof Error ? error.message : "invalid Runtime storage plan");
  }
}

function parseBuildStartBody(value: unknown): BuildStartBody {
  const object = exactObject(value, "$.body", ["appHandle", "buildHandle"]);
  return {
    appHandle: opaqueId(object.appHandle, "$.body.appHandle"),
    buildHandle: opaqueId(object.buildHandle, "$.body.buildHandle"),
  };
}

function parseBuildCancelBody(value: unknown): BuildCancelBody {
  const object = exactObject(value, "$.body", ["appHandle", "buildHandle", "graceMs"]);
  return {
    appHandle: opaqueId(object.appHandle, "$.body.appHandle"),
    buildHandle: opaqueId(object.buildHandle, "$.body.buildHandle"),
    graceMs: boundedInteger(object.graceMs, "$.body.graceMs", 0, 30_000),
  };
}

function parseBuildOutputReleaseBody(value: unknown): BuildOutputReleaseBody {
  const object = exactObject(value, "$.body", ["ownerKey", "buildHandle", "digest", "bytes"]);
  return {
    ownerKey: appOwnerKey(object.ownerKey, "$.body.ownerKey"),
    buildHandle: opaqueId(object.buildHandle, "$.body.buildHandle"),
    digest: artifactDigest(object.digest, "$.body.digest"),
    bytes: boundedInteger(object.bytes, "$.body.bytes", 1, 8 * 1024 * 1024 * 1024),
  };
}

function parseAppStopBody(value: unknown): AppStopBody {
  const object = exactObject(value, "$.body", ["appHandle"]);
  return { appHandle: opaqueId(object.appHandle, "$.body.appHandle") };
}

function parseWorkloadPrepareBody(value: unknown): WorkloadPrepareBody {
  const object = exactObject(
    value,
    "$.body",
    ["appHandle", "workloadHandle", "workloadKind", "argv", "cwd", "environment", "sdkTicket", "cliTicket"],
    ["logsTicket", "uiPort"],
  );
  const workloadKind = stringEnum(
    object.workloadKind,
    ["ui", "service", "job"] as const,
    "$.body.workloadKind",
  );
  const uiPort = object.uiPort === undefined
    ? undefined
    : boundedInteger(object.uiPort, "$.body.uiPort", 1, 65_535);
  if (workloadKind === "ui" && uiPort === undefined) {
    missing("$.body.uiPort", "UI workloads require a declared port");
  }
  if (workloadKind !== "ui" && uiPort !== undefined) {
    invalid("$.body.uiPort", "only UI workloads may declare a port");
  }
  return {
    appHandle: opaqueId(object.appHandle, "$.body.appHandle"),
    workloadHandle: opaqueId(object.workloadHandle, "$.body.workloadHandle"),
    workloadKind,
    argv: validateArgv(object.argv, "$.body.argv"),
    cwd: validateCapsuleCwd(object.cwd, "$.body.cwd"),
    environment: validateEnvironment(object.environment, "$.body.environment"),
    sdkTicket: streamTicket(object.sdkTicket, "$.body.sdkTicket"),
    cliTicket: streamTicket(object.cliTicket, "$.body.cliTicket"),
    ...(object.logsTicket === undefined
      ? {}
      : { logsTicket: streamTicket(object.logsTicket, "$.body.logsTicket") }),
    ...(uiPort === undefined ? {} : { uiPort }),
  };
}

function parseViewerAttachBody(value: unknown): ViewerAttachBody {
  const object = exactObject(value, "$.body", ["appHandle", "workloadHandle", "viewerTicket"]);
  return {
    appHandle: opaqueId(object.appHandle, "$.body.appHandle"),
    workloadHandle: opaqueId(object.workloadHandle, "$.body.workloadHandle"),
    viewerTicket: streamTicket(object.viewerTicket, "$.body.viewerTicket"),
  };
}

function parseViewerDetachBody(value: unknown): ViewerDetachBody {
  const object = exactObject(value, "$.body", ["appHandle", "workloadHandle"]);
  return {
    appHandle: opaqueId(object.appHandle, "$.body.appHandle"),
    workloadHandle: opaqueId(object.workloadHandle, "$.body.workloadHandle"),
  };
}

function parseWorkloadStartBody(value: unknown): WorkloadStartBody {
  const object = exactObject(value, "$.body", ["appHandle", "workloadHandle"]);
  return {
    appHandle: opaqueId(object.appHandle, "$.body.appHandle"),
    workloadHandle: opaqueId(object.workloadHandle, "$.body.workloadHandle"),
  };
}

function parseWorkloadStopBody(value: unknown): WorkloadStopBody {
  const object = exactObject(value, "$.body", ["appHandle", "workloadHandle", "graceMs"]);
  return {
    appHandle: opaqueId(object.appHandle, "$.body.appHandle"),
    workloadHandle: opaqueId(object.workloadHandle, "$.body.workloadHandle"),
    graceMs: boundedInteger(object.graceMs, "$.body.graceMs", 0, 30_000),
  };
}

function protocolVersion(value: unknown, path: string): asserts value is typeof CAPSULE_PROTOCOL_VERSION {
  if (value !== CAPSULE_PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      "PROTOCOL_UNSUPPORTED_VERSION",
      path,
      `expected protocol version ${CAPSULE_PROTOCOL_VERSION}`,
    );
  }
}

function storagePlanVersion(
  value: unknown,
  path: string,
): asserts value is typeof CAPSULE_STORAGE_PLAN_VERSION {
  if (value !== CAPSULE_STORAGE_PLAN_VERSION) {
    throw new ProtocolValidationError(
      "PROTOCOL_UNSUPPORTED_VERSION",
      path,
      `expected storage plan version ${CAPSULE_STORAGE_PLAN_VERSION}`,
    );
  }
}

function opaqueId(value: unknown, path: string): string {
  const result = boundedString(value, path, 22, 22);
  if (!OPAQUE_ID_PATTERN.test(result)) invalid(path, "invalid opaque ID");
  return result;
}

function appOwnerKey(value: unknown, path: string): string {
  const result = boundedString(value, path, 64, 64);
  if (!APP_OWNER_KEY_PATTERN.test(result)) invalid(path, "invalid Host-derived App owner key");
  return result;
}

function sessionId(value: unknown, path: string): string {
  const result = boundedString(value, path, 43, 43);
  if (!SESSION_ID_PATTERN.test(result)) invalid(path, "invalid session ID");
  return result;
}

function streamTicket(value: unknown, path: string): string {
  if (typeof value !== "string" || !STREAM_TICKET_PATTERN.test(value)) {
    invalid(path, "invalid stream ticket");
  }
  return value;
}

function artifactDigest(value: unknown, path: string): string {
  const result = boundedString(value, path, 71, 71);
  if (!SHA256_DIGEST_PATTERN.test(result)) invalid(path, "expected a lowercase sha256 digest");
  return result;
}

function exactObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const object = plainObject(value, path, "expected an object");
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new ProtocolValidationError(
        "PROTOCOL_UNKNOWN_FIELD",
        `${path}.${key}`,
        "unknown field",
      );
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      missing(`${path}.${key}`, "required field is missing");
    }
  }
  return object;
}

function plainObject(value: unknown, path: string, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError("PROTOCOL_INVALID_TYPE", path, message);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolValidationError("PROTOCOL_INVALID_TYPE", path, "expected a plain object");
  }
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  path: string,
  minimumLength: number,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new ProtocolValidationError("PROTOCOL_INVALID_TYPE", path, "expected a string");
  }
  if (value.length < minimumLength || value.length > maximumLength) {
    invalid(path, `string length must be between ${minimumLength} and ${maximumLength}`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(path, `expected an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function stringArray(
  value: unknown,
  path: string,
  maximumItems: number,
  maximumStringLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    invalid(path, `expected an array with at most ${maximumItems} items`);
  }
  return value.map((item, index) => boundedString(item, `${path}[${index}]`, 1, maximumStringLength));
}

function stringEnum<const T extends readonly string[]>(
  value: unknown,
  options: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !options.includes(value)) {
    invalid(path, `expected one of ${options.join(", ")}`);
  }
  return value as T[number];
}

function literal<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  path: string,
): asserts value is T {
  if (value !== expected) invalid(path, `expected ${JSON.stringify(expected)}`);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function invalid(path: string, message: string): never {
  throw new ProtocolValidationError("PROTOCOL_INVALID_VALUE", path, message);
}

function missing(path: string, message: string): never {
  throw new ProtocolValidationError("PROTOCOL_MISSING_FIELD", path, message);
}

export type { StreamKind, WorkloadKind };
