#!/usr/bin/env node

import { cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stageCapsuleNative } from "./stage-capsule-native.mjs";
import { distributionIdentity } from "./package-macos-release-contract.mjs";

if (process.platform !== "darwin") {
  console.error("The Apple Virtualization.framework helper can only be built on macOS.");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(root, "desktop", "capsule-vm-macos");
const outDir = resolve(
  process.env.LAMARCK_CAPSULE_NATIVE_ROOT
    ?? join(root, "desktop", "shell", "dist-electron", "native"),
);
const guestReleaseRoot = resolve(
  process.env.LAMARCK_GUEST_RELEASE_ROOT
    ?? join(root, ".lamarck", "build", "capsule-guest", "release"),
);
const scratchPath = resolve(
  process.env.LAMARCK_CAPSULE_BUILD_SCRATCH
    ?? join(root, ".lamarck", "build", "capsule-vm-macos"),
);
const product = "lamarck-capsule-vm-host";
const destination = join(outDir, product);
const distributionBuild = process.env.LAMARCK_REQUIRE_DISTRIBUTION_SIGNING === "1";
const codesignIdentity = distributionBuild
  ? distributionIdentity(process.env.LAMARCK_CODESIGN_IDENTITY)
  : process.env.LAMARCK_CODESIGN_IDENTITY || "-";
const swiftEnvironment = {
  ...process.env,
  SWIFT_MODULECACHE_PATH: join(scratchPath, "module-cache", "swift"),
  CLANG_MODULE_CACHE_PATH: join(scratchPath, "module-cache", "clang"),
};

await mkdir(scratchPath, { recursive: true });

run("xcrun", [
  "swift",
  "build",
  "--disable-sandbox",
  "--package-path",
  packagePath,
  "--scratch-path",
  scratchPath,
  "--configuration",
  "release",
  "--product",
  product,
], swiftEnvironment);

const binPath = capture("xcrun", [
  "swift",
  "build",
  "--disable-sandbox",
  "--package-path",
  packagePath,
  "--scratch-path",
  scratchPath,
  "--configuration",
  "release",
  "--show-bin-path",
], swiftEnvironment);

await mkdir(outDir, { recursive: true });
await cp(join(binPath, product), destination);

run("codesign", [
  "--force",
  "--sign",
  codesignIdentity,
  "--options",
  "runtime",
  ...(distributionBuild ? ["--timestamp"] : []),
  "--entitlements",
  join(packagePath, "CapsuleVmHost.entitlements"),
  destination,
]);
run("codesign", ["--verify", "--strict", "--verbose=4", destination]);
await stageCapsuleNative(root, { sourceReleaseRoot: guestReleaseRoot, nativeRoot: outDir });

console.log(destination);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
}
