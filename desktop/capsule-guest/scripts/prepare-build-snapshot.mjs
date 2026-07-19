#!/usr/bin/env node

import { createBuildSnapshot, validateBuildSnapshot } from "./build-snapshot.mjs";

const [operation, firstPath, secondPath] = process.argv.slice(2);
if (operation === "create" && firstPath && secondPath) {
  process.stdout.write(`${JSON.stringify(await createBuildSnapshot(firstPath, secondPath))}\n`);
} else if (operation === "verify" && firstPath && !secondPath) {
  process.stdout.write(`${JSON.stringify(await validateBuildSnapshot(firstPath))}\n`);
} else {
  throw new Error(
    "usage: prepare-build-snapshot.mjs create <repository> <snapshot> | verify <snapshot>",
  );
}
