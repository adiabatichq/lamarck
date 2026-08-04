#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { validateGuestRelease } from "../desktop/capsule-guest/scripts/release-contract.mjs";
import {
  assertDeviceIdentityNativeResourceLayout,
  deviceIdentityNativeAddonPath,
} from "../desktop/core/src/device-identity/native/resource-path.mjs";
import {
  createMacOsReleaseSourceSnapshot,
  validateMacOsReleaseSourceSnapshot,
  validateMacOsShellBuildExport,
} from "./macos-release-source.mjs";
import {
  compileRenameExclHelper,
  publishDirectoryNoReplace,
} from "./macos-release-publication.mjs";
import { loadFrozenOsxSign } from "./macos-release-signer.mjs";
import { runPackagedNodePtySmoke } from "./macos-release-runtime.mjs";
import { resolveBuildSystemIdentity } from "./build-system-identity.mjs";
import {
  requireMarketplaceTrustRoot,
  validateMarketplaceTrustRootResource,
} from "./marketplace-trust-roots.mjs";
import {
  assertExactBooleanEntitlements,
  assertExactCodeSignatureIdentity,
  assertExactMachOArchitecture,
  createMacOsReleasePlan,
  loadMacOsReleaseConfig,
  macOsReleaseEntitlementsForPath,
  resolveInstalledDeveloperIdIdentity,
  validateLockedElectronPackage,
} from "./package-macos-release-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKETPLACE_URL_TYPES = [{
  CFBundleURLName: "ai.lamarck.marketplace",
  CFBundleURLSchemes: ["lamarck"],
}];
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const dryRun = parseArguments(process.argv.slice(2));
const config = loadMacOsReleaseConfig({ root, packageVersion: rootPackage.version });

if (dryRun) {
  process.stdout.write(`${JSON.stringify({
    dryRun: true,
    appPath: config.finalAppPath,
    archivePath: config.finalArchivePath,
    guestReleaseRoot: config.guestReleaseRoot,
    electronArtifact: config.electronArtifact,
    electronArchiveSource: config.electronArchiveSource,
    plan: createMacOsReleasePlan(config),
  }, null, 2)}\n`);
} else {
  const resolvedSigningIdentity = await preflight(config);
  await packageRelease(config, resolvedSigningIdentity);
}

async function packageRelease(releaseConfig, signingIdentity) {
  const buildIdentity = await resolveBuildSystemIdentity({ root, requireClean: true });
  if (buildIdentity.version !== releaseConfig.version) {
    throw new Error("release build version does not match the packaging version");
  }
  await mkdir(dirname(releaseConfig.outputRoot), { recursive: true, mode: 0o700 });
  const stagingRoot = await mkdtemp(`${releaseConfig.outputRoot}.staging-`);
  const appPath = join(stagingRoot, releaseConfig.appName);
  const submissionArchive = join(stagingRoot, "notary-submission.zip");
  const distributionArchive = join(stagingRoot, `Lamarck-${releaseConfig.version}-macos-${releaseConfig.expectedGuestArchitecture}.zip`);
  const isolatedNativeRoot = join(stagingRoot, "native-input");
  const sourceSnapshotRoot = join(stagingRoot, "source-snapshot");
  const shellBuildExport = join(stagingRoot, "shell-build-export");
  const renameExclHelper = join(stagingRoot, "rename-excl");
  const publishRoot = join(stagingRoot, "publish");
  try {
    const sourceSnapshot = await createMacOsReleaseSourceSnapshot(root, sourceSnapshotRoot);
    const snapshotPackage = JSON.parse(await readFile(join(sourceSnapshotRoot, "package.json"), "utf8"));
    if (snapshotPackage.version !== rootPackage.version) {
      throw new Error("release package version changed before the source snapshot was frozen");
    }
    const frozenReleaseConfig = loadMacOsReleaseConfig({
      root,
      packageVersion: snapshotPackage.version,
    });
    if (JSON.stringify(frozenReleaseConfig) !== JSON.stringify(releaseConfig)) {
      throw new Error("macOS release configuration changed before the source snapshot was frozen");
    }
    releaseConfig = frozenReleaseConfig;
    validateLockedElectronPackage(
      JSON.parse(await readFile(join(sourceSnapshotRoot, "package-lock.json"), "utf8")),
    );
    await mkdir(shellBuildExport, { mode: 0o700 });
    const builderImageId = await buildShellFromSnapshot(
      sourceSnapshotRoot,
      shellBuildExport,
      sourceSnapshot.manifestDigest,
      buildIdentity,
    );
    await validateMacOsReleaseSourceSnapshot(sourceSnapshotRoot);
    await validateMacOsShellBuildExport(
      shellBuildExport,
      sourceSnapshotRoot,
      builderImageId,
    );
    compileRenameExclHelper(
      join(sourceSnapshotRoot, "scripts", "rename-excl.c"),
      renameExclHelper,
    );
    const electronAppSource = await materializePinnedElectronApplication(
      releaseConfig,
      stagingRoot,
    );
    run(process.execPath, [
      join(sourceSnapshotRoot, "scripts", "build-capsule-vm-macos.mjs"),
    ], {
      env: {
        ...process.env,
        LAMARCK_CODESIGN_IDENTITY: signingIdentity.hash,
        LAMARCK_REQUIRE_DISTRIBUTION_SIGNING: "1",
        LAMARCK_CAPSULE_NATIVE_ROOT: isolatedNativeRoot,
        LAMARCK_CAPSULE_BUILD_SCRATCH: join(stagingRoot, "swift-build"),
        LAMARCK_GUEST_RELEASE_ROOT: releaseConfig.guestReleaseRoot,
      },
    });
    run(process.execPath, [
      join(
        sourceSnapshotRoot,
        "desktop", "core", "src", "device-identity", "native", "build.mjs",
      ),
      "--native-root",
      isolatedNativeRoot,
    ]);
    await validateMacOsReleaseSourceSnapshot(sourceSnapshotRoot);
    await validateNativeResources(isolatedNativeRoot, releaseConfig.expectedGuestArchitecture);

    run("ditto", ["--rsrc", "--extattr", electronAppSource, appPath]);
    await assembleApplication(
      appPath,
      isolatedNativeRoot,
      releaseConfig,
      sourceSnapshotRoot,
      shellBuildExport,
    );
    await validatePackagedApplication(appPath, releaseConfig);

    const capsuleHelper = packagedHelper(appPath);
    await assertPackagedMachOArchitectures(appPath, releaseConfig.expectedGuestArchitecture);
    const frozenSigner = await loadFrozenOsxSign(shellBuildExport);
    try {
      await signElectronApplication(
        appPath,
        capsuleHelper,
        signingIdentity.hash,
        frozenSigner.sign,
      );
    } finally {
      frozenSigner.deregister();
    }
    await verifyReleaseSignatures(
      appPath,
      capsuleHelper,
      signingIdentity,
      releaseConfig.expectedGuestArchitecture,
    );

    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, submissionArchive]);
    const notarization = capture("xcrun", [
      "notarytool", "submit", submissionArchive,
      "--keychain-profile", releaseConfig.notaryProfile,
      "--wait",
      "--output-format", "json",
    ]);
    assertAcceptedNotarization(notarization);
    run("xcrun", ["stapler", "staple", appPath]);
    run("xcrun", ["stapler", "validate", appPath]);
    run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);

    await validatePackagedApplication(appPath, releaseConfig);
    await verifyReleaseSignatures(
      appPath,
      capsuleHelper,
      signingIdentity,
      releaseConfig.expectedGuestArchitecture,
    );

    await rm(submissionArchive, { force: true });
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, distributionArchive]);
    await mkdir(publishRoot, { mode: 0o755 });
    await rename(appPath, join(publishRoot, releaseConfig.appName));
    await rename(distributionArchive, join(publishRoot, basename(releaseConfig.finalArchivePath)));
    // stagingRoot is created beside outputRoot, so this one RENAME_EXCL
    // publishes the complete pair or nothing on the same filesystem. Unlike
    // rename(), it cannot replace even a concurrently-created empty directory.
    await publishDirectoryNoReplace(
      publishRoot,
      releaseConfig.outputRoot,
      renameExclHelper,
    );
    process.stdout.write(`${JSON.stringify({
      appPath: releaseConfig.finalAppPath,
      archivePath: releaseConfig.finalArchivePath,
    })}\n`);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function preflight(releaseConfig) {
  requireMarketplaceTrustRoot(process.env);
  const resolvedSigningIdentity = resolveInstalledDeveloperIdIdentity(
    releaseConfig.codesignIdentity,
    captureCombined("security", ["find-identity", "-v", "-p", "codesigning"]),
  );
  const release = await validateGuestRelease(releaseConfig.guestReleaseRoot);
  if (release.descriptor.architecture !== releaseConfig.expectedGuestArchitecture) {
    throw new Error(
      `signed Guest architecture ${release.descriptor.architecture} does not match packaging Host ${releaseConfig.expectedGuestArchitecture}`,
    );
  }
  if (releaseConfig.electronArchiveSource) {
    await requireRealFile(releaseConfig.electronArchiveSource, "pinned Electron archive source");
  }
  await requireAbsent(releaseConfig.outputRoot, "macOS release output");
  return resolvedSigningIdentity;
}

async function materializePinnedElectronApplication(releaseConfig, stagingRoot) {
  const artifact = releaseConfig.electronArtifact;
  const archive = join(stagingRoot, artifact.archiveName);
  if (releaseConfig.electronArchiveSource) {
    await copyAndVerifyPinnedArchive(
      releaseConfig.electronArchiveSource,
      archive,
      artifact.sha256,
    );
  } else {
    await downloadAndVerifyPinnedArchive(artifact.url, archive, artifact.sha256);
  }
  const extracted = join(stagingRoot, "electron-input");
  await mkdir(extracted, { mode: 0o700 });
  run("ditto", ["-x", "-k", archive, extracted]);
  assertExactList(await sortedEntries(extracted), ["Electron.app"], "pinned Electron archive root");
  const app = join(extracted, "Electron.app");
  await requireRealDirectory(app, "pinned Electron.app");
  const executable = join(app, "Contents", "MacOS", "Electron");
  await requireRealFile(executable, "pinned Electron executable");
  const version = capture("plutil", [
    "-extract", "CFBundleShortVersionString", "raw", "-o", "-",
    join(app, "Contents", "Info.plist"),
  ]).trim();
  if (version !== artifact.version) throw new Error("pinned Electron.app version is incorrect");
  await assertPackagedMachOArchitectures(app, artifact.architecture);
  return app;
}

async function copyAndVerifyPinnedArchive(sourcePath, destinationPath, expectedSha256) {
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 512n * 1024n * 1024n) {
      throw new Error("pinned Electron archive source is not a bounded single-link regular file");
    }
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.byteLength, Number(before.size) - offset),
        offset,
      );
      if (bytesRead < 1) throw new Error("pinned Electron archive ended before its stated size");
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      await writeAll(destination, chunk, offset);
      offset += bytesRead;
    }
    await destination.sync();
    const after = await source.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error("pinned Electron archive changed while it was copied");
    if (digest.digest("hex") !== expectedSha256) {
      throw new Error("pinned Electron archive SHA-256 does not match the release contract");
    }
  } finally {
    await destination?.close();
    await source.close();
  }
}

async function downloadAndVerifyPinnedArchive(url, destinationPath, expectedSha256) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "Lamarck-release-builder/1" },
  });
  if (!response.ok || !response.body || !response.url.startsWith("https://")) {
    throw new Error(`pinned Electron artifact download failed with HTTP ${response.status}`);
  }
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength && (!/^\d+$/.test(advertisedLength) || Number(advertisedLength) > 512 * 1024 * 1024)) {
    throw new Error("pinned Electron artifact has an invalid Content-Length");
  }
  const destination = await open(
    destinationPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const digest = createHash("sha256");
    let offset = 0;
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      offset += chunk.byteLength;
      if (offset > 512 * 1024 * 1024) {
        throw new Error("pinned Electron artifact exceeds its download byte limit");
      }
      digest.update(chunk);
      await writeAll(destination, chunk, offset - chunk.byteLength);
    }
    if (offset < 1 || digest.digest("hex") !== expectedSha256) {
      throw new Error("downloaded Electron artifact SHA-256 does not match the release contract");
    }
    await destination.sync();
  } finally {
    await destination.close();
  }
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (bytesWritten < 1) throw new Error("release archive copy made no progress");
    offset += bytesWritten;
  }
}

async function buildShellFromSnapshot(snapshotRoot, exportRoot, manifestDigest, buildIdentity) {
  if (!/^sha256:[a-f0-9]{64}$/.test(manifestDigest)) {
    throw new Error("macOS release source snapshot digest is invalid");
  }
  const dockerfile = join(
    snapshotRoot,
    "desktop", "capsule-guest", "buildroot", "Dockerfile",
  );
  const dockerContext = dirname(dockerfile);
  const builderImageIdFile = join(dirname(exportRoot), "builder-image-id");
  run("docker", [
    "build",
    "--platform", "linux/arm64",
    "--file", dockerfile,
    "--iidfile", builderImageIdFile,
    dockerContext,
  ]);
  await requireRealFile(builderImageIdFile, "pinned builder image identity file");
  const builderImageId = (await readFile(builderImageIdFile, "utf8")).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(builderImageId)) {
    throw new Error("pinned macOS release builder has an invalid immutable image identity");
  }
  const user = `${process.getuid()}:${process.getgid()}`;
  run("docker", [
    "run", "--rm",
    "--platform", "linux/arm64",
    "--network", "bridge",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit", "512",
    "--memory", "4g",
    "--user", user,
    "--tmpfs", "/work:rw,nosuid,nodev,exec,size=3221225472,mode=1777",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456,mode=1777",
    "--volume", `${snapshotRoot}:/snapshot:ro`,
    "--volume", `${exportRoot}:/export:rw`,
    "--env", `LAMARCK_BUILDER_IMAGE_ID=${builderImageId}`,
    "--env", `LAMARCK_BUILD_VERSION=${buildIdentity.version}`,
    "--env", `LAMARCK_BUILD_COMMIT=${buildIdentity.commit}`,
    "--env", `LAMARCK_MARKETPLACE_SIGNING_KEY_ID=${process.env.LAMARCK_MARKETPLACE_SIGNING_KEY_ID}`,
    "--env", `LAMARCK_MARKETPLACE_SIGNING_PUBLIC_KEY=${process.env.LAMARCK_MARKETPLACE_SIGNING_PUBLIC_KEY}`,
    builderImageId,
    "/usr/local/bin/node",
    "/snapshot/scripts/build-macos-release-shell-inside.mjs",
    "/snapshot",
    "/export",
  ]);
  return builderImageId;
}

async function assembleApplication(
  appPath,
  nativeRoot,
  releaseConfig,
  sourceSnapshotRoot,
  shellBuildExport,
) {
  const contents = join(appPath, "Contents");
  const resources = join(contents, "Resources");
  const appResources = join(resources, "app");
  const electronResources = join(appResources, "dist-electron");
  const plist = join(contents, "Info.plist");
  const appIconSource = join(
    sourceSnapshotRoot,
    "desktop",
    "shell",
    "assets",
    "Lamarck.icns",
  );

  await rm(join(resources, "default_app.asar"), { force: true });
  await rm(join(resources, "electron.icns"), { force: true });
  await copyRealFile(appIconSource, join(resources, "Lamarck.icns"));
  for (const key of [
    "ElectronAsarIntegrity",
    "NSAppTransportSecurity",
    "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
  ]) run("plutil", ["-remove", key, plist]);
  for (const [key, value] of [
    ["CFBundleIdentifier", releaseConfig.bundleIdentifier],
    ["CFBundleName", "Lamarck"],
    ["CFBundleDisplayName", "Lamarck"],
    ["CFBundleIconFile", "Lamarck.icns"],
    ["CFBundleShortVersionString", releaseConfig.version],
    ["CFBundleVersion", releaseConfig.version],
  ]) {
    run("plutil", ["-replace", key, "-string", value, plist]);
  }
  run("plutil", ["-remove", "CFBundleURLTypes", plist], { allowFailure: true });
  run("plutil", ["-insert", "CFBundleURLTypes", "-json", JSON.stringify(MARKETPLACE_URL_TYPES), plist]);

  await mkdir(electronResources, { recursive: true, mode: 0o755 });
  await writeFile(join(appResources, "package.json"), `${JSON.stringify({
    name: "@lamarck/shell",
    version: releaseConfig.version,
    private: true,
    main: "dist-electron/main.cjs",
  })}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
  await copyRealTree(join(shellBuildExport, "dist"), join(appResources, "dist"));
  await copyRealTree(
    join(shellBuildExport, "runtime-dependencies", "node_modules"),
    join(appResources, "node_modules"),
  );

  const fixedElectronFiles = [
    "app-preload.cjs",
    "connector-runner.cjs",
    "core.mjs",
    "guard-service.cjs",
    "main.cjs",
    "marketplace-trust-roots.json",
    "preload.cjs",
    "pty-helper.cjs",
  ];
  for (const name of fixedElectronFiles) {
    await copyRealFile(
      join(shellBuildExport, "dist-electron", name),
      join(electronResources, name),
    );
  }
  await copyRealTree(
    join(shellBuildExport, "dist-electron", "scaffolds"),
    join(electronResources, "scaffolds"),
  );
  await copyRealTree(nativeRoot, join(electronResources, "native"));
  assertDeviceIdentityNativeResourceLayout(
    electronResources,
    join(electronResources, "native"),
  );
}

async function validatePackagedApplication(appPath, releaseConfig) {
  await requireRealDirectory(appPath, "packaged Lamarck.app");
  const resources = join(appPath, "Contents", "Resources");
  const appResources = join(resources, "app");
  const actualAppEntries = await sortedEntries(appResources);
  assertExactList(
    actualAppEntries,
    ["dist", "dist-electron", "node_modules", "package.json"],
    "packaged app resources",
  );
  const electronResources = join(appResources, "dist-electron");
  assertExactList(await sortedEntries(electronResources), [
    "app-preload.cjs",
    "connector-runner.cjs",
    "core.mjs",
    "guard-service.cjs",
    "main.cjs",
    "marketplace-trust-roots.json",
    "native",
    "preload.cjs",
    "pty-helper.cjs",
    "scaffolds",
  ], "packaged Electron resources");
  assertDeviceIdentityNativeResourceLayout(
    electronResources,
    join(electronResources, "native"),
  );
  await validateMarketplaceTrustRootResource(
    join(electronResources, "marketplace-trust-roots.json"),
    process.env,
  );
  assertExactList(
    await sortedEntries(join(electronResources, "scaffolds")),
    ["app-v1"],
    "packaged scaffold collection",
  );
  assertExactList(
    await sortedEntries(join(electronResources, "scaffolds", "app-v1")),
    ["index.html", "index.tsx", "main.tsx", "package-lock.json", "package.json", "vite.config.ts"],
    "packaged blank App scaffold",
  );
  const expectedPackage = {
    name: "@lamarck/shell",
    version: releaseConfig.version,
    private: true,
    main: "dist-electron/main.cjs",
  };
  const actualPackage = JSON.parse(await readFile(join(appResources, "package.json"), "utf8"));
  if (JSON.stringify(actualPackage) !== JSON.stringify(expectedPackage)) {
    throw new Error("packaged app package.json does not match the release contract");
  }
  await validatePackagedNodePtyRuntime(appResources);
  runPackagedNodePtySmoke(appResources, {
    executable: join(appPath, "Contents", "MacOS", "Electron"),
    expectedPlatform: "darwin",
    expectedArchitecture: releaseConfig.expectedGuestArchitecture,
  });
  const plist = join(appPath, "Contents", "Info.plist");
  for (const [key, expected] of [
    ["CFBundleIdentifier", releaseConfig.bundleIdentifier],
    ["CFBundleName", "Lamarck"],
    ["CFBundleDisplayName", "Lamarck"],
    ["CFBundleIconFile", "Lamarck.icns"],
    ["CFBundleShortVersionString", releaseConfig.version],
    ["CFBundleVersion", releaseConfig.version],
    ["CFBundleExecutable", "Electron"],
  ]) {
    const actual = capture("plutil", ["-extract", key, "raw", "-o", "-", plist]).trim();
    if (actual !== expected) throw new Error(`packaged Info.plist ${key} is incorrect`);
  }
  const packagedUrlTypes = JSON.parse(capture("plutil", [
    "-extract", "CFBundleURLTypes", "json", "-o", "-", plist,
  ]));
  if (JSON.stringify(packagedUrlTypes) !== JSON.stringify(MARKETPLACE_URL_TYPES)) {
    throw new Error("packaged Info.plist Marketplace URL scheme is incorrect");
  }
  const plistDescription = capture("plutil", ["-p", plist]);
  for (const forbiddenKey of [
    "ElectronAsarIntegrity",
    "NSAppTransportSecurity",
    "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
  ]) {
    if (plistDescription.includes(`\"${forbiddenKey}\"`)) {
      throw new Error(`packaged Info.plist retained forbidden key ${forbiddenKey}`);
    }
  }
  await requireRealFile(join(resources, "Lamarck.icns"), "packaged Lamarck app icon");
  await requireAbsent(join(resources, "electron.icns"), "Electron default app icon");
  await requireAbsent(join(resources, "default_app.asar"), "Electron default app archive");
  await requireAbsent(join(resources, "template"), "obsolete packaged workspace template");
  await requireAbsent(join(resources, "apps"), "official App collection in Desktop resources");
  await requireAbsent(join(resources, "connectors"), "official Connector collection in Desktop resources");
  assertExactList(
    (await readdir(join(appPath, "Contents", "Frameworks"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "en")),
    [
      "Electron Helper.app",
      "Electron Helper (GPU).app",
      "Electron Helper (Plugin).app",
      "Electron Helper (Renderer).app",
    ],
    "Electron helper application set",
  );
  await validateNativeResources(
    join(electronResources, "native"),
    releaseConfig.expectedGuestArchitecture,
  );
}

async function validateNativeResources(nativeRoot, expectedArchitecture) {
  await requireRealDirectory(nativeRoot, "native resource root");
  assertExactList(
    await sortedEntries(nativeRoot),
    ["capsule-guest", "device-identity", "lamarck-capsule-vm-host"],
    "native resource root",
  );
  const deviceIdentityDirectory = join(nativeRoot, "device-identity");
  await requireRealDirectory(deviceIdentityDirectory, "device identity native resource directory");
  assertExactList(
    await sortedEntries(deviceIdentityDirectory),
    ["lamarck_device_identity.node"],
    "device identity native resource directory",
  );
  const deviceIdentityAddon = deviceIdentityNativeAddonPath(nativeRoot);
  const deviceIdentityDetails = await requireRealFile(
    deviceIdentityAddon,
    "device identity native addon",
  );
  if ((deviceIdentityDetails.mode & 0o777) !== 0o644) {
    throw new Error("device identity native addon mode is not 0644");
  }
  assertExactMachOArchitecture(
    capture("lipo", ["-archs", deviceIdentityAddon]),
    expectedArchitecture,
    "device identity native addon",
  );
  const helper = join(nativeRoot, "lamarck-capsule-vm-host");
  const helperDetails = await requireRealFile(helper, "Capsule VM helper");
  if ((helperDetails.mode & 0o111) === 0) throw new Error("Capsule VM helper is not executable");
  assertExactMachOArchitecture(
    capture("lipo", ["-archs", helper]),
    expectedArchitecture,
    "Capsule VM helper",
  );
  const release = await validateGuestRelease(join(nativeRoot, "capsule-guest"));
  if (release.descriptor.architecture !== expectedArchitecture) {
    throw new Error("staged Guest release architecture does not match the package");
  }
}

async function validatePackagedNodePtyRuntime(appResources) {
  const nodeModules = join(appResources, "node_modules");
  assertExactList(
    await sortedEntries(nodeModules),
    ["node-addon-api", "node-pty"],
    "packaged runtime dependency closure",
  );

  const nodePty = join(nodeModules, "node-pty");
  assertExactList(
    await sortedEntries(nodePty),
    ["LICENSE", "lib", "package.json", "prebuilds"],
    "packaged node-pty package",
  );
  const nodePtyPackage = JSON.parse(await readFile(join(nodePty, "package.json"), "utf8"));
  if (
    nodePtyPackage.name !== "node-pty"
    || nodePtyPackage.version !== "1.1.0"
    || nodePtyPackage.main !== "./lib/index.js"
    || JSON.stringify(nodePtyPackage.dependencies) !== JSON.stringify({
      "node-addon-api": "^7.1.0",
    })
  ) throw new Error("packaged node-pty identity does not match the release contract");
  assertExactList(await sortedEntries(join(nodePty, "lib")), [
    "conpty_console_list_agent.js",
    "conpty_console_list_agent.js.map",
    "eventEmitter2.js",
    "eventEmitter2.js.map",
    "eventEmitter2.test.js",
    "eventEmitter2.test.js.map",
    "index.js",
    "index.js.map",
    "interfaces.js",
    "interfaces.js.map",
    "shared",
    "terminal.js",
    "terminal.js.map",
    "terminal.test.js",
    "terminal.test.js.map",
    "testUtils.test.js",
    "testUtils.test.js.map",
    "types.js",
    "types.js.map",
    "unixTerminal.js",
    "unixTerminal.js.map",
    "unixTerminal.test.js",
    "unixTerminal.test.js.map",
    "utils.js",
    "utils.js.map",
    "windowsConoutConnection.js",
    "windowsConoutConnection.js.map",
    "windowsPtyAgent.js",
    "windowsPtyAgent.js.map",
    "windowsPtyAgent.test.js",
    "windowsPtyAgent.test.js.map",
    "windowsTerminal.js",
    "windowsTerminal.js.map",
    "windowsTerminal.test.js",
    "windowsTerminal.test.js.map",
    "worker",
  ], "packaged node-pty JavaScript runtime");
  assertExactList(
    await sortedEntries(join(nodePty, "lib", "shared")),
    ["conout.js", "conout.js.map"],
    "packaged node-pty shared runtime",
  );
  assertExactList(
    await sortedEntries(join(nodePty, "lib", "worker")),
    ["conoutSocketWorker.js", "conoutSocketWorker.js.map"],
    "packaged node-pty worker runtime",
  );
  assertExactList(
    await sortedEntries(join(nodePty, "prebuilds")),
    ["darwin-arm64"],
    "packaged node-pty platform prebuild set",
  );
  const prebuilds = join(nodePty, "prebuilds", "darwin-arm64");
  assertExactList(
    await sortedEntries(prebuilds),
    ["pty.node", "spawn-helper"],
    "packaged node-pty arm64 prebuild set",
  );
  const ptyNode = await requireRealFile(
    join(prebuilds, "pty.node"),
    "packaged node-pty native addon",
  );
  if ((ptyNode.mode & 0o777) !== 0o644) {
    throw new Error("packaged node-pty native addon mode is not 0644");
  }
  const spawnHelper = await requireRealFile(
    join(prebuilds, "spawn-helper"),
    "packaged node-pty spawn helper",
  );
  if ((spawnHelper.mode & 0o777) !== 0o755) {
    throw new Error("packaged node-pty spawn helper mode is not 0755");
  }

  const nodeAddonApi = join(nodeModules, "node-addon-api");
  assertExactList(await sortedEntries(nodeAddonApi), [
    "LICENSE.md",
    "README.md",
    "common.gypi",
    "except.gypi",
    "index.js",
    "napi-inl.deprecated.h",
    "napi-inl.h",
    "napi.h",
    "node_addon_api.gyp",
    "node_api.gyp",
    "noexcept.gypi",
    "nothing.c",
    "package-support.json",
    "package.json",
    "tools",
  ], "packaged node-addon-api package");
  assertExactList(await sortedEntries(join(nodeAddonApi, "tools")), [
    "README.md",
    "check-napi.js",
    "clang-format.js",
    "conversion.js",
    "eslint-format.js",
  ], "packaged node-addon-api tools");
  const nodeAddonPackage = JSON.parse(
    await readFile(join(nodeAddonApi, "package.json"), "utf8"),
  );
  if (nodeAddonPackage.name !== "node-addon-api" || nodeAddonPackage.version !== "7.1.1") {
    throw new Error("packaged node-addon-api identity does not match the release contract");
  }
}

async function signElectronApplication(appPath, capsuleHelper, identity, sign) {
  if (typeof sign !== "function") throw new Error("frozen Electron signer is unavailable");
  const signableCode = new Set(await listMachOFiles(appPath));
  if (!signableCode.has(resolve(capsuleHelper))) {
    throw new Error("Capsule VM helper is not a Mach-O code object in the Electron signing set");
  }
  const deviceIdentityAddon = packagedDeviceIdentityAddon(appPath);
  if (!signableCode.has(resolve(deviceIdentityAddon))) {
    throw new Error("device identity addon is missing from the Electron signing set");
  }
  for (const path of packagedNodePtyCode(appPath)) {
    if (!signableCode.has(resolve(path))) {
      throw new Error("packaged node-pty code is missing from the Electron signing set");
    }
  }
  const bundleSuffixes = [".app", ".framework"];
  await sign({
    app: appPath,
    platform: "darwin",
    type: "distribution",
    identity,
    identityValidation: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    ignore: (path) => !signableCode.has(resolve(path))
      && !bundleSuffixes.some((suffix) => path.endsWith(suffix)),
    optionsForFile: (path) => ({
      entitlements: [...macOsReleaseEntitlementsForPath(resolve(path), { appPath, capsuleHelper })],
      hardenedRuntime: true,
    }),
  });
}

async function verifyDistributionSignature(path, expectedIdentity, entitlementKeys) {
  run("codesign", [
    "--verify",
    "--strict",
    "--verbose=4",
    path,
  ]);
  const details = captureCombined("codesign", ["-dv", "--verbose=4", path]);
  if (/Signature=adhoc|TeamIdentifier=not set/.test(details)) {
    throw new Error(`${path} is not distribution signed`);
  }
  assertExactCodeSignatureIdentity(details, expectedIdentity, path);
  const certificateRoot = await mkdtemp(join(tmpdir(), "lamarck-signature-certificate-"));
  try {
    const prefix = join(certificateRoot, "certificate-");
    run("codesign", ["-d", "--extract-certificates", prefix, path]);
    const leafCertificate = await readFile(`${prefix}0`);
    const leafSha1 = createHash("sha1").update(leafCertificate).digest("hex").toUpperCase();
    if (leafSha1 !== expectedIdentity.hash) {
      throw new Error(`${path} leaf signing certificate does not match the resolved identity`);
    }
  } finally {
    await rm(certificateRoot, { recursive: true, force: true });
  }

  const entitlementXml = capture("codesign", ["-d", "--entitlements", ":-", path]);
  let entitlements = {};
  if (entitlementXml.trim()) {
    try {
      entitlements = JSON.parse(captureWithInput(
        "plutil",
        ["-convert", "json", "-o", "-", "--", "-"],
        entitlementXml,
      ));
    } catch (cause) {
      throw new Error(`${path} entitlements are not a valid property list`, { cause });
    }
  }
  assertExactBooleanEntitlements(entitlements, entitlementKeys, path);
}

async function verifyReleaseSignatures(
  appPath,
  capsuleHelper,
  expectedIdentity,
  expectedArchitecture,
) {
  await assertPackagedMachOArchitectures(appPath, expectedArchitecture);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
  const codeObjects = await listCodeObjects(appPath);
  if (!codeObjects.includes(resolve(capsuleHelper))) {
    throw new Error("Capsule VM helper is missing from the postflight code-object set");
  }
  const deviceIdentityAddon = packagedDeviceIdentityAddon(appPath);
  if (!codeObjects.includes(resolve(deviceIdentityAddon))) {
    throw new Error("device identity addon is missing from the postflight code-object set");
  }
  for (const path of packagedNodePtyCode(appPath)) {
    if (!codeObjects.includes(resolve(path))) {
      throw new Error("packaged node-pty code is missing from the postflight code-object set");
    }
  }
  for (const path of codeObjects) {
    await verifyDistributionSignature(
      path,
      expectedIdentity,
      [...macOsReleaseEntitlementsForPath(path, { appPath, capsuleHelper })],
    );
  }
}

function assertAcceptedNotarization(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new Error("notarytool did not return JSON", { cause });
  }
  if (value?.status !== "Accepted" || typeof value?.id !== "string" || value.id.length < 1) {
    throw new Error(`Apple notarization was not accepted (${String(value?.status ?? "unknown")})`);
  }
}

async function copyRealTree(source, destination) {
  const details = await lstat(source);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`release copy source is not a real directory: ${source}`);
  }
  await mkdir(destination, { mode: 0o755 });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`release copy source contains symlink: ${sourcePath}`);
    if (entry.isDirectory()) await copyRealTree(sourcePath, destinationPath);
    else if (entry.isFile()) await copyRealFile(sourcePath, destinationPath);
    else throw new Error(`release copy source contains unsupported entry: ${sourcePath}`);
  }
}

async function copyRealFile(source, destination) {
  const details = await requireRealFile(source, "release copy source");
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
  await chmod(destination, (details.mode & 0o111) === 0 ? 0o644 : 0o755);
}

async function listMachOFiles(rootPath) {
  const result = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        if (await isMachO(path)) result.push(resolve(path));
      }
      else throw new Error(`packaged resources contain unsupported entry: ${path}`);
    }
  };
  await visit(rootPath);
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

async function listCodeObjects(rootPath) {
  const result = new Set(await listMachOFiles(rootPath));
  result.add(resolve(rootPath));
  const bundleSuffixes = [".app", ".framework", ".xpc", ".appex"];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (bundleSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
          result.add(resolve(path));
        }
        await visit(path);
      } else if (!entry.isFile()) {
        throw new Error(`packaged resources contain unsupported entry: ${path}`);
      }
    }
  };
  await visit(rootPath);
  return [...result].sort((left, right) => left.localeCompare(right, "en"));
}

async function assertPackagedMachOArchitectures(rootPath, expectedArchitecture) {
  const files = await listMachOFiles(rootPath);
  if (files.length < 1) throw new Error(`${rootPath} contains no Mach-O code objects`);
  for (const path of files) {
    assertExactMachOArchitecture(
      capture("lipo", ["-archs", path]),
      expectedArchitecture,
      path,
    );
  }
}

async function isMachO(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    if (bytesRead !== 4) return false;
    return new Set([
      "feedface", "feedfacf", "cefaedfe", "cffaedfe",
      "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
    ]).has(buffer.toString("hex"));
  } finally {
    await handle.close();
  }
}

async function requireRealDirectory(path, label) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  return details;
}

async function requireRealFile(path, label) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1) {
    throw new Error(`${label} is not a nonempty regular file`);
  }
  return details;
}

async function requireAbsent(path, label) {
  try {
    await lstat(path);
    throw new Error(`${label} already exists; refusing to overwrite it`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function sortedEntries(path) {
  return (await readdir(path)).sort((left, right) => left.localeCompare(right, "en"));
}

function assertExactList(actual, expected, label) {
  const wanted = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has missing or unexpected entries`);
  }
}

function packagedHelper(appPath) {
  return join(
    appPath,
    "Contents", "Resources", "app", "dist-electron", "native",
    "lamarck-capsule-vm-host",
  );
}

function packagedDeviceIdentityAddon(appPath) {
  return deviceIdentityNativeAddonPath(join(
    appPath,
    "Contents", "Resources", "app", "dist-electron", "native",
  ));
}

function packagedNodePtyCode(appPath) {
  const root = join(
    appPath,
    "Contents", "Resources", "app", "node_modules", "node-pty",
    "prebuilds", "darwin-arm64",
  );
  return [join(root, "pty.node"), join(root, "spawn-helper")];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  return result.stdout;
}

function captureCombined(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? result.signal}: ${result.stderr.trim()}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

function captureWithInput(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? result.signal}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function parseArguments(args) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--dry-run") return true;
  throw new Error("usage: package-macos-release.mjs [--dry-run]");
}
