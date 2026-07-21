#!/usr/bin/env node

// Publishes one alpha desktop build to the R2 releases bucket.
//
// Object layout (all writes this script performs):
//   desktop/macos/arm64/alpha/<version>/Lamarck-Alpha-<version>-macos-arm64.zip
//   desktop/macos/arm64/alpha/<version>/SHA256SUMS
//   desktop/macos/arm64/alpha/latest.json        <- the only mutable pointer,
//                                                   written last, after the
//                                                   archive is re-downloaded
//                                                   from the public domain and
//                                                   its digest verified
//
// Version paths are immutable: a retry keeps byte-identical objects and
// rejects conflicting bytes. Roll back by pointing latest.json at an older
// version.
//
//   node scripts/publish-alpha.mjs [--dir .lamarck/build/alpha]

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { hashFile, r2StoreFromEnvironment } from "./r2-object-store.mjs";

const CHANNEL_PREFIX = "desktop/macos/arm64/alpha";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const POINTER_CACHE = "no-cache";

const bucket = process.env.R2_RELEASES_BUCKET ?? "lamarck-desktop-releases-prod";
const publicBase = validatedPublicBase(process.env.RELEASES_PUBLIC_BASE ?? "https://releases.lamarck.ai");
const directoryArgIndex = process.argv.indexOf("--dir");
const directory = resolve(
  directoryArgIndex >= 0 ? process.argv[directoryArgIndex + 1] : ".lamarck/build/alpha",
);

const versionArgIndex = process.argv.indexOf("--version");
const requestedVersion = versionArgIndex >= 0 ? process.argv[versionArgIndex + 1] : null;
let releaseDocuments = (await readdir(directory)).filter((name) => name.endsWith(".release.json"));
if (requestedVersion) {
  releaseDocuments = releaseDocuments.filter((name) => name === `Lamarck-Alpha-${requestedVersion}.release.json`);
}
if (releaseDocuments.length !== 1) {
  throw new Error(
    `expected exactly one matching *.release.json in ${directory}; found ${releaseDocuments.length}`
      + (requestedVersion ? "" : " (disambiguate with --version <x.y.z-alpha.tag>)"),
  );
}
const release = JSON.parse(await readFile(join(directory, releaseDocuments[0]), "utf8"));
if (
  release.channel !== "alpha"
  || !/^\d+\.\d+\.\d+-alpha(?:\.[A-Za-z0-9]+)?$/.test(release.version ?? "")
  || !/^[A-Za-z0-9.-]+\.zip$/.test(release.file ?? "")
  || !/^sha256:[a-f0-9]{64}$/.test(release.sha256 ?? "")
  || !Number.isSafeInteger(release.bytes)
  || release.bytes < 1
  || release.bytes > 8 * 1024 * 1024 * 1024
  || typeof release.pub_date !== "string"
  || !Number.isFinite(Date.parse(release.pub_date))
) throw new Error(`${releaseDocuments[0]} is not a valid alpha release document`);

const archivePath = join(directory, release.file);
const expectedSha256 = release.sha256.slice("sha256:".length);
const local = await hashFile(archivePath);
if (local.sha256 !== expectedSha256 || local.size !== release.bytes) {
  throw new Error("local archive does not match its release document");
}

const store = r2StoreFromEnvironment(bucket);
const versionPrefix = `${CHANNEL_PREFIX}/${release.version}`;
const archiveKey = `${versionPrefix}/${release.file}`;
const sumsKey = `${versionPrefix}/SHA256SUMS`;
const pointerKey = `${CHANNEL_PREFIX}/latest.json`;

const archiveResult = await store.putFileImmutable(archiveKey, archivePath, {
  contentType: "application/zip",
  cacheControl: IMMUTABLE_CACHE,
});
console.log(`[publish] ${archiveResult.uploaded ? "PUT" : "KEEP"} ${archiveKey} (${release.bytes} bytes)`);
const sumsResult = await store.putBufferImmutable(
  sumsKey,
  Buffer.from(`${expectedSha256}  ${release.file}\n`, "utf8"),
  {
    contentType: "text/plain; charset=utf-8",
    cacheControl: IMMUTABLE_CACHE,
  },
);
console.log(`[publish] ${sumsResult.uploaded ? "PUT" : "KEEP"} ${sumsKey}`);

const publicUrl = `${publicBase}/${archiveKey}`;
console.log(`[publish] Verifying public download ${publicUrl}`);
const download = await fetchWithRetry(publicUrl);
if (!download.body) throw new Error("public download response has no body");
const digest = createHash("sha256");
let downloadedBytes = 0;
for await (const chunk of download.body) {
  digest.update(chunk);
  downloadedBytes += chunk.byteLength;
}
if (digest.digest("hex") !== expectedSha256 || downloadedBytes !== release.bytes) {
  throw new Error("public download does not match the published archive digest");
}

const pointer = {
  channel: "alpha",
  version: release.version,
  file: release.file,
  url: publicUrl,
  sha256: release.sha256,
  bytes: release.bytes,
  pub_date: release.pub_date,
};
console.log(`[publish] PUT ${pointerKey}`);
await store.putBuffer(pointerKey, Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, "utf8"), {
  contentType: "application/json",
  cacheControl: POINTER_CACHE,
});

console.log(`[publish] Published ${release.version}; latest.json now points at ${publicUrl}`);

function validatedPublicBase(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) throw new Error("RELEASES_PUBLIC_BASE must be a public HTTPS origin or path");
  return url.toString().replace(/\/$/, "");
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
    } catch (error) {
      lastError = error;
    }
    if (response?.ok) return response;
    if (response) {
      lastError = new Error(`public download failed with ${response.status}`);
      await response.body?.cancel();
      if (![408, 429].includes(response.status) && response.status < 500) throw lastError;
    }
    if (attempt < 4) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * (2 ** (attempt - 1))));
  }
  throw lastError ?? new Error("public download failed");
}
