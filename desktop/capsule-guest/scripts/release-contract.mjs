import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const RELEASE_DESCRIPTOR_FILE = "capsule-guest-release.json";
export const ARCHITECTURE = "arm64";
export const BUNDLE_NAME = `capsule-guest-${ARCHITECTURE}`;
export const EXPECTED_FEATURES = Object.freeze([
  "artifact-erofs-v1",
  "build-v1",
  "oci-policy-v1",
  "sdk-uds-v1",
  "tickets-v1",
  "warm-rebuild-v1",
]);

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024 * 1024;

export async function validateGuestRelease(rootValue) {
  const root = await requireDirectory(rootValue, "Guest release root");
  const rootFiles = await listEntries(root);
  if (JSON.stringify(rootFiles) !== JSON.stringify([BUNDLE_NAME, RELEASE_DESCRIPTOR_FILE].sort())) {
    throw new Error("Guest release root contains unexpected entries");
  }
  const descriptor = exactReleaseDescriptor(
    JSON.parse(await readSmallRegularFile(join(root, RELEASE_DESCRIPTOR_FILE), MAX_JSON_BYTES)),
  );
  const bundle = await requireDirectory(join(root, descriptor.bundleRelativePath), "Guest image bundle");
  const manifestBytes = await readSmallRegularBytes(join(bundle, "manifest.json"), MAX_JSON_BYTES);
  const manifestDigest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  if (manifestDigest !== descriptor.manifestDigest) throw new Error("Guest manifest digest mismatch");
  const publicKey = decodePublicKey(descriptor.pinnedEd25519PublicKey);
  await verifyDetached(join(bundle, "manifest.ed25519"), manifestBytes, publicKey, "Guest manifest");
  const manifest = exactImageManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.architecture !== descriptor.architecture) throw new Error("Guest manifest architecture mismatch");
  if (manifest.supervisorVersion !== descriptor.supervisorVersion) {
    throw new Error("Guest supervisor version mismatch");
  }
  for (const artifact of manifest.artifacts) {
    const path = joinInside(bundle, artifact.path);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size !== artifact.size) {
      throw new Error(`Guest artifact metadata mismatch for ${artifact.path}`);
    }
    if (`sha256:${await sha256File(path)}` !== artifact.sha256) {
      throw new Error(`Guest artifact digest mismatch for ${artifact.path}`);
    }
  }

  const complianceManifestBytes = await readSmallRegularBytes(
    join(bundle, "compliance-manifest.json"),
    MAX_JSON_BYTES,
  );
  await verifyDetached(
    join(bundle, "compliance-manifest.ed25519"),
    complianceManifestBytes,
    publicKey,
    "compliance manifest",
  );
  const complianceManifest = exactComplianceManifest(
    JSON.parse(complianceManifestBytes.toString("utf8")),
  );
  if (complianceManifest.subjectManifestDigest !== manifestDigest) {
    throw new Error("compliance manifest is bound to another Guest image");
  }
  const compliancePaths = new Set();
  for (const file of complianceManifest.files) {
    if (!file.path.startsWith("compliance/")) throw new Error("compliance file must be under compliance/");
    if (!compliancePaths.add(file.path)) throw new Error(`duplicate compliance file ${file.path}`);
    const path = joinInside(bundle, file.path);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size !== file.size) {
      throw new Error(`compliance file metadata mismatch for ${file.path}`);
    }
    if (`sha256:${await sha256File(path)}` !== file.sha256) {
      throw new Error(`compliance file digest mismatch for ${file.path}`);
    }
  }
  for (const required of [
    "compliance/sbom.spdx.json",
    "compliance/THIRD_PARTY_NOTICES.txt",
    "compliance/corresponding-source-offer.json",
    "compliance/builder-environment.json",
    "compliance/build-input-manifest.json",
    "compliance/js-builder-environment.json",
    "compliance/compliance-index.json",
  ]) {
    if (!compliancePaths.has(required)) throw new Error(`release is missing ${required}`);
  }
  if (![...compliancePaths].some((path) => path.startsWith("compliance/licenses/"))) {
    throw new Error("release contains no retained license texts");
  }
  if (![...compliancePaths].some((path) => path.startsWith("compliance/corresponding-source/"))) {
    throw new Error("release contains no corresponding source");
  }
  const actualCompliance = (await listRegularFiles(join(bundle, "compliance")))
    .map((path) => `compliance/${path}`);
  if (JSON.stringify(actualCompliance) !== JSON.stringify([...compliancePaths].sort())) {
    throw new Error("compliance tree does not exactly match its signed manifest");
  }

  const expectedBundleFiles = new Set([
    "Image",
    "rootfs.ext4",
    "manifest.json",
    "manifest.ed25519",
    "compliance-manifest.json",
    "compliance-manifest.ed25519",
    ...compliancePaths,
  ]);
  const actualBundleFiles = await listRegularFiles(bundle);
  if (JSON.stringify(actualBundleFiles) !== JSON.stringify([...expectedBundleFiles].sort())) {
    throw new Error("Guest image bundle contains unsigned or unexpected files");
  }
  return { root, bundle, descriptor, manifest, complianceManifest };
}

export async function copyAndHashSparse(sourceValue, destinationValue) {
  const sourcePath = resolve(sourceValue);
  const destinationPath = resolve(destinationValue);
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_ARTIFACT_BYTES)) {
      throw new Error(`${sourcePath} is not a supported nonempty artifact`);
    }
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      const requested = Math.min(buffer.byteLength, Number(before.size) - offset);
      const { bytesRead } = await source.read(buffer, 0, requested, offset);
      if (bytesRead === 0) throw new Error(`${sourcePath} ended before its stated size`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (!isAllZero(chunk)) await writeAll(destination, chunk, offset);
      offset += bytesRead;
    }
    await destination.truncate(offset);
    await destination.sync();
    const after = await source.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`${sourcePath} changed while it was copied`);
    }
    return {
      size: Number(before.size),
      sha256: `sha256:${hash.digest("hex")}`,
    };
  } finally {
    await destination?.close();
    await source.close();
  }
}

export async function copyTreeNoLinks(sourceValue, destinationValue) {
  const source = await requireDirectory(sourceValue, "copy source");
  const destination = resolve(destinationValue);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const visit = async (sourceDirectory, destinationDirectory) => {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const sourcePath = join(sourceDirectory, entry.name);
      const destinationPath = join(destinationDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`copy source contains symbolic link ${sourcePath}`);
      if (entry.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        await visit(sourcePath, destinationPath);
      } else if (entry.isFile()) {
        await copyAndHashSparse(sourcePath, destinationPath);
      } else throw new Error(`copy source contains unsupported entry ${sourcePath}`);
    }
  };
  await visit(source, destination);
}

export async function sha256File(pathValue) {
  const path = resolve(pathValue);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`${path} is not a regular file`);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error(`${path} changed while hashing`);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function listRegularFiles(rootValue) {
  const root = resolve(rootValue);
  const result = [];
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`release tree contains symbolic link ${absolute}`);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile()) result.push(path);
      else throw new Error(`release tree contains unsupported entry ${absolute}`);
    }
  };
  await visit(root);
  return result.sort();
}

export function publicKeyFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.byteLength !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([PUBLIC_KEY_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function exactReleaseDescriptor(value) {
  const object = exactObject(value, "$", [
    "schemaVersion", "vmWireVersion", "guestProtocolVersion", "architecture",
    "bundleRelativePath", "manifestDigest", "pinnedEd25519PublicKey", "supervisorVersion",
    "features", "runtimeAbi", "nodeVersion", "nodeModulesAbi", "libc", "cpuCount",
    "memorySizeBytes", "stateFormatVersion",
  ]);
  if (object.schemaVersion !== 1 || object.vmWireVersion !== 1 || object.guestProtocolVersion !== 1) {
    throw new Error("unsupported Guest release descriptor version");
  }
  if (object.architecture !== ARCHITECTURE || object.bundleRelativePath !== BUNDLE_NAME) {
    throw new Error("Guest release architecture or bundle path is invalid");
  }
  digest(object.manifestDigest, "$.manifestDigest");
  decodePublicKey(object.pinnedEd25519PublicKey);
  if (object.supervisorVersion !== "0.1.0") throw new Error("unexpected Guest supervisor version");
  if (JSON.stringify(object.features) !== JSON.stringify(EXPECTED_FEATURES)) {
    throw new Error("Guest feature list is not canonical");
  }
  if (
    object.runtimeAbi !== "capsule-node-v1"
    || object.nodeVersion !== "24.10.0"
    || object.nodeModulesAbi !== "137"
    || object.libc !== "glibc-2.43"
    || object.cpuCount !== 4
    || object.memorySizeBytes !== 4 * 1024 * 1024 * 1024
    || object.stateFormatVersion !== 1
  ) throw new Error("Guest runtime descriptor does not match the pinned runtime");
  return object;
}

function exactImageManifest(value) {
  const object = exactObject(value, "$", [
    "schemaVersion", "imageVersion", "architecture", "supervisorVersion", "artifacts",
  ]);
  if (object.schemaVersion !== 1 || object.architecture !== ARCHITECTURE || object.supervisorVersion !== "0.1.0") {
    throw new Error("Guest image manifest identity is invalid");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(object.imageVersion)) {
    throw new Error("Guest image version is invalid");
  }
  if (!Array.isArray(object.artifacts) || object.artifacts.length !== 2) {
    throw new Error("Guest image must contain kernel and rootfs artifacts");
  }
  const roles = new Set();
  object.artifacts = object.artifacts.map((value, index) => {
    const artifact = exactObject(value, `$.artifacts[${index}]`, ["role", "path", "size", "sha256"]);
    if (!["kernel", "rootfs"].includes(artifact.role) || roles.has(artifact.role)) {
      throw new Error("Guest image artifact roles are invalid");
    }
    roles.add(artifact.role);
    safeRelativePath(artifact.path, `$.artifacts[${index}].path`);
    const expectedPath = artifact.role === "kernel" ? "Image" : "rootfs.ext4";
    if (artifact.path !== expectedPath) throw new Error("Guest image artifact path is not canonical");
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > MAX_ARTIFACT_BYTES) {
      throw new Error("Guest image artifact size is invalid");
    }
    digest(artifact.sha256, `$.artifacts[${index}].sha256`);
    return artifact;
  });
  if (!roles.has("kernel") || !roles.has("rootfs")) throw new Error("Guest image artifacts are incomplete");
  return object;
}

function exactComplianceManifest(value) {
  const object = exactObject(value, "$", ["schemaVersion", "subjectManifestDigest", "files"]);
  if (object.schemaVersion !== 1) throw new Error("unsupported compliance manifest version");
  digest(object.subjectManifestDigest, "$.subjectManifestDigest");
  if (!Array.isArray(object.files) || object.files.length < 5 || object.files.length > 100_000) {
    throw new Error("compliance manifest file list is invalid");
  }
  let previous = "";
  object.files = object.files.map((value, index) => {
    const file = exactObject(value, `$.files[${index}]`, ["path", "size", "sha256"]);
    safeRelativePath(file.path, `$.files[${index}].path`);
    if (previous && previous >= file.path) {
      throw new Error("compliance manifest files must be sorted and unique");
    }
    previous = file.path;
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ARTIFACT_BYTES) {
      throw new Error("compliance file size is invalid");
    }
    digest(file.sha256, `$.files[${index}].sha256`);
    return file;
  });
  return object;
}

async function verifyDetached(path, bytes, publicKey, label) {
  const signature = await readSmallRegularBytes(path, 64);
  if (signature.byteLength !== 64 || !verify(null, bytes, publicKey, signature)) {
    throw new Error(`${label} signature is invalid`);
  }
}

function decodePublicKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("release Ed25519 public key is invalid");
  }
  const raw = Buffer.from(value, "base64");
  if (raw.byteLength !== 32 || raw.toString("base64") !== value) {
    throw new Error("release Ed25519 public key is not canonical");
  }
  return publicKeyFromRaw(raw);
}

async function readSmallRegularFile(path, maximumBytes) {
  return (await readSmallRegularBytes(path, maximumBytes)).toString("utf8");
}

async function readSmallRegularBytes(path, maximumBytes) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1 || details.size > maximumBytes) {
    throw new Error(`${path} is not a bounded regular file`);
  }
  return await readFile(path);
}

async function requireDirectory(value, label) {
  const path = resolve(value);
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  return await realpath(path);
}

async function listEntries(root) {
  return (await readdir(root)).sort((left, right) => left.localeCompare(right, "en"));
}

function exactObject(value, path, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const object = value;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${path} has unknown or missing fields`);
  return object;
}

function digest(value, path) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new Error(`${path} is not a sha256 digest`);
}

function safeRelativePath(value, path) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${path} is not a safe relative path`);
  }
  if (value.split("/").some((component) => !component || component === "." || component === "..")) {
    throw new Error(`${path} is not a safe relative path`);
  }
}

function joinInside(root, value) {
  safeRelativePath(value, "release path");
  const path = resolve(root, value);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("release path escapes its root");
  return path;
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (bytesWritten < 1) throw new Error("artifact copy made no progress");
    offset += bytesWritten;
  }
}

function isAllZero(buffer) {
  for (let index = 0; index < buffer.byteLength; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}
