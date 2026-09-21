import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { desktopReleasePointer, publishDesktopRelease, validateDesktopRelease } from "./desktop-release.mjs";

const bytes = Buffer.from("signed ZIP fixture");
const release = {
  channel: "alpha", version: "0.2.0", file: "Lamarck-0.2.0-macos-arm64.zip",
  signing: "developer-id-notarized", pub_date: "2026-09-18T00:00:00Z",
  sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.length,
};
test("website and native update feed point to the same immutable ZIP", () => {
  const pointer = desktopReleasePointer(release);
  assert.equal(pointer.currentRelease, release.version);
  assert.equal(pointer.releases[0].updateTo.url, pointer.url);
  assert.equal(pointer.releases[0].updateTo.version, release.version);
  assert.match(pointer.url, /\/desktop\/macos\/arm64\/0\.2\.0\/Lamarck-0\.2\.0-macos-arm64.zip$/);
});
test("signed desktop metadata rejects ad-hoc packages and path injection", () => {
  for (const patch of [{ signing: "ad-hoc" }, { channel: "stable" }, { version: "0.2.0-alpha.1" }, { file: "../bad.zip" }, { bytes: 0 }, { sha256: "bad" }]) {
    assert.throws(() => validateDesktopRelease({ ...release, ...patch }));
  }
});
async function fixture(t, { publicBytes = bytes, current = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-publish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, release.file), bytes);
  const writes = [];
  const store = Object.fromEntries(["putFileImmutable", "putBufferImmutable", "putBuffer"].map((method) => [method, async (...args) => writes.push([method, ...args])]));
  const fetchImpl = async (url) => url.endsWith("latest.json")
    ? current ? Response.json(current) : new Response(null, { status: 404 })
    : new Response(publicBytes);
  return { directory, store, fetchImpl, writes };
}
test("both feeds publish after public ZIP verification, with the rollback guard pointer first", async (t) => {
  const context = await fixture(t);
  await publishDesktopRelease({ release, ...context });
  assert.deepEqual(context.writes.map(([method]) => method), ["putFileImmutable", "putBufferImmutable", "putBuffer", "putBuffer"]);
  assert.match(context.writes[2][1], /desktop\/macos\/arm64\/latest.json$/);
  assert.equal(context.writes[2][3].cacheControl, "no-cache");
  assert.match(context.writes[3][1], /desktop\/macos\/arm64\/latest-mac.yml$/);
  assert.equal(context.writes[3][3].cacheControl, "no-cache");
  assert.equal(context.writes[3][2].toString(), `version: 0.2.0\nreleaseDate: "2026-09-18T00:00:00Z"\nfiles:\n  - url: "${desktopReleasePointer(release).url}"\n    sha512: ${createHash("sha512").update(bytes).digest("base64")}\n    size: ${bytes.length}\n`);
});
test("corrupted public download never changes the update pointer", async (t) => {
  const context = await fixture(t, { publicBytes: Buffer.from("corrupt") });
  await assert.rejects(publishDesktopRelease({ release, ...context }), /digest or size mismatch/);
  assert.equal(context.writes.some(([method]) => method === "putBuffer"), false);
});
test("local corruption and accidental rollback fail before uploading", async (t) => {
  const context = await fixture(t);
  await assert.rejects(publishDesktopRelease({ release: { ...release, bytes: 1 }, ...context }), /Local archive/);
  const rollback = await fixture(t, { current: { ...release, version: "0.3.0", file: "Lamarck-0.3.0-macos-arm64.zip" } });
  await assert.rejects(publishDesktopRelease({ release, ...rollback }), /downgrade/);
  assert.equal(context.writes.length + rollback.writes.length, 0);
});
