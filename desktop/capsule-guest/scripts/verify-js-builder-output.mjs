#!/usr/bin/env node

import { validateJavaScriptBuilderOutput } from "./js-builder-inventory.mjs";

const [prebuilt, snapshot] = process.argv.slice(2);
if (!prebuilt || !snapshot) {
  throw new Error("usage: verify-js-builder-output.mjs <prebuilt> <snapshot>");
}
const result = await validateJavaScriptBuilderOutput(prebuilt, snapshot);
process.stdout.write(`${JSON.stringify({
  sourceSnapshotManifestDigest: result.snapshot.manifestDigest,
  outputs: result.inventory.outputs.length,
})}\n`);
