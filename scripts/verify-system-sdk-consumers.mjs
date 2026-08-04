#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { discoverConsumerDirectories } from "./update-system-sdk-consumers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stableCaretPattern = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sdkPackage = await readJson(join(root, "desktop", "system-sdk", "package.json"));
const corePackage = await readJson(join(root, "desktop", "core", "package.json"));
const violations = [];

if (corePackage.dependencies?.["@lamarck/system"] !== sdkPackage.version) {
  violations.push(`desktop/core must depend on exact @lamarck/system ${sdkPackage.version}`);
}

const appsDirectory = join(root, "apps");
const appDirectories = await discoverConsumerDirectories({
  appsDirectory,
  scaffoldDirectory: join(root, "desktop", "core", "scaffolds", "app-v1"),
});
if (appDirectories.length < 1) violations.push("repository has no first-party App consumers to verify");

let canonicalRange;
let canonicalEntry;
let canonicalAppId;
for (const appDirectory of appDirectories) {
  const appId = appDirectory.split(/[\\/]/).at(-1);
  const appPackage = await readJson(join(appDirectory, "package.json"));
  const lock = await readJson(join(appDirectory, "package-lock.json"));
  const declaredRange = appPackage.dependencies?.["@lamarck/system"];
  const lockRange = lock.packages?.[""]?.dependencies?.["@lamarck/system"];
  const sdkEntry = lock.packages?.["node_modules/@lamarck/system"];

  if (!isCanonicalCaretRange(declaredRange)) {
    violations.push(`${appId} package.json must declare a stable caret range for @lamarck/system`);
  }
  if (lockRange !== declaredRange) {
    violations.push(`${appId} package-lock root must match its package.json SDK range`);
  }
  if (!isValidLockedSdkEntry(sdkEntry, declaredRange)) {
    violations.push(`${appId} package-lock has an invalid @lamarck/system registry entry`);
  }

  if (canonicalRange === undefined) {
    canonicalRange = declaredRange;
    canonicalEntry = sdkEntry;
    canonicalAppId = appId;
  } else {
    if (declaredRange !== canonicalRange) {
      violations.push(`${appId} and ${canonicalAppId} must declare the same SDK range`);
    }
    if (!isDeepStrictEqual(sdkEntry, canonicalEntry)) {
      violations.push(`${appId} and ${canonicalAppId} must pin the same SDK registry entry`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(`System SDK consumer alignment failed:\n- ${violations.join("\n- ")}`);
}

process.stdout.write(
  `Core uses @lamarck/system ${sdkPackage.version}; ${appDirectories.length} App consumers share ${canonicalRange}\n`,
);

function isCanonicalCaretRange(value) {
  return typeof value === "string" && stableCaretPattern.test(value);
}

function isValidLockedSdkEntry(entry, range) {
  if (!entry || typeof entry !== "object" || !isCanonicalCaretRange(range)) return false;
  if (!stableVersionSatisfiesCaret(entry.version, range)) return false;
  if (entry.resolved !== `https://registry.npmjs.org/@lamarck/system/-/system-${entry.version}.tgz`) {
    return false;
  }
  return isSha512Integrity(entry.integrity);
}

function stableVersionSatisfiesCaret(version, range) {
  if (typeof version !== "string") return false;
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

function isSha512Integrity(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value.slice("sha512-".length), "base64").byteLength === 64;
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
