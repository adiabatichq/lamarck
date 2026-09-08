#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyAndHashSparse, listRegularFiles, sha256File } from "./release-contract.mjs";

export const OS_BASE_MANIFEST = "os-base-manifest.json";
export const OS_BASE_SOURCE_DIRECTORIES = ["desktop/capsule-guest/buildroot", "desktop/capsule-guest/native"];
export const OS_BASE_SOURCE_FILES = [
  "LICENSE",
  "desktop/capsule-guest/scripts/build-buildroot-inside.sh",
  "desktop/capsule-guest/scripts/verify-buildroot-hash-policy.mjs",
];
const OUTPUT_ROOTS = ["image-input/", "output/legal-info/", "src/", "os-source/"];
const REQUIRED_OUTPUTS = [
  "image-input/Image", "image-input/rootfs.ext4", "image-input/builder-packages.tsv",
  "output/legal-info/manifest.csv", "output/legal-info/legal-info.sha256",
  "output/legal-info/buildroot.config", "output/legal-info/host-manifest.csv", "src/buildroot-2026.05.tar.xz",
];

/** Only inputs to OS/native outputs, not the npm lock or Guest business JS. */
export async function describeOsBaseInputs(repository, builderImageId, sourceDateEpoch = "0", jobs = "4") {
  if (!/^sha256:[a-f0-9]{64}$/.test(builderImageId)) throw new Error("OS base requires an immutable builder image ID");
  if (!/^(0|[1-9][0-9]*)$/.test(String(sourceDateEpoch)) || !Number.isSafeInteger(Number(sourceDateEpoch))) throw new Error("invalid OS base SOURCE_DATE_EPOCH");
  if (!/^[1-9][0-9]*$/.test(String(jobs)) || Number(jobs) > 256) throw new Error("OS base JOBS must be between 1 and 256");
  const paths = [...OS_BASE_SOURCE_FILES];
  for (const directory of OS_BASE_SOURCE_DIRECTORIES) {
    await realDirectory(join(repository, directory));
    paths.push(...(await listRegularFiles(join(repository, directory))).map(path => `${directory}/${path}`));
  }
  return {
    schemaVersion: 1, platform: "linux/arm64", builderImageId,
    sourceDateEpoch: Number(sourceDateEpoch), jobs: Number(jobs),
    files: await inventory(repository, paths.sort()),
  };
}

/** Called only after a fresh isolated native build, before base publication. */
export async function createOsBase(base, repository, builderImageId, epoch, jobs) {
  await realDirectory(base);
  const identity = await describeOsBaseInputs(repository, builderImageId, epoch, jobs);
  await mkdir(join(base, "os-source"), { mode: 0o700 });
  for (const file of identity.files) await copyOsBaseFile(basePath(repository, file.path), basePath(join(base, "os-source"), file.path), file.mode);
  if (JSON.stringify(identity) !== JSON.stringify(await describeOsBaseInputs(repository, builderImageId, epoch, jobs))) throw new Error("OS base source changed during capture");
  const outputs = await inventory(base, await listRegularFiles(base));
  validateOutputPaths(outputs);
  const manifest = { schemaVersion: 1, identity, outputs };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(join(base, OS_BASE_MANIFEST), bytes, { flag: "wx", mode: 0o444 });
  const digest = hash(bytes);
  await verifyOsBase(base, digest, identity);
  return { digest, manifest };
}

/** A pin comes from the caller, never from an untrusted artifact directory. */
export async function verifyOsBase(base, expectedDigest, expectedIdentity) {
  await realDirectory(base);
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("OS base requires an explicit SHA-256 manifest pin");
  const bytes = await readManifest(join(base, OS_BASE_MANIFEST));
  if (hash(bytes) !== expectedDigest) throw new Error("OS base manifest digest mismatch");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (!manifest || Object.keys(manifest).sort().join(",") !== "identity,outputs,schemaVersion" || manifest.schemaVersion !== 1) throw new Error("invalid OS base V1 manifest");
  if (JSON.stringify(manifest.identity) !== JSON.stringify(expectedIdentity)) throw new Error("OS base inputs do not match the current OS/native build inputs");
  validateOutputPaths(manifest.outputs);
  const paths = await listRegularFiles(base);
  if (JSON.stringify(paths) !== JSON.stringify([...manifest.outputs.map(file => file.path), OS_BASE_MANIFEST].sort())) throw new Error("OS base contains missing or unexpected files");
  const actual = await inventory(base, manifest.outputs.map(file => file.path));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.outputs)) throw new Error("OS base output integrity mismatch");
  // Retained native source must actually be the source named by the identity.
  const source = await inventory(join(base, "os-source"), expectedIdentity.files.map(file => file.path));
  if (JSON.stringify(source) !== JSON.stringify(expectedIdentity.files)) throw new Error("OS base corresponding source mismatch");
  return { digest: expectedDigest, manifest };
}

/** Copy verified files into a private build staging tree, then verify again. */
export async function stageOsBase(base, expectedDigest, expectedIdentity, destination) {
  const verified = await verifyOsBase(base, expectedDigest, expectedIdentity);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const file of verified.manifest.outputs) await copyOsBaseFile(basePath(base, file.path), basePath(destination, file.path), file.mode);
  await copyOsBaseFile(join(base, OS_BASE_MANIFEST), join(destination, OS_BASE_MANIFEST), 0o444);
  return verifyOsBase(destination, expectedDigest, expectedIdentity);
}

function validateOutputPaths(outputs) {
  if (!Array.isArray(outputs) || outputs.length < REQUIRED_OUTPUTS.length || outputs.length > 100_000) throw new Error("invalid OS base output inventory");
  let previous = "";
  for (const file of outputs) {
    if (!file || Object.keys(file).sort().join(",") !== "mode,path,sha256,size"
      || typeof file.path !== "string" || !safePath(file.path) || file.path <= previous
      || !OUTPUT_ROOTS.some(prefix => file.path.startsWith(prefix))
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 16 * 1024 ** 3
      || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777
      || !/^sha256:[a-f0-9]{64}$/.test(file.sha256)) throw new Error("invalid OS base output record");
    previous = file.path;
  }
  for (const required of REQUIRED_OUTPUTS) if (!outputs.some(file => file.path === required && file.size > 0)) throw new Error(`OS base is missing ${required}`);
  for (const prefix of ["output/legal-info/licenses/", "output/legal-info/sources/", "output/legal-info/host-licenses/", "output/legal-info/host-sources/"]) {
    if (!outputs.some(file => file.path.startsWith(prefix) && file.size > 0)) throw new Error(`OS base is missing corresponding source or licenses: ${prefix}`);
  }
}

async function inventory(root, paths) {
  const result = [];
  for (const path of paths) {
    const absolute = basePath(root, path);
    const before = await lstat(absolute, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(16 * 1024 ** 3)) throw new Error(`OS base input is not a bounded, unlinked regular file: ${path}`);
    const sha256 = `sha256:${await sha256File(absolute)}`;
    const after = await lstat(absolute, { bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) throw new Error(`OS base input changed: ${path}`);
    result.push({ path, mode: Number(before.mode & 0o777n), size: Number(before.size), sha256 });
  }
  return result;
}

export async function copyOsBaseFile(source, destination, mode) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if ((await lstat(source)).size === 0) await writeFile(destination, Buffer.alloc(0), { flag: "wx", mode });
  else await copyAndHashSparse(source, destination);
  await chmod(destination, mode);
}

async function readManifest(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 16 * 1024 * 1024) throw new Error("invalid OS base manifest file");
    return await file.readFile();
  } finally { await file.close(); }
}

async function realDirectory(path) {
  if (!(await lstat(path)).isDirectory()) throw new Error(`OS base directory is missing or symbolic: ${path}`);
}
function safePath(path) { return path.length <= 2048 && !/[\\\x00]/.test(path) && path.split("/").every(part => part && part !== "." && part !== ".."); }
function basePath(root, path) { if (!safePath(path)) throw new Error("invalid OS base relative path"); return join(root, path); }
function hash(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, base, pinOrRepository, repositoryOrBuilder, builderOrEpoch, epochOrJobs, jobsOrDestination, destination] = process.argv.slice(2);
  if (command === "create") {
    console.log((await createOsBase(base, pinOrRepository, repositoryOrBuilder, builderOrEpoch, epochOrJobs)).digest);
  } else if (command === "verify" || command === "stage") {
    const identity = await describeOsBaseInputs(repositoryOrBuilder, builderOrEpoch, epochOrJobs, jobsOrDestination);
    if (command === "stage") await stageOsBase(base, pinOrRepository, identity, destination);
    else await verifyOsBase(base, pinOrRepository, identity);
    console.log(pinOrRepository);
  } else throw new Error("usage: os-base.mjs create <base> <snapshot> <builder-id> <epoch> <jobs> | verify|stage <base> <pin> <snapshot> <builder-id> <epoch> <jobs> [destination]");
}
