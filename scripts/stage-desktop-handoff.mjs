#!/usr/bin/env node
import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateDesktopRelease } from "./desktop-release.mjs";
import { hashFile } from "./r2-object-store.mjs";
const source = resolve(process.argv[2] ?? ".lamarck/release/macos");
const destination = resolve(process.argv[3] ?? "release-handoff/stable");
const documents = (await readdir(source)).filter((name) => name.endsWith(".release.json"));
if (documents.length !== 1) throw new Error("Expected one stable release document");
const release = validateDesktopRelease(JSON.parse(await readFile(join(source, documents[0]), "utf8")));
for (const name of [release.file, documents[0]]) {
  const stat = await lstat(join(source, name));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1) throw new Error("Invalid release artifact");
}
const archive = await hashFile(join(source, release.file));
if (`sha256:${archive.sha256}` !== release.sha256 || archive.size !== release.bytes) throw new Error("Archive does not match release metadata");
await mkdir(destination, { recursive: false });
for (const name of [release.file, documents[0]]) await copyFile(join(source, name), join(destination, name));
