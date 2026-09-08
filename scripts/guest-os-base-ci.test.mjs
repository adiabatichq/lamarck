import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createOsBase, OS_BASE_SOURCE_FILES } from "../desktop/capsule-guest/scripts/os-base.mjs";
import { downloadVerifiedFile } from "./download-verified-file.mjs";
import { osBaseObjectKey, parseOsBasePin, publishOsBase, restoreOsBase } from "./guest-os-base-ci.mjs";

const BUILDER = `sha256:${"a".repeat(64)}`;
const PIN_PATH = "desktop/capsule-guest/os-base-pin.json";
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("CI publishes and publicly verifies a base with its builder, then restores from the reviewed pin", async t => {
  const f = await fixture(t);
  const pin = await publishOsBase(f.options);
  assert.equal(pin.manifestDigest, f.base.digest);
  assert.deepEqual(JSON.parse(await readFile(join(f.repo, PIN_PATH))), pin);
  assert.deepEqual([...f.objects.keys()], [osBaseObjectKey(pin)]);
  assert.deepEqual(f.calls.map(args => args[1]), ["inspect", "save"]);
  f.calls.length = 0;
  assert.equal(await restoreOsBase(f.options), true);
  assert.deepEqual(f.calls.map(args => args[1]), ["load", "inspect"]);
  const restored = await environment(f.env.GITHUB_ENV);
  assert.equal(restored.LAMARCK_GUEST_OS_BASE_DIGEST, pin.manifestDigest);
  assert.equal(restored.LAMARCK_GUEST_BUILDER_IMAGE_ID, BUILDER);
  assert.equal(digest(await readFile(join(restored.LAMARCK_GUEST_OS_BASE, "os-base-manifest.json"))), pin.manifestDigest);
  const oldCalls = f.calls.length;
  assert.deepEqual(await publishOsBase({ ...f.options, env: { ...f.env, ...restored } }), pin);
  assert.equal(f.calls.length, oldCalls, "reused base must not export or upload a new builder");
});

test("initial release builds fresh; JS-only releases reuse; native input changes select a new base", async t => {
  const f = await fixture(t);
  assert.equal(await restoreOsBase(f.options), false);
  await publishOsBase(f.options);
  await put(join(f.repo, "desktop/capsule-guest/src/supervisor.ts"), "new Guest JavaScript");
  await put(join(f.repo, "desktop/cli/src/operations.ts"), "new business command");
  assert.equal(await restoreOsBase(f.options), true);
  await put(join(f.repo, "desktop/capsule-guest/native/helper.c"), "changed native helper");
  assert.equal(await restoreOsBase({ ...f.options, download: () => assert.fail("must not download stale native base") }), false);
});

test("invalid pins, missing objects and tampered downloads fail without loading a builder or exporting environment", async t => {
  const f = await fixture(t);
  const pin = await publishOsBase(f.options);
  await put(join(f.repo, PIN_PATH), "{}");
  await assert.rejects(restoreOsBase(f.options), /Invalid trusted OS base pin/);
  await put(join(f.repo, PIN_PATH), JSON.stringify(pin));
  const key = osBaseObjectKey(pin);
  const original = f.objects.get(key);
  f.objects.delete(key);
  f.calls.length = 0;
  await assert.rejects(restoreOsBase(f.options), /download failed with 404/);
  f.objects.set(key, Buffer.from("tampered archive"));
  await assert.rejects(restoreOsBase(f.options), /failed verification/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(f.env.GITHUB_ENV), /ENOENT/);
  f.objects.set(key, original);
});

test("a restored builder must have the exact pinned image ID and arm64 platform", async t => {
  const f = await fixture(t);
  await publishOsBase(f.options);
  for (const image of [
    { Id: BUILDER, Os: "linux", Architecture: "amd64" },
    { Id: `sha256:${"b".repeat(64)}`, Os: "linux", Architecture: "arm64" },
  ]) {
    await assert.rejects(restoreOsBase({ ...f.options, docker: async args => args[1] === "load" ? ""
      : JSON.stringify([image]) }), /builder identity mismatch/);
  }
  await assert.rejects(readFile(f.env.GITHUB_ENV), /ENOENT/);
});

test("a base pin is not proposed when public verification fails", async t => {
  const f = await fixture(t);
  await assert.rejects(publishOsBase({ ...f.options, download: async () => { throw new Error("public verification failed"); } }), /public verification failed/);
  await assert.rejects(readFile(join(f.repo, PIN_PATH)), /ENOENT/);
});

test("pin paths are derived from bounded exact metadata; CI restores before building and proposes both pins", async () => {
  for (const value of [null, {}, { schemaVersion: 2 }]) assert.throws(() => parseOsBasePin(value), /Invalid/);
  const workflow = await readFile(new URL("../.github/workflows/guest-release.yml", import.meta.url), "utf8");
  assert(workflow.indexOf("node scripts/guest-os-base-ci.mjs restore") < workflow.indexOf("run: npm run capsule-guest:image"));
  assert(workflow.indexOf("node scripts/guest-os-base-ci.mjs publish") > workflow.indexOf("Verify Guest descriptor with Desktop Host"));
  assert.match(workflow, /path: \|\s+desktop\/capsule-guest\/release-pin\.json\s+desktop\/capsule-guest\/os-base-pin\.json/);
  assert.match(workflow, /cp release-handoff\/guest-pin\/os-base-pin\.json/);
});

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), "lamarck-ci-base-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  for (const path of [...OS_BASE_SOURCE_FILES, "desktop/capsule-guest/buildroot/config", "desktop/capsule-guest/native/helper.c"]) await put(join(repo, path), `source ${path}`);
  const work = join(repo, ".lamarck/build/capsule-guest");
  const raw = join(work, "raw-base");
  for (const path of ["image-input/Image", "image-input/rootfs.ext4", "image-input/builder-packages.tsv", "output/legal-info/manifest.csv", "output/legal-info/legal-info.sha256", "output/legal-info/buildroot.config", "output/legal-info/licenses/LICENSE", "output/legal-info/sources/source.tar", "output/legal-info/host-manifest.csv", "output/legal-info/host-licenses/LICENSE", "output/legal-info/host-sources/source.tar", "src/buildroot-2026.05.tar.xz"]) await put(join(raw, path), `output ${path}`);
  const base = await createOsBase(raw, repo, BUILDER);
  await mkdir(join(work, "os-bases"));
  await rename(raw, join(work, "os-bases", base.digest.slice(7)));
  await put(join(work, "release/capsule-guest-arm64/compliance/os-base-manifest.json"), `${JSON.stringify(base.manifest)}\n`);
  const env = { GITHUB_ENV: join(repo, "workflow-env"), SOURCE_DATE_EPOCH: "0", JOBS: "4", RELEASES_PUBLIC_BASE: "https://releases.example.test" };
  const objects = new Map();
  const calls = [];
  const options = {
    repo, env,
    store: { putFileImmutable: async (key, file) => { assert(!objects.has(key)); objects.set(key, await readFile(file)); } },
    download: args => downloadVerifiedFile({ ...args, attempts: 1, fetchImpl: async url => {
      const bytes = objects.get(new URL(url).pathname.slice(1));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    } }),
    docker: async args => {
      calls.push(args);
      if (args[1] === "inspect") return JSON.stringify([{ Id: BUILDER, Os: "linux", Architecture: "arm64" }]);
      if (args[1] === "save") await writeFile(args[3], "pinned Docker image archive");
      if (args[1] === "load") assert.equal(await readFile(args[3], "utf8"), "pinned Docker image archive");
      return "";
    },
  };
  return { repo, env, base, objects, calls, options };
}
async function put(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
async function environment(path) { return Object.fromEntries((await readFile(path, "utf8")).trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])); }
