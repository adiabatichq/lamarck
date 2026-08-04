#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryOrigin = "https://registry.npmjs.org";
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stableCaretPattern = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!isStableVersion(version)) {
    throw new Error("Usage: node scripts/update-system-sdk-consumers.mjs <stable-version>");
  }
  const release = await fetchPublishedRelease(version);
  const consumerDirectories = await discoverConsumerDirectories({
    appsDirectory: join(root, "apps"),
    scaffoldDirectory: join(root, "desktop", "core", "scaffolds", "app-v1"),
  });
  const changed = await updateConsumerLocks({
    consumerDirectories,
    release,
  });
  if (changed.length === 0) {
    process.stdout.write(`First-party App consumer locks already use @lamarck/system ${version}\n`);
  } else {
    process.stdout.write(`Updated @lamarck/system ${version} in:\n${changed.join("\n")}\n`);
  }
}

export async function fetchPublishedRelease(version, fetchImpl = fetch) {
  if (!isStableVersion(version)) throw new Error(`Invalid stable SDK version: ${version}`);
  const metadataUrl = `${registryOrigin}/@lamarck%2fsystem/${version}`;
  const response = await fetchImpl(metadataUrl, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`npm registry metadata request failed with ${response.status}`);
  }
  const metadata = await response.json();
  const resolved = `${registryOrigin}/@lamarck/system/-/system-${version}.tgz`;
  if (
    metadata?.name !== "@lamarck/system"
    || metadata?.version !== version
    || metadata?.dist?.tarball !== resolved
    || !isSha512Integrity(metadata?.dist?.integrity)
  ) {
    throw new Error(`npm registry returned invalid @lamarck/system ${version} metadata`);
  }
  if (metadata.dependencies && Object.keys(metadata.dependencies).length > 0) {
    throw new Error("App consumer lock updater requires @lamarck/system to have no runtime dependencies");
  }
  return {
    version,
    resolved,
    integrity: metadata.dist.integrity,
    engines: normalizeEngines(metadata.engines),
  };
}

export async function discoverConsumerDirectories({ appsDirectory, scaffoldDirectory }) {
  let entries;
  try {
    entries = await readdir(appsDirectory, { withFileTypes: true });
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    entries = [];
  }
  const appDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(appsDirectory, entry.name))
    .sort();
  return [...appDirectories, scaffoldDirectory];
}

export async function updateConsumerLocks({ consumerDirectories, release }) {
  validateRelease(release);
  if (!Array.isArray(consumerDirectories) || consumerDirectories.length < 1) {
    throw new Error("No first-party App consumers found");
  }

  const updates = [];
  for (const appDirectory of consumerDirectories) {
    const appId = appDirectory.split(/[\\/]/).at(-1);
    if (!appId) throw new Error("Invalid App consumer directory");
    const packageDocument = await readJson(join(appDirectory, "package.json"));
    const lockPath = join(appDirectory, "package-lock.json");
    const lock = await readJson(lockPath);
    const declaredRange = packageDocument.dependencies?.["@lamarck/system"];
    if (!stableVersionSatisfiesCaret(release.version, declaredRange)) {
      throw new Error(`${appId} does not declare a compatible SDK range for ${release.version}`);
    }
    if (lock.packages?.[""]?.dependencies?.["@lamarck/system"] !== declaredRange) {
      throw new Error(`${appId} package-lock root does not match package.json`);
    }

    const nextEntry = {
      version: release.version,
      resolved: release.resolved,
      integrity: release.integrity,
      ...(release.engines ? { engines: release.engines } : {}),
    };
    const currentEntry = lock.packages?.["node_modules/@lamarck/system"];
    if (JSON.stringify(currentEntry) === JSON.stringify(nextEntry)) continue;
    lock.packages["node_modules/@lamarck/system"] = nextEntry;
    updates.push({ lockPath, bytes: `${JSON.stringify(lock, null, 2)}\n` });
  }

  for (const update of updates) await writeFile(update.lockPath, update.bytes, "utf8");
  return updates.map((update) => update.lockPath);
}

function validateRelease(release) {
  if (!release || !isStableVersion(release.version)) throw new Error("Invalid SDK release version");
  const expectedResolved = `${registryOrigin}/@lamarck/system/-/system-${release.version}.tgz`;
  if (release.resolved !== expectedResolved) throw new Error("Invalid SDK release tarball URL");
  if (!isSha512Integrity(release.integrity)) throw new Error("Invalid SDK release integrity");
  normalizeEngines(release.engines);
}

function normalizeEngines(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid SDK engines metadata");
  }
  const entries = Object.entries(value);
  if (entries.some(([key, entry]) => !key || typeof entry !== "string")) {
    throw new Error("Invalid SDK engines metadata");
  }
  return Object.fromEntries(entries);
}

function isSha512Integrity(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value.slice("sha512-".length), "base64").byteLength === 64;
}

function isStableVersion(value) {
  return typeof value === "string" && stableVersionPattern.test(value);
}

function isNodeError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

function stableVersionSatisfiesCaret(version, range) {
  if (typeof range !== "string") return false;
  const versionMatch = stableVersionPattern.exec(version);
  const rangeMatch = stableCaretPattern.exec(range);
  if (!versionMatch || !rangeMatch) return false;
  const current = versionMatch.slice(1).map(Number);
  const minimum = rangeMatch.slice(1).map(Number);
  if (compareVersions(current, minimum) < 0) return false;
  if (minimum[0] > 0) return current[0] === minimum[0];
  if (minimum[1] > 0) return current[0] === 0 && current[1] === minimum[1];
  return current[0] === 0 && current[1] === 0 && current[2] === minimum[2];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
