import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";

export interface DependencyBundleEntry {
  resolved: string;
  integrity: string;
  bytes: number;
  file: string;
}

export interface DependencyBundleManifest {
  version: 1;
  entries: DependencyBundleEntry[];
}

export const MAX_DEPENDENCY_MANIFEST_BYTES = 64 * 1024 * 1024;

export async function validateDependencyBundle(
  root: string,
  signal?: AbortSignal,
): Promise<DependencyBundleManifest> {
  const manifestValue = await readBoundedManifest(`${root}/manifest.json`, signal);
  const manifestObject = exactObject(manifestValue, "dependency manifest", ["version", "entries"]);
  if (manifestObject.version !== 1) throw new Error("dependency manifest version must be 1");
  if (!Array.isArray(manifestObject.entries) || manifestObject.entries.length > 100_000) {
    throw new Error("dependency manifest entries must be an array of at most 100000 items");
  }
  const entries: DependencyBundleEntry[] = [];
  const identities = new Set<string>();
  const files = new Set<string>();
  let previousIdentity: string | undefined;
  for (let index = 0; index < manifestObject.entries.length; index += 1) {
    throwIfAborted(signal);
    const raw = exactObject(manifestObject.entries[index], `dependency entry ${index}`, [
      "resolved",
      "integrity",
      "bytes",
      "file",
    ]);
    const resolved = validateRegistryResolved(raw.resolved, `dependency entry ${index}.resolved`);
    const integrity = validateSha512Integrity(raw.integrity, `dependency entry ${index}.integrity`);
    if (!Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 1 || (raw.bytes as number) > 512 * 1024 * 1024) {
      throw new Error(`dependency entry ${index}.bytes is outside the allowed range`);
    }
    const digestHex = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
    const expectedFile = `tarballs/${digestHex}.tgz`;
    if (raw.file !== expectedFile) {
      throw new Error(`dependency entry ${index}.file must be ${expectedFile}`);
    }
    const identity = `${resolved}\0${integrity}`;
    if (previousIdentity !== undefined && Buffer.compare(Buffer.from(previousIdentity), Buffer.from(identity)) >= 0) {
      throw new Error("dependency manifest entries must be strictly bytewise sorted");
    }
    previousIdentity = identity;
    if (identities.has(identity)) throw new Error("dependency manifest contains a duplicate package identity");
    if (files.has(expectedFile)) throw new Error("dependency manifest contains a duplicate tarball file");
    identities.add(identity);
    files.add(expectedFile);
    const entry: DependencyBundleEntry = {
      resolved,
      integrity,
      bytes: raw.bytes as number,
      file: expectedFile,
    };
    await verifyTarball(root, entry, signal);
    entries.push(entry);
  }
  await assertClosedBundleTree(root, files, signal);
  return { version: 1, entries };
}

export function validatePackageLock(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("package-lock.json must be an object");
  if (value.lockfileVersion !== 2 && value.lockfileVersion !== 3) {
    throw new Error("package-lock.json lockfileVersion must be 2 or 3");
  }
  if (!isPlainObject(value.packages)) throw new Error("package-lock.json packages must be an object");
  return value;
}

export function rewritePackageLockForBroker(
  value: unknown,
  manifest: DependencyBundleManifest,
  brokerOrigin: string,
): { lock: Record<string, unknown>; usedEntries: number } {
  const lock = structuredClone(validatePackageLock(value));
  const packages = lock.packages as Record<string, unknown>;
  const available = new Map<string, DependencyBundleEntry>(
    manifest.entries.map((entry) => [`${entry.resolved}\0${entry.integrity}`, entry] as const),
  );
  const used = new Set<string>();
  for (const [packagePath, rawPackage] of Object.entries(packages)) {
    if (packagePath === "") continue;
    if (!isPlainObject(rawPackage)) throw new Error(`package-lock package ${packagePath} must be an object`);
    if (rawPackage.link === true) {
      validateWorkspaceLink(rawPackage.resolved, `${packagePath}.resolved`);
      continue;
    }
    const resolved = validateRegistryResolved(rawPackage.resolved, `${packagePath}.resolved`);
    const integrity = validateSha512Integrity(rawPackage.integrity, `${packagePath}.integrity`);
    const identity = `${resolved}\0${integrity}`;
    const entry = available.get(identity);
    if (!entry) throw new Error(`dependency bundle is missing ${resolved} with exact lock integrity`);
    rawPackage.resolved = `${brokerOrigin}/${entry.file}`;
    used.add(identity);
  }
  if (used.size !== available.size) {
    const extra = [...available.keys()].find((identity) => !used.has(identity));
    throw new Error(`dependency bundle contains an unreferenced tarball ${extra?.split("\0")[0]}`);
  }
  return { lock, usedEntries: used.size };
}

export function packageLockHasRegistryPackages(value: unknown): boolean {
  const lock = validatePackageLock(value);
  return Object.entries(lock.packages as Record<string, unknown>).some(([path, entry]) => {
    if (path === "") return false;
    return !isPlainObject(entry) || entry.link !== true;
  });
}

export function validateWorkspaceLink(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new Error(`${label} must be a bounded relative path`);
  }
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.includes("//")) {
    throw new Error(`${label} must stay inside the package workspace`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} contains traversal or non-canonical segments`);
  }
  return value;
}

export function validateRegistryResolved(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new Error(`${label} must be a bounded URL string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "registry.npmjs.org"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) {
    throw new Error(`${label} must be an exact registry.npmjs.org HTTPS tarball URL`);
  }
  return url.toString();
}

export function validateSha512Integrity(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) {
    throw new Error(`${label} must be one canonical sha512 SRI value`);
  }
  const decoded = Buffer.from(value.slice("sha512-".length), "base64");
  if (decoded.byteLength !== 64 || decoded.toString("base64") !== value.slice("sha512-".length)) {
    throw new Error(`${label} is not canonical sha512 base64`);
  }
  return value;
}

async function verifyTarball(
  root: string,
  entry: DependencyBundleEntry,
  signal?: AbortSignal,
): Promise<void> {
  const path = `${root}/${entry.file}`;
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    throw new Error(`dependency tarball ${entry.file} must be one regular file`);
  }
  if (details.size !== entry.bytes) throw new Error(`dependency tarball ${entry.file} size mismatch`);
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) {
    throwIfAborted(signal);
    hash.update(chunk);
  }
  const integrity = `sha512-${hash.digest("base64")}`;
  if (integrity !== entry.integrity) throw new Error(`dependency tarball ${entry.file} integrity mismatch`);
}

async function assertClosedBundleTree(
  root: string,
  expectedFiles: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const top = await opendir(root);
  const topNames: string[] = [];
  for await (const entry of top) {
    throwIfAborted(signal);
    topNames.push(entry.name);
  }
  topNames.sort();
  if (topNames.join("\0") !== "manifest.json\0tarballs") {
    throw new Error("dependency bundle root may contain only manifest.json and tarballs/");
  }
  const manifest = await lstat(`${root}/manifest.json`);
  const tarballs = await lstat(`${root}/tarballs`);
  if (!manifest.isFile() || manifest.isSymbolicLink() || !tarballs.isDirectory() || tarballs.isSymbolicLink()) {
    throw new Error("dependency bundle has invalid root entry types");
  }
  const directory = await opendir(`${root}/tarballs`);
  const actualFiles = new Set<string>();
  for await (const entry of directory) {
    throwIfAborted(signal);
    if (!entry.isFile()) throw new Error("dependency tarballs directory may contain regular files only");
    actualFiles.add(`tarballs/${entry.name}`);
  }
  if (
    actualFiles.size !== expectedFiles.size
    || [...actualFiles].some((file) => !expectedFiles.has(file))
  ) {
    throw new Error("dependency tarballs directory differs from the closed manifest");
  }
}

async function readBoundedManifest(path: string, signal?: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_DEPENDENCY_MANIFEST_BYTES) {
      throw new Error(
        `dependency manifest exceeds the ${MAX_DEPENDENCY_MANIFEST_BYTES}-byte Guest parse bound`,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_DEPENDENCY_MANIFEST_BYTES) {
      throw new Error(
        `dependency manifest exceeds the ${MAX_DEPENDENCY_MANIFEST_BYTES}-byte Guest parse bound`,
      );
    }
    throwIfAborted(signal);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error("dependency manifest is not valid UTF-8", { cause: error });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error("dependency manifest is not valid JSON", { cause: error });
    }
  } finally {
    await handle.close();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("dependency validation aborted");
}

function exactObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
