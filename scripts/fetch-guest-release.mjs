#!/usr/bin/env node

// Downloads the pinned Capsule Guest runtime from the public releases domain
// into .lamarck/build/capsule-guest/release, verifying the pinned inventory,
// every downloaded file, and the pinned manifest digest. The separately
// downloadable source archive is fetched only with --include-source. Read-only
// against R2 — no credentials involved.
//
//   node scripts/fetch-guest-release.mjs [--pin path] [--destination path]
//     [--include-source]

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateGuestRelease } from "../desktop/capsule-guest/scripts/release-contract.mjs";
import { downloadVerifiedFile } from "./download-verified-file.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const publicBase = validatedPublicBase(process.env.RELEASES_PUBLIC_BASE ?? "https://releases.lamarck.ai");
const pinPath = resolve(option("--pin") ?? join(root, "desktop", "capsule-guest", "release-pin.json"));
const destination = resolve(
  option("--destination") ?? join(root, ".lamarck", "build", "capsule-guest", "release"),
);
const includeSource = process.argv.includes("--include-source");

const pin = JSON.parse(await readFile(pinPath, "utf8"));
if (
  pin.schemaVersion !== 1
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pin.imageVersion ?? "")
  || !/^sha256:[a-f0-9]{64}$/.test(pin.manifestDigest ?? "")
  || !/^sha256:[a-f0-9]{64}$/.test(pin.inventorySha256 ?? "")
  || !/^guest\/[a-z0-9/-]+\/[a-f0-9]{16}$/.test(pin.objectPrefix ?? "")
) throw new Error(`${pinPath} is not a valid guest pin`);
const correspondingSource = validateCorrespondingSource(
  pin.correspondingSource,
  pin,
  publicBase,
);

if (existsSync(destination)) {
  try {
    const existing = await validateGuestRelease(destination, {
      requireSourceArchive: includeSource,
    });
    if (
      existing.descriptor.manifestDigest === pin.manifestDigest
      && correspondingSourceMatches(existing.descriptor.correspondingSource, correspondingSource)
    ) {
      console.log(`[guest] Pinned release already present at ${destination}`);
      process.exit(0);
    }
  } catch {}
  throw new Error(`${destination} holds a different guest release; remove it first`);
}

const inventoryResponse = await fetchWithRetry(`${publicBase}/${pin.objectPrefix}/files.json`, "guest inventory");
const inventoryBytes = Buffer.from(await inventoryResponse.arrayBuffer());
if (inventoryBytes.byteLength < 2 || inventoryBytes.byteLength > 16 * 1024 * 1024) {
  throw new Error("guest inventory has an invalid size");
}
if (`sha256:${createHash("sha256").update(inventoryBytes).digest("hex")}` !== pin.inventorySha256) {
  throw new Error("guest inventory does not match its pinned digest");
}
const inventoryDocument = JSON.parse(inventoryBytes.toString("utf8"));
if (inventoryDocument.schemaVersion !== 1 || inventoryDocument.manifestDigest !== pin.manifestDigest) {
  throw new Error("guest inventory does not match the pinned manifest digest");
}
const files = inventoryDocument.files;
if (!Array.isArray(files) || files.length === 0 || files.length > 100_000) {
  throw new Error("guest inventory has an invalid file count");
}

const staging = `${destination}.download-${process.pid}`;
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
try {
  const paths = new Set();
  let aggregateBytes = 0;
  let sourceInventoryEntry;
  for (const entry of files) {
    if (
      typeof entry.path !== "string"
      || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(entry.path)
      || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
      || !Number.isInteger(entry.size)
      || entry.size < 0
      || entry.size > 8 * 1024 * 1024 * 1024
    ) throw new Error(`guest inventory entry is invalid: ${JSON.stringify(entry)}`);
    if (paths.has(entry.path)) throw new Error(`guest inventory repeats a path: ${entry.path}`);
    paths.add(entry.path);
    aggregateBytes += entry.size;
    if (aggregateBytes > 16 * 1024 * 1024 * 1024) throw new Error("guest inventory is too large");
    if (entry.path === correspondingSource?.file) {
      if (
        entry.size !== correspondingSource.bytes
        || `sha256:${entry.sha256}` !== correspondingSource.sha256
      ) {
        throw new Error("guest source archive does not match the pinned metadata");
      }
      sourceInventoryEntry = entry;
      if (!includeSource) continue;
    }
    const target = join(staging, entry.path);
    await mkdir(dirname(target), { recursive: true });
    console.log(`[guest] GET ${entry.path} (${entry.size} bytes)`);
    await downloadVerifiedFile({
      url: `${publicBase}/${pin.objectPrefix}/${entry.path}`,
      label: `guest file ${entry.path}`,
      target,
      expectedBytes: entry.size,
      expectedSha256: entry.sha256,
    });
  }
  if (correspondingSource && !sourceInventoryEntry) {
    throw new Error("guest inventory omits the pinned source archive");
  }
  const staged = await validateGuestRelease(staging, {
    requireSourceArchive: includeSource,
  });
  if (staged.descriptor.manifestDigest !== pin.manifestDigest) {
    throw new Error("downloaded guest release does not match the pinned manifest digest");
  }
  if (!correspondingSourceMatches(staged.descriptor.correspondingSource, correspondingSource)) {
    throw new Error("downloaded guest source offer does not match the repository pin");
  }
  await mkdir(dirname(destination), { recursive: true });
  await rename(staging, destination);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}
console.log(`[guest] Pinned release ready at ${destination}`);

function validateCorrespondingSource(value, pinValue, base) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pinPath} has no valid corresponding-source metadata`);
  }
  const expectedUrl = `${base}/${pinValue.objectPrefix}/${value.file}`;
  if (
    value.imageVersion !== pinValue.imageVersion
    || typeof value.file !== "string"
    || !/^Lamarck-Capsule-Guest-[A-Za-z0-9._-]+-Open-Source\.tar\.gz$/.test(value.file)
    || value.file !== `Lamarck-Capsule-Guest-${value.imageVersion}-Open-Source.tar.gz`
    || value.url !== expectedUrl
    || !/^sha256:[a-f0-9]{64}$/.test(value.sha256 ?? "")
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1
    || value.bytes > 8 * 1024 * 1024 * 1024
    || value.mediaType !== "application/gzip"
    || value.format !== "tar+gzip"
  ) throw new Error(`${pinPath} has invalid corresponding-source metadata`);
  return value;
}

function correspondingSourceMatches(actual, expected) {
  if (!actual || !expected) return actual === undefined && expected === undefined;
  return [
    "imageVersion",
    "file",
    "url",
    "sha256",
    "bytes",
    "mediaType",
    "format",
  ].every((field) => actual[field] === expected[field]);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--") || process.argv.indexOf(name, index + 1) >= 0) {
    throw new Error(`${name} requires exactly one value`);
  }
  return value;
}

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

async function fetchWithRetry(url, label) {
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
      lastError = new Error(`${label} download failed with ${response.status}`);
      await response.body?.cancel();
      if (![408, 429].includes(response.status) && response.status < 500) throw lastError;
    }
    if (attempt < 4) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * (2 ** (attempt - 1))));
  }
  throw lastError ?? new Error(`${label} download failed`);
}
