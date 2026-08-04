import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const MACOS_RELEASE_SOURCE_MANIFEST = "macos-release-source-v1.json";

// This is deliberately an allowlist. Generated output, repository metadata,
// ambient node_modules, and unrelated backend code can never become release
// inputs merely because they happen to exist in the checkout.
export const MACOS_RELEASE_SOURCE_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "desktop/capsule/package.json",
  "desktop/capsule/tsconfig.json",
  "desktop/capsule-guest/buildroot/Dockerfile",
  "desktop/capsule-guest/package.json",
  "desktop/capsule-guest/scripts/release-contract.mjs",
  "desktop/capsule-guest/tsconfig.json",
  "desktop/capsule-vm-macos/CapsuleVmHost.entitlements",
  "desktop/capsule-vm-macos/Package.swift",
  "desktop/core/package.json",
  "desktop/core/tsconfig.json",
  "desktop/shell/index.html",
  "desktop/shell/assets/Lamarck.icns",
  "desktop/shell/package.json",
  "desktop/shell/tsconfig.json",
  "desktop/shell/vite.config.ts",
  "desktop/system-sdk/package.json",
  "desktop/system-sdk/tsconfig.json",
  "scripts/build-desktop.mjs",
  "scripts/build-electron-main.mjs",
  "scripts/build-system-identity.mjs",
  "scripts/build-capsule-vm-macos.mjs",
  "scripts/build-macos-release-shell-inside.mjs",
  "scripts/macos-release-signer.mjs",
  "scripts/macos-release-runtime.mjs",
  "scripts/package-macos-release-contract.mjs",
  "scripts/rename-excl.c",
  "scripts/stage-capsule-native.mjs",
]);

export const MACOS_RELEASE_SOURCE_DIRECTORIES = Object.freeze([
  "desktop/capsule/src",
  "desktop/capsule-vm-macos/Sources",
  "desktop/core/src",
  "desktop/core/scaffolds/app-v1",
  "desktop/shell/electron",
  "desktop/shell/src",
  "desktop/system-sdk/src",
]);

const MAX_SOURCE_FILES = 20_000;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export async function createMacOsReleaseSourceSnapshot(
  repositoryValue,
  destinationValue,
  options = {},
) {
  const repository = resolve(repositoryValue);
  const destination = resolve(destinationValue);
  await requireRealDirectory(repository, "release repository");
  const before = await inventorySelectedSource(repository);
  await mkdir(destination, { recursive: false, mode: 0o700 });

  for (const entry of before.files) {
    await copyStableFile(
      join(repository, entry.path),
      join(destination, entry.path),
      entry,
    );
  }
  await options.afterCopy?.();

  const after = await inventorySelectedSource(repository);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("macOS release source membership or identity changed during snapshot creation");
  }

  const manifestValue = {
    schemaVersion: 1,
    files: before.files.map(({ path, size, mode, sha256 }) => ({
      path,
      size,
      mode,
      sha256,
    })),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifestValue)}\n`, "utf8");
  await writeFile(join(destination, MACOS_RELEASE_SOURCE_MANIFEST), manifestBytes, {
    flag: "wx",
    mode: 0o400,
  });
  await sealSnapshotTree(destination);
  const validation = await validateMacOsReleaseSourceSnapshot(destination);
  return Object.freeze({
    ...validation,
    manifestDigest: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
  });
}

export async function validateMacOsReleaseSourceSnapshot(snapshotValue) {
  const snapshot = resolve(snapshotValue);
  await requireRealDirectory(snapshot, "macOS release source snapshot");
  const manifestPath = join(snapshot, MACOS_RELEASE_SOURCE_MANIFEST);
  const manifestBytes = await readStableFile(manifestPath, MAX_MANIFEST_BYTES, {
    allowEmpty: false,
    requireSingleLink: true,
  });
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (cause) {
    throw new Error("macOS release source manifest is not valid JSON", { cause });
  }
  if (
    !isExactObject(manifest, ["files", "schemaVersion"])
    || manifest.schemaVersion !== 1
    || !Array.isArray(manifest.files)
    || manifest.files.length < 1
    || manifest.files.length > MAX_SOURCE_FILES
  ) throw new Error("macOS release source manifest has an invalid exact schema");

  const expectedFiles = new Set([MACOS_RELEASE_SOURCE_MANIFEST]);
  const expectedDirectories = new Set();
  let previous = "";
  let totalBytes = 0;
  for (const [index, entry] of manifest.files.entries()) {
    if (
      !isExactObject(entry, ["mode", "path", "sha256", "size"])
      || !isSafeRelativePath(entry.path)
      || (previous && compareNames(previous, entry.path) >= 0)
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || entry.size > MAX_SOURCE_FILE_BYTES
      || ![0o444, 0o555].includes(entry.mode)
      || typeof entry.sha256 !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256)
    ) throw new Error(`macOS release source manifest entry ${index} is invalid`);
    previous = entry.path;
    totalBytes += entry.size;
    if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
      throw new Error("macOS release source snapshot exceeds its total byte limit");
    }
    expectedFiles.add(entry.path);
    addParentDirectories(expectedDirectories, entry.path);
    const path = join(snapshot, entry.path);
    const details = await lstat(path);
    if (
      !details.isFile()
      || details.isSymbolicLink()
      || details.nlink !== 1
      || details.size !== entry.size
      || (details.mode & 0o777) !== entry.mode
    ) throw new Error(`macOS release source metadata mismatch for ${entry.path}`);
    const bytes = await readStableFile(path, MAX_SOURCE_FILE_BYTES, {
      allowEmpty: true,
      requireSingleLink: true,
    });
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== entry.sha256) {
      throw new Error(`macOS release source digest mismatch for ${entry.path}`);
    }
  }
  addParentDirectories(expectedDirectories, MACOS_RELEASE_SOURCE_MANIFEST);

  const actual = await listTree(snapshot);
  if (
    JSON.stringify(actual.files) !== JSON.stringify([...expectedFiles].sort(compareNames))
    || JSON.stringify(actual.directories)
      !== JSON.stringify([...expectedDirectories].sort(compareNames))
  ) throw new Error("macOS release source snapshot has missing or unexpected entries");
  return Object.freeze({
    root: snapshot,
    manifestDigest: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
    fileCount: manifest.files.length,
    totalBytes,
  });
}

export async function validateMacOsShellBuildExport(
  exportValue,
  snapshotValue,
  expectedBuilderImageId,
) {
  const exportRoot = resolve(exportValue);
  const snapshot = await validateMacOsReleaseSourceSnapshot(snapshotValue);
  await requireRealDirectory(exportRoot, "macOS Shell build export");
  const topLevel = (await readdir(exportRoot)).sort(compareNames);
  if (JSON.stringify(topLevel) !== JSON.stringify([
    "builder-inventory.json",
    "dist",
    "dist-electron",
    "host-tools",
    "runtime-dependencies",
  ])) throw new Error("macOS Shell build export has missing or unexpected entries");

  const inventoryBytes = await readStableFile(
    join(exportRoot, "builder-inventory.json"),
    MAX_MANIFEST_BYTES,
    { allowEmpty: false, requireSingleLink: true },
  );
  let inventory;
  try {
    inventory = JSON.parse(inventoryBytes.toString("utf8"));
  } catch (cause) {
    throw new Error("macOS Shell builder inventory is not valid JSON", { cause });
  }
  const packageLockBytes = await readStableFile(
    join(resolve(snapshotValue), "package-lock.json"),
    MAX_SOURCE_FILE_BYTES,
    { allowEmpty: false, requireSingleLink: true },
  );
  let packageLock;
  try {
    packageLock = JSON.parse(packageLockBytes.toString("utf8"));
  } catch (cause) {
    throw new Error("snapshot package-lock.json is not valid JSON", { cause });
  }
  assertBuilderInventory(
    inventory,
    snapshot.manifestDigest,
    expectedBuilderImageId,
    `sha256:${createHash("sha256").update(packageLockBytes).digest("hex")}`,
    packageLock,
  );

  const actualOutputTree = await describeOutputTrees(
    exportRoot,
    ["dist", "dist-electron", "host-tools", "runtime-dependencies"],
  );
  const expectedDirectories = new Set();
  for (const output of inventory.outputs) addParentDirectories(expectedDirectories, output.path);
  if (
    JSON.stringify(actualOutputTree.files) !== JSON.stringify(inventory.outputs)
    || JSON.stringify(actualOutputTree.directories)
      !== JSON.stringify([...expectedDirectories].sort(compareNames))
  ) {
    throw new Error("macOS Shell build output does not match its builder inventory");
  }
  return Object.freeze({ root: exportRoot, inventory });
}

export function assertBuilderInventory(
  inventory,
  sourceManifestDigest,
  expectedBuilderImageId,
  expectedPackageLockSha256,
  packageLock,
) {
  if (
    !isExactObject(inventory, [
      "builderImageId",
      "outputs",
      "packageLockSha256",
      "runtime",
      "schemaVersion",
      "sourceManifestDigest",
      "tools",
    ])
    || inventory.schemaVersion !== 1
    || inventory.sourceManifestDigest !== sourceManifestDigest
    || inventory.builderImageId !== expectedBuilderImageId
    || inventory.packageLockSha256 !== expectedPackageLockSha256
    || !isExactObject(inventory.runtime, [
      "nodeExecutableSha256", "nodeVersion", "npmCliSha256", "npmVersion",
    ])
    || inventory.runtime.nodeVersion !== "v24.18.0"
    || inventory.runtime.npmVersion !== "11.16.0"
    || !isSha256(inventory.runtime.nodeExecutableSha256)
    || !isSha256(inventory.runtime.npmCliSha256)
    || !isExactObject(inventory.tools, [
      "esbuild", "nodeAddonApi", "nodePty", "osxSign", "typescript", "vite",
    ])
    || !Array.isArray(inventory.outputs)
    || inventory.outputs.length < 1
    || inventory.outputs.length > MAX_SOURCE_FILES
  ) throw new Error("macOS Shell builder inventory has an invalid exact schema or identity");

  for (const [name, packageName, expectedVersion] of [
    ["vite", "vite", "6.4.1"],
    ["typescript", "typescript", "5.9.3"],
    ["esbuild", "esbuild", "0.25.12"],
    ["osxSign", "@electron/osx-sign", "2.4.0"],
    ["nodePty", "node-pty", "1.1.0"],
    ["nodeAddonApi", "node-addon-api", "7.1.1"],
  ]) {
    const tool = inventory.tools[name];
    const locked = packageLock?.packages?.[`node_modules/${packageName}`];
    if (
      !isExactObject(tool, ["entrySha256", "integrity", "packageJsonSha256", "resolved", "version"])
      || tool.version !== expectedVersion
      || packageLock?.lockfileVersion !== 3
      || locked?.version !== expectedVersion
      || tool.resolved !== locked.resolved
      || tool.integrity !== locked.integrity
      || !isSha256(tool.entrySha256)
      || !isSha256(tool.packageJsonSha256)
      || typeof tool.resolved !== "string"
      || !tool.resolved.startsWith("https://registry.npmjs.org/")
      || typeof tool.integrity !== "string"
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(tool.integrity)
    ) throw new Error(`macOS Shell builder ${name} identity is invalid`);
  }
  let previous = "";
  let totalOutputBytes = 0;
  for (const output of inventory.outputs) {
    if (
      !isExactObject(output, ["mode", "path", "sha256", "size"])
      || !isSafeRelativePath(output.path)
      || !/^(?:dist|dist-electron|host-tools|runtime-dependencies)\//.test(output.path)
      || (previous && compareNames(previous, output.path) >= 0)
      || !Number.isSafeInteger(output.size)
      || output.size < 0
      || output.size > MAX_SOURCE_FILE_BYTES
      || ![0o644, 0o755].includes(output.mode)
      || !isSha256(output.sha256)
    ) throw new Error("macOS Shell builder output inventory is invalid");
    previous = output.path;
    totalOutputBytes += output.size;
    if (totalOutputBytes > MAX_SOURCE_TOTAL_BYTES) {
      throw new Error("macOS Shell builder output exceeds its total byte limit");
    }
  }
}

async function inventorySelectedSource(repository) {
  const paths = [...MACOS_RELEASE_SOURCE_FILES];
  for (const relativeDirectory of MACOS_RELEASE_SOURCE_DIRECTORIES) {
    await collectFiles(repository, relativeDirectory, paths);
  }
  paths.sort(compareNames);
  if (new Set(paths).size !== paths.length) {
    throw new Error("macOS release source allowlist paths overlap");
  }
  if (paths.length > MAX_SOURCE_FILES) throw new Error("macOS release source has too many files");
  const files = [];
  let totalBytes = 0;
  for (const relativePath of paths) {
    const path = join(repository, relativePath);
    const { bytes, identity, executable } = await describeStableSourceFile(path);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
      throw new Error("macOS release source exceeds its total byte limit");
    }
    files.push({
      path: relativePath,
      size: bytes.byteLength,
      mode: executable ? 0o555 : 0o444,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      sourceIdentity: identity,
    });
  }
  return { files, totalBytes };
}

async function collectFiles(repository, relativeDirectory, result) {
  const directory = join(repository, relativeDirectory);
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`macOS release source is not a real directory: ${directory}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareNames(left.name, right.name));
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (isExcludedSourcePath(relativePath)) continue;
    const path = join(repository, relativePath);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new Error(`macOS release source contains link: ${path}`);
    if (details.isDirectory()) await collectFiles(repository, relativePath, result);
    else if (details.isFile()) result.push(relativePath);
    else throw new Error(`macOS release source contains special file: ${path}`);
  }
  const after = await lstat(directory, { bigint: true });
  if (!sameIdentity(before, after)) {
    throw new Error(`macOS release source directory changed while it was enumerated: ${directory}`);
  }
}

function isExcludedSourcePath(_relativePath) {
  return false;
}

async function describeStableSourceFile(path) {
  const pathDetails = await lstat(path);
  if (pathDetails.isSymbolicLink() || !pathDetails.isFile()) {
    throw new Error(`macOS release input is not a regular file and links are forbidden: ${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size > BigInt(MAX_SOURCE_FILE_BYTES)
    ) throw new Error(`macOS release input is not a bounded single-link regular file: ${path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) {
      throw new Error(`macOS release input changed while it was read: ${path}`);
    }
    return {
      bytes,
      executable: (Number(before.mode) & 0o111) !== 0,
      identity: identityValue(before),
    };
  } finally {
    await handle.close();
  }
}

async function copyStableFile(source, destination, expected) {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationHandle;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || JSON.stringify(identityValue(before)) !== JSON.stringify(expected.sourceIdentity)
    ) throw new Error(`macOS release input identity changed before copy: ${source}`);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      expected.mode,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < expected.size) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, expected.size - offset),
        offset,
      );
      if (bytesRead < 1) throw new Error(`macOS release input ended during copy: ${source}`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await writeAll(destinationHandle, chunk, offset);
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await sourceHandle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      throw new Error(`macOS release input grew during copy: ${source}`);
    }
    await destinationHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    if (
      !sameIdentity(before, after)
      || `sha256:${hash.digest("hex")}` !== expected.sha256
    ) throw new Error(`macOS release input changed during copy: ${source}`);
  } finally {
    await destinationHandle?.close();
    await sourceHandle.close();
  }
  await chmod(destination, expected.mode);
}

async function describeOutputTrees(root, directories) {
  const paths = [];
  const actualDirectories = new Set();
  for (const directory of directories) {
    await collectOutputFiles(root, directory, paths, actualDirectories);
  }
  paths.sort(compareNames);
  const files = await Promise.all(paths.map(async (relativePath) => {
    const path = join(root, relativePath);
    const details = await lstat(path);
    const bytes = await readStableFile(path, MAX_SOURCE_FILE_BYTES, {
      allowEmpty: true,
      requireSingleLink: true,
    });
    return {
      path: relativePath,
      size: bytes.byteLength,
      mode: details.mode & 0o777,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  }));
  return {
    files,
    directories: [...actualDirectories].sort(compareNames),
  };
}

async function collectOutputFiles(root, relativeDirectory, result, directories) {
  const directory = join(root, relativeDirectory);
  await requireRealDirectory(directory, "macOS Shell build output directory");
  directories.add(relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareNames(left.name, right.name));
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const path = join(root, relativePath);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new Error(`macOS Shell build output contains link: ${path}`);
    if (details.isDirectory()) {
      await collectOutputFiles(root, relativePath, result, directories);
    }
    else if (details.isFile()) result.push(relativePath);
    else throw new Error(`macOS Shell build output contains special file: ${path}`);
  }
}

async function sealSnapshotTree(root) {
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (!entry.isFile()) throw new Error(`snapshot contains unsupported entry: ${path}`);
    }
    // Keep private directories owner-writable so the staging tree can be
    // deleted after publication. Immutability is enforced by the exact
    // manifest checks and Docker's read-only bind, not by advisory owner bits.
    await chmod(directory, 0o700);
  };
  await visit(root);
}

async function listTree(root) {
  const files = [];
  const directories = [];
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const details = await lstat(path);
      if (details.isSymbolicLink()) throw new Error(`snapshot contains link: ${path}`);
      if (details.isDirectory()) {
        directories.push(relativePath);
        await visit(path, relativePath);
      } else if (details.isFile()) files.push(relativePath);
      else throw new Error(`snapshot contains special file: ${path}`);
    }
  };
  await visit(root);
  return { files: files.sort(compareNames), directories: directories.sort(compareNames) };
}

async function readStableFile(path, maximumBytes, { allowEmpty, requireSingleLink }) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || (requireSingleLink && before.nlink !== 1n)
      || (!allowEmpty && before.size < 1n)
      || before.size > BigInt(maximumBytes)
    ) throw new Error(`${path} is not a bounded regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) throw new Error(`${path} changed while it was read`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (bytesWritten < 1) throw new Error("macOS release snapshot copy made no progress");
    offset += bytesWritten;
  }
}

async function requireRealDirectory(path, label) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
}

function identityValue(details) {
  return {
    device: details.dev.toString(),
    inode: details.ino.toString(),
    size: details.size.toString(),
    mode: details.mode.toString(),
    links: details.nlink.toString(),
    modifiedNanoseconds: details.mtimeNs.toString(),
    changedNanoseconds: details.ctimeNs.toString(),
  };
}

function sameIdentity(left, right) {
  return JSON.stringify(identityValue(left)) === JSON.stringify(identityValue(right));
}

function addParentDirectories(result, path) {
  const components = path.split("/");
  components.pop();
  let current = "";
  for (const component of components) {
    current = current ? `${current}/${component}` : component;
    result.add(current);
  }
}

function isSafeRelativePath(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 1024
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((component) => (
      component.length >= 1
      && component !== "."
      && component !== ".."
      && !component.includes("\0")
    ));
}

function isExactObject(value, keys) {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort(compareNames))
      === JSON.stringify([...keys].sort(compareNames));
}

function isSha256(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}
