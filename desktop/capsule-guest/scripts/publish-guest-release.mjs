#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileRenameExclHelper,
  publishDirectoryNoReplace,
} from "../../../scripts/macos-release-publication.mjs";

const snapshotRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export async function publishGuestReleaseNoReplace(
  sourceValue,
  destinationValue,
  helperValue,
  options = {},
) {
  const helper = compileRenameExclHelper(
    join(snapshotRoot, "scripts", "rename-excl.c"),
    helperValue,
    options,
  );
  await publishDirectoryNoReplace(sourceValue, destinationValue, helper, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination, helper] = process.argv.slice(2);
  if (!source || !destination || !helper || process.argv.length !== 5) {
    throw new Error(
      "usage: publish-guest-release.mjs <staged-release> <destination> <rename-excl-helper>",
    );
  }
  await publishGuestReleaseNoReplace(source, destination, helper);
}
