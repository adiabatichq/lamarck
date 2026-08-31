import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateAppManifest, type AppManifest } from "../app-loader";

export const APP_PACKAGE_MAX_ENTRIES = 100_000;
export const APP_PACKAGE_MAX_PATH_BYTES = 4_096;
export const APP_PACKAGE_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const APP_PACKAGE_MAX_BYTES = 1024 * 1024 * 1024;
export const APP_PACKAGE_EXCLUDED_ROOTS = Object.freeze([
  ".git",
  ".lamarck",
  "node_modules",
] as const);

const EXCLUDED_NAMES = new Set<string>(APP_PACKAGE_EXCLUDED_ROOTS);
const PACKAGE_DIGEST_PREFIX = Buffer.from("lamarck-app-package-v1\0", "utf8");

export type AppPackageEntry =
  | { readonly path: string; readonly kind: "file"; readonly bytes: Uint8Array }
  | { readonly path: string; readonly kind: "symlink"; readonly target: string };

export interface ValidatedAppPackage {
  readonly appId: string;
  readonly manifest: AppManifest;
  readonly entries: readonly AppPackageEntry[];
  readonly digest: `sha256:${string}`;
}

/**
 * Reads the complete versioned App projection. Git index/ignore state and Host
 * metadata are deliberately absent from this contract.
 */
export async function* readAppPackageTree(rootValue: string): AsyncIterable<AppPackageEntry> {
  for (const entry of await collectAppPackageTree(rootValue)) yield entry;
}

export async function collectAppPackageTree(rootValue: string): Promise<readonly AppPackageEntry[]> {
  const root = resolve(rootValue);
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("App package root must be a real directory");
  }
  const canonicalRoot = await realpath(root);
  const entries: AppPackageEntry[] = [];
  const exactPaths = new Set<string>();
  const portablePaths = new Map<string, string>();
  let totalBytes = 0;

  const visit = async (
    absoluteDirectory: string,
    relativeDirectory: string,
    expectedDirectory: BigIntStats,
  ): Promise<void> => {
    assertSameDirectory(expectedDirectory, await lstat(absoluteDirectory, { bigint: true }), relativeDirectory);
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => compareUtf8(left.name, right.name));
    for (const child of children) {
      if (relativeDirectory === "" && EXCLUDED_NAMES.has(child.name)) continue;
      if (child.name !== child.name.normalize("NFC")) {
        throw new Error(`Package path is not NFC-normalized: ${child.name}`);
      }
      const entryPath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      validateAppPackagePath(entryPath);
      if (exactPaths.has(entryPath)) throw new Error(`Duplicate package path: ${entryPath}`);
      exactPaths.add(entryPath);
      const portableKey = appPackagePortablePathKey(entryPath);
      const collision = portablePaths.get(portableKey);
      if (collision !== undefined) {
        throw new Error(`Package paths collide on a portable filesystem: ${collision}, ${entryPath}`);
      }
      portablePaths.set(portableKey, entryPath);

      const absolutePath = join(absoluteDirectory, child.name);
      const info = await lstat(absolutePath, { bigint: true });
      if (info.isSymbolicLink()) {
        throw new Error(`Package symlinks are not supported: ${entryPath}`);
      }
      const resolvedEntry = await realpath(absolutePath);
      assertContained(canonicalRoot, resolvedEntry);

      if (info.isDirectory()) {
        await visit(absolutePath, entryPath, info);
        continue;
      }
      if (!info.isFile()) throw new Error(`Unsupported package file type: ${entryPath}`);
      if (info.nlink !== 1n) throw new Error(`Package hard links are not supported: ${entryPath}`);
      if (info.size > BigInt(APP_PACKAGE_MAX_FILE_BYTES)) {
        throw new Error(`Package file exceeds 512 MiB: ${entryPath}`);
      }
      const bytes = await readStableFile(absolutePath, entryPath, info);
      totalBytes += bytes.byteLength;
      if (totalBytes > APP_PACKAGE_MAX_BYTES) throw new Error("App package exceeds 1 GiB");
      entries.push(Object.freeze({ path: entryPath, kind: "file", bytes }));
      if (entries.length > APP_PACKAGE_MAX_ENTRIES) {
        throw new Error("App package has too many entries");
      }
    }
    assertSameDirectory(expectedDirectory, await lstat(absoluteDirectory, { bigint: true }), relativeDirectory);
  };

  await visit(root, "", rootInfo);
  entries.sort(compareEntries);
  return Object.freeze(entries);
}

export function validateAppPackageTree(
  input: Iterable<AppPackageEntry>,
  expectedAppId: string,
): ValidatedAppPackage {
  const entries = [...input].map(copyAndValidateEntry).sort(compareEntries);
  if (entries.length > APP_PACKAGE_MAX_ENTRIES) throw new Error("App package has too many entries");
  const paths = new Set<string>();
  const portablePaths = new Map<string, string>();
  let totalBytes = 0;
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`Duplicate package path: ${entry.path}`);
    paths.add(entry.path);
    const portableKey = appPackagePortablePathKey(entry.path);
    const collision = portablePaths.get(portableKey);
    if (collision !== undefined) {
      throw new Error(`Package paths collide on a portable filesystem: ${collision}, ${entry.path}`);
    }
    portablePaths.set(portableKey, entry.path);
    if (entry.kind === "symlink") {
      throw new Error(`Package symlinks are not supported: ${entry.path}`);
    }
    totalBytes += entry.bytes.byteLength;
    if (totalBytes > APP_PACKAGE_MAX_BYTES) throw new Error("App package exceeds 1 GiB");
  }

  const manifestEntry = entries.find((entry) => entry.path === "manifest.json");
  if (!manifestEntry || manifestEntry.kind !== "file") {
    throw new Error("App package requires manifest.json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestEntry.bytes));
  } catch (error) {
    throw new Error("App package manifest.json is not valid UTF-8 JSON", { cause: error });
  }
  const validation = validateAppManifest(parsed, expectedAppId);
  if (!validation.ok) throw new Error(`Invalid App manifest: ${validation.error}`);

  return Object.freeze({
    appId: expectedAppId,
    manifest: validation.manifest,
    entries: Object.freeze(entries),
    digest: hashAppPackageTree(entries),
  });
}

export function hashAppPackageTree(entriesValue: Iterable<AppPackageEntry>): `sha256:${string}` {
  const entries = [...entriesValue].map(copyAndValidateEntry).sort(compareEntries);
  const hash = createHash("sha256").update(PACKAGE_DIGEST_PREFIX);
  for (const entry of entries) {
    const path = Buffer.from(entry.path, "utf8");
    const content = entry.kind === "file" ? Buffer.from(entry.bytes) : Buffer.from(entry.target, "utf8");
    const header = Buffer.alloc(17);
    header.writeUInt8(entry.kind === "file" ? 1 : 2, 0);
    header.writeBigUInt64BE(BigInt(path.byteLength), 1);
    header.writeBigUInt64BE(BigInt(content.byteLength), 9);
    hash.update(header).update(path).update(content);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Materializes a validated logical package into a new or empty directory. */
export async function materializeAppPackageTree(
  entriesValue: Iterable<AppPackageEntry>,
  destinationValue: string,
): Promise<void> {
  const entries = [...entriesValue].map(copyAndValidateEntry).sort(compareEntries);
  const destination = resolve(destinationValue);
  await mkdir(destination, { recursive: true, mode: 0o755 });
  for (const entry of entries) {
    if (entry.kind === "symlink") {
      throw new Error(`Package symlinks are not supported: ${entry.path}`);
    }
    const target = resolve(destination, ...entry.path.split("/"));
    assertContained(destination, target);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(entry.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(target, 0o644);
  }
}

/**
 * Replaces only projected package contents and preserves private excluded
 * roots. A caller-held lifecycle lock makes this the single writeback owner;
 * a retained pending ref supplies crash recovery until publication completes.
 */
export async function replaceAppPackageTree(
  rootValue: string,
  entriesValue: Iterable<AppPackageEntry>,
): Promise<void> {
  const root = resolve(rootValue);
  const parent = dirname(root);
  const stage = await mkdtemp(join(parent, `.${basename(root)}-package-stage-`));
  try {
    await materializeAppPackageTree(entriesValue, stage);
    const current = await readdir(root, { withFileTypes: true });
    for (const entry of current) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
    const staged = await readdir(stage, { withFileTypes: true });
    staged.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of staged) {
      await rename(join(stage, entry.name), join(root, entry.name));
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export function validateAppPackagePath(value: string): void {
  const utf8 = Buffer.from(value, "utf8");
  if (
    !value
    || value !== value.normalize("NFC")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || value.includes("//")
    || isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")
    || EXCLUDED_NAMES.has(value.split("/")[0]!)
    || utf8.byteLength > APP_PACKAGE_MAX_PATH_BYTES
  ) {
    throw new Error(`Invalid package path: ${JSON.stringify(value)}`);
  }
}

function copyAndValidateEntry(entry: AppPackageEntry): AppPackageEntry {
  validateAppPackagePath(entry.path);
  if (entry.kind === "file") {
    if (!(entry.bytes instanceof Uint8Array)) throw new Error(`Package file has invalid bytes: ${entry.path}`);
    if (entry.bytes.byteLength > APP_PACKAGE_MAX_FILE_BYTES) {
      throw new Error(`Package file exceeds 512 MiB: ${entry.path}`);
    }
    return Object.freeze({ path: entry.path, kind: "file", bytes: Uint8Array.from(entry.bytes) });
  }
  if (entry.kind === "symlink" && typeof entry.target === "string") {
    return Object.freeze({ path: entry.path, kind: "symlink", target: entry.target });
  }
  throw new Error(`Package entry has an unsupported kind: ${entry.path}`);
}

async function readStableFile(
  absolutePath: string,
  entryPath: string,
  expected: BigIntStats,
): Promise<Buffer> {
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertSameFile(expected, before, entryPath);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertSameFile(before, after, entryPath);
    const pathname = await lstat(absolutePath, { bigint: true });
    assertSameFile(after, pathname, entryPath);
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertSameFile(
  expected: BigIntStats,
  actual: BigIntStats,
  path: string,
): void {
  if (
    !actual.isFile()
    || actual.isSymbolicLink()
    || actual.nlink !== 1n
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.size !== expected.size
    || actual.mtimeNs !== expected.mtimeNs
    || actual.ctimeNs !== expected.ctimeNs
  ) {
    throw new Error(`Package file changed while reading: ${path}`);
  }
}

function assertSameDirectory(expected: BigIntStats, actual: BigIntStats, path: string): void {
  if (
    !actual.isDirectory()
    || actual.isSymbolicLink()
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.mtimeNs !== expected.mtimeNs
    || actual.ctimeNs !== expected.ctimeNs
  ) {
    throw new Error(`Package directory changed while reading: ${path || "."}`);
  }
}

export function appPackagePortablePathKey(path: string): string {
  return path.toLocaleLowerCase("en-US");
}

function compareEntries(left: AppPackageEntry, right: AppPackageEntry): number {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertContained(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) return;
  throw new Error(`Package entry escapes root: ${basename(candidate)}`);
}
