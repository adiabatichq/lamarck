#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { r2StoreFromEnvironment } from "./r2-object-store.mjs";
import { publishDesktopRelease } from "./desktop-release.mjs";
const directory = resolve(process.argv[2] ?? "release-handoff/stable");
const documents = (await readdir(directory)).filter((name) => name.endsWith(".release.json"));
if (documents.length !== 1) throw new Error("Expected one stable release document");
const release = JSON.parse(await readFile(join(directory, documents[0]), "utf8"));
const pointer = await publishDesktopRelease({ release, directory,
  store: r2StoreFromEnvironment(process.env.R2_RELEASES_BUCKET ?? "lamarck-desktop-releases-prod"),
});
console.log(`Published Lamarck ${pointer.version}: ${pointer.url}`);
