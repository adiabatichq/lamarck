#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outDir = join(root, "dist");
const outFile = join(outDir, `lamarck-${pkg.version}.tar.gz`);

run("npm", ["--workspace", "@lamarck/core", "run", "build"]);
run("npm", ["--workspace", "@lamarck/shell", "run", "build"]);
mkdirSync(outDir, { recursive: true });

const include = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "desktop",
  "scripts/package-os-patch.mjs",
  "scripts/build-core.mjs",
  "scripts/build-electron-main.mjs",
  "scripts/build-system-identity.mjs",
  "scripts/build-capsule-vm-macos.mjs",
  "scripts/stage-capsule-native.mjs",
  "scripts/build-macos-release-shell-inside.mjs",
  "scripts/macos-release-publication.mjs",
  "scripts/macos-release-runtime.mjs",
  "scripts/macos-release-signer.mjs",
  "scripts/macos-release-source.mjs",
  "scripts/package-macos-release-contract.mjs",
  "scripts/package-macos-release.mjs",
  "scripts/package-macos-release.test.mjs",
  "scripts/rename-excl.c",
  "scripts/test-capsule.mjs",
];

const args = [
  "-czf",
  outFile,
  "--exclude",
  "node_modules",
  "--exclude",
  ".git",
  "--exclude",
  "desktop/shell/dist-electron/.swift-build",
  "--exclude",
  "desktop/shell/dist-electron/.swift-test",
  "--exclude",
  "desktop/capsule-vm-macos/.build",
  "--exclude",
  "*/.lamarck/*.db",
  "--exclude",
  "*/.lamarck/*.db-*",
  ...include,
];

const result = spawnSync("tar", args, { cwd: root, stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(outFile);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
