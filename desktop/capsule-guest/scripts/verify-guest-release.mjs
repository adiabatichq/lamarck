#!/usr/bin/env node

import { validateGuestRelease } from "./release-contract.mjs";

const [releaseRoot] = process.argv.slice(2);
if (!releaseRoot) throw new Error("usage: verify-guest-release.mjs <release-root>");
const release = await validateGuestRelease(releaseRoot);
process.stdout.write(`${JSON.stringify({
  manifestDigest: release.descriptor.manifestDigest,
  architecture: release.descriptor.architecture,
  imageVersion: release.manifest.imageVersion,
  complianceFiles: release.complianceManifest.files.length,
})}\n`);
