#!/usr/bin/env node
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createMacOsReleaseSourceSnapshot, validateMacOsShellBuildExport } from "./macos-release-source.mjs";
import { buildShellFromSnapshot } from "./macos-release-builder.mjs";
import { resolveBuildSystemIdentity } from "./build-system-identity.mjs";
import { requireMarketplaceTrustRoot } from "./marketplace-trust-roots.mjs";

const root = resolve(import.meta.dirname, "..");
if (!process.argv[2] || process.argv.length !== 3) throw new Error("Usage: build-macos-release-handoff.mjs <new-output-directory>");
const destination = resolve(process.argv[2]);
requireMarketplaceTrustRoot(process.env);
const identity = await resolveBuildSystemIdentity({ root, requireClean: true });
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(identity.version)) throw new Error("Release version must be x.y.z");
await mkdir(destination, { recursive: false, mode: 0o700 });
const snapshot = join(destination, "snapshot");
const snapshotIdentity = await createMacOsReleaseSourceSnapshot(root, snapshot);
const exportRoot = join(destination, "export");
await mkdir(exportRoot, { mode: 0o700 });
const builderImageId = await buildShellFromSnapshot(snapshot, exportRoot, snapshotIdentity.manifestDigest, identity);
await validateMacOsShellBuildExport(exportRoot, snapshot, builderImageId);
await writeFile(join(destination, "identity.json"), JSON.stringify({
  ...identity, builderImageId, sourceManifestDigest: snapshotIdentity.manifestDigest,
}));
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `builder-image-id=${builderImageId}\n`);
