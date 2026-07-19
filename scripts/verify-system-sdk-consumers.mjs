#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkPackage = await readJson(join(root, "desktop", "system-sdk", "package.json"));
const expectedVersion = sdkPackage.version;
const expectedRange = `^${expectedVersion}`;
const expectedResolved = `https://registry.npmjs.org/@lamarck/system/-/system-${expectedVersion}.tgz`;
const integrity = await packIntegrity();
const violations = [];

const corePackage = await readJson(join(root, "desktop", "core", "package.json"));
if (corePackage.dependencies?.["@lamarck/system"] !== expectedVersion) {
  violations.push(`desktop/core must depend on exact @lamarck/system ${expectedVersion}`);
}

const appsDirectory = join(root, "desktop", "template", "apps");
const appIds = (await readdir(appsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (appIds.length < 1) violations.push("repository has no first-party App consumers to verify");

for (const appId of appIds) {
  const appDirectory = join(appsDirectory, appId);
  const appPackage = await readJson(join(appDirectory, "package.json"));
  const lock = await readJson(join(appDirectory, "package-lock.json"));
  const lockRoot = lock.packages?.[""];
  const sdkEntry = lock.packages?.["node_modules/@lamarck/system"];

  if (appPackage.dependencies?.["@lamarck/system"] !== expectedRange) {
    violations.push(`${appId} package.json must declare @lamarck/system ${expectedRange}`);
  }
  if (lockRoot?.dependencies?.["@lamarck/system"] !== expectedRange) {
    violations.push(`${appId} package-lock root must declare @lamarck/system ${expectedRange}`);
  }
  if (
    sdkEntry?.version !== expectedVersion
    || sdkEntry.resolved !== expectedResolved
    || sdkEntry.integrity !== integrity
  ) {
    violations.push(`${appId} package-lock must pin the current SDK tarball (${integrity})`);
  }
}

if (violations.length > 0) {
  throw new Error(`System SDK consumer alignment failed:\n- ${violations.join("\n- ")}`);
}

process.stdout.write(`First-party @lamarck/system consumers match ${expectedVersion} (${integrity})\n`);

async function packIntegrity() {
  const output = (await run(process.execPath, [join(root, "scripts", "pack-system-sdk.mjs")])).trim();
  const lines = output.split(/\r?\n/);
  const integrity = lines.at(-1);
  if (!integrity?.startsWith("sha512-")) {
    throw new Error(`System SDK packer did not report an integrity value: ${output}`);
  }
  return integrity;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function run(command, args) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || code !== 0) {
        reject(new Error(`${command} exited with ${signal ?? code}`));
      } else {
        resolveRun(stdout);
      }
    });
  });
}
