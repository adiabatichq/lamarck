#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  ARCHITECTURE,
  BUNDLE_NAME,
  EXPECTED_FEATURES,
  GUEST_RELEASE_PREFIX,
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

const sourceDirectory = join(complianceInput, "corresponding-source");
await requireRealDirectory(sourceDirectory, "corresponding source");
const sourceArchiveName = `Lamarck-Capsule-Guest-${imageVersion}-Open-Source.tar.gz`;
const sourceArchivePath = join(releaseRoot, sourceArchiveName);
createSourceArchive(sourceDirectory, sourceArchivePath);
const sourceArchiveDetails = await lstat(sourceArchivePath);
const publicBase = validatedPublicBase(
  process.env.RELEASES_PUBLIC_BASE ?? "https://releases.lamarck.ai",
);
const objectPrefix = `${GUEST_RELEASE_PREFIX}/${imageDigest.slice("sha256:".length, "sha256:".length + 16)}`;
const correspondingSource = {
  imageVersion,
  file: sourceArchiveName,
  url: `${publicBase}/${objectPrefix}/${sourceArchiveName}`,
  sha256: `sha256:${await sha256File(sourceArchivePath)}`,
  bytes: sourceArchiveDetails.size,
  mediaType: "application/gzip",
  format: "tar+gzip",
};

const complianceRoot = join(bundle, "compliance");
await copyRuntimeCompliance(complianceInput, complianceRoot);
const preparedOffer = JSON.parse(await readFile(
  join(complianceInput, "corresponding-source-offer.json"),
  "utf8",
));
if (
  preparedOffer.schemaVersion !== 1
  || preparedOffer.fulfillment?.kind !== "prepared-corresponding-source"
  || !Array.isArray(preparedOffer.components)
  || !Array.isArray(preparedOffer.files)
) {
  throw new Error("prepared corresponding-source offer is invalid");
}
await writeExclusive(
  join(complianceRoot, "corresponding-source-offer.json"),
  Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    subject: preparedOffer.subject,
    fulfillment: {
      kind: "network-download",
      archive: correspondingSource,
      statement:
        "This exact source archive is published beside the immutable Guest release. It is not required to install, run, or update Lamarck.",
    },
    buildroot: preparedOffer.buildroot,
    components: preparedOffer.components,
    files: preparedOffer.files,
  })}\n`, "utf8"),
);
const indexedComplianceFiles = await listRegularFiles(complianceRoot);
await writeExclusive(
  join(complianceRoot, "compliance-index.json"),
  Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    imageVersion,
    architecture: ARCHITECTURE,
    files: await Promise.all(indexedComplianceFiles.map(async (path) => ({
      path,
      sha256: `sha256:${await sha256File(join(complianceRoot, path))}`,
    }))),
  })}\n`, "utf8"),
);

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

const complianceManifestBytes = Buffer.from(`${JSON.stringify({
  schemaVersion: 2,
  subjectManifestDigest: imageDigest,
  files: complianceFiles,
})}\n`, "utf8");
const complianceSignature = sign(null, complianceManifestBytes, privateKey);
if (complianceSignature.byteLength !== 64) throw new Error("Ed25519 signature must be 64 bytes");
await writeExclusive(join(bundle, "compliance-manifest.json"), complianceManifestBytes);
await writeExclusive(join(bundle, "compliance-manifest.ed25519"), complianceSignature);

const release = {
  schemaVersion: 2,
  vmWireVersion: 2,
  guestProtocolVersion: 2,
  architecture: ARCHITECTURE,
  bundleRelativePath: BUNDLE_NAME,
  manifestDigest: imageDigest,
  pinnedEd25519PublicKey: publicKey.toString("base64"),
  supervisorVersion: "0.1.0",
  features: EXPECTED_FEATURES,
  runtimeAbi: "capsule-node-v1",
  nodeVersion: "24.18.0",
  nodeModulesAbi: "137",
  libc: "glibc-2.43",
  cpuCount: 4,
  memorySizeBytes: 4 * 1024 * 1024 * 1024,
  stateFormatVersion: 1,
  correspondingSource,
};
await writeExclusive(
  join(releaseRoot, "capsule-guest-release.json"),
  Buffer.from(`${JSON.stringify(release)}\n`, "utf8"),
);
await validateGuestRelease(releaseRoot, { requireSourceArchive: true });
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

async function copyRuntimeCompliance(source, destination) {
  await mkdir(destination, { mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (
      entry.name === "corresponding-source"
      || entry.name === "corresponding-source-offer.json"
      || entry.name === "compliance-index.json"
    ) continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`compliance input contains symbolic link ${sourcePath}`);
    if (entry.isDirectory()) await copyTreeNoLinks(sourcePath, destinationPath);
    else if (entry.isFile()) await copyAndHashSparse(sourcePath, destinationPath);
    else throw new Error(`compliance input contains unsupported entry ${sourcePath}`);
  }
}

function createSourceArchive(source, destination) {
  const version = spawnSync("tar", ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) throw version.error ?? new Error("tar is unavailable");
  const common = ["-czf", destination, "-C", dirname(source), basename(source)];
  const args = /GNU tar/.test(version.stdout)
    ? [
        "--sort=name",
        `--mtime=@${parseSourceDateEpoch(process.env.SOURCE_DATE_EPOCH ?? "0")}`,
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=pax",
        "--pax-option=delete=atime,delete=ctime",
        "--no-xattrs",
        ...common,
      ]
    : ["--format", "pax", ...common];
  const result = spawnSync("tar", args, {
    env: { ...process.env, COPYFILE_DISABLE: "1", LC_ALL: "C" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar exited with ${result.status ?? result.signal}`);
}

function parseSourceDateEpoch(value) {
  if (!/^(0|[1-9][0-9]{0,11})$/.test(value)) throw new Error("SOURCE_DATE_EPOCH is invalid");
  return value;
}

function validatedPublicBase(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) throw new Error("RELEASES_PUBLIC_BASE must be a public HTTPS origin or path");
  return url.toString().replace(/\/$/, "");
}
