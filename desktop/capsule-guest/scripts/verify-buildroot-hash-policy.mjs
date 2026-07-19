#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const LINUX_VERSION = "6.18.7";
const LINUX_ARCHIVE = `linux-${LINUX_VERSION}.tar.xz`;
const LINUX_SHA256 = "b726a4d15cf9ae06219b56d87820776e34d89fbc137e55fb54a9b9c3015b8f1e";
const LINUX_HASH_LINES = [
  `sha256  ${LINUX_SHA256}  ${LINUX_ARCHIVE}`,
  "sha256  fb5a425bd3b3cd6071a3a9aff9909a859e7c1158d54d32e07658398cd67eb6a0  COPYING",
  "sha256  8780e78a1a737e127f25a65f6d95269bffd36158dc261114de7859b490bfc5aa  LICENSES/preferred/GPL-2.0",
  "sha256  8e378ab93586eb55135d3bc119cce787f7324f48394777d00c34fa3d0be3303f  LICENSES/exceptions/Linux-syscall-note",
];
const NODE_HASH_LINES = [
  "sha256  07f0558316ebb8977dd6fb29b4de8d369a639d3d8cef544293852a6f5eea6af8  node-v24.10.0-linux-arm64.tar.xz",
  "sha256  537308465103a306d0e3eecf42632b4ff1b48aaaec044e9fc10a78c81fd00b34  LICENSE",
];

const [sourceValue, outputValue, externalValue, extra] = process.argv.slice(2);
if (!sourceValue || !outputValue || !externalValue || extra !== undefined) {
  throw new Error(
    "usage: verify-buildroot-hash-policy.mjs <buildroot-source> <output> <external-tree>",
  );
}

const source = await requireRealDirectory(sourceValue, "Buildroot source");
const output = await requireRealDirectory(outputValue, "Buildroot output");
const external = await requireRealDirectory(externalValue, "Buildroot external tree");
const checkHash = join(source, "support", "download", "check-hash");
await requireRegularFile(checkHash, "patched Buildroot check-hash");

const expectedHashFiles = new Map([
  ["LINUX_HASH_FILES", {
    builtIn: join(source, "linux", "linux.hash"),
    external: join(external, "patches", "linux", LINUX_VERSION, "linux.hash"),
    expectedLines: LINUX_HASH_LINES,
  }],
  [
    "LINUX_HEADERS_HASH_FILES",
    {
      builtIn: join(source, "package", "linux-headers", "linux-headers.hash"),
      external: join(
        external,
        "patches",
        "linux-headers",
        LINUX_VERSION,
        "linux-headers.hash",
      ),
      expectedLines: LINUX_HASH_LINES,
    },
  ],
]);
const variables = readBuildrootVariables(source, output, external, [
  "LINUX_HASH_FILES",
  "LINUX_HEADERS_HASH_FILES",
  "LINUX_SOURCE",
  "LINUX_HEADERS_SOURCE",
  "LINUX_VERSION",
  "LINUX_HEADERS_VERSION",
]);

for (const name of ["LINUX_VERSION", "LINUX_HEADERS_VERSION"]) {
  if (variables.get(name) !== LINUX_VERSION) {
    throw new Error(`${name} is not pinned to ${LINUX_VERSION}`);
  }
}
for (const name of ["LINUX_SOURCE", "LINUX_HEADERS_SOURCE"]) {
  if (variables.get(name) !== LINUX_ARCHIVE) {
    throw new Error(`${name} is not pinned to ${LINUX_ARCHIVE}`);
  }
}
for (const [name, expected] of expectedHashFiles) {
  const actualPaths = (variables.get(name)?.split(/\s+/).filter(Boolean) ?? [])
    .map((path) => resolve(source, path));
  if (
    JSON.stringify(actualPaths) !== JSON.stringify([expected.builtIn, expected.external])
  ) {
    throw new Error(`${name} did not resolve to its pinned external hash candidate`);
  }
  const existingPaths = [];
  for (const path of actualPaths) {
    try {
      await requireRegularFile(path, `${name} candidate`);
      existingPaths.push(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (JSON.stringify(existingPaths) !== JSON.stringify([expected.external])) {
    throw new Error(`${name} has an unpinned or missing effective hash file`);
  }
  await validatePinnedHashFile(expected.external, expected.expectedLines);
}

await validatePinnedHashFile(
  join(external, "package", "node24-bin", "node24-bin.hash"),
  NODE_HASH_LINES,
);

await exercisePatchedCheckHash(checkHash);
process.stdout.write(
  `Buildroot custom source and license hashes are pinned; Linux sha256:${LINUX_SHA256}\n`,
);

function readBuildrootVariables(sourceRoot, outputRoot, externalRoot, names) {
  const result = spawnSync("make", [
    "-s",
    "-C",
    sourceRoot,
    `O=${outputRoot}`,
    `BR2_EXTERNAL=${externalRoot}`,
    "printvars",
    `VARS=${names.join(" ")}`,
  ], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("could not inspect Buildroot hash resolution", {
      cause: result.error ?? new Error((result.stderr || result.stdout).trim()),
    });
  }
  const variables = new Map();
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`unexpected Buildroot printvars output: ${line}`);
    const name = line.slice(0, separator);
    if (!names.includes(name) || variables.has(name)) {
      throw new Error(`unexpected Buildroot printvars variable: ${name}`);
    }
    variables.set(name, line.slice(separator + 1));
  }
  if (variables.size !== names.length) {
    throw new Error("Buildroot printvars omitted a required Linux hash variable");
  }
  return variables;
}

async function validatePinnedHashFile(path, expectedLines) {
  await requireRegularFile(path, "custom source hash file");
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (JSON.stringify(lines) !== JSON.stringify(expectedLines)) {
    throw new Error(`${path} does not contain the exact pinned source and license hashes`);
  }
}

async function exercisePatchedCheckHash(checkHashPath) {
  const root = await mkdtemp(join(tmpdir(), "lamarck-buildroot-hash-policy-"));
  try {
    const archive = join(root, "fixture.tar.xz");
    const hashFile = join(root, "fixture.hash");
    const bytes = Buffer.from("Lamarck Buildroot hash policy fixture\n", "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });

    const missing = runCheckHash(checkHashPath, archive, []);
    requireStatus(missing, 3, "forced checking accepted a missing hash-file argument");
    if (
      !/ERROR: no hash file/.test(missing.stderr)
      || /WARNING: no hash file/.test(missing.stderr)
    ) throw new Error("forced missing-hash failure retained warn-and-continue semantics");

    const nonexistent = runCheckHash(checkHashPath, archive, [join(root, "missing.hash")]);
    requireStatus(nonexistent, 3, "forced checking accepted a nonexistent hash file");

    await writeFile(
      hashFile,
      `sha256  ${"0".repeat(64)}  fixture.tar.xz\n`,
      { flag: "wx", mode: 0o600 },
    );
    const mismatch = runCheckHash(checkHashPath, archive, [hashFile]);
    requireStatus(mismatch, 2, "forced checking accepted a mismatched archive hash");

    await writeFile(hashFile, `sha256  ${digest}  fixture.tar.xz\n`);
    const valid = runCheckHash(checkHashPath, archive, [hashFile]);
    requireStatus(valid, 0, "forced checking rejected a valid archive hash");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runCheckHash(checkHashPath, archive, hashFiles) {
  return spawnSync(checkHashPath, [archive, "fixture.tar.xz", ...hashFiles], {
    encoding: "utf8",
    env: {
      ...process.env,
      BR2_DOWNLOAD_FORCE_CHECK_HASHES: "y",
      BR_NO_CHECK_HASH_FOR: "",
    },
  });
}

function requireStatus(result, expected, message) {
  if (result.error || result.status !== expected) {
    throw new Error(message, {
      cause: result.error ?? new Error((result.stderr || result.stdout).trim()),
    });
  }
}

async function requireRealDirectory(pathValue, label) {
  const path = resolve(pathValue);
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
  return await realpath(path);
}

async function requireRegularFile(path, label) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1 || details.nlink !== 1) {
    throw new Error(`${label} is not a nonempty single-link regular file: ${path}`);
  }
}
