#!/usr/bin/env node

// Uploads a signed Capsule Guest release to the R2 releases bucket under a
// digest-addressed, immutable prefix, and records the pin the desktop alpha
// workflow builds against. A retry keeps byte-identical objects and rejects
// a conflicting object under the same prefix.
//
// Object layout (all writes this script performs):
//   guest/macos/arm64/<manifest digest, first 16 hex>/<every file of the
//     release tree: capsule-guest-release.json, capsule-guest-arm64/...,
//     and the separately downloadable corresponding-source archive>
//   guest/macos/arm64/<digest16>/files.json   <- upload inventory, written
//                                                last; its presence marks the
//                                                prefix complete
//
// Also writes desktop/capsule-guest/release-pin.json locally; commit that
// file so CI consumes exactly this guest release.
//
//   node scripts/upload-guest-release.mjs [source-release-dir]

import { readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  GUEST_RELEASE_PREFIX,
  validateGuestRelease,
} from "../desktop/capsule-guest/scripts/release-contract.mjs";
import { r2StoreFromEnvironment } from "./r2-object-store.mjs";

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

const root = resolve(new URL("..", import.meta.url).pathname);
const source = resolve(process.argv[2] ?? join(root, ".lamarck", "build", "capsule-guest", "release"));
const bucket = process.env.R2_RELEASES_BUCKET ?? "lamarck-desktop-releases-prod";

const { descriptor, manifest } = await validateGuestRelease(source, {
  requireSourceArchive: true,
});
const digest = descriptor.manifestDigest;
if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
  throw new Error("guest release descriptor has no valid manifest digest");
}
const objectPrefix =
  `${GUEST_RELEASE_PREFIX}/${digest.slice("sha256:".length, "sha256:".length + 16)}`;

const store = r2StoreFromEnvironment(bucket);
const inventoryKey = `${objectPrefix}/files.json`;

const files = [];
await collectFiles(source, files);
files.sort((left, right) => left.localeCompare(right, "en"));
if (files.length === 0) throw new Error("guest release tree is empty");

const inventory = [];
for (const relativePath of files) {
  const key = `${objectPrefix}/${relativePath}`;
  const uploaded = await store.putFileImmutable(key, join(source, relativePath), {
    contentType: relativePath === descriptor.correspondingSource?.file
      ? descriptor.correspondingSource.mediaType
      : "application/octet-stream",
    cacheControl: IMMUTABLE_CACHE,
  });
  console.log(`[guest] ${uploaded.uploaded ? "PUT" : "KEEP"} ${key}`);
  const { sha256, size } = uploaded;
  inventory.push({ path: relativePath, sha256, size });
}
const inventoryBytes = Buffer.from(
  `${JSON.stringify({ schemaVersion: 1, manifestDigest: digest, files: inventory }, null, 2)}\n`,
  "utf8",
);
const inventoryResult = await store.putBufferImmutable(
  inventoryKey,
  inventoryBytes,
  { contentType: "application/json", cacheControl: IMMUTABLE_CACHE },
);
console.log(`[guest] ${inventoryResult.uploaded ? "PUT" : "KEEP"} ${inventoryKey}`);

const pinPath = join(root, "desktop", "capsule-guest", "release-pin.json");
await writeFile(pinPath, `${JSON.stringify({
  schemaVersion: descriptor.schemaVersion,
  imageVersion: manifest.imageVersion,
  manifestDigest: digest,
  inventorySha256: `sha256:${inventoryResult.sha256}`,
  objectPrefix,
  ...(descriptor.correspondingSource
    ? { correspondingSource: descriptor.correspondingSource }
    : {}),
}, null, 2)}\n`, "utf8");
console.log(`[guest] Wrote ${pinPath}; commit it so CI builds against this release`);

async function collectFiles(directory, result, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) {
      throw new Error(`guest release contains an unsupported file name: ${relativePath}`);
    }
    if (entry.isDirectory()) await collectFiles(join(directory, entry.name), result, relativePath);
    else if (entry.isFile()) result.push(relativePath);
    else throw new Error(`guest release contains an unsupported entry: ${relativePath}`);
  }
}
