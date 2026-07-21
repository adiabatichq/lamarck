#!/usr/bin/env node

// Copies only the three expected alpha package outputs into a non-hidden
// directory for GitHub Actions artifact handoff between the macOS package job
// and the Linux R2 publish job.

import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const source = resolve(process.argv[2] ?? ".lamarck/build/alpha");
const destination = resolve(process.argv[3] ?? "release-handoff/alpha");
const entries = await readdir(source);
const releaseDocuments = entries.filter((name) => name.endsWith(".release.json"));
if (releaseDocuments.length !== 1) {
  throw new Error(`expected exactly one alpha release document in ${source}`);
}
const release = JSON.parse(await readFile(join(source, releaseDocuments[0]), "utf8"));
if (
  release.channel !== "alpha"
  || !/^\d+\.\d+\.\d+-alpha(?:\.[A-Za-z0-9]+)?$/.test(release.version ?? "")
  || release.file !== `Lamarck-Alpha-${release.version}-macos-arm64.zip`
) throw new Error("alpha release document is invalid for artifact handoff");

const expected = [
  release.file,
  `${release.file}.sha256`,
  releaseDocuments[0],
].sort((left, right) => left.localeCompare(right, "en"));
if (JSON.stringify(entries.sort((left, right) => left.localeCompare(right, "en"))) !== JSON.stringify(expected)) {
  throw new Error(`alpha package output contains missing or unexpected entries: ${entries.join(", ")}`);
}
for (const name of expected) {
  const details = await lstat(join(source, name));
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1) {
    throw new Error(`alpha package output is not a non-empty regular file: ${name}`);
  }
}

if (await lstat(destination).catch(() => null)) throw new Error(`artifact handoff already exists: ${destination}`);
await mkdir(destination, { recursive: true });
for (const name of expected) await copyFile(join(source, name), join(destination, name));
console.log(`[alpha] Staged ${expected.length} files for Actions handoff at ${destination}`);
