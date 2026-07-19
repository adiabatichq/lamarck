#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

run("npm", ["--workspace", "@lamarck/capsule", "test"]);
run("npm", ["--workspace", "@lamarck/capsule", "run", "typecheck"]);
run("npm", ["--workspace", "@lamarck/capsule-guest", "test"]);
run("npm", ["--workspace", "@lamarck/capsule-guest", "run", "typecheck"]);
run("node", ["desktop/capsule-guest/scripts/test-native-helpers.mjs"]);
run("node", ["desktop/capsule-guest/scripts/test-build-inputs.mjs"]);
run("node", ["desktop/capsule-guest/scripts/test-release-pipeline.mjs"]);
run("npm", ["--workspace", "@lamarck/core", "run", "build"]);
run("npm", [
  "--workspace",
  "@lamarck/core",
  "run",
  "test:unit",
  "--",
  "test/app-runtime-capsule.e2e.test.ts",
]);
run("npm", ["--workspace", "@lamarck/system", "test"]);
run("npm", [
  "--workspace",
  "@lamarck/shell",
  "run",
  "test",
  "--",
  "electron/capsule",
  "electron/capsule-vm",
]);

if (process.platform === "darwin") {
  const scratchPath = join(root, ".lamarck", "build", "capsule-vm-macos-tests");
  mkdirSync(scratchPath, { recursive: true });
  run("xcrun", [
    "swift",
    "test",
    "--disable-sandbox",
    "--package-path",
    join(root, "desktop", "capsule-vm-macos"),
    "--scratch-path",
    scratchPath,
  ], {
    ...process.env,
    SWIFT_MODULECACHE_PATH: join(scratchPath, "module-cache", "swift"),
    CLANG_MODULE_CACHE_PATH: join(scratchPath, "module-cache", "clang"),
  });
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
