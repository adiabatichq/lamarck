#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDocument = JSON.parse(await readFile(
  join(root, "desktop", "system-sdk", "package.json"),
  "utf8",
));
const tarballPath = join(root, ".lamarck", "build", "system-sdk", "lamarck-system.tgz");
const tarball = await readFile(tarballPath);
const expectedIntegrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
const expectedTarball = `https://registry.npmjs.org/@lamarck/system/-/system-${packageDocument.version}.tgz`;
const metadataUrl = `https://registry.npmjs.org/@lamarck%2fsystem/${packageDocument.version}`;
const wait = process.argv.includes("--wait");
const attempts = wait ? 13 : 1;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const response = await fetch(metadataUrl, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    if (attempt < attempts) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
      continue;
    }
    await setOutput("published", "false");
    if (wait) throw new Error(`@lamarck/system@${packageDocument.version} was not visible after publication`);
    process.stdout.write(`@lamarck/system@${packageDocument.version} is not published\n`);
    process.exit(0);
  }
  if (!response.ok) {
    throw new Error(`npm registry metadata request failed with ${response.status}`);
  }
  const metadata = await response.json();
  if (
    metadata?.name !== "@lamarck/system"
    || metadata?.version !== packageDocument.version
    || metadata?.dist?.integrity !== expectedIntegrity
    || metadata?.dist?.tarball !== expectedTarball
  ) {
    throw new Error(`npm registry contains different immutable bytes for @lamarck/system@${packageDocument.version}`);
  }
  await setOutput("published", "true");
  process.stdout.write(`@lamarck/system@${packageDocument.version} matches ${expectedIntegrity}\n`);
  process.exit(0);
}

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}
