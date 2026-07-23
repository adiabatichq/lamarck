import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import type { GuestArchitecture } from "../../../capsule/src/protocol/types";
import { validateArtifactDigest } from "../../../capsule/src/protocol/validate";
import type { CapsuleVmGuestImageBase } from "../capsule-vm/launcher";

export const CAPSULE_GUEST_RELEASE_DESCRIPTOR_FILE = "capsule-guest-release.json";

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MINIMUM_VM_MEMORY_BYTES = 512 * 1024 * 1024;
const MAXIMUM_VM_MEMORY_BYTES = 64 * 1024 * 1024 * 1024;
const MEMORY_ALIGNMENT_BYTES = 1024 * 1024;

export interface CapsuleGuestReleaseDescriptor {
  schemaVersion: 1;
  vmWireVersion: 2;
  guestProtocolVersion: 2;
  architecture: GuestArchitecture;
  bundleRelativePath: string;
  manifestDigest: string;
  pinnedEd25519PublicKey: string;
  supervisorVersion: string;
  features: string[];
  runtimeAbi: "capsule-node-v1";
  nodeVersion: string;
  nodeModulesAbi: string;
  libc: string;
  cpuCount: number;
  memorySizeBytes: number;
  stateFormatVersion: 1;
}

export interface CapsuleGuestRuntimeExpectation {
  runtimeAbi: "capsule-node-v1";
  architecture: GuestArchitecture;
  nodeVersion: string;
  nodeModulesAbi: string;
  libc: string;
}

export interface LoadedCapsuleGuestRelease {
  descriptor: CapsuleGuestReleaseDescriptor;
  vmImage: CapsuleVmGuestImageBase;
  handshake: {
    expectedImageDigest: string;
    expectedArchitecture: GuestArchitecture;
    expectedSupervisorVersion: string;
    expectedFeatures: readonly string[];
  };
  runtime: CapsuleGuestRuntimeExpectation;
}

export interface LoadCapsuleGuestReleaseOptions {
  /** Electron's trusted, app-bundled `process.resourcesPath`. */
  resourcesRoot: string;
  /** Host-private mutable VM state. This path is deliberately not release-controlled JSON. */
  stateDirectory: string;
  /** Test seam; production derives this from `process.arch`. */
  hostArchitecture?: NodeJS.Architecture;
}

export class CapsuleGuestReleaseError extends Error {
  constructor(
    readonly code:
      | "INVALID_RESOURCE_ROOT"
      | "INVALID_DESCRIPTOR_FILE"
      | "INVALID_DESCRIPTOR_JSON"
      | "INVALID_DESCRIPTOR_FIELD"
      | "INCOMPATIBLE_ARCHITECTURE"
      | "INVALID_IMAGE_BUNDLE"
      | "INVALID_STATE_DIRECTORY",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CapsuleGuestReleaseError";
  }
}

/**
 * Loads the one Host-bundled release descriptor. The descriptor selects a
 * signed image bundle but cannot redirect outside the trusted resources root.
 */
export async function loadCapsuleGuestRelease(
  options: LoadCapsuleGuestReleaseOptions,
): Promise<LoadedCapsuleGuestRelease> {
  if (!isAbsolute(options.resourcesRoot) || options.resourcesRoot.includes("\0")) {
    throw new CapsuleGuestReleaseError(
      "INVALID_RESOURCE_ROOT",
      "Capsule Guest resources root must be an absolute path",
    );
  }
  if (!isAbsolute(options.stateDirectory) || options.stateDirectory.includes("\0")) {
    throw new CapsuleGuestReleaseError(
      "INVALID_DESCRIPTOR_FIELD",
      "Capsule VM state directory must be an absolute Host-selected path",
    );
  }

  const suppliedRoot = resolve(options.resourcesRoot);
  let rootStat;
  try {
    rootStat = await lstat(suppliedRoot);
  } catch (cause) {
    throw new CapsuleGuestReleaseError(
      "INVALID_RESOURCE_ROOT",
      "Capsule Guest resources root is unavailable",
      { cause },
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new CapsuleGuestReleaseError(
      "INVALID_RESOURCE_ROOT",
      "Capsule Guest resources root must be a real directory",
    );
  }
  const resourcesRoot = await realpath(suppliedRoot);
  const descriptorPath = join(resourcesRoot, CAPSULE_GUEST_RELEASE_DESCRIPTOR_FILE);
  const descriptor = parseDescriptor(await readPinnedRegularFile(descriptorPath));

  const hostArchitecture = normalizeHostArchitecture(options.hostArchitecture ?? process.arch);
  if (descriptor.architecture !== hostArchitecture) {
    throw new CapsuleGuestReleaseError(
      "INCOMPATIBLE_ARCHITECTURE",
      `Capsule Guest architecture ${descriptor.architecture} does not match Host ${hostArchitecture}`,
    );
  }

  const imageBundlePath = await resolveImageBundle(
    resourcesRoot,
    descriptor.bundleRelativePath,
  );
  const expectedFeatures = Object.freeze([...descriptor.features]);
  const stateDirectory = await prepareStateDirectory(options.stateDirectory);

  return {
    descriptor,
    vmImage: {
      imageBundlePath,
      stateDirectory,
      expectedManifestDigest: descriptor.manifestDigest,
      manifestPublicKey: descriptor.pinnedEd25519PublicKey,
      cpuCount: descriptor.cpuCount,
      memorySizeBytes: descriptor.memorySizeBytes,
    },
    handshake: {
      expectedImageDigest: descriptor.manifestDigest,
      expectedArchitecture: descriptor.architecture,
      expectedSupervisorVersion: descriptor.supervisorVersion,
      expectedFeatures,
    },
    runtime: {
      runtimeAbi: descriptor.runtimeAbi,
      architecture: descriptor.architecture,
      nodeVersion: descriptor.nodeVersion,
      nodeModulesAbi: descriptor.nodeModulesAbi,
      libc: descriptor.libc,
    },
  };
}

async function prepareStateDirectory(requestedPath: string): Promise<string> {
  const requested = resolve(requestedPath);
  try {
    await mkdir(requested, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new CapsuleGuestReleaseError(
      "INVALID_STATE_DIRECTORY",
      "Capsule VM state directory could not be created",
      { cause },
    );
  }

  let handle;
  try {
    handle = await open(
      requested,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
    if (!metadata.isDirectory()
      || (effectiveUid !== undefined && metadata.uid !== effectiveUid)) {
      throw new Error("state directory is not a Host-owned directory");
    }
    await handle.chmod(0o700);
    const privateMetadata = await handle.stat();
    if ((privateMetadata.mode & 0o077) !== 0) {
      throw new Error("state directory is not private");
    }
  } catch (cause) {
    throw new CapsuleGuestReleaseError(
      "INVALID_STATE_DIRECTORY",
      "Capsule VM state directory must be a private Host-owned real directory",
      { cause },
    );
  } finally {
    await handle?.close();
  }

  return await realpath(requested);
}

async function readPinnedRegularFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    throw new CapsuleGuestReleaseError(
      "INVALID_DESCRIPTOR_FILE",
      "Capsule Guest release descriptor is unavailable or is a symbolic link",
      { cause },
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_DESCRIPTOR_BYTES) {
      throw new CapsuleGuestReleaseError(
        "INVALID_DESCRIPTOR_FILE",
        `Capsule Guest release descriptor must be a regular file of at most ${MAX_DESCRIPTOR_BYTES} bytes`,
      );
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function parseDescriptor(source: string): CapsuleGuestReleaseDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new CapsuleGuestReleaseError(
      "INVALID_DESCRIPTOR_JSON",
      "Capsule Guest release descriptor is not valid JSON",
      { cause },
    );
  }
  const object = exactObject(value, "$", [
    "schemaVersion",
    "vmWireVersion",
    "guestProtocolVersion",
    "architecture",
    "bundleRelativePath",
    "manifestDigest",
    "pinnedEd25519PublicKey",
    "supervisorVersion",
    "features",
    "runtimeAbi",
    "nodeVersion",
    "nodeModulesAbi",
    "libc",
    "cpuCount",
    "memorySizeBytes",
    "stateFormatVersion",
  ]);

  literal(object.schemaVersion, 1, "$.schemaVersion");
  literal(object.vmWireVersion, 2, "$.vmWireVersion");
  literal(object.guestProtocolVersion, 2, "$.guestProtocolVersion");
  const architecture = stringEnum(object.architecture, ["arm64", "x64"] as const, "$.architecture");
  const bundleRelativePath = canonicalRelativePath(object.bundleRelativePath, "$.bundleRelativePath");
  const manifestDigest = validatedDigest(object.manifestDigest, "$.manifestDigest");
  const pinnedEd25519PublicKey = canonicalEd25519PublicKey(
    object.pinnedEd25519PublicKey,
    "$.pinnedEd25519PublicKey",
  );
  const supervisorVersion = patternedString(
    object.supervisorVersion,
    "$.supervisorVersion",
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/,
  );
  const features = canonicalFeatures(object.features);
  if (!features.includes("artifact-adoption-receipt-v1")) {
    invalid(
      "$.features",
      "required artifact adoption receipt feature artifact-adoption-receipt-v1 is missing",
    );
  }
  if (!features.includes("warm-rebuild-v1")) {
    invalid("$.features", "required Host Build feature warm-rebuild-v1 is missing");
  }
  if (!features.includes("vsock-record-v2")) {
    invalid("$.features", "required explicit vsock relay feature vsock-record-v2 is missing");
  }
  literal(object.runtimeAbi, "capsule-node-v1", "$.runtimeAbi");
  const nodeVersion = patternedString(
    object.nodeVersion,
    "$.nodeVersion",
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
  );
  const nodeModulesAbi = patternedString(
    object.nodeModulesAbi,
    "$.nodeModulesAbi",
    /^(?:0|[1-9]\d{0,5})$/,
  );
  const libc = patternedString(object.libc, "$.libc", /^[a-z][a-z0-9.-]{0,63}$/);
  const cpuCount = boundedInteger(object.cpuCount, "$.cpuCount", 1, 64);
  const memorySizeBytes = boundedInteger(
    object.memorySizeBytes,
    "$.memorySizeBytes",
    MINIMUM_VM_MEMORY_BYTES,
    MAXIMUM_VM_MEMORY_BYTES,
  );
  if (memorySizeBytes % MEMORY_ALIGNMENT_BYTES !== 0) {
    invalid("$.memorySizeBytes", "memory size must be aligned to one MiB");
  }
  literal(object.stateFormatVersion, 1, "$.stateFormatVersion");

  return {
    schemaVersion: 1,
    vmWireVersion: 2,
    guestProtocolVersion: 2,
    architecture,
    bundleRelativePath,
    manifestDigest,
    pinnedEd25519PublicKey,
    supervisorVersion,
    features,
    runtimeAbi: "capsule-node-v1",
    nodeVersion,
    nodeModulesAbi,
    libc,
    cpuCount,
    memorySizeBytes,
    stateFormatVersion: 1,
  };
}

async function resolveImageBundle(resourcesRoot: string, relativePath: string): Promise<string> {
  const segments = relativePath.split("/");
  let cursor = resourcesRoot;
  try {
    for (const segment of segments) {
      cursor = join(cursor, segment);
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("bundle path component is not a real directory");
      }
    }
    const canonical = await realpath(cursor);
    if (canonical !== cursor || !isInsideRoot(resourcesRoot, canonical)) {
      throw new Error("bundle path escaped the trusted resources root");
    }
    return canonical;
  } catch (cause) {
    throw new CapsuleGuestReleaseError(
      "INVALID_IMAGE_BUNDLE",
      "Capsule Guest image bundle is missing, linked, non-directory, or outside resources",
      { cause },
    );
  }
}

function normalizeHostArchitecture(value: NodeJS.Architecture): GuestArchitecture {
  if (value === "arm64" || value === "x64") return value;
  throw new CapsuleGuestReleaseError(
    "INCOMPATIBLE_ARCHITECTURE",
    `Host architecture ${value} cannot run this Capsule Guest release`,
  );
}

function canonicalRelativePath(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    invalid(path, "expected a nonempty relative path of at most 512 characters");
  }
  if (
    value.includes("\0")
    || value.includes("\\")
    || value.startsWith("/")
    || value.endsWith("/")
    || posix.normalize(value) !== value
  ) {
    invalid(path, "path must be a canonical POSIX relative path");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => (
      segment.length < 1
      || segment === "."
      || segment === ".."
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment)
    ))
  ) {
    invalid(path, "path contains an unsafe component");
  }
  return value;
}

function canonicalEd25519PublicKey(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    invalid(path, "expected canonical padded base64 for a 32-byte Ed25519 public key");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    invalid(path, "expected canonical padded base64 for a 32-byte Ed25519 public key");
  }
  return value;
}

function canonicalFeatures(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    invalid("$.features", "expected between 1 and 32 feature names");
  }
  const features = value.map((feature, index) => patternedString(
    feature,
    `$.features[${index}]`,
    /^[a-z][a-z0-9.-]{0,63}$/,
  ));
  for (let index = 1; index < features.length; index += 1) {
    if (features[index - 1]!.localeCompare(features[index]!) >= 0) {
      invalid("$.features", "features must be strictly sorted with no duplicates");
    }
  }
  return features;
}

function exactObject(
  value: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(value)) invalid(path, "expected an object");
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, "unknown field");
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      invalid(`${path}.${field}`, "required field is missing");
    }
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

function patternedString(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(path, "invalid string value");
  return value;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(path, `expected an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function literal<T extends string | number>(value: unknown, expected: T, path: string): void {
  if (value !== expected) invalid(path, `expected ${JSON.stringify(expected)}`);
}

function validatedDigest(value: unknown, path: string): string {
  try {
    return validateArtifactDigest(value, path);
  } catch (cause) {
    throw new CapsuleGuestReleaseError(
      "INVALID_DESCRIPTOR_FIELD",
      `${path}: expected a lowercase sha256 digest`,
      { cause },
    );
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${sep}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(path: string, message: string): never {
  throw new CapsuleGuestReleaseError(
    "INVALID_DESCRIPTOR_FIELD",
    `${path}: ${message}`,
  );
}
