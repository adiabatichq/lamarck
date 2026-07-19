#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { validateBuildSnapshot } from "./build-snapshot.mjs";
import { sha256File } from "./release-contract.mjs";

const [snapshotValue, installedSourceValue, outputRootValue] = process.argv.slice(2);
if (!snapshotValue || !installedSourceValue || !outputRootValue) {
  throw new Error(
    "usage: generate-js-builder-inventory.mjs <snapshot> <installed-source> <prebuilt-output>",
  );
}
const snapshot = resolve(snapshotValue);
const installedSource = resolve(installedSourceValue);
const outputRoot = resolve(outputRootValue);
const snapshotDetails = await validateBuildSnapshot(snapshot);
const requireFromBuild = createRequire(join(installedSource, "package.json"));
const npmRoot = resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm");
const npmPackage = JSON.parse(await readFile(join(npmRoot, "package.json"), "utf8"));
const typescriptPackagePath = requireFromBuild.resolve("typescript/package.json");
const esbuildPackagePath = requireFromBuild.resolve("esbuild/package.json");
const esbuildBinaryPath = requireFromBuild.resolve("@esbuild/linux-arm64/bin/esbuild");
const typescriptPackage = JSON.parse(await readFile(typescriptPackagePath, "utf8"));
const esbuildPackage = JSON.parse(await readFile(esbuildPackagePath, "utf8"));
const packageLockPath = join(snapshot, "package-lock.json");

const outputFiles = await listRegularFiles(outputRoot, new Set(["js-builder-environment.json"]));
if (outputFiles.length < 2 || outputFiles.length > 1_000) {
  throw new Error("JavaScript builder emitted an unsupported number of files");
}
let aggregateOutputBytes = 0;
for (const path of outputFiles) {
  const details = await lstat(join(outputRoot, path));
  if (details.size < 1 || details.size > 128 * 1024 * 1024) {
    throw new Error(`JavaScript builder output has an unsupported size: ${path}`);
  }
  aggregateOutputBytes += details.size;
}
if (aggregateOutputBytes > 256 * 1024 * 1024) {
  throw new Error("JavaScript builder output exceeds its aggregate byte limit");
}
const inventory = {
  schemaVersion: 1,
  sourceSnapshotManifestDigest: snapshotDetails.manifestDigest,
  packageLockSha256: `sha256:${await sha256File(packageLockPath)}`,
  runtime: {
    nodeVersion: process.version,
    nodeExecutableSha256: `sha256:${await sha256File(process.execPath)}`,
    npmVersion: npmPackage.version,
    npmCliSha256: `sha256:${await sha256File(join(npmRoot, "bin", "npm-cli.js"))}`,
  },
  tools: {
    esbuildVersion: esbuildPackage.version,
    esbuildPackageSha256: `sha256:${await sha256File(esbuildPackagePath)}`,
    esbuildBinarySha256: `sha256:${await sha256File(esbuildBinaryPath)}`,
    typescriptVersion: typescriptPackage.version,
    typescriptPackageSha256: `sha256:${await sha256File(typescriptPackagePath)}`,
    typescriptCliSha256: `sha256:${await sha256File(join(dirname(typescriptPackagePath), "bin", "tsc"))}`,
  },
  outputs: await Promise.all(outputFiles.map(async (path) => {
    const absolute = join(outputRoot, path);
    const details = await lstat(absolute);
    return {
      path,
      size: details.size,
      sha256: `sha256:${await sha256File(absolute)}`,
    };
  })),
};
if (
  inventory.runtime.nodeVersion !== "v24.10.0"
  || inventory.runtime.npmVersion !== "11.6.1"
  || inventory.tools.esbuildVersion !== "0.25.12"
  || inventory.tools.typescriptVersion !== "5.9.3"
) throw new Error("JavaScript builder toolchain does not match the pinned release identity");
await writeFile(
  join(outputRoot, "js-builder-environment.json"),
  `${JSON.stringify(inventory)}\n`,
  { flag: "wx", mode: 0o600 },
);

async function listRegularFiles(root, excluded) {
  const result = [];
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`prebuilt output contains symbolic link ${absolute}`);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile()) {
        if (!excluded.has(path)) result.push(path);
      } else throw new Error(`prebuilt output contains unsupported entry ${absolute}`);
    }
  };
  await visit(root);
  return result.sort((left, right) => left.localeCompare(right, "en"));
}
