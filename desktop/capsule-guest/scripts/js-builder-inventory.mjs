import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateBuildSnapshot } from "./build-snapshot.mjs";
import { sha256File } from "./release-contract.mjs";

const MAXIMUM_INVENTORY_BYTES = 8 * 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAXIMUM_AGGREGATE_OUTPUT_BYTES = 256 * 1024 * 1024;

export async function validateJavaScriptBuilderOutput(prebuiltValue, snapshotValue) {
  const prebuilt = resolve(prebuiltValue);
  const snapshot = resolve(snapshotValue);
  const snapshotDetails = await validateBuildSnapshot(snapshot);
  const inventoryPath = join(prebuilt, "js-builder-environment.json");
  const inventory = exactObject(
    JSON.parse((await readBoundedRegularFile(inventoryPath, MAXIMUM_INVENTORY_BYTES)).toString("utf8")),
    "JavaScript builder inventory",
    ["schemaVersion", "sourceSnapshotManifestDigest", "packageLockSha256", "runtime", "tools", "outputs"],
  );
  if (
    inventory.schemaVersion !== 1
    || inventory.sourceSnapshotManifestDigest !== snapshotDetails.manifestDigest
    || inventory.packageLockSha256 !== `sha256:${await sha256File(join(snapshot, "package-lock.json"))}`
  ) throw new Error("JavaScript builder inventory is bound to different source inputs");
  const runtime = exactObject(inventory.runtime, "JavaScript runtime inventory", [
    "nodeVersion", "nodeExecutableSha256", "npmVersion", "npmCliSha256",
  ]);
  const tools = exactObject(inventory.tools, "JavaScript tool inventory", [
    "esbuildVersion", "esbuildPackageSha256", "esbuildBinarySha256",
    "typescriptVersion", "typescriptPackageSha256", "typescriptCliSha256",
  ]);
  if (
    runtime.nodeVersion !== "v24.10.0"
    || runtime.npmVersion !== "11.6.1"
    || tools.esbuildVersion !== "0.25.12"
    || tools.typescriptVersion !== "5.9.3"
  ) throw new Error("JavaScript builder inventory has an unexpected pinned tool version");
  for (const [label, value] of Object.entries({
    nodeExecutableSha256: runtime.nodeExecutableSha256,
    npmCliSha256: runtime.npmCliSha256,
    esbuildPackageSha256: tools.esbuildPackageSha256,
    esbuildBinarySha256: tools.esbuildBinarySha256,
    typescriptPackageSha256: tools.typescriptPackageSha256,
    typescriptCliSha256: tools.typescriptCliSha256,
  })) requireDigest(value, label);

  if (!Array.isArray(inventory.outputs) || inventory.outputs.length < 2 || inventory.outputs.length > 1_000) {
    throw new Error("JavaScript builder output inventory is invalid");
  }
  let previous = "";
  let aggregateBytes = 0;
  const expectedPaths = new Set(["js-builder-environment.json"]);
  for (const [index, value] of inventory.outputs.entries()) {
    const output = exactObject(value, `JavaScript output ${index}`, ["path", "size", "sha256"]);
    if (
      typeof output.path !== "string"
      || !safeRelativePath(output.path)
      || (previous && compareNames(previous, output.path) >= 0)
      || !Number.isSafeInteger(output.size)
      || output.size < 1
      || output.size > MAXIMUM_OUTPUT_BYTES
    ) throw new Error(`JavaScript builder output ${index} is invalid`);
    requireDigest(output.sha256, `JavaScript output ${output.path}`);
    previous = output.path;
    aggregateBytes += output.size;
    if (aggregateBytes > MAXIMUM_AGGREGATE_OUTPUT_BYTES) {
      throw new Error("JavaScript builder output inventory exceeds its aggregate byte limit");
    }
    expectedPaths.add(output.path);
    const path = join(prebuilt, output.path);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size !== output.size) {
      throw new Error(`JavaScript builder output metadata mismatch for ${output.path}`);
    }
    if (`sha256:${await sha256File(path)}` !== output.sha256) {
      throw new Error(`JavaScript builder output digest mismatch for ${output.path}`);
    }
  }
  const actualPaths = await listRegularFiles(prebuilt);
  if (JSON.stringify(actualPaths) !== JSON.stringify([...expectedPaths].sort(compareNames))) {
    throw new Error("JavaScript prebuilt tree contains missing or unexpected files");
  }
  return Object.freeze({ inventory, inventoryPath, snapshot: snapshotDetails });
}

async function readBoundedRegularFile(path, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new Error(`${path} is not a bounded regular file`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error(`${path} changed while it was read`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function listRegularFiles(root) {
  const result = [];
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`JavaScript prebuilt tree contains symlink ${absolute}`);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile()) result.push(path);
      else throw new Error(`JavaScript prebuilt tree contains unsupported entry ${absolute}`);
    }
  };
  await visit(root);
  return result.sort(compareNames);
}

function exactObject(value, label, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is not a SHA-256 digest`);
  }
}

function safeRelativePath(value) {
  return value.length > 0
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && value.split("/").every((component) => component && component !== "." && component !== "..");
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}
