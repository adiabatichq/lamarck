import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { copyAndHashSparse, sha256File } from "./release-contract.mjs";

export const BUILD_SNAPSHOT_MANIFEST = "build-input-manifest.json";

export const BUILD_SNAPSHOT_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "desktop/capsule/package.json",
  "desktop/capsule/tsconfig.json",
  "desktop/capsule-guest/package.json",
  "desktop/capsule-guest/tsconfig.json",
  "desktop/core/package.json",
  "desktop/shell/package.json",
  "scripts/macos-release-publication.mjs",
  "scripts/rename-excl.c",
]);

export const BUILD_SNAPSHOT_DIRECTORIES = Object.freeze([
  "desktop/capsule/src",
  "desktop/capsule-guest/buildroot",
  "desktop/capsule-guest/native",
  "desktop/capsule-guest/scripts",
  "desktop/capsule-guest/src",
  "desktop/capsule-guest/test-boot",
]);

export async function createBuildSnapshot(repositoryValue, destinationValue, options = {}) {
  const repository = resolve(repositoryValue);
  const destination = resolve(destinationValue);
  await requireRealDirectory(repository, "repository");
  const sourceBefore = await describeSelectedSource(repository);
  await mkdir(destination, { recursive: false, mode: 0o700 });

  for (const relativePath of BUILD_SNAPSHOT_FILES) {
    await copySnapshotFile(
      join(repository, relativePath),
      join(destination, relativePath),
    );
  }
  for (const relativePath of BUILD_SNAPSHOT_DIRECTORIES) {
    await copySnapshotTree(
      join(repository, relativePath),
      join(destination, relativePath),
    );
  }

  const files = await describeFiles(destination);
  const expectedFiles = sourceBefore.map(({ path, size, mode, sha256 }) => ({
    path,
    size,
    mode,
    sha256,
  }));
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    throw new Error("build inputs changed while the private snapshot was copied");
  }
  await options.afterCopy?.();
  const sourceAfter = await describeSelectedSource(repository);
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
    throw new Error("build source membership or content changed during snapshot creation");
  }
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    files,
  })}\n`, "utf8");
  await writeFile(join(destination, BUILD_SNAPSHOT_MANIFEST), manifestBytes, {
    flag: "wx",
    mode: 0o600,
  });
  await validateBuildSnapshot(destination);
  return Object.freeze({
    root: destination,
    manifestDigest: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
    fileCount: files.length,
  });
}

async function describeSelectedSource(repository) {
  const paths = [];
  for (const relativePath of BUILD_SNAPSHOT_FILES) paths.push(relativePath);
  for (const relativePath of BUILD_SNAPSHOT_DIRECTORIES) {
    await collectSourceFiles(repository, relativePath, paths);
  }
  paths.sort(compareNames);
  if (new Set(paths).size !== paths.length) throw new Error("build snapshot input paths overlap");
  return await Promise.all(paths.map(async (relativePath) => {
    const path = join(repository, relativePath);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.nlink !== 1n) {
      throw new Error(`build input is not a nonempty regular file: ${path}`);
    }
    const sha256 = `sha256:${await sha256File(path)}`;
    const after = await lstat(path, { bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mode !== after.mode
      || before.nlink !== after.nlink
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error(`build input changed while it was inventoried: ${path}`);
    return {
      path: relativePath,
      size: Number(before.size),
      mode: (Number(before.mode) & 0o111) === 0 ? 0o644 : 0o755,
      sha256,
      sourceIdentity: {
        device: before.dev.toString(),
        inode: before.ino.toString(),
        mode: before.mode.toString(),
        links: before.nlink.toString(),
        modifiedNanoseconds: before.mtimeNs.toString(),
        changedNanoseconds: before.ctimeNs.toString(),
      },
    };
  }));
}

async function collectSourceFiles(repository, relativeDirectory, result) {
  const directory = join(repository, relativeDirectory);
  await requireRealDirectory(directory, "snapshot source directory");
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareNames(left.name, right.name));
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const path = join(repository, relativePath);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new Error(`build input contains symbolic link ${path}`);
    if (details.isDirectory()) await collectSourceFiles(repository, relativePath, result);
    else if (details.isFile()) result.push(relativePath);
    else throw new Error(`build input contains unsupported entry ${path}`);
  }
}

export async function validateBuildSnapshot(snapshotValue) {
  const snapshot = resolve(snapshotValue);
  await requireRealDirectory(snapshot, "build snapshot");
  const manifestPath = join(snapshot, BUILD_SNAPSHOT_MANIFEST);
  const manifestBytes = await readStableRegularFile(manifestPath, 16 * 1024 * 1024);
  let value;
  try {
    value = JSON.parse(manifestBytes.toString("utf8"));
  } catch (cause) {
    throw new Error("build snapshot manifest is not valid JSON", { cause });
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["files", "schemaVersion"])
    || value.schemaVersion !== 1
    || !Array.isArray(value.files)
    || value.files.length < 1
    || value.files.length > 100_000
  ) throw new Error("build snapshot manifest has an invalid exact schema");

  let previous = "";
  const expectedFiles = new Set([BUILD_SNAPSHOT_MANIFEST]);
  const expectedDirectories = new Set();
  for (const [index, entry] of value.files.entries()) {
    if (
      typeof entry !== "object"
      || entry === null
      || Array.isArray(entry)
      || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["mode", "path", "sha256", "size"])
      || typeof entry.path !== "string"
      || !isSafeRelativePath(entry.path)
      || (previous && compareNames(previous, entry.path) >= 0)
      || !Number.isSafeInteger(entry.size)
      || entry.size < 1
      || ![0o644, 0o755].includes(entry.mode)
      || typeof entry.sha256 !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256)
    ) throw new Error(`build snapshot manifest entry ${index} is invalid`);
    previous = entry.path;
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
    ) throw new Error(`build snapshot metadata mismatch for ${entry.path}`);
    if (`sha256:${await sha256File(path)}` !== entry.sha256) {
      throw new Error(`build snapshot digest mismatch for ${entry.path}`);
    }
  }
  addParentDirectories(expectedDirectories, BUILD_SNAPSHOT_MANIFEST);

  const actual = await listSnapshotTree(snapshot);
  if (
    JSON.stringify(actual.files) !== JSON.stringify([...expectedFiles].sort(compareNames))
    || JSON.stringify(actual.directories) !== JSON.stringify([...expectedDirectories].sort(compareNames))
  ) throw new Error("build snapshot contains missing or unexpected entries");
  return Object.freeze({
    root: snapshot,
    manifestDigest: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
    fileCount: value.files.length,
  });
}

async function copySnapshotTree(source, destination) {
  await requireRealDirectory(source, "snapshot source directory");
  await mkdir(destination, { recursive: true, mode: 0o755 });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => compareNames(left.name, right.name));
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const details = await lstat(sourcePath);
    if (details.isSymbolicLink()) throw new Error(`build input contains symbolic link ${sourcePath}`);
    if (details.isDirectory()) await copySnapshotTree(sourcePath, destinationPath);
    else if (details.isFile()) await copySnapshotFile(sourcePath, destinationPath);
    else throw new Error(`build input contains unsupported entry ${sourcePath}`);
  }
}

async function copySnapshotFile(source, destination) {
  const details = await lstat(source);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1) {
    throw new Error(`build input is not a nonempty regular file: ${source}`);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await copyAndHashSparse(source, destination);
  await chmod(destination, (details.mode & 0o111) === 0 ? 0o644 : 0o755);
}

async function describeFiles(root) {
  const { files } = await listSnapshotTree(root);
  return await Promise.all(files.map(async (relativePath) => {
    const path = join(root, relativePath);
    const details = await lstat(path);
    return {
      path: relativePath,
      size: details.size,
      mode: details.mode & 0o777,
      sha256: `sha256:${await sha256File(path)}`,
    };
  }));
}

async function listSnapshotTree(root) {
  const files = [];
  const directories = [];
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const details = await lstat(path);
      if (details.isSymbolicLink()) throw new Error(`build snapshot contains symbolic link ${path}`);
      if (details.isDirectory()) {
        directories.push(relativePath);
        await visit(path, relativePath);
      } else if (details.isFile()) files.push(relativePath);
      else throw new Error(`build snapshot contains unsupported entry ${path}`);
    }
  };
  await visit(root);
  return {
    files: files.sort(compareNames),
    directories: directories.sort(compareNames),
  };
}

async function readStableRegularFile(path, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size < 1n
      || before.size > BigInt(maximumBytes)
    ) {
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

async function requireRealDirectory(path, label) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
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
  return value.length > 0
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && value.split("/").every((component) => component && component !== "." && component !== "..");
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}
