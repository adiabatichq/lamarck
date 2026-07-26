#!/usr/bin/env node

import { validateGuestRelease } from "./release-contract.mjs";

const [releaseRoot, option] = process.argv.slice(2);
if (!releaseRoot || (option && option !== "--require-source")) {
  throw new Error("usage: verify-guest-release.mjs <release-root> [--require-source]");
}
const release = await validateGuestRelease(releaseRoot, {
  requireSourceArchive: option === "--require-source",
});
process.stdout.write(`${JSON.stringify({
  manifestDigest: release.descriptor.manifestDigest,
  architecture: release.descriptor.architecture,
  imageVersion: release.manifest.imageVersion,
  complianceFiles: release.complianceManifest.files.length,
})}\n`);
