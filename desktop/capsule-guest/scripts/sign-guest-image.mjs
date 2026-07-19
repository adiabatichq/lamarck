#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ARCHITECTURE,
  BUNDLE_NAME,
  EXPECTED_FEATURES,
  copyAndHashSparse,
  copyTreeNoLinks,
  listRegularFiles,
  sha256File,
  validateGuestRelease,
} from "./release-contract.mjs";
import { readValidatedGuestSigningKey } from "./signing-key.mjs";

const [
  inputValue,
  complianceValue,
  outputValue,
  keyValue,
  imageVersion = "0.1.0",
  repositoryRootValue,
] =
  process.argv.slice(2);
if (!inputValue || !complianceValue || !outputValue || !keyValue) {
  throw new Error(
    "usage: sign-guest-image.mjs <image-input> <compliance-input> <release-root> <ed25519-private-key.pem> [image-version] [live-repository-root]",
  );
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(imageVersion)) {
  throw new Error("invalid image version");
}
const input = resolve(inputValue);
const complianceInput = resolve(complianceValue);
const releaseRoot = resolve(outputValue);
const keyPath = resolve(keyValue);
await requireRealDirectory(input, "image input");
await requireRealDirectory(complianceInput, "compliance input");
await mkdir(releaseRoot, { recursive: false, mode: 0o700 });
const bundle = join(releaseRoot, BUNDLE_NAME);
await mkdir(bundle, { mode: 0o700 });

const artifactInputs = [
  { role: "kernel", source: join(input, "Image"), path: "Image" },
  { role: "rootfs", source: join(input, "rootfs.ext4"), path: "rootfs.ext4" },
];
const artifacts = [];
for (const artifact of artifactInputs) {
  const copied = await copyAndHashSparse(artifact.source, join(bundle, artifact.path));
  artifacts.push({
    role: artifact.role,
    path: artifact.path,
    size: copied.size,
    sha256: copied.sha256,
  });
}

const complianceRoot = join(bundle, "compliance");
await copyTreeNoLinks(complianceInput, complianceRoot);
const complianceFiles = [];
for (const relativePath of await listRegularFiles(complianceRoot)) {
  const path = join(complianceRoot, relativePath);
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1) {
    throw new Error(`invalid compliance file ${relativePath}`);
  }
  complianceFiles.push({
    path: `compliance/${relativePath}`,
    size: details.size,
    sha256: `sha256:${await sha256File(path)}`,
  });
}

const manifest = {
  schemaVersion: 1,
  imageVersion,
  architecture: ARCHITECTURE,
  supervisorVersion: "0.1.0",
  artifacts,
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
const validatedKey = await readValidatedGuestSigningKey(
  keyPath,
  repositoryRootValue ? { repositoryRoot: repositoryRootValue } : undefined,
);
const privateKey = createPrivateKey(validatedKey.bytes);
if (privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("Guest signing key must be Ed25519");
}
const manifestSignature = sign(null, manifestBytes, privateKey);
if (manifestSignature.byteLength !== 64) throw new Error("Ed25519 signature must be 64 bytes");
const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
const expectedPrefix = Buffer.from("302a300506032b6570032100", "hex");
if (publicDer.byteLength !== 44 || !publicDer.subarray(0, 12).equals(expectedPrefix)) {
  throw new Error("unexpected Ed25519 public key encoding");
}
const publicKey = publicDer.subarray(12);
const imageDigest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
await writeExclusive(join(bundle, "manifest.json"), manifestBytes);
await writeExclusive(join(bundle, "manifest.ed25519"), manifestSignature);

const complianceManifestBytes = Buffer.from(`${JSON.stringify({
  schemaVersion: 1,
  subjectManifestDigest: imageDigest,
  files: complianceFiles,
})}\n`, "utf8");
const complianceSignature = sign(null, complianceManifestBytes, privateKey);
if (complianceSignature.byteLength !== 64) throw new Error("Ed25519 signature must be 64 bytes");
await writeExclusive(join(bundle, "compliance-manifest.json"), complianceManifestBytes);
await writeExclusive(join(bundle, "compliance-manifest.ed25519"), complianceSignature);

const release = {
  schemaVersion: 1,
  vmWireVersion: 1,
  guestProtocolVersion: 1,
  architecture: ARCHITECTURE,
  bundleRelativePath: BUNDLE_NAME,
  manifestDigest: imageDigest,
  pinnedEd25519PublicKey: publicKey.toString("base64"),
  supervisorVersion: "0.1.0",
  features: EXPECTED_FEATURES,
  runtimeAbi: "capsule-node-v1",
  nodeVersion: "24.10.0",
  nodeModulesAbi: "137",
  libc: "glibc-2.43",
  cpuCount: 4,
  memorySizeBytes: 4 * 1024 * 1024 * 1024,
  stateFormatVersion: 1,
};
await writeExclusive(
  join(releaseRoot, "capsule-guest-release.json"),
  Buffer.from(`${JSON.stringify(release)}\n`, "utf8"),
);
await validateGuestRelease(releaseRoot);
process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);

async function requireRealDirectory(path, label) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
}

async function writeExclusive(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
}
