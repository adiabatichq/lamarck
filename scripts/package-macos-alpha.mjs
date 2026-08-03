#!/usr/bin/env node

// Transition-period alpha packager: assembles a runnable, AD-HOC signed
// "Lamarck Alpha.app" zip from the ordinary developer build outputs.
//
// This is NOT the production release path. It produces no Developer ID
// signature and no notarization; downloads must be opened through the
// Gatekeeper "Open Anyway" flow. Retire this script once Developer ID
// signing lands and package:macos serves distribution.
//
// The app payload layout deliberately mirrors assembleApplication() in
// package-macos-release.mjs so alpha builds exercise the same runtime
// closure the release contract validates.
//
//   npm run package:macos:alpha              # version <shell>-alpha.<UTCstamp>
//   npm run package:macos:alpha -- --version 0.1.0-alpha.3

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateGuestRelease } from "../desktop/capsule-guest/scripts/release-contract.mjs";
import {
  assertDeviceIdentityNativeResourceLayout,
  deviceIdentityNativeAddonPath,
} from "../desktop/core/src/device-identity/native/resource-path.mjs";
import { runPackagedNodePtySmoke } from "./macos-release-runtime.mjs";

const ALPHA_BUNDLE_ID = "ai.lamarck.desktop.alpha";
const ALPHA_APP_NAME = "Lamarck Alpha.app";
const ALPHA_DISPLAY_NAME = "Lamarck Alpha";

const root = resolve(new URL("..", import.meta.url).pathname);
const shellRoot = join(root, "desktop", "shell");
const appIconSource = join(shellRoot, "assets", "Lamarck.icns");

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("the alpha packager builds macOS arm64 on macOS arm64 only");
}

const versionArgIndex = process.argv.indexOf("--version");
const shellPackage = JSON.parse(await readFile(join(shellRoot, "package.json"), "utf8"));
const version = versionArgIndex >= 0
  ? process.argv[versionArgIndex + 1]
  : `${shellPackage.version}-alpha.${utcStamp()}`;
if (!/^\d+\.\d+\.\d+-alpha(?:\.[A-Za-z0-9]+)?$/.test(version ?? "")) {
  throw new Error(`alpha version must look like 1.2.3-alpha.<tag>; received ${version}`);
}

const outputRoot = join(root, ".lamarck", "build", "alpha");
const archiveName = `Lamarck-Alpha-${version}-macos-arm64.zip`;
const archivePath = join(outputRoot, archiveName);
if (existsSync(archivePath)) {
  throw new Error(`alpha archive already exists; bump the version: ${archivePath}`);
}

console.log(`[alpha] Building Lamarck Alpha ${version} (ad-hoc signed, NOT for broad distribution)`);
run("npm", ["run", "build"], {
  cwd: root,
  env: {
    ...process.env,
    LAMARCK_BUILD_VERSION: version,
  },
});

// Every input below comes from the ordinary developer build/staging flow.
const distRoot = join(shellRoot, "dist");
const electronOutRoot = join(shellRoot, "dist-electron");
const nativeRoot = join(electronOutRoot, "native");
const templateRoot = join(root, "desktop", "template");
const electronSourceApp = join(root, "node_modules", "electron", "dist", "Electron.app");
const FIXED_ELECTRON_FILES = [
  "app-preload.cjs",
  "connector-runner.cjs",
  "core.mjs",
  "guard-service.cjs",
  "main.cjs",
  "preload.cjs",
  "pty-helper.cjs",
];

await requireDirectory(distRoot, "renderer build output (npm run build)");
await requireDirectory(nativeRoot, "capsule native staging (npm run capsule-guest:stage)");
await requireFile(
  deviceIdentityNativeAddonPath(nativeRoot),
  "device identity native addon (npm run build)",
);
const guestRelease = await validateGuestRelease(join(nativeRoot, "capsule-guest"));
await requireDirectory(templateRoot, "workspace template");
await requireDirectory(electronSourceApp, "Electron.app (node node_modules/electron/install.js)");
await requireFile(appIconSource, "Lamarck app icon");
for (const name of FIXED_ELECTRON_FILES) {
  await requireFile(join(electronOutRoot, name), `electron build output ${name}`);
}
const nodePtyRoot = join(root, "node_modules", "node-pty");
await requireFile(join(nodePtyRoot, "prebuilds", "darwin-arm64", "pty.node"), "node-pty prebuild");

const stagingRoot = join(outputRoot, `.staging-${process.pid}`);
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
const appPath = join(stagingRoot, ALPHA_APP_NAME);

try {
  console.log("[alpha] Staging Electron.app");
  run("ditto", ["--rsrc", "--extattr", electronSourceApp, appPath]);

  console.log("[alpha] Assembling app payload");
  const contents = join(appPath, "Contents");
  const resources = join(contents, "Resources");
  const appResources = join(resources, "app");
  const electronResources = join(appResources, "dist-electron");
  const plist = join(contents, "Info.plist");

  await rm(join(resources, "default_app.asar"), { force: true });
  await rm(join(resources, "electron.icns"), { force: true });
  await cp(appIconSource, join(resources, "Lamarck.icns"));
  for (const key of [
    "ElectronAsarIntegrity",
    "NSAppTransportSecurity",
    "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
  ]) run("plutil", ["-remove", key, plist], { allowFailure: true });
  for (const [key, value] of [
    ["CFBundleIdentifier", ALPHA_BUNDLE_ID],
    ["CFBundleName", ALPHA_DISPLAY_NAME],
    ["CFBundleDisplayName", ALPHA_DISPLAY_NAME],
    ["CFBundleIconFile", "Lamarck.icns"],
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
  ]) run("plutil", ["-replace", key, "-string", value, plist]);
  run("plutil", ["-replace", "LamarckReleaseChannel", "-string", "alpha", plist]);

  await mkdir(electronResources, { recursive: true });
  await writeFile(join(appResources, "package.json"), `${JSON.stringify({
    name: "@lamarck/shell",
    version,
    private: true,
    main: "dist-electron/main.cjs",
  })}\n`, { encoding: "utf8", flag: "wx" });
  await cp(distRoot, join(appResources, "dist"), { recursive: true, verbatimSymlinks: false });
  for (const name of FIXED_ELECTRON_FILES) {
    await cp(join(electronOutRoot, name), join(electronResources, name));
  }
  await cp(nativeRoot, join(electronResources, "native"), { recursive: true });
  assertDeviceIdentityNativeResourceLayout(
    electronResources,
    join(electronResources, "native"),
  );
  await cp(templateRoot, join(resources, "template"), { recursive: true });

  // Runtime dependency closure: node-pty and its single runtime dependency,
  // shaped exactly like the release exportNodePtyRuntime() output.
  const ptyDestination = join(appResources, "node_modules", "node-pty");
  await mkdir(join(ptyDestination, "prebuilds", "darwin-arm64"), { recursive: true });
  for (const name of ["LICENSE", "package.json"]) {
    await cp(join(nodePtyRoot, name), join(ptyDestination, name));
  }
  await cp(join(nodePtyRoot, "lib"), join(ptyDestination, "lib"), { recursive: true });
  // npm's blocked install scripts leave spawn-helper without its executable
  // bit; the release pipeline restores it the same way.
  for (const [name, mode] of [["pty.node", 0o644], ["spawn-helper", 0o755]]) {
    const destination = join(ptyDestination, "prebuilds", "darwin-arm64", name);
    await cp(join(nodePtyRoot, "prebuilds", "darwin-arm64", name), destination);
    await chmod(destination, mode);
  }
  const addonRoot = join(root, "node_modules", "node-addon-api");
  await cp(addonRoot, join(appResources, "node_modules", "node-addon-api"), {
    recursive: true,
    filter: (source) => !source.includes(`${addonRoot}/node_modules`),
  });

  console.log("[alpha] Ad-hoc signing");
  run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  run("codesign", ["--verify", "--deep", "--strict", appPath]);

  console.log("[alpha] Running packaged node-pty smoke");
  runPackagedNodePtySmoke(appResources, {
    executable: join(appPath, "Contents", "MacOS", "Electron"),
    expectedPlatform: "darwin",
    expectedArchitecture: "arm64",
    // A newly assembled ad-hoc bundle can spend longer than the ordinary
    // runtime timeout in macOS's first-launch assessment. The in-process PTY
    // operation remains independently bounded to five seconds.
    timeoutMs: 60_000,
  });

  console.log("[alpha] Archiving");
  const stagingArchive = join(stagingRoot, archiveName);
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, stagingArchive]);
  const sha256 = createHash("sha256").update(await readFile(stagingArchive)).digest("hex");
  const size = (await stat(stagingArchive)).size;
  await rename(stagingArchive, archivePath);
  await writeFile(join(outputRoot, `${archiveName}.sha256`), `${sha256}  ${archiveName}\n`, {
    encoding: "utf8",
  });
  const openSource = guestRelease.descriptor.correspondingSource
    ? {
        purpose: "license-compliance",
        ...guestRelease.descriptor.correspondingSource,
      }
    : undefined;
  await writeFile(join(outputRoot, `Lamarck-Alpha-${version}.release.json`), `${JSON.stringify({
    channel: "alpha",
    version,
    file: archiveName,
    sha256: `sha256:${sha256}`,
    bytes: size,
    pub_date: new Date().toISOString(),
    signing: "ad-hoc",
    ...(openSource ? { openSource } : {}),
  }, null, 2)}\n`, { encoding: "utf8" });

  console.log(JSON.stringify({ archivePath, version, sha256, bytes: size }, null, 2));
  console.log("[alpha] Done. Testers must allow the app in System Settings > Privacy & Security.");
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

function run(command, args, { cwd = root, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  }
}

async function requireDirectory(path, label) {
  const details = await stat(path).catch(() => null);
  if (!details?.isDirectory()) throw new Error(`missing ${label}: ${path}`);
  if ((await readdir(path)).length === 0) throw new Error(`${label} is empty: ${path}`);
}

async function requireFile(path, label) {
  const details = await stat(path).catch(() => null);
  if (!details?.isFile() || details.size < 1) throw new Error(`missing ${label}: ${path}`);
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
}
