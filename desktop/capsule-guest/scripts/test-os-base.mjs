import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createBuildSnapshot } from "./build-snapshot.mjs";
import { createOsBase, describeOsBaseInputs, OS_BASE_SOURCE_FILES, stageOsBase, verifyOsBase } from "./os-base.mjs";
import { assembleGuestPrograms, GUEST_PROGRAM_FILES } from "./assemble-guest-programs.mjs";

const BUILDER = `sha256:${"a".repeat(64)}`;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("the build preflight imports OS base helpers without dispatching the CLI", async t => {
  const fixture = await createFixture(t);
  const script = await readFile(new URL("./build-guest-image.sh", import.meta.url), "utf8");
  const preflight = script.match(/node --input-type=module -e '([\s\S]*?)'/)?.[1];
  assert(preflight, "the build must validate native inputs before compiling");
  const modulePath = fileURLToPath(new URL("./os-base.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", preflight,
    modulePath, fixture.source, BUILDER, "0", "4"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const direct = spawnSync(process.execPath, [modulePath, "invalid-command"], { encoding: "utf8" });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /usage: os-base\.mjs/);
});

test("Guest/CLI JS and npm lock changes reuse the base; every OS/native input change invalidates it", async t => {
  const fixture = await createFixture(t);
  const identity = await describeOsBaseInputs(fixture.source, BUILDER);
  const base = await createOsBase(fixture.base, fixture.source, BUILDER);
  for (const path of ["desktop/capsule-guest/src/supervisor.ts", "desktop/cli/src/operations.ts", "package-lock.json"]) {
    await put(join(fixture.source, path), "new business JavaScript or dependency lock");
    assert.deepEqual(await describeOsBaseInputs(fixture.source, BUILDER), identity);
    await verifyOsBase(fixture.base, base.digest, identity);
  }
  for (const file of identity.files) {
    const path = join(fixture.source, file.path);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("changed")]));
    await assert.rejects(verifyOsBase(fixture.base, base.digest, await describeOsBaseInputs(fixture.source, BUILDER)), /inputs do not match/);
    await writeFile(path, original);
  }
  for (const parameters of [[`sha256:${"b".repeat(64)}`, "0", "4"], [BUILDER, "1", "4"], [BUILDER, "0", "8"]]) {
    await assert.rejects(verifyOsBase(fixture.base, base.digest, await describeOsBaseInputs(fixture.source, ...parameters)), /inputs do not match/);
  }
  await put(join(fixture.source, "desktop/capsule-guest/buildroot/new-native-input"), "added");
  await assert.rejects(verifyOsBase(fixture.base, base.digest, await describeOsBaseInputs(fixture.source, BUILDER)), /inputs do not match/);
});

test("missing, unpinned, dirty, tampered and substituted bases fail before staging", async t => {
  const fixture = await createFixture(t);
  const identity = await describeOsBaseInputs(fixture.source, BUILDER);
  const base = await createOsBase(fixture.base, fixture.source, BUILDER);
  const staged = join(fixture.root, "staged");
  await stageOsBase(fixture.base, base.digest, identity, staged);
  assert.equal((await verifyOsBase(staged, base.digest, identity)).digest, base.digest);
  await assert.rejects(verifyOsBase(staged, "", identity), /explicit SHA-256/);
  await assert.rejects(verifyOsBase(staged, `sha256:${"0".repeat(64)}`, identity), /digest mismatch/);
  await assert.rejects(verifyOsBase(join(fixture.root, "missing"), base.digest, identity), /ENOENT/);
  for (const path of ["image-input/rootfs.ext4", "output/legal-info/licenses/LICENSE", "os-source/LICENSE"]) {
    const original = await readFile(join(staged, path));
    await writeFile(join(staged, path), "tampered");
    const destination = join(fixture.root, `rejected-${path.replaceAll("/", "-")}`);
    await assert.rejects(stageOsBase(staged, base.digest, identity, destination), /integrity mismatch/);
    await assert.rejects(readFile(join(destination, "os-base-manifest.json")), /ENOENT/);
    await writeFile(join(staged, path), original);
  }
  await put(join(staged, "unlisted"), "dirty output");
  await assert.rejects(verifyOsBase(staged, base.digest, identity), /missing or unexpected/);
  await rm(join(staged, "unlisted"));
  await rm(join(staged, "image-input/Image"));
  await symlink(join(fixture.base, "image-input/Image"), join(staged, "image-input/Image"));
  await assert.rejects(verifyOsBase(staged, base.digest, identity), /symbolic link/);
});

test("publication assembly refuses a bad pin before creating an output tree", async t => {
  const fixture = await createFixture(t);
  await createOsBase(fixture.base, fixture.source, BUILDER);
  const output = join(fixture.root, "assembly-output");
  await assert.rejects(assembleGuestPrograms({ base: fixture.base, pin: `sha256:${"0".repeat(64)}`,
    prebuilt: join(fixture.root, "no-programs"), snapshot: fixture.source, output, builderImageId: BUILDER }), /digest mismatch/);
  await assert.rejects(readFile(join(output, "image-input/rootfs.ext4")), /ENOENT/);
});

test("source modes and retained native source are bound to the base identity", async t => {
  const fixture = await createFixture(t);
  const identity = await describeOsBaseInputs(fixture.source, BUILDER);
  const base = await createOsBase(fixture.base, fixture.source, BUILDER);
  await chmod(join(fixture.source, "desktop/capsule-guest/native/helper.c"), 0o755);
  assert.notDeepEqual(await describeOsBaseInputs(fixture.source, BUILDER), identity);
  await rm(join(fixture.base, "output/legal-info/sources/source.tar"));
  await assert.rejects(verifyOsBase(fixture.base, base.digest, identity), /missing or unexpected/);
});

const hasExt4Tools = ["mke2fs", "debugfs", "e2fsck"].every(command => !spawnSync(command, ["-V"]).error);
test("assembles and reads back Guest programs in a real ext4 image from the same pinned base", { skip: !hasExt4Tools && "e2fsprogs is unavailable on this host" }, async t => {
  const fixture = await createFixture(t);
  const snapshot = join(fixture.root, "snapshot");
  const captured = await createBuildSnapshot(repository, snapshot);
  const tree = join(fixture.root, "rootfs-tree");
  for (const [, target] of GUEST_PROGRAM_FILES) await mkdir(join(tree, dirname(target)), { recursive: true });
  await rm(join(fixture.base, "image-input/rootfs.ext4"));
  const built = spawnSync("mke2fs", ["-q", "-t", "ext4", "-d", tree, join(fixture.base, "image-input/rootfs.ext4"), "32768"], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const base = await createOsBase(fixture.base, snapshot, BUILDER);
  const prebuilt = join(fixture.root, "prebuilt");
  await createPrograms(prebuilt, snapshot, captured.manifestDigest, "first");
  const first = await assembleGuestPrograms({ base: fixture.base, pin: base.digest, prebuilt, snapshot, output: join(fixture.root, "first"), builderImageId: BUILDER });
  await assembleGuestPrograms({ base: fixture.base, pin: base.digest, prebuilt, snapshot, output: join(fixture.root, "repeat"), builderImageId: BUILDER });
  assert.equal(
    digest(await readFile(join(fixture.root, "first/image-input/rootfs.ext4"))),
    digest(await readFile(join(fixture.root, "repeat/image-input/rootfs.ext4"))),
    "identical assembly inputs must produce identical image bytes",
  );
  await createPrograms(prebuilt, snapshot, captured.manifestDigest, "second");
  const second = await assembleGuestPrograms({ base: fixture.base, pin: base.digest, prebuilt, snapshot, output: join(fixture.root, "second"), builderImageId: BUILDER });
  assert.equal(first.osBaseDigest, second.osBaseDigest);
  assert.notEqual(digest(await readFile(join(fixture.root, "first/image-input/rootfs.ext4"))), digest(await readFile(join(fixture.root, "second/image-input/rootfs.ext4"))));
  await verifyOsBase(fixture.base, base.digest, await describeOsBaseInputs(snapshot, BUILDER));
  t.diagnostic(`Synthetic ext4 assembly including verification: first ${first.assemblyMs} ms, second ${second.assemblyMs} ms; no full OS build measured.`);
});

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lamarck-os-base-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const base = join(root, "base");
  for (const path of [...OS_BASE_SOURCE_FILES, "desktop/capsule-guest/buildroot/config", "desktop/capsule-guest/buildroot/Dockerfile", "desktop/capsule-guest/native/helper.c"]) await put(join(source, path), `source ${path}`);
  for (const path of ["image-input/Image", "image-input/rootfs.ext4", "image-input/builder-packages.tsv", "output/legal-info/manifest.csv", "output/legal-info/legal-info.sha256", "output/legal-info/buildroot.config", "output/legal-info/licenses/LICENSE", "output/legal-info/sources/source.tar", "output/legal-info/host-manifest.csv", "output/legal-info/host-licenses/LICENSE", "output/legal-info/host-sources/source.tar", "src/buildroot-2026.05.tar.xz"]) await put(join(base, path), `output ${path}`);
  return { root, source, base };
}
async function put(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode: 0o644 }); }

async function createPrograms(prebuilt, snapshot, snapshotDigest, marker) {
  const outputs = [];
  for (const source of [...new Set(GUEST_PROGRAM_FILES.map(([source]) => source))].sort()) {
    const path = `capsule-guest/dist/${source}`;
    const bytes = Buffer.from(`console.log(${JSON.stringify(marker)});\n`);
    await put(join(prebuilt, path), bytes);
    outputs.push({ path, size: bytes.length, sha256: digest(bytes) });
  }
  const hash = `sha256:${"b".repeat(64)}`;
  await put(join(prebuilt, "js-builder-environment.json"), JSON.stringify({
    schemaVersion: 1, sourceSnapshotManifestDigest: snapshotDigest,
    packageLockSha256: digest(await readFile(join(snapshot, "package-lock.json"))),
    runtime: { nodeVersion: "v24.18.0", nodeExecutableSha256: hash, npmVersion: "11.16.0", npmCliSha256: hash },
    tools: { esbuildVersion: "0.25.12", esbuildPackageSha256: hash, esbuildBinarySha256: hash, typescriptVersion: "5.9.3", typescriptPackageSha256: hash, typescriptCliSha256: hash },
    outputs,
  }));
}
