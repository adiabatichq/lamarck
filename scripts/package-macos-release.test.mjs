import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  assertExactBooleanEntitlements,
  assertExactCodeSignatureIdentity,
  assertExactMachOArchitecture,
  createMacOsReleasePlan,
  distributionIdentity,
  loadMacOsReleaseConfig,
  macOsReleaseEntitlementsForPath,
  notaryProfile,
  resolveInstalledDeveloperIdIdentity,
  validateLockedElectronPackage,
  MACOS_ELECTRON_ARTIFACT,
} from "./package-macos-release-contract.mjs";
import {
  assertBuilderInventory,
  createMacOsReleaseSourceSnapshot,
  MACOS_RELEASE_SOURCE_DIRECTORIES,
  MACOS_RELEASE_SOURCE_FILES,
  validateMacOsReleaseSourceSnapshot,
} from "./macos-release-source.mjs";
import {
  compileRenameExclHelper,
  publishDirectoryNoReplace,
} from "./macos-release-publication.mjs";
import { loadFrozenOsxSign } from "./macos-release-signer.mjs";
import { runPackagedNodePtySmoke } from "./macos-release-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validEnvironment = {
  LAMARCK_CODESIGN_IDENTITY: "Developer ID Application: Lamarck Test (ABCDE12345)",
  LAMARCK_NOTARY_PROFILE: "lamarck-notary",
};

test("release credentials fail closed when signing identity is absent or ad-hoc", () => {
  assert.throws(() => distributionIdentity(undefined), /required/);
  assert.throws(() => distributionIdentity("-"), /ad-hoc/);
  assert.throws(() => distributionIdentity("adhoc"), /ad-hoc/);
  assert.throws(() => distributionIdentity("Apple Development: Example"), /Developer ID Application/);
});

test("release credentials require a bounded keychain profile", () => {
  assert.throws(() => notaryProfile(undefined), /required/);
  assert.throws(() => notaryProfile("unsafe\nprofile"), /single-line/);
  assert.equal(notaryProfile("lamarck-notary"), "lamarck-notary");
});

test("release identity must resolve to an installed valid Developer ID certificate", () => {
  const hash = "A".repeat(40);
  const name = validEnvironment.LAMARCK_CODESIGN_IDENTITY;
  const output = `  1) ${hash} \"${name}\"\n     1 valid identities found\n`;
  assert.deepEqual(resolveInstalledDeveloperIdIdentity(name, output), {
    hash,
    name,
    teamId: "ABCDE12345",
  });
  assert.deepEqual(resolveInstalledDeveloperIdIdentity(hash.toLowerCase(), output), {
    hash,
    name,
    teamId: "ABCDE12345",
  });
  assert.throws(() => resolveInstalledDeveloperIdIdentity(
    hash,
    `  1) ${hash} \"Apple Development: Test\"\n`,
  ), /not an installed valid Developer ID/);
  assert.throws(() => resolveInstalledDeveloperIdIdentity(name, "0 valid identities found"), /not an installed/);
});

test("release config is macOS-only and requires both credential references", () => {
  assert.throws(() => loadMacOsReleaseConfig({
    root,
    packageVersion: "0.1.0",
    env: validEnvironment,
    platform: "linux",
    architecture: "arm64",
  }), /requires macOS/);
  assert.throws(() => loadMacOsReleaseConfig({
    root,
    packageVersion: "0.1.0",
    env: { LAMARCK_CODESIGN_IDENTITY: validEnvironment.LAMARCK_CODESIGN_IDENTITY },
    platform: "darwin",
    architecture: "arm64",
  }), /LAMARCK_NOTARY_PROFILE is required/);
  assert.throws(() => loadMacOsReleaseConfig({
    root,
    packageVersion: "0.1.0",
    env: validEnvironment,
    platform: "darwin",
    architecture: "x64",
  }), /alpha macOS release is arm64-only; no signed x64 Guest image exists/);
});

test("dry-run plan includes every production trust gate and never package:patch", () => {
  const config = loadMacOsReleaseConfig({
    root,
    packageVersion: "0.1.0",
    env: validEnvironment,
    platform: "darwin",
    architecture: "arm64",
  });
  const actions = createMacOsReleasePlan(config).map((step) => step.action);
  assert.deepEqual(actions, [
    "verify-installed-developer-id-identity",
    "validate-signed-guest-release",
    "sealed-pinned-shell-production-build",
    "materialize-lock-bound-electron-artifact",
    "build-and-distribution-sign-vz-helper",
    "stage-exact-native-resources",
    "assemble-electron-app",
    "electron-osx-sign-inside-out-hardened-runtime",
    "codesign-deep-strict",
    "notarytool-submit-wait",
    "stapler-staple-and-validate",
    "spctl-assess-execute",
    "verify-exact-native-tree-and-signatures",
    "exclusive-atomic-publish-app-and-stapled-zip",
  ]);
  assert.equal(JSON.stringify(actions).includes("package:patch"), false);
});

test("release signing policy gives only Electron and Capsule their required entitlements", () => {
  const appPath = resolve(root, ".lamarck", "test", "Lamarck.app");
  const capsuleHelper = resolve(
    appPath,
    "Contents", "Resources", "app", "dist-electron", "native", "lamarck-capsule-vm-host",
  );
  const options = { appPath, capsuleHelper };
  assert.deepEqual(macOsReleaseEntitlementsForPath(appPath, options), [
    "com.apple.security.cs.allow-jit",
  ]);
  assert.deepEqual(macOsReleaseEntitlementsForPath(resolve(
    appPath,
    "Contents", "Frameworks", "Electron Helper (Renderer).app",
  ), options), ["com.apple.security.cs.allow-jit"]);
  assert.deepEqual(macOsReleaseEntitlementsForPath(resolve(
    appPath,
    "Contents", "Frameworks", "Electron Helper (Plugin).app",
  ), options), [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
  ]);
  assert.deepEqual(macOsReleaseEntitlementsForPath(capsuleHelper, options), [
    "com.apple.security.virtualization",
  ]);
  assert.deepEqual(macOsReleaseEntitlementsForPath(resolve(
    appPath,
    "Contents", "Resources", "app", "dist-electron", "native", "capsule-guest", "rootfs.img",
  ), options), []);
  assert.deepEqual(macOsReleaseEntitlementsForPath(resolve(
    appPath,
    "Contents", "Resources", "Electron Helper (Plugin).app-lookalike", "tool",
  ), options), []);
  assert.throws(() => macOsReleaseEntitlementsForPath(resolve(root, "outside"), options), /escaped/);
});

test("Electron release input is bound to the exact package-lock artifact", () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      "node_modules/electron": {
        version: MACOS_ELECTRON_ARTIFACT.version,
        resolved: MACOS_ELECTRON_ARTIFACT.npmResolved,
        integrity: MACOS_ELECTRON_ARTIFACT.npmIntegrity,
      },
    },
  };
  assert.equal(validateLockedElectronPackage(lock), MACOS_ELECTRON_ARTIFACT);
  assert.throws(() => validateLockedElectronPackage({
    ...lock,
    packages: {
      "node_modules/electron": {
        ...lock.packages["node_modules/electron"],
        version: "42.6.0",
      },
    },
  }), /does not match/);
});

test("Mach-O and signature identity gates require exact architecture, authority, and Team ID", () => {
  assert.doesNotThrow(() => assertExactMachOArchitecture("arm64\n", "arm64"));
  assert.throws(() => assertExactMachOArchitecture("x86_64\n", "arm64"), /exactly/);
  assert.throws(() => assertExactMachOArchitecture("x86_64 arm64\n", "arm64"), /exactly/);
  const identity = {
    hash: "A".repeat(40),
    name: validEnvironment.LAMARCK_CODESIGN_IDENTITY,
    teamId: "ABCDE12345",
  };
  const details = [
    `Authority=${identity.name}`,
    "Authority=Developer ID Certification Authority",
    "TeamIdentifier=ABCDE12345",
  ].join("\n");
  assert.doesNotThrow(() => assertExactCodeSignatureIdentity(details, identity));
  assert.throws(() => assertExactCodeSignatureIdentity(
    details.replace("ABCDE12345", "ZZZZZ12345"),
    identity,
  ), /authority|Team ID/);
});

test("entitlement verification rejects missing, extra, and non-boolean grants", () => {
  assert.doesNotThrow(() => assertExactBooleanEntitlements(
    { "com.apple.security.cs.allow-jit": true },
    ["com.apple.security.cs.allow-jit"],
  ));
  assert.throws(() => assertExactBooleanEntitlements({}, ["com.apple.security.cs.allow-jit"]), /missing/);
  assert.throws(() => assertExactBooleanEntitlements({
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.network.client": true,
  }, ["com.apple.security.cs.allow-jit"]), /unexpected/);
  assert.throws(() => assertExactBooleanEntitlements({
    "com.apple.security.cs.allow-jit": false,
  }, ["com.apple.security.cs.allow-jit"]), /not true/);
});

test("the real dry-run entrypoint rejects missing credentials before filesystem work", () => {
  const env = { ...process.env };
  delete env.LAMARCK_CODESIGN_IDENTITY;
  delete env.LAMARCK_NOTARY_PROFILE;
  const result = spawnSync(process.execPath, [
    resolve(root, "scripts", "package-macos-release.mjs"),
    "--dry-run",
  ], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /LAMARCK_CODESIGN_IDENTITY is required/);
});

test("a valid macOS dry-run is pure and does not require release input paths", {
  skip: process.platform !== "darwin",
}, () => {
  const env = {
    ...process.env,
    ...validEnvironment,
    LAMARCK_GUEST_RELEASE_ROOT: resolve(root, ".definitely-missing-guest-release"),
    LAMARCK_ELECTRON_ARCHIVE: resolve(root, ".definitely-missing-electron-archive.zip"),
    LAMARCK_MACOS_RELEASE_OUTPUT: resolve(root, ".definitely-unwritten-release-output"),
  };
  const result = spawnSync(process.execPath, [
    resolve(root, "scripts", "package-macos-release.mjs"),
    "--dry-run",
  ], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"dryRun": true/);
});

test("local and hermetic release builds share the canonical Desktop recipe", async () => {
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const shellPackage = JSON.parse(await readFile(
    join(root, "desktop", "shell", "package.json"),
    "utf8",
  ));
  const releaseBuilder = await readFile(
    join(root, "scripts", "build-macos-release-shell-inside.mjs"),
    "utf8",
  );

  assert.equal(rootPackage.scripts.build, "node scripts/build-desktop.mjs");
  assert.equal(shellPackage.scripts.build, "node ../../scripts/build-desktop.mjs");
  assert.match(releaseBuilder, /join\(source, "scripts\/build-desktop\.mjs"\)/);
  assert.ok(MACOS_RELEASE_SOURCE_FILES.includes("scripts/build-desktop.mjs"));
});

test("Desktop and macOS release outputs do not bundle an App System SDK copy", async () => {
  const electronBuilder = await readFile(
    join(root, "scripts", "build-electron-main.mjs"),
    "utf8",
  );
  const releasePackager = await readFile(
    join(root, "scripts", "package-macos-release.mjs"),
    "utf8",
  );

  assert.doesNotMatch(electronBuilder, /dist-electron[\s\S]*system-sdk/);
  assert.doesNotMatch(releasePackager, /electronResources, "system-sdk"/);
});

test("macOS release source snapshot is exact, private, and excludes ambient output", async (t) => {
  const fixture = await createReleaseSourceFixture(t);
  await mkdir(join(fixture.repository, "node_modules"));
  await writeFile(join(fixture.repository, "node_modules", "ambient.js"), "untrusted\n");
  await mkdir(join(fixture.repository, "desktop", "shell", "dist"), { recursive: true });
  await writeFile(join(fixture.repository, "desktop", "shell", "dist", "stale.js"), "stale\n");
  await mkdir(join(fixture.repository, "desktop", "template", ".lamarck"), { recursive: true });
  await writeFile(
    join(fixture.repository, "desktop", "template", ".lamarck", "system.db"),
    "private host state\n",
  );
  const result = await createMacOsReleaseSourceSnapshot(
    fixture.repository,
    fixture.snapshot,
  );
  assert.ok(result.fileCount >= MACOS_RELEASE_SOURCE_FILES.length);
  assert.match(result.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await validateMacOsReleaseSourceSnapshot(fixture.snapshot), result);
  for (const frozenBuilderInput of [
    "desktop/capsule-guest/buildroot/Dockerfile",
    "desktop/capsule-guest/scripts/release-contract.mjs",
    "desktop/capsule-vm-macos/Package.swift",
    "desktop/capsule-vm-macos/Sources/fixture.txt",
    "scripts/build-desktop.mjs",
    "scripts/build-capsule-vm-macos.mjs",
    "scripts/build-macos-release-shell-inside.mjs",
    "scripts/macos-release-runtime.mjs",
    "scripts/macos-release-signer.mjs",
    "scripts/package-macos-release-contract.mjs",
    "scripts/rename-excl.c",
    "scripts/stage-capsule-native.mjs",
  ]) {
    assert.equal(
      await readFile(join(fixture.snapshot, frozenBuilderInput), "utf8"),
      `${frozenBuilderInput.endsWith("/fixture.txt")
        ? dirname(frozenBuilderInput)
        : frozenBuilderInput}\n`,
    );
  }
  await assert.rejects(readFile(join(fixture.snapshot, "node_modules", "ambient.js")), /ENOENT/);
  await assert.rejects(
    readFile(join(fixture.snapshot, "desktop", "shell", "dist", "stale.js")),
    /ENOENT/,
  );
  await assert.rejects(
    readFile(join(fixture.snapshot, "desktop", "template", ".lamarck", "system.db")),
    /ENOENT/,
  );
});

test("macOS release source snapshot rejects symbolic links and hard links", async (t) => {
  const symbolic = await createReleaseSourceFixture(t, "symbolic");
  const selected = join(symbolic.repository, MACOS_RELEASE_SOURCE_FILES[0]);
  await rm(selected);
  await symlink(join(symbolic.repository, MACOS_RELEASE_SOURCE_FILES[1]), selected);
  await assert.rejects(
    createMacOsReleaseSourceSnapshot(symbolic.repository, symbolic.snapshot),
    /link|regular file/,
  );

  const hard = await createReleaseSourceFixture(t, "hard");
  const hardSelected = join(hard.repository, MACOS_RELEASE_SOURCE_FILES[0]);
  await rm(hardSelected);
  await link(join(hard.repository, MACOS_RELEASE_SOURCE_FILES[1]), hardSelected);
  await assert.rejects(
    createMacOsReleaseSourceSnapshot(hard.repository, hard.snapshot),
    /single-link/,
  );
});

test("macOS release source snapshot detects a deterministic source race", async (t) => {
  const fixture = await createReleaseSourceFixture(t, "race");
  await assert.rejects(
    createMacOsReleaseSourceSnapshot(fixture.repository, fixture.snapshot, {
      afterCopy: async () => {
        await writeFile(join(fixture.repository, "package.json"), "changed during copy\n");
      },
    }),
    /changed during snapshot creation/,
  );
});

test("Shell builder inventory is bound to exact snapshot, lock, image, and tool identities", () => {
  const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const image = `sha256:${"a".repeat(64)}`;
  const source = `sha256:${"b".repeat(64)}`;
  const lockDigest = `sha256:${"c".repeat(64)}`;
  const packageLock = {
    lockfileVersion: 3,
    packages: Object.fromEntries([
      ["vite", "6.4.1"],
      ["typescript", "5.9.3"],
      ["esbuild", "0.25.12"],
      ["@electron/osx-sign", "2.4.0"],
      ["node-pty", "1.1.0"],
      ["node-addon-api", "7.1.1"],
    ].map(([name, version]) => [`node_modules/${name}`, {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity: `sha512-${Buffer.alloc(64, name).toString("base64")}`,
    }])),
  };
  const inventory = {
    schemaVersion: 1,
    sourceManifestDigest: source,
    packageLockSha256: lockDigest,
    builderImageId: image,
    runtime: {
      nodeVersion: "v24.10.0",
      nodeExecutableSha256: sha("node"),
      npmVersion: "11.6.1",
      npmCliSha256: sha("npm"),
    },
    tools: Object.fromEntries(Object.entries({
      vite: "6.4.1",
      typescript: "5.9.3",
      esbuild: "0.25.12",
      osxSign: "2.4.0",
      nodePty: "1.1.0",
      nodeAddonApi: "7.1.1",
    }).map(([name, version]) => [name, {
      version,
      resolved: packageLock.packages[
        `node_modules/${({
          osxSign: "@electron/osx-sign",
          nodePty: "node-pty",
          nodeAddonApi: "node-addon-api",
        })[name] ?? name}`
      ].resolved,
      integrity: packageLock.packages[
        `node_modules/${({
          osxSign: "@electron/osx-sign",
          nodePty: "node-pty",
          nodeAddonApi: "node-addon-api",
        })[name] ?? name}`
      ].integrity,
      packageJsonSha256: sha(`${name}-package`),
      entrySha256: sha(`${name}-entry`),
    }])),
    outputs: [{
      path: "dist/index.html",
      size: 5,
      mode: 0o644,
      sha256: sha("index"),
    }],
  };
  assert.doesNotThrow(() => assertBuilderInventory(
    inventory,
    source,
    image,
    lockDigest,
    packageLock,
  ));
  assert.throws(() => assertBuilderInventory(
    { ...inventory, builderImageId: `sha256:${"d".repeat(64)}` },
    source,
    image,
    lockDigest,
    packageLock,
  ), /identity/);
  assert.throws(() => assertBuilderInventory(
    {
      ...inventory,
      tools: { ...inventory.tools, vite: { ...inventory.tools.vite, version: "6.4.2" } },
    },
    source,
    image,
    lockDigest,
    packageLock,
  ), /vite identity/);
});

test("frozen signer loader permits its verified closure and denies ambient dependency fallback", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "lamarck-frozen-signer-"));
  t.after(async () => await rm(temporaryRoot, { recursive: true, force: true }));

  const validExport = join(temporaryRoot, "valid-export");
  const validPackage = join(
    validExport,
    "host-tools", "node_modules", "@electron", "osx-sign",
  );
  await mkdir(join(validPackage, "dist"), { recursive: true });
  await writeFile(join(validPackage, "package.json"), '{"type":"module"}\n');
  await writeFile(
    join(validPackage, "dist", "index.js"),
    "import { basename } from 'node:path';\nexport const sign = () => basename('/frozen/signer');\n",
  );
  const signer = await loadFrozenOsxSign(validExport);
  try {
    assert.equal(signer.sign(), "signer");
  } finally {
    signer.deregister();
  }

  const escapedExport = join(temporaryRoot, "escaped-export");
  const escapedPackage = join(
    escapedExport,
    "host-tools", "node_modules", "@electron", "osx-sign",
  );
  const ambientPackage = join(escapedExport, "node_modules", "ambient-signer-dependency");
  await mkdir(join(escapedPackage, "dist"), { recursive: true });
  await mkdir(ambientPackage, { recursive: true });
  await writeFile(join(escapedPackage, "package.json"), '{"type":"module"}\n');
  await writeFile(
    join(escapedPackage, "dist", "index.js"),
    "import value from 'ambient-signer-dependency';\nexport const sign = () => value;\n",
  );
  await writeFile(
    join(ambientPackage, "package.json"),
    '{"type":"module","exports":"./index.js"}\n',
  );
  await writeFile(join(ambientPackage, "index.js"), "export default 'ambient';\n");
  await assert.rejects(loadFrozenOsxSign(escapedExport), /ambient module resolution/);
});

test("packaged node-pty smoke loads only the exact app-local native runtime closure", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "lamarck-node-pty-smoke-"));
  t.after(async () => await rm(temporaryRoot, { recursive: true, force: true }));
  const appResources = join(temporaryRoot, "app");
  const packageRoot = join(appResources, "node_modules", "node-pty");
  await mkdir(join(appResources, "dist-electron"), { recursive: true });
  await mkdir(join(packageRoot, "lib"), { recursive: true });
  await writeFile(join(appResources, "dist-electron", "pty-helper.cjs"), "// fixture\n");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "node-pty",
    version: "1.1.0",
    main: "./lib/index.js",
  }));
  await writeFile(join(packageRoot, "lib", "index.js"), [
    "const { spawn: spawnChild } = require('node:child_process');",
    "module.exports = {",
    "  spawn(file, args, options) {",
    "    const child = spawnChild(file, args, {",
    "      cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'ignore'],",
    "    });",
    "    const dataHandlers = [];",
    "    const exitHandlers = [];",
    "    child.stdout.on('data', (data) => {",
    "      for (const handler of dataHandlers) handler(data.toString('utf8'));",
    "    });",
    "    child.on('exit', (exitCode, signal) => {",
    "      for (const handler of exitHandlers) handler({ exitCode, signal });",
    "    });",
    "    return {",
    "      kill() { child.kill(); },",
    "      onData(handler) { dataHandlers.push(handler); },",
    "      onExit(handler) { exitHandlers.push(handler); },",
    "    };",
    "  },",
    "  open() {},",
    "  native: { fork() {}, open() {} },",
    "};",
    "",
  ].join("\n"));

  const evidence = runPackagedNodePtySmoke(appResources);
  assert.deepEqual(evidence, {
    ok: true,
    platform: process.platform,
    architecture: process.arch,
    modulesAbi: process.versions.modules,
    napi: process.versions.napi,
    spawnedFixedCommand: true,
  });

  await writeFile(join(temporaryRoot, "ambient.cjs"), [
    "module.exports = {",
    "  spawn() {}, open() {}, native: { fork() {}, open() {} },",
    "};",
    "",
  ].join("\n"));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "node-pty",
    version: "1.1.0",
    main: "../../../ambient.cjs",
  }));
  assert.throws(
    () => runPackagedNodePtySmoke(appResources),
    /outside the exact packaged runtime closure/,
  );
});

test("packaged node-pty smoke fails before ambient ancestor fallback", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "lamarck-node-pty-ambient-"));
  t.after(async () => await rm(temporaryRoot, { recursive: true, force: true }));
  const appResources = join(temporaryRoot, "nested", "app");
  const ambientPackage = join(temporaryRoot, "node_modules", "node-pty");
  await mkdir(join(appResources, "dist-electron"), { recursive: true });
  await mkdir(join(ambientPackage, "lib"), { recursive: true });
  await writeFile(join(appResources, "dist-electron", "pty-helper.cjs"), "// fixture\n");
  await writeFile(join(ambientPackage, "package.json"), JSON.stringify({
    name: "node-pty",
    version: "1.1.0",
    main: "./lib/index.js",
  }));
  await writeFile(join(ambientPackage, "lib", "index.js"), [
    "module.exports = {",
    "  spawn() {}, open() {}, native: { fork() {}, open() {} },",
    "};",
    "",
  ].join("\n"));
  assert.throws(
    () => runPackagedNodePtySmoke(appResources),
    /packaged node-pty package\.json|ENOENT/,
  );
});

test("exclusive publication never replaces or writes through a race-created filesystem entry", {
  skip: !new Set(["darwin", "linux"]).has(process.platform),
}, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "lamarck-rename-excl-test-"));
  t.after(async () => await rm(temporaryRoot, { recursive: true, force: true }));
  const helper = compileRenameExclHelper(
    join(root, "scripts", "rename-excl.c"),
    join(temporaryRoot, "rename-excl"),
  );

  for (const kind of ["file", "empty-directory", "nonempty-directory", "symlink"]) {
    const source = join(temporaryRoot, `${kind}-source`);
    const destination = join(temporaryRoot, `${kind}-destination`);
    await mkdir(source);
    await writeFile(join(source, "release.txt"), `${kind}-release\n`);
    await assert.rejects(publishDirectoryNoReplace(source, destination, helper, {
      beforeRename: async () => {
        if (kind === "file") {
          await writeFile(destination, "preserve file\n");
          return;
        }
        if (kind === "symlink") {
          const symlinkTarget = join(temporaryRoot, `${kind}-target`);
          await mkdir(symlinkTarget);
          await symlink(symlinkTarget, destination);
          return;
        }
        await mkdir(destination);
        if (kind === "nonempty-directory") {
          await writeFile(join(destination, "attacker.txt"), "preserve me\n");
        }
      },
    }), /exited with/);
    assert.equal(await readFile(join(source, "release.txt"), "utf8"), `${kind}-release\n`);
    if (kind === "file") {
      assert.equal(await readFile(destination, "utf8"), "preserve file\n");
    } else if (kind === "nonempty-directory") {
      assert.equal(await readFile(join(destination, "attacker.txt"), "utf8"), "preserve me\n");
    } else if (kind === "symlink") {
      assert.equal((await lstat(destination)).isSymbolicLink(), true);
      assert.deepEqual(await readdir(join(temporaryRoot, `${kind}-target`)), []);
    } else {
      assert.deepEqual(await readdir(destination), []);
    }
  }
});

test("exclusive publication atomically moves the complete directory when target is absent", {
  skip: !new Set(["darwin", "linux"]).has(process.platform),
}, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "lamarck-rename-excl-success-"));
  t.after(async () => await rm(temporaryRoot, { recursive: true, force: true }));
  const helper = compileRenameExclHelper(
    join(root, "scripts", "rename-excl.c"),
    join(temporaryRoot, "rename-excl"),
  );
  const source = join(temporaryRoot, "source");
  const destination = join(temporaryRoot, "destination");
  await mkdir(source);
  await writeFile(join(source, "release.txt"), "complete\n");
  await publishDirectoryNoReplace(source, destination, helper);
  await assert.rejects(readFile(join(source, "release.txt")), /ENOENT/);
  assert.equal(await readFile(join(destination, "release.txt"), "utf8"), "complete\n");
});

async function createReleaseSourceFixture(t, suffix = "source") {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `lamarck-release-${suffix}-`));
  t.after(async () => await rm(temporaryRoot, { recursive: true, force: true }));
  const repository = join(temporaryRoot, "repository");
  const snapshot = join(temporaryRoot, "snapshot");
  await mkdir(repository);
  for (const relativePath of MACOS_RELEASE_SOURCE_FILES) {
    const path = join(repository, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${relativePath}\n`);
  }
  for (const relativeDirectory of MACOS_RELEASE_SOURCE_DIRECTORIES) {
    const directory = join(repository, relativeDirectory);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "fixture.txt"), `${relativeDirectory}\n`);
  }
  return { repository, snapshot };
}
