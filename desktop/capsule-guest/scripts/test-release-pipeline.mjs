#!/usr/bin/env node

import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stageCapsuleNative } from "../../../scripts/stage-capsule-native.mjs";
import {
  BUILD_SNAPSHOT_DIRECTORIES,
  BUILD_SNAPSHOT_FILES,
  createBuildSnapshot,
} from "./build-snapshot.mjs";
import { readDockerImageId } from "./docker-image-id.mjs";
import { publishGuestReleaseNoReplace } from "./publish-guest-release.mjs";
import { verifyGuestNodeClosure } from "./verify-guest-node-closure.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = join(repo, "desktop", "capsule-guest", "scripts");
const root = await mkdtemp(join(tmpdir(), "lamarck-release-pipeline-"));
try {
  const buildScriptPath = join(scripts, "build-guest-image.sh");
  const buildScript = await readFile(buildScriptPath, "utf8");
  assert(buildScript.includes("--iidfile \"$builder_iid_file\""), "Guest builder does not capture an immutable image ID");
  assert(!buildScript.includes("-t lamarck-capsule-buildroot"), "Guest builder still publishes a mutable Docker tag");
  assert(
    buildScript.match(/\"\$builder_image_id\"/g)?.length === 4,
    "Guest build stages are not all bound to the same immutable builder image ID",
  );
  const buildrootRun = buildScript.indexOf('\n"$@"\n');
  const reclaimCall = buildScript.lastIndexOf("\nreclaim_builder_outputs\n");
  const complianceGeneration = buildScript.indexOf("generate-compliance.mjs");
  assert(
    buildScript.includes("--network none")
      && buildScript.includes("--read-only")
      && buildScript.includes("--cap-drop ALL")
      && buildScript.includes("--cap-add CHOWN")
      && buildScript.includes("--cap-add DAC_READ_SEARCH")
      && buildScript.includes("--security-opt no-new-privileges:true")
      && buildScript.includes("--user 0:0")
      && buildScript.includes('-R "$host_uid:$host_gid" /prebuilt /export')
      && buildrootRun >= 0
      && reclaimCall > buildrootRun
      && complianceGeneration > reclaimCall,
    "Guest builder does not narrowly return Linux bind-mount ownership before Host release work",
  );
  assert(
    buildScript.includes('download_cache_requested="${LAMARCK_GUEST_BUILDROOT_DOWNLOAD_CACHE:-}"'),
    "Guest builder does not expose the exact opt-in Buildroot download cache flag",
  );
  assert(
    buildScript.includes('"$snapshot_guest/scripts/validate-buildroot-download-cache.mjs" "$repo"'),
    "Guest builder does not validate its fixed Buildroot download cache from the sealed snapshot",
  );
  const cacheMountLines = buildScript.split("\n").filter((line) => line.includes("--mount"));
  assert(
    cacheMountLines.length === 1
      && cacheMountLines[0].includes(
        'type=bind,source=$download_cache,target=/buildroot-download-cache',
      ),
    "Guest builder cache mount is not limited to the fixed download-cache target",
  );
  assert(
    !cacheMountLines[0].includes("/work/output")
      && !cacheMountLines[0].includes("/work/src")
      && !cacheMountLines[0].includes("/export")
      && !cacheMountLines[0].includes("toolchain"),
    "Guest builder cache mount includes build output, source, export, or toolchain state",
  );
  const malformedCacheFlag = spawnSync(buildScriptPath, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      LAMARCK_GUEST_BUILDROOT_DOWNLOAD_CACHE: "yes",
      LAMARCK_GUEST_SIGNING_KEY: "",
    },
  });
  assert(malformedCacheFlag.status !== 0, "malformed Buildroot download cache opt-in was accepted");
  assert(
    /must be unset or exactly 1/.test(malformedCacheFlag.stderr || malformedCacheFlag.stdout),
    "malformed Buildroot download cache opt-in failed for an unrelated reason",
  );
  const exactCacheFlag = spawnSync(buildScriptPath, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      LAMARCK_GUEST_BUILDROOT_DOWNLOAD_CACHE: "1",
      LAMARCK_GUEST_SIGNING_KEY: "",
    },
  });
  assert(exactCacheFlag.status !== 0, "Guest builder unexpectedly ran without a signing key");
  assert(
    /LAMARCK_GUEST_SIGNING_KEY/.test(exactCacheFlag.stderr || exactCacheFlag.stdout),
    "exact Buildroot download cache opt-in was rejected before the normal signing-key gate",
  );
  const buildrootScript = await readFile(join(scripts, "build-buildroot-inside.sh"), "utf8");
  assert(
    buildrootScript.includes('export BR2_DL_DIR="$download_root"'),
    "Buildroot does not bind only its download directory to the optional cache",
  );
  assert(
    buildrootScript.includes(
      "expected=9d2f3af10fcac763a61ff6e41894a033f9ecf9267ba13dd0912eedcd3be2b22a",
    )
      && buildrootScript.includes('cache_archive="$download_cache/$archive"')
      && buildrootScript.includes('ln -- "$cache_publish_temp" "$cache_archive"'),
    "pinned Buildroot source archive is not safely reused and atomically cached",
  );
  const applyHashPatch = buildrootScript.indexOf(
    'patch --batch --forward --fuzz=0 --strip=1 --directory="$source"',
  );
  const configureBuildroot = buildrootScript.indexOf("lamarck_capsule_arm64_defconfig");
  const verifyHashPolicy = buildrootScript.indexOf("verify-buildroot-hash-policy.mjs");
  const buildBuildroot = buildrootScript.indexOf('"-j${JOBS:-$(nproc)}"');
  assert(
    applyHashPatch >= 0
      && configureBuildroot > applyHashPatch
      && verifyHashPolicy > configureBuildroot
      && buildBuildroot > verifyHashPolicy,
    "Buildroot forced-hash patch and policy gate do not precede every package download",
  );
  const forcedHashPatch = await readFile(join(
    repo,
    "desktop/capsule-guest/buildroot/buildroot-patches/0001-download-force-hashes-reject-missing-hash-files.patch",
  ), "utf8");
  assert(
    forcedHashPatch.includes(
      'BR2_DOWNLOAD_FORCE_CHECK_HASHES="$(BR2_DOWNLOAD_FORCE_CHECK_HASHES)"',
    )
      && forcedHashPatch.includes(
        'if [ "${BR2_DOWNLOAD_FORCE_CHECK_HASHES:-}" = "y" ]; then',
      )
      && forcedHashPatch.includes("exit 3")
      && forcedHashPatch.includes('printf "WARNING: no hash file for %s\\n"'),
    "pinned Buildroot patch does not fail closed only under forced hash checking",
  );
  const bootScript = await readFile(join(scripts, "test-guest-image-boot.mjs"), "utf8");
  assert(bootScript.includes('"--iidfile", imageIdFile'), "QEMU smoke does not capture an immutable runner ID");
  assert(!bootScript.includes("lamarck-capsule-qemu-smoke:"), "QEMU smoke still runs a mutable Docker tag");
  assert(
    bootScript.includes('\"--user\", dockerHostIdentity()')
      && bootScript.includes("process.getuid?.()")
      && bootScript.includes("process.getgid?.()"),
    "QEMU smoke does not use the Host owner identity for private release bind mounts",
  );
  assert(
    bootScript.includes('"virtio-blk-device,drive=rootfs,bus=virtio-mmio-bus.0"'),
    "QEMU smoke does not pin rootfs to the first Linux virtio block device",
  );
  assert(
    bootScript.includes('"virtio-blk-device,drive=state,bus=virtio-mmio-bus.1"'),
    "QEMU smoke does not pin state to the second Linux virtio block device",
  );
  const supervisorBuild = await readFile(join(scripts, "build-supervisor.mjs"), "utf8");
  assert(
    supervisorBuild.includes('"release-runc-smoke": resolve(root, "src", "release-runc-smoke.ts")'),
    "signed Guest build omits the production runc smoke bundle",
  );
  assert(
    supervisorBuild.includes('"cli", "dist", "lamarck-managed.mjs"')
      && !supervisorBuild.includes('"cli", "src"'),
    "signed Guest build does not consume the built managed CLI artifact",
  );
  const javascriptBuild = await readFile(join(scripts, "build-js-inside.sh"), "utf8");
  assert(
    javascriptBuild.includes("verify-guest-node-closure.mjs")
      && javascriptBuild.indexOf("verify-guest-node-closure.mjs")
        < javascriptBuild.indexOf("npm ci"),
    "Guest JavaScript build does not verify its selected Node closure before npm ci",
  );
  assert(
    !javascriptBuild.includes("@lamarck/system")
      && !javascriptBuild.includes("system-sdk"),
    "Guest JavaScript build still compiles or exports the App System SDK",
  );
  assert(
    javascriptBuild.indexOf("desktop/cli/scripts/build.mjs")
      < javascriptBuild.indexOf("desktop/capsule-guest/scripts/build-supervisor.mjs"),
    "Guest JavaScript build does not build the CLI before the Capsule Guest bundle",
  );
  assert(
    !BUILD_SNAPSHOT_FILES.some((path) => path.startsWith("desktop/system-sdk/"))
      && !BUILD_SNAPSHOT_DIRECTORIES.some((path) => path.startsWith("desktop/system-sdk/")),
    "Guest build snapshot still includes App System SDK source",
  );
  assert(
    BUILD_SNAPSHOT_FILES.includes("LICENSE")
      && BUILD_SNAPSHOT_FILES.includes("desktop/cli/package.json")
      && BUILD_SNAPSHOT_FILES.includes("desktop/cli/tsconfig.build.json")
      && BUILD_SNAPSHOT_DIRECTORIES.includes("desktop/cli/scripts")
      && BUILD_SNAPSHOT_DIRECTORIES.includes("desktop/cli/src"),
    "Guest build snapshot omits a required CLI build input",
  );
  assert(
    JSON.stringify(await verifyGuestNodeClosure(repo, { runtimeVersion: "24.18.0" }))
      === JSON.stringify(["desktop/capsule", "desktop/capsule-guest", "desktop/cli"]),
    "current Guest workspace closure is not exact",
  );
  const nodeClosureFixture = join(root, "guest-node-closure");
  await createGuestNodeClosureFixture(nodeClosureFixture);
  assert(
    JSON.stringify(await verifyGuestNodeClosure(
      nodeClosureFixture,
      { runtimeVersion: "24.18.0" },
    )) === JSON.stringify(["desktop/capsule", "desktop/capsule-guest", "desktop/cli"]),
    "valid Guest Node closure fixture was rejected",
  );
  const capsuleManifestPath = join(nodeClosureFixture, "desktop/capsule/package.json");
  const capsuleManifest = JSON.parse(await readFile(capsuleManifestPath, "utf8"));
  capsuleManifest.engines.node = ">=99.0.0";
  await writeFile(capsuleManifestPath, `${JSON.stringify(capsuleManifest)}\n`);
  await expectReject(
    verifyGuestNodeClosure(nodeClosureFixture, { runtimeVersion: "24.18.0" }),
    /does not accept pinned Node/,
  );
  capsuleManifest.engines.node = ">=24.10.0";
  await writeFile(capsuleManifestPath, `${JSON.stringify(capsuleManifest)}\n`);
  const coreManifestPath = join(nodeClosureFixture, "desktop/core/package.json");
  const coreManifest = JSON.parse(await readFile(coreManifestPath, "utf8"));
  coreManifest.engines.node = ">=99.0.0";
  await writeFile(coreManifestPath, `${JSON.stringify(coreManifest)}\n`);
  await verifyGuestNodeClosure(nodeClosureFixture, { runtimeVersion: "24.18.0" });
  const postBuild = await readFile(join(
    repo,
    "desktop/capsule-guest/buildroot/board/lamarck/arm64/post-build.sh",
  ), "utf8");
  assert(
    postBuild.includes("lamarck-release-runc-smoke.js"),
    "signed Guest rootfs omits the production runc smoke bundle",
  );
  assert(
    !postBuild.includes("system-sdk"),
    "signed Guest rootfs still bundles an App System SDK copy",
  );
  const guestService = await readFile(join(
    repo,
    "desktop/capsule-guest/buildroot/board/lamarck/arm64/rootfs-overlay/usr/libexec/lamarck-guest-service",
  ), "utf8");
  const runcSmokeIndex = guestService.indexOf("/usr/libexec/lamarck-release-runc-smoke.js");
  const successMarkerIndex = guestService.indexOf("LAMARCK_GUEST_BOOT_SMOKE_OK");
  assert(
    runcSmokeIndex >= 0 && successMarkerIndex > runcSmokeIndex,
    "QEMU success marker is not gated by the exact production runc smoke",
  );

  const builderImageId = `sha256:${"b".repeat(64)}`;
  const builderImageIdPath = join(root, "builder-image-id");
  await writeFile(builderImageIdPath, `${builderImageId}\n`);
  assert(
    await readDockerImageId(builderImageIdPath) === builderImageId,
    "canonical immutable Docker image ID was not accepted",
  );
  await writeFile(join(root, "mutable-docker-tag"), "lamarck-capsule-buildroot:latest\n");
  await expectReject(
    readDockerImageId(join(root, "mutable-docker-tag")),
    /canonical immutable sha256 image ID/,
  );
  await symlink(builderImageIdPath, join(root, "linked-builder-image-id"));
  await expectReject(
    readDockerImageId(join(root, "linked-builder-image-id")),
    /ELOOP|symbolic link|non-symlink/,
  );

  const defconfig = await readFile(join(
    repo,
    "desktop/capsule-guest/buildroot/configs/lamarck_capsule_arm64_defconfig",
  ), "utf8");
  assert(
    defconfig.includes('BR2_GLOBAL_PATCH_DIR="$(BR2_EXTERNAL_LAMARCK_PATH)/patches"'),
    "Buildroot custom-source hashes are not enabled",
  );
  assert(
    defconfig.includes("BR2_DOWNLOAD_FORCE_CHECK_HASHES=y"),
    "Buildroot must fail rather than warn when any custom download lacks a hash",
  );
  const pinnedLinuxHash =
    "sha256  a7a7e3d2ae9d95e74197223a8d4eb5f6be7aac21b6e6de27e9685d001c1f8cb0  linux-6.18.39.tar.xz";
  const expectedHashFiles = new Map([
    [
      "desktop/capsule-guest/buildroot/patches/linux/6.18.39/linux.hash",
      [
        pinnedLinuxHash,
        "sha256  fb5a425bd3b3cd6071a3a9aff9909a859e7c1158d54d32e07658398cd67eb6a0  COPYING",
        "sha256  8780e78a1a737e127f25a65f6d95269bffd36158dc261114de7859b490bfc5aa  LICENSES/preferred/GPL-2.0",
        "sha256  8e378ab93586eb55135d3bc119cce787f7324f48394777d00c34fa3d0be3303f  LICENSES/exceptions/Linux-syscall-note",
      ],
    ],
    [
      "desktop/capsule-guest/buildroot/patches/linux-headers/6.18.39/linux-headers.hash",
      [
        pinnedLinuxHash,
        "sha256  fb5a425bd3b3cd6071a3a9aff9909a859e7c1158d54d32e07658398cd67eb6a0  COPYING",
        "sha256  8780e78a1a737e127f25a65f6d95269bffd36158dc261114de7859b490bfc5aa  LICENSES/preferred/GPL-2.0",
        "sha256  8e378ab93586eb55135d3bc119cce787f7324f48394777d00c34fa3d0be3303f  LICENSES/exceptions/Linux-syscall-note",
      ],
    ],
    [
      "desktop/capsule-guest/buildroot/package/node24-bin/node24-bin.hash",
      [
        "sha256  58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6  node-v24.18.0-linux-arm64.tar.xz",
        "sha256  148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5  LICENSE",
      ],
    ],
  ]);
  for (const [relativePath, expectedLines] of expectedHashFiles) {
    const hashLines = (await readFile(join(repo, relativePath), "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert(
      JSON.stringify(hashLines) === JSON.stringify(expectedLines),
      `${relativePath} does not exclusively bind its source and license files`,
    );
  }

  const cacheRepository = join(root, "cache-repository");
  await mkdir(cacheRepository);
  const cacheValidator = join(scripts, "validate-buildroot-download-cache.mjs");
  const cacheValidation = spawnNode(cacheValidator, [cacheRepository]);
  assert(cacheValidation.status === 0, "fixed Buildroot download cache was not created");
  const cacheRoot = join(
    await realpath(cacheRepository),
    ".lamarck",
    "build",
    "capsule-guest",
    "download-cache",
    "buildroot-2026.05-v1",
  );
  assert(cacheValidation.stdout.trim() === cacheRoot, "cache validator returned an unexpected path");
  await mkdir(join(cacheRoot, "busybox"));
  await writeFile(join(cacheRoot, "busybox", "busybox.tar"), "regular cached archive\n");
  runNode(cacheValidator, [cacheRepository]);

  const outsideCache = join(root, "outside-cache-entry");
  await writeFile(outsideCache, "outside\n");
  const linkedCacheEntry = join(cacheRoot, "linked-archive");
  await symlink(outsideCache, linkedCacheEntry);
  const linkedCacheValidation = spawnNode(cacheValidator, [cacheRepository]);
  assert(linkedCacheValidation.status !== 0, "symbolic-link cache entry was accepted");
  assert(
    /symbolic link/.test(linkedCacheValidation.stderr || linkedCacheValidation.stdout),
    "symbolic-link cache entry failed for an unrelated reason",
  );
  await rm(linkedCacheEntry, { force: true });

  if (new Set(["darwin", "linux"]).has(process.platform)) {
    const specialCacheEntry = join(cacheRoot, "special-entry");
    const fifo = spawnSync("mkfifo", [specialCacheEntry], { encoding: "utf8" });
    assert(!fifo.error && fifo.status === 0, "could not create special cache-entry fixture");
    const specialCacheValidation = spawnNode(cacheValidator, [cacheRepository]);
    assert(specialCacheValidation.status !== 0, "special cache entry was accepted");
    assert(
      /special entry/.test(specialCacheValidation.stderr || specialCacheValidation.stdout),
      "special cache entry failed for an unrelated reason",
    );
    await rm(specialCacheEntry, { force: true });
  }

  const escapeRepository = join(root, "cache-escape-repository");
  const escapeTarget = join(root, "cache-escape-target");
  await mkdir(escapeRepository);
  await mkdir(escapeTarget);
  await symlink(escapeTarget, join(escapeRepository, ".lamarck"));
  const escapedCacheValidation = spawnNode(cacheValidator, [escapeRepository]);
  assert(escapedCacheValidation.status !== 0, "cache root escaped through a parent symbolic link");
  assert(
    (await readdir(escapeTarget)).length === 0,
    "cache validator created entries outside its fixed repository root",
  );
  const callerSelectedCache = spawnNode(cacheValidator, [cacheRepository, escapeTarget]);
  assert(callerSelectedCache.status !== 0, "cache validator accepted a caller-selected cache path");

  await createProjectFixture(root);
  const sourceSnapshot = join(root, "source-snapshot");
  const snapshot = await createBuildSnapshot(root, sourceSnapshot);
  const work = join(root, ".lamarck", "build", "capsule-guest");
  const legal = join(work, "output", "legal-info");
  const imageInput = join(work, "image-input");
  const buildrootArchive = join(work, "src", "buildroot-2026.05.tar.xz");
  await createLegalFixture(legal);
  await mkdir(imageInput, { recursive: true });
  await writeFile(join(imageInput, "builder-packages.tsv"), "bash\t5.2.15-2+b7\tarm64\n");
  await createJavaScriptBuilderFixture(work, sourceSnapshot, snapshot.manifestDigest);
  await writeFile(join(imageInput, "Image"), Buffer.from("test-kernel-image\n"));
  const rootfs = join(imageInput, "rootfs.ext4");
  await writeFile(rootfs, Buffer.from("rootfs"));
  await truncate(rootfs, 64 * 1024 * 1024);
  await writeFile(rootfs, Buffer.from("tail"), { flag: "r+" }).catch(() => {});
  await mkdir(dirname(buildrootArchive), { recursive: true });
  await writeFile(buildrootArchive, Buffer.from("pinned-buildroot-source\n"));

  const compliance = join(work, "compliance");
  runNode(join(scripts, "generate-compliance.mjs"), [
    legal,
    buildrootArchive,
    sourceSnapshot,
    compliance,
    "0.1.0",
    builderImageId,
  ]);
  const builderEnvironment = JSON.parse(
    await readFile(join(compliance, "builder-environment.json"), "utf8"),
  );
  assert(
    builderEnvironment.builderImageId === builderImageId,
    "signed compliance omitted the exact immutable Docker builder image ID",
  );
  const sbom = JSON.parse(await readFile(join(compliance, "sbom.spdx.json"), "utf8"));
  assert(sbom.spdxVersion === "SPDX-2.3", "SPDX version was not generated");
  assert(sbom.packages.length === 4, "SPDX package inventory is incomplete");
  const offer = JSON.parse(await readFile(join(compliance, "corresponding-source-offer.json"), "utf8"));
  assert(
    offer.fulfillment.kind === "prepared-corresponding-source",
    "source offer is not prepared for detached release packaging",
  );
  const busyboxSource = offer.components.find((component) => component.name === "busybox")?.sourcePath;
  assert(
    busyboxSource === "corresponding-source/target-packages/busybox-1.38.0/busybox-1.38.0.tar.bz2",
    "Buildroot's namespaced BusyBox source path was not preserved",
  );
  const versionedSource = offer.components.find((component) => component.name === "versioned")?.sourcePath;
  assert(
    versionedSource === "corresponding-source/target-packages/versioned-release_1__candidate/versioned.tar.xz",
    "Buildroot version sanitization was not applied to the source directory",
  );
  const sourceManifest = JSON.parse(
    await readFile(join(sourceSnapshot, "build-input-manifest.json"), "utf8"),
  );
  const offeredPaths = new Set(offer.files.map((file) => file.path));
  for (const input of sourceManifest.files) {
    assert(
      offeredPaths.has(`corresponding-source/lamarck-project/${input.path}`),
      `corresponding source omitted sealed build input ${input.path}`,
    );
  }

  const flatLegal = join(work, "flat-legal-info");
  await createLegalFixture(flatLegal, { nestedSources: false });
  const flatCompliance = spawnNode(join(scripts, "generate-compliance.mjs"), [
    flatLegal,
    buildrootArchive,
    sourceSnapshot,
    join(work, "flat-compliance"),
    "0.1.0",
    builderImageId,
  ]);
  assert(flatCompliance.status !== 0, "flat Buildroot source layout was accepted");
  assert(
    /source archive/.test(flatCompliance.stderr || flatCompliance.stdout),
    "flat Buildroot source layout failed for an unrelated reason",
  );

  const extraLegal = join(work, "extra-legal-info");
  await createLegalFixture(extraLegal);
  await writeFile(
    join(extraLegal, "sources", "busybox-1.38.0", "unlisted.patch"),
    "unlisted corresponding source\n",
  );
  const extraCompliance = spawnNode(join(scripts, "generate-compliance.mjs"), [
    extraLegal,
    buildrootArchive,
    sourceSnapshot,
    join(work, "extra-compliance"),
    "0.1.0",
    builderImageId,
  ]);
  assert(extraCompliance.status !== 0, "unlisted Buildroot legal-info file was accepted");
  assert(
    /does not cover sources\/busybox-1\.38\.0\/unlisted\.patch/.test(
      extraCompliance.stderr || extraCompliance.stdout,
    ),
    "unlisted Buildroot legal-info file failed for an unrelated reason",
  );

  const { privateKey } = generateKeyPairSync("ed25519");
  const key = join(work, "test-key.pem");
  await writeFile(key, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const release = join(work, "release");
  runNode(join(scripts, "sign-guest-image.mjs"), [imageInput, compliance, release, key, "0.1.0"]);
  runNode(join(scripts, "verify-guest-release.mjs"), [release, "--require-source"]);

  const releaseDescriptor = JSON.parse(
    await readFile(join(release, "capsule-guest-release.json"), "utf8"),
  );
  assert(releaseDescriptor.schemaVersion === 1, "Guest release descriptor v1 was not emitted");
  const sourceArchive = releaseDescriptor.correspondingSource;
  assert(sourceArchive?.format === "tar+gzip", "source archive metadata is incomplete");
  assert(
    (await stat(join(release, sourceArchive.file))).size === sourceArchive.bytes,
    "source archive size is not bound to the Guest descriptor",
  );
  const archiveListing = spawnSync("tar", [
    "-tzf",
    join(release, sourceArchive.file),
  ], { encoding: "utf8" });
  assert(
    archiveListing.status === 0
      && archiveListing.stdout.split("\n").some((path) =>
        path.endsWith(
          "corresponding-source/target-packages/busybox-1.38.0/busybox-1.38.0.tar.bz2",
        )),
    "detached archive does not contain the offered corresponding source",
  );
  const runtimeCompliance = await listFiles(
    join(release, "capsule-guest-arm64", "compliance"),
  );
  assert(
    !runtimeCompliance.some((path) => path.startsWith("corresponding-source/")),
    "runtime Guest bundle still contains corresponding source",
  );
  const releasedOffer = JSON.parse(await readFile(
    join(
      release,
      "capsule-guest-arm64",
      "compliance",
      "corresponding-source-offer.json",
    ),
    "utf8",
  ));
  assert(
    releasedOffer.fulfillment.kind === "network-download"
      && releasedOffer.fulfillment.archive.url === sourceArchive.url,
    "signed source offer does not point to the detached immutable archive",
  );

  const copiedRootfs = await stat(join(release, "capsule-guest-arm64", "rootfs.ext4"));
  assert(copiedRootfs.size === 64 * 1024 * 1024, "sparse rootfs logical size changed");
  if (typeof copiedRootfs.blocks === "number" && copiedRootfs.blocks > 0) {
    assert(copiedRootfs.blocks * 512 < copiedRootfs.size / 4, "rootfs sparse holes were expanded");
  }

  const collision = spawnNode(join(scripts, "sign-guest-image.mjs"), [
    imageInput,
    compliance,
    release,
    key,
    "0.1.0",
  ]);
  assert(collision.status !== 0, "signer overwrote an existing release");

  const sbomPath = join(release, "capsule-guest-arm64", "compliance", "sbom.spdx.json");
  const originalSbom = await readFile(sbomPath);
  await writeFile(sbomPath, Buffer.concat([originalSbom, Buffer.from("tamper")]), { flag: "w" });
  const tampered = spawnNode(join(scripts, "verify-guest-release.mjs"), [release]);
  assert(tampered.status !== 0, "verifier accepted tampered compliance output");
  await writeFile(sbomPath, originalSbom, { flag: "w" });
  runNode(join(scripts, "verify-guest-release.mjs"), [release]);

  const nativeRoot = join(root, "desktop", "shell", "dist-electron", "native");
  await mkdir(nativeRoot, { recursive: true });
  const helper = join(nativeRoot, "lamarck-capsule-vm-host");
  await writeFile(helper, "fixture-helper\n", { mode: 0o755 });
  await chmod(helper, 0o755);
  const staged = await stageCapsuleNative(root);
  assert(staged === join(nativeRoot, "capsule-guest"), "release staged at an unexpected path");
  await stageCapsuleNative(root);
  runNode(join(scripts, "verify-guest-release.mjs"), [staged]);
  assert(
    !(await lstat(join(staged, sourceArchive.file)).catch(() => null)),
    "Desktop native staging copied the developer-only source archive",
  );
  const stagedStrictVerification = spawnNode(
    join(scripts, "verify-guest-release.mjs"),
    [staged, "--require-source"],
  );
  assert(
    stagedStrictVerification.status !== 0
      && /archive is required but missing/.test(
        stagedStrictVerification.stderr || stagedStrictVerification.stdout,
      ),
    "strict public-release verification accepted a runtime-only Guest projection",
  );

  if (new Set(["darwin", "linux"]).has(process.platform)) {
    const publicationRoot = join(root, "publication");
    await mkdir(publicationRoot);
    for (const kind of ["file", "empty-directory", "nonempty-directory", "symlink"]) {
      const source = join(publicationRoot, `${kind}-source`);
      const destination = join(publicationRoot, `${kind}-destination`);
      const helperPath = join(publicationRoot, `${kind}-rename-excl`);
      const symlinkTarget = join(publicationRoot, `${kind}-target`);
      await mkdir(source);
      await writeFile(join(source, "release.txt"), `${kind}-release\n`);
      await expectReject(
        publishGuestReleaseNoReplace(source, destination, helperPath, {
          beforeRename: async () => {
            if (kind === "file") await writeFile(destination, "preserve file\n");
            else if (kind === "symlink") {
              await mkdir(symlinkTarget);
              await symlink(symlinkTarget, destination);
            } else {
              await mkdir(destination);
              if (kind === "nonempty-directory") {
                await writeFile(join(destination, "attacker.txt"), "preserve me\n");
              }
            }
          },
        }),
        /exited with/,
      );
      assert(
        await readFile(join(source, "release.txt"), "utf8") === `${kind}-release\n`,
        `exclusive Guest publication moved source after ${kind} collision`,
      );
      if (kind === "symlink") {
        assert((await lstat(destination)).isSymbolicLink(), "Guest publication replaced a symlink");
        assert((await readdir(symlinkTarget)).length === 0, "Guest publication wrote through a symlink");
      }
    }

    const source = join(publicationRoot, "success-source");
    const destination = join(publicationRoot, "success-destination");
    await mkdir(source);
    await writeFile(join(source, "release.txt"), "complete\n");
    await publishGuestReleaseNoReplace(
      source,
      destination,
      join(publicationRoot, "success-rename-excl"),
    );
    await expectReject(lstat(source), /ENOENT/);
    assert(
      JSON.stringify(await readdir(destination)) === JSON.stringify(["release.txt"]),
      "exclusive Guest publication nested or incompletely moved the release",
    );
    assert(
      await readFile(join(destination, "release.txt"), "utf8") === "complete\n",
      "exclusive Guest publication changed the signed release",
    );
  }

  process.stdout.write("release pipeline validators passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createProjectFixture(root) {
  for (const path of BUILD_SNAPSHOT_FILES) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${path}\n`);
  }
  for (const path of BUILD_SNAPSHOT_DIRECTORIES) {
    const destination = join(root, path, "fixture.txt");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${path}\n`);
  }
}

async function createGuestNodeClosureFixture(root) {
  const packages = {
    "desktop/capsule": {
      name: "@lamarck/capsule",
      version: "0.1.0",
      engines: { node: ">=24.10.0" },
      dependencies: { "@lamarck/cli": "0.1.0" },
    },
    "desktop/capsule-guest": {
      name: "@lamarck/capsule-guest",
      version: "0.1.0",
      engines: { node: ">=24.10.0" },
      dependencies: { "@lamarck/capsule": "0.1.0", "@lamarck/cli": "0.1.0" },
    },
    "desktop/cli": {
      name: "@lamarck/cli",
      version: "0.1.0",
      engines: { node: ">=24.12.0" },
    },
    "desktop/core": {
      name: "@lamarck/core",
      version: "0.1.0",
      engines: { node: ">=24.12.0" },
    },
  };
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "fixture",
    version: "0.1.0",
    workspaces: Object.keys(packages),
  })}\n`);
  await writeFile(join(root, "package-lock.json"), `${JSON.stringify({
    name: "fixture",
    version: "0.1.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "0.1.0" },
      ...packages,
    },
  })}\n`);
  for (const [workspace, manifest] of Object.entries(packages)) {
    const path = join(root, workspace, "package.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(manifest)}\n`);
  }
}

async function createJavaScriptBuilderFixture(work, snapshotRoot, manifestDigest) {
  const prebuilt = join(work, "prebuilt-verification");
  const files = [
    ["capsule-guest/dist/supervisor.js", "supervisor fixture\n"],
    ["capsule-guest/dist/offline-npm.js", "offline npm fixture\n"],
    ["capsule-guest/dist/release-runc-smoke.js", "runc smoke fixture\n"],
  ];
  for (const [path, contents] of files) {
    const destination = join(prebuilt, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const placeholder = digest("tool fixture");
  const inventory = {
    schemaVersion: 1,
    sourceSnapshotManifestDigest: manifestDigest,
    packageLockSha256: digest(await readFile(join(snapshotRoot, "package-lock.json"))),
    runtime: {
      nodeVersion: "v24.18.0",
      nodeExecutableSha256: placeholder,
      npmVersion: "11.16.0",
      npmCliSha256: placeholder,
    },
    tools: {
      esbuildVersion: "0.25.12",
      esbuildPackageSha256: placeholder,
      esbuildBinarySha256: placeholder,
      typescriptVersion: "5.9.3",
      typescriptPackageSha256: placeholder,
      typescriptCliSha256: placeholder,
    },
    outputs: files.map(([path, contents]) => ({
      path,
      size: Buffer.byteLength(contents),
      sha256: digest(contents),
    })).sort((left, right) => left.path.localeCompare(right.path, "en")),
  };
  const inventoryBytes = `${JSON.stringify(inventory)}\n`;
  await writeFile(join(prebuilt, "js-builder-environment.json"), inventoryBytes);
  await mkdir(join(work, "image-input"), { recursive: true });
  await writeFile(join(work, "image-input", "js-builder-environment.json"), inventoryBytes);
}

async function createLegalFixture(root, { nestedSources = true } = {}) {
  await mkdir(join(root, "licenses", "linux-6.18.39"), { recursive: true });
  await mkdir(join(root, "licenses", "node24-bin-24.18.0"), { recursive: true });
  await mkdir(join(root, "licenses", "busybox-1.38.0"), { recursive: true });
  await mkdir(join(root, "licenses", "versioned-release_1__candidate"), { recursive: true });
  await mkdir(join(root, "sources"), { recursive: true });
  await writeFile(join(root, "licenses", "linux-6.18.39", "COPYING"), "GPL-2.0-only\n");
  await writeFile(join(root, "licenses", "node24-bin-24.18.0", "LICENSE"), "MIT\n");
  await writeFile(join(root, "licenses", "busybox-1.38.0", "LICENSE"), "GPL-2.0-only\n");
  await writeFile(join(root, "licenses", "versioned-release_1__candidate", "LICENSE"), "MIT\n");
  const sourceFixtures = [
    ["linux-6.18.39", "linux-6.18.39.tar.xz", "linux source\n"],
    ["node24-bin-24.18.0", "node-v24.18.0-linux-arm64.tar.xz", "node source\n"],
    ["busybox-1.38.0", "busybox-1.38.0.tar.bz2", "busybox source\n"],
    ["versioned-release_1__candidate", "versioned.tar.xz", "versioned source\n"],
  ];
  for (const [directory, archive, contents] of sourceFixtures) {
    const destination = nestedSources ? join(root, "sources", directory) : join(root, "sources");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, archive), contents);
  }
  await writeFile(join(root, "README"), "Buildroot legal-info fixture\n");
  await writeFile(join(root, "buildroot.config"), "BR2_aarch64=y\n");
  await writeFile(join(root, "manifest.csv"), [
    '"PACKAGE","VERSION","LICENSE","LICENSE FILES","SOURCE ARCHIVE","SOURCE SITE","DEPENDENCIES WITH LICENSES"',
    '"busybox","1.38.0","GPL-2.0-only","LICENSE","busybox-1.38.0.tar.bz2","https://busybox.net",""',
    '"linux","6.18.39","GPL-2.0-only","COPYING","linux-6.18.39.tar.xz","https://kernel.org",""',
    '"node24-bin","24.18.0","MIT","LICENSE","node-v24.18.0-linux-arm64.tar.xz","https://nodejs.org",""',
    '"versioned","release/1: candidate","MIT","LICENSE","versioned.tar.xz","https://example.invalid",""',
    "",
  ].join("\n"));
  const files = await listFiles(root);
  const lines = [];
  for (const path of files) {
    const bytes = await readFile(join(root, path));
    lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${path}`);
  }
  await writeFile(join(root, "legal-info.sha256"), `${lines.sort().join("\n")}\n`);
}

async function listFiles(root, prefix = "") {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const files = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(join(root, entry.name), path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function runNode(script, args) {
  const result = spawnNode(script, args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${script} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function spawnNode(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectReject(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    if (pattern.test(String(error?.message ?? error))) return;
    throw error;
  }
  throw new Error(`expected rejection matching ${pattern}`);
}
