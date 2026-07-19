#!/usr/bin/env node

import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

const [repositoryValue, extra] = process.argv.slice(2);
if (!repositoryValue || extra !== undefined) {
  throw new Error("usage: validate-buildroot-download-cache.mjs <repository-root>");
}

const repository = await requireRealDirectory(resolve(repositoryValue), "repository root");
const components = [
  ".lamarck",
  "build",
  "capsule-guest",
  "download-cache",
  "buildroot-2026.05-v1",
];
let cacheRoot = repository;
for (const component of components) {
  const candidate = resolve(cacheRoot, component);
  requireInside(repository, candidate);
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const details = await lstat(candidate);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Buildroot download cache path is not a real directory: ${candidate}`);
  }
  const canonical = await realpath(candidate);
  if (canonical !== candidate) {
    throw new Error(`Buildroot download cache path escapes its fixed repository root: ${candidate}`);
  }
  cacheRoot = candidate;
}

// Docker's --mount parser uses commas as field separators. The cache location
// is fixed rather than caller-selected, but fail clearly if the repository
// itself is in a path that cannot be represented by this mount form.
if (cacheRoot.includes(",") || cacheRoot.includes("\n") || cacheRoot.includes("\r")) {
  throw new Error("Buildroot download cache path is not representable as a Docker bind mount");
}

await validateCacheTree(cacheRoot, cacheRoot);
process.stdout.write(`${cacheRoot}\n`);

async function validateCacheTree(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    requireInside(root, path);
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      throw new Error(`Buildroot download cache contains a symbolic link: ${path}`);
    }
    if (details.isDirectory()) await validateCacheTree(root, path);
    else if (!details.isFile()) {
      throw new Error(`Buildroot download cache contains a special entry: ${path}`);
    }
  }
}

async function requireRealDirectory(path, label) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
  return await realpath(path);
}

function requireInside(root, path) {
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error(`Buildroot download cache path escapes its fixed repository root: ${path}`);
  }
}
