#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(root, "desktop");
const skippedDirectories = new Set([
  ".build",
  ".swiftpm",
  "dist",
  "dist-electron",
  "node_modules",
]);

// This cross-module E2E already imports the SDK transport implementation. It
// remains explicit debt until the integration suite moves out of Core; the SDK
// package must not own or suppress this repository-level exception.
const sourceConsumerDebt = new Map([
  [
    "desktop/core/test/app-runtime-capsule.e2e.test.ts",
    "move the Core/Shell/Capsule integration to the root integration suite",
  ],
]);

const violations = [];
const observedDebt = new Set();

await walk(desktopRoot, async (path) => {
  const repositoryPath = relative(root, path).split(sep).join("/");
  if (repositoryPath.startsWith("desktop/system-sdk/")) return;

  if (path.endsWith("/lamarck-system.d.ts")) {
    violations.push(`${repositoryPath}: copied @lamarck/system declaration`);
  }
  if (!/\.(?:[cm]?[jt]sx?|d\.ts)$/.test(path)) return;

  const source = await readFile(path, "utf8");
  if (source.includes(`declare module "@lamarck/system"`)) {
    violations.push(`${repositoryPath}: ambient @lamarck/system declaration`);
  }
  if (source.includes("LAMARCK_SYSTEM_DTS")) {
    violations.push(`${repositoryPath}: legacy copied SDK declaration marker`);
  }
  if (source.includes("system-sdk/src/")) {
    const reason = sourceConsumerDebt.get(repositoryPath);
    if (reason) {
      observedDebt.add(repositoryPath);
      process.stderr.write(`[module-boundaries] existing debt: ${repositoryPath} — ${reason}\n`);
    } else {
      violations.push(`${repositoryPath}: imports System SDK implementation source`);
    }
  }
});

for (const path of sourceConsumerDebt.keys()) {
  if (!observedDebt.has(path)) {
    violations.push(`${path}: stale System SDK source-import debt allowance`);
  }
}

if (violations.length > 0) {
  throw new Error(`Repository module boundary violations:\n- ${violations.join("\n- ")}`);
}

process.stdout.write("Repository module boundaries verified\n");

async function walk(directory, visit) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) await walk(path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    }
  }
}
