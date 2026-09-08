#!/usr/bin/env node

// The existing protected Guest release workflow carries a reviewed base pin
// through Git and stores the base plus its exact builder in the existing R2 bucket.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeOsBaseInputs, verifyOsBase, OS_BASE_MANIFEST } from "../desktop/capsule-guest/scripts/os-base.mjs";
import { BUNDLE_NAME, sha256File } from "../desktop/capsule-guest/scripts/release-contract.mjs";
import { downloadVerifiedFile } from "./download-verified-file.mjs";
import { r2StoreFromEnvironment } from "./r2-object-store.mjs";

const PIN_PATH = "desktop/capsule-guest/os-base-pin.json";
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const isDigest = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const workRoot = repo => join(repo, ".lamarck/build/capsule-guest");
const exactKeys = (value, keys) => value && Object.keys(value).sort().join(",") === keys;

export function parseOsBasePin(pin) {
  if (!exactKeys(pin, "archive,builderImageId,identityDigest,manifestDigest,schemaVersion") || pin.schemaVersion !== 1
    || ![pin.manifestDigest, pin.identityDigest, pin.builderImageId].every(isDigest)
    || !exactKeys(pin.archive, "bytes,sha256") || !isDigest(pin.archive.sha256)
    || !Number.isSafeInteger(pin.archive.bytes) || pin.archive.bytes < 1 || pin.archive.bytes > 16 * 1024 ** 3) {
    throw new Error("Invalid trusted OS base pin");
  }
  return pin;
}

export function osBaseObjectKey(pin) {
  parseOsBasePin(pin);
  return `guest/os-base/arm64/${pin.manifestDigest.slice(7)}/${pin.archive.sha256.slice(7)}.tar.gz`;
}

/** Only absence of a pin or changed native inputs selects a fresh build. */
export async function restoreOsBase({ repo, env = process.env, download = downloadVerifiedFile, docker = runDocker }) {
  let pin;
  try { pin = parseOsBasePin(JSON.parse(await readFile(join(repo, PIN_PATH), "utf8"))); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log("[guest-base] No reviewed pin yet; building the initial OS base");
    return false;
  }
  const identity = await describeOsBaseInputs(repo, pin.builderImageId, env.SOURCE_DATE_EPOCH ?? "0", env.JOBS ?? "4");
  if (digest(JSON.stringify(identity)) !== pin.identityDigest) {
    console.log("[guest-base] Native inputs changed; building and proposing a new OS base");
    return false;
  }
  await mkdir(workRoot(repo), { recursive: true });
  const stage = await mkdtemp(join(workRoot(repo), "ci-base-"));
  try {
    const archive = join(stage, "base.tar.gz");
    await download(downloadOptions(pin, archive, env));
    const unpacked = join(stage, "unpacked");
    await mkdir(unpacked, { mode: 0o700 });
    // The complete archive is size/digest-verified against the reviewed Git pin
    // before tar or Docker sees it. It contains only base files and docker save.
    run("tar", ["-xzpf", archive, "--no-same-owner", "-C", unpacked]);
    const baseName = pin.manifestDigest.slice(7);
    if ((await readdir(unpacked)).sort().join(",") !== [baseName, "builder.tar"].sort().join(",")) throw new Error("Unexpected OS base archive entries");
    const base = join(unpacked, baseName);
    await verifyOsBase(base, pin.manifestDigest, identity);
    await docker(["image", "load", "--input", join(unpacked, "builder.tar")]);
    await verifyBuilder(docker, pin.builderImageId);
    if (!env.GITHUB_ENV) throw new Error("OS base restore requires the workflow environment file");
    if (/[\r\n\0]/.test(base)) throw new Error("Invalid OS base staging path");
    await appendFile(env.GITHUB_ENV, `LAMARCK_GUEST_OS_BASE=${base}\nLAMARCK_GUEST_OS_BASE_DIGEST=${pin.manifestDigest}\nLAMARCK_GUEST_BUILDER_IMAGE_ID=${pin.builderImageId}\n`);
    await rm(archive);
    await rm(join(unpacked, "builder.tar"));
    console.log(`[guest-base] Restored verified base ${pin.manifestDigest} and builder ${pin.builderImageId}`);
    return true;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/** Run only after the normal complete-image verification and boot gate. */
export async function publishOsBase({ repo, env = process.env, store, download = downloadVerifiedFile, docker = runDocker }) {
  const manifestPath = join(workRoot(repo), "release", BUNDLE_NAME, "compliance", OS_BASE_MANIFEST);
  const manifestBytes = await readFile(manifestPath);
  const manifestDigest = digest(manifestBytes);
  const { identity } = JSON.parse(manifestBytes);
  const expected = await describeOsBaseInputs(repo, identity.builderImageId, env.SOURCE_DATE_EPOCH ?? "0", env.JOBS ?? "4");
  const base = env.LAMARCK_GUEST_OS_BASE ?? join(workRoot(repo), "os-bases", manifestDigest.slice(7));
  await verifyOsBase(base, manifestDigest, expected);
  if (env.LAMARCK_GUEST_OS_BASE) {
    const pin = parseOsBasePin(JSON.parse(await readFile(join(repo, PIN_PATH), "utf8")));
    if (pin.manifestDigest !== manifestDigest || pin.identityDigest !== digest(JSON.stringify(expected))
      || pin.builderImageId !== expected.builderImageId) throw new Error("Released Guest does not match the restored base pin");
    console.log(`[guest-base] Retaining reviewed pin ${manifestDigest}; no base upload needed`);
    return pin;
  }
  await verifyBuilder(docker, identity.builderImageId);
  const stage = await mkdtemp(join(workRoot(repo), "ci-base-publish-"));
  try {
    await docker(["image", "save", "--output", join(stage, "builder.tar"), identity.builderImageId]);
    const archive = join(stage, "base.tar.gz");
    run("tar", ["-czf", archive, "-C", dirname(base), basename(base), "-C", stage, "builder.tar"]);
    await verifyOsBase(base, manifestDigest, expected);
    const pin = parseOsBasePin({ schemaVersion: 1, manifestDigest, builderImageId: identity.builderImageId,
      identityDigest: digest(JSON.stringify(expected)),
      archive: { bytes: (await stat(archive)).size, sha256: `sha256:${await sha256File(archive)}` } });
    store ??= r2StoreFromEnvironment(env.R2_RELEASES_BUCKET ?? "lamarck-desktop-releases-prod");
    await store.putFileImmutable(osBaseObjectKey(pin), archive, {
      contentType: "application/gzip", cacheControl: "public, max-age=31536000, immutable",
    });
    // Do not propose a pin until the exact artifact is readable publicly.
    await download(downloadOptions(pin, join(stage, "public-verification.tar.gz"), env));
    await writeFile(join(repo, PIN_PATH), `${JSON.stringify(pin, null, 2)}\n`);
    console.log(`[guest-base] Published ${manifestDigest}; proposing ${PIN_PATH} for review`);
    return pin;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

function downloadOptions(pin, target, env) {
  const origin = new URL(env.RELEASES_PUBLIC_BASE ?? "https://releases.lamarck.ai");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("Invalid releases public origin");
  return { url: new URL(osBaseObjectKey(pin), origin).href, target, label: "pinned OS base and builder",
    expectedBytes: pin.archive.bytes, expectedSha256: pin.archive.sha256.slice(7) };
}
async function verifyBuilder(docker, id) {
  const value = JSON.parse(await docker(["image", "inspect", id]));
  if (!Array.isArray(value) || value.length !== 1 || value[0].Id !== id
    || value[0].Os !== "linux" || value[0].Architecture !== "arm64") throw new Error("Restored OS builder identity mismatch");
}
function runDocker(args) { return run("docker", args); }
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv[2] === "restore") await restoreOsBase({ repo });
  else if (process.argv[2] === "publish") await publishOsBase({ repo });
  else throw new Error("usage: guest-os-base-ci.mjs restore|publish");
}
