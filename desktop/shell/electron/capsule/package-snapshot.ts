import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  openSync,
  type BigIntStats,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  appPackagePortablePathKey,
  validateAppPackagePath,
} from "../../../core/src/apps/package-tree";
import {
  normalizeCapsuleStorageError,
  type CapsuleStorageBudgetLike,
  type CapsuleStorageReservation,
} from "./storage-budget";

export const CAPSULE_TREE_FORMAT = "capsule-tree-v1" as const;
export const CAPSULE_TREE_MAGIC = Buffer.from("LCAPT001", "ascii");
const HEADER_BYTES = 16;
const TYPE_DIRECTORY = 1;
const TYPE_FILE = 2;
const MAX_ENTRIES = 100_000;
const MAX_PATH_BYTES = 4_096;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const EXCLUDED_NAMES = new Set([".git", ".lamarck", "node_modules"]);

interface TreeEntry {
  readonly path: string;
  readonly pathBytes: Buffer;
  readonly type: typeof TYPE_DIRECTORY | typeof TYPE_FILE;
  readonly mode: 0o755 | 0o644;
  readonly size: number;
}

interface SnapshotEntry extends TreeEntry {
  readonly absolutePath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
}

interface VirtualSnapshotEntry extends TreeEntry {
  readonly content?: Uint8Array | AsyncIterable<Uint8Array>;
}

export interface CapsuleTreeSnapshot {
  readonly format: typeof CAPSULE_TREE_FORMAT;
  readonly digest: `sha256:${string}`;
  readonly bytes: number;
  readonly entries: number;
  readonly path: string;
  createReadStream(): ReturnType<typeof createReadStream>;
}

export interface CapsulePackageSnapshot extends CapsuleTreeSnapshot {
  /** Canonical logical App package identity shared with Core versioning. */
  readonly packageDigest: `sha256:${string}`;
}

interface CapsuleSnapshotWriterDependencies {
  removeTemporary(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  afterPublication(published: boolean): Promise<void>;
}

const DEFAULT_SNAPSHOT_WRITER_DEPENDENCIES: CapsuleSnapshotWriterDependencies = {
  async removeTemporary(path) {
    await rm(path, { force: true });
  },
  syncDirectory,
  async afterPublication() {},
};

const SNAPSHOT_PUBLICATION_TAILS = new Map<string, Promise<void>>();
const SNAPSHOT_PUBLICATION_QUARANTINE = new Map<string, Error>();

export type CapsuleVirtualTreeEntry =
  | {
      readonly type: "directory";
      readonly path: string;
    }
  | {
      readonly type: "file";
      readonly path: string;
      /** Exact byte count; the writer fails closed if the stream differs. */
      readonly contentBytes: number;
      /** Byte content only: this contract deliberately accepts no Host source path. */
      readonly content: Uint8Array | AsyncIterable<Uint8Array>;
      readonly executable?: boolean;
    };

/** Materializes a race-detected, immutable package snapshot in Host-private CAS. */
export async function createCapsulePackageSnapshot(options: {
  packageDir: string;
  cacheDir: string;
  ownerKey?: string;
  storageBudget?: CapsuleStorageBudgetLike;
  /** Deterministic managed-writer seams; production uses unlink(2) and directory fsync. */
  snapshotWriter?: Partial<CapsuleSnapshotWriterDependencies>;
}): Promise<CapsulePackageSnapshot> {
  const packageDir = resolve(options.packageDir);
  const packageInfo = await lstat(packageDir, { bigint: true });
  if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) {
    throw new Error("App package root must be a real directory");
  }
  const canonicalRoot = await realpath(packageDir);
  const canonicalCache = await prepareSnapshotCache(options.cacheDir, {
    lexical: packageDir,
    canonical: canonicalRoot,
  });
  const entries = await collectEntries(packageDir, canonicalRoot, packageInfo);
  return await writeCapsuleTreeSnapshot(entries, canonicalCache, async () => {
    await assertTreeStable(packageDir, packageInfo, entries);
  }, storageOptions(options), snapshotWriter(options.snapshotWriter), true) as CapsulePackageSnapshot;
}

/**
 * Seals Host-produced logical files without granting this encoder authority to
 * resolve caller-selected filesystem paths or follow links.
 */
export async function createCapsuleVirtualTreeSnapshot(options: {
  entries: readonly CapsuleVirtualTreeEntry[];
  cacheDir: string;
  ownerKey?: string;
  storageBudget?: CapsuleStorageBudgetLike;
  storageScope?: "package-snapshot" | "dependency-cache";
  /** Deterministic managed-writer seams; production uses unlink(2) and directory fsync. */
  snapshotWriter?: Partial<CapsuleSnapshotWriterDependencies>;
}): Promise<CapsuleTreeSnapshot> {
  const entries = normalizeVirtualEntries(options.entries);
  const canonicalCache = await prepareSnapshotCache(options.cacheDir);
  return writeCapsuleTreeSnapshot(
    entries,
    canonicalCache,
    undefined,
    storageOptions(options),
    snapshotWriter(options.snapshotWriter),
  );
}

/**
 * Reads one bounded file only after validating the complete immutable tree,
 * including its digest. This lets build policy inspect the captured lockfile
 * instead of racing a second read from the live App package.
 */
export async function readCapsuleTreeFile(
  snapshot: Pick<CapsuleTreeSnapshot, "path" | "digest" | "bytes">,
  treePath: string,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const selection = await readCapsuleTreeSelection(snapshot, [{ path: treePath, maxBytes }]);
  return selection.contents.get(treePath);
}

export interface CapsuleTreeSelection {
  readonly present: ReadonlySet<string>;
  readonly contents: ReadonlyMap<string, Buffer>;
}

/** Validates and hashes the immutable tree once while selecting bounded files
 * and/or checking path presence for Host build policy. */
export async function readCapsuleTreeSelection(
  snapshot: Pick<CapsuleTreeSnapshot, "path" | "digest" | "bytes">,
  requests: readonly { path: string; maxBytes?: number }[],
): Promise<CapsuleTreeSelection> {
  const requested = new Map<string, number | undefined>();
  for (const request of requests) {
    validateRelativePath(request.path);
    if (
      request.maxBytes !== undefined
      && (
        !Number.isSafeInteger(request.maxBytes)
        || request.maxBytes < 0
        || request.maxBytes > MAX_FILE_BYTES
      )
    ) {
      throw new Error("Capsule tree read bound is invalid");
    }
    if (requested.has(request.path)) {
      throw new Error(`Capsule tree path was requested more than once: ${request.path}`);
    }
    requested.set(request.path, request.maxBytes);
  }
  if (
    !Number.isSafeInteger(snapshot.bytes)
    || snapshot.bytes < CAPSULE_TREE_MAGIC.byteLength + HEADER_BYTES
    || snapshot.bytes > MAX_SNAPSHOT_BYTES
    || !/^sha256:[0-9a-f]{64}$/.test(snapshot.digest)
  ) {
    throw new Error("Capsule tree snapshot identity is invalid");
  }

  const input = await open(
    snapshot.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await input.stat({ bigint: true });
    if (
      !before.isFile()
      || before.size !== BigInt(snapshot.bytes)
      || (Number(before.mode) & 0o777) !== 0o400
    ) {
      throw new Error("Capsule tree snapshot file is invalid");
    }
    const reader = new HashedFileReader(input);
    const magic = await reader.readExact(CAPSULE_TREE_MAGIC.byteLength);
    if (!magic.equals(CAPSULE_TREE_MAGIC)) throw new Error("Capsule tree magic mismatch");

    const directories = new Set<string>();
    let previousPathBytes: Buffer | undefined;
    const present = new Set<string>();
    const contents = new Map<string, Buffer>();
    let entries = 0;
    for (;;) {
      const header = await reader.readExact(HEADER_BYTES);
      const type = decodeRecordType(header);
      if (type === 0) break;
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error("Capsule tree has too many entries");
      const mode = header.readUInt16BE(2);
      const pathLength = header.readUInt32BE(4);
      const contentLengthBig = header.readBigUInt64BE(8);
      validateRecordHeader(type, mode, pathLength, contentLengthBig);
      const pathBytes = await reader.readExact(pathLength);
      if (previousPathBytes && Buffer.compare(previousPathBytes, pathBytes) >= 0) {
        throw new Error("Capsule tree paths are not strictly ordered");
      }
      previousPathBytes = pathBytes;
      const path = decodeTreePath(pathBytes);
      const parent = treeParent(path);
      if (parent && !directories.has(parent)) {
        throw new Error(`Capsule tree parent was not declared: ${path}`);
      }
      const contentLength = Number(contentLengthBig);
      if (type === TYPE_DIRECTORY) {
        directories.add(path);
        if (requested.has(path)) {
          present.add(path);
          if (requested.get(path) !== undefined) {
            throw new Error(`Capsule tree path is not a file: ${path}`);
          }
        }
        continue;
      }
      if (requested.has(path)) {
        present.add(path);
        const maxBytes = requested.get(path);
        if (maxBytes !== undefined) {
          if (contentLength > maxBytes) {
            throw new Error(`Capsule tree file exceeds read bound: ${path}`);
          }
          contents.set(path, await reader.readExact(contentLength));
        } else {
          await reader.skip(contentLength);
        }
      } else {
        await reader.skip(contentLength);
      }
    }
    await reader.assertEof(snapshot.bytes);
    const after = await input.stat({ bigint: true });
    if (
      !after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || `sha256:${reader.digest()}` !== snapshot.digest
    ) {
      throw new Error("Capsule tree snapshot integrity check failed");
    }
    return Object.freeze({ present, contents });
  } finally {
    await input.close();
  }
}

async function writeCapsuleTreeSnapshot(
  entries: readonly (SnapshotEntry | VirtualSnapshotEntry)[],
  canonicalCache: string,
  beforeSeal?: () => Promise<void>,
  storage?: {
    ownerKey: string;
    budget: CapsuleStorageBudgetLike;
    scope: "package-snapshot" | "dependency-cache";
  },
  writer: CapsuleSnapshotWriterDependencies = DEFAULT_SNAPSHOT_WRITER_DEPENDENCIES,
  logicalPackage = false,
): Promise<CapsuleTreeSnapshot | CapsulePackageSnapshot> {
  const expectedBytes = encodedTreeBytes(entries);
  let reservation: CapsuleStorageReservation | undefined;
  if (storage) {
    reservation = await storage.budget.reserve({
      owner: storage.ownerKey,
      scope: storage.scope,
      bytes: expectedBytes,
    });
  }
  const temporaryPath = join(
    canonicalCache,
    `.snapshot-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  let output: Awaited<ReturnType<typeof open>>;
  try {
    output = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    await reservation?.release();
    throw normalizeCapsuleStorageError(error, "Capsule package snapshot storage is full");
  }
  const hash = createHash("sha256");
  const packageHash = logicalPackage
    ? createHash("sha256").update(Buffer.from("lamarck-app-package-v1\0", "utf8"))
    : undefined;
  let bytes = 0;

  const append = async (chunk: Uint8Array) => {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("App package snapshot exceeds 1 GiB");
    hash.update(value);
    await writeAll(output, value);
  };

  try {
    await append(CAPSULE_TREE_MAGIC);
    for (const entry of entries) {
      await append(encodeHeader(entry));
      await append(entry.pathBytes);
      if (entry.type !== TYPE_FILE) continue;
      if (packageHash) {
        const packageHeader = Buffer.alloc(17);
        packageHeader.writeUInt8(1, 0);
        packageHeader.writeBigUInt64BE(BigInt(entry.pathBytes.byteLength), 1);
        packageHeader.writeBigUInt64BE(BigInt(entry.size), 9);
        packageHash.update(packageHeader).update(entry.pathBytes);
      }
      let contentBytes = 0;
      await streamEntryContent(entry, async (chunk) => {
        if (!(chunk instanceof Uint8Array)) throw new Error(`Tree file emitted non-byte content: ${entry.path}`);
        contentBytes += chunk.byteLength;
        if (contentBytes > entry.size) throw contentSizeError(entry);
        packageHash?.update(chunk);
        await append(chunk);
      });
      if (contentBytes !== entry.size) throw contentSizeError(entry);
    }
    await beforeSeal?.();
    await append(Buffer.alloc(HEADER_BYTES));
    await output.sync();
    await output.chmod(0o400);
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await output.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    try {
      await removeSnapshotTemporaryDurably(temporaryPath, canonicalCache, writer);
    } catch (cleanupError) {
      failures.push(cleanupError);
      throw normalizeCapsuleStorageError(
        combinedManagedWriterError("Capsule package snapshot cleanup failed", failures),
        "Capsule package snapshot cleanup failed",
      );
    }
    await reservation?.release();
    throw normalizeCapsuleStorageError(
      combinedManagedWriterError("Capsule package snapshot write failed", failures),
      "Capsule package snapshot storage is full",
    );
  }
  try {
    await output.close();
  } catch (error) {
    try {
      await removeSnapshotTemporaryDurably(temporaryPath, canonicalCache, writer);
    } catch (cleanupError) {
      throw normalizeCapsuleStorageError(
        combinedManagedWriterError(
          "Capsule package snapshot cleanup failed",
          [error, cleanupError],
        ),
        "Capsule package snapshot cleanup failed",
      );
    }
    await reservation?.release();
    throw normalizeCapsuleStorageError(error, "Capsule package snapshot storage is full");
  }

  const hex = hash.digest("hex");
  const finalPath = join(canonicalCache, `${hex}.tree`);
  let published = false;
  let cleanupAttempted = false;
  let cleanupConfirmed = false;
  try {
    return await withSnapshotPublicationLock(finalPath, async () => {
      const quarantined = SNAPSHOT_PUBLICATION_QUARANTINE.get(finalPath);
      if (quarantined) {
        throw new Error("Capsule package snapshot publication is quarantined", {
          cause: quarantined,
        });
      }
      let publicationError: unknown;
      try {
        // link(2) publishes without replacing an existing content-addressed object.
        // rename(2) would silently clobber the winner on POSIX.
        await link(temporaryPath, finalPath);
        published = true;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          publicationError = error;
        } else {
          try {
            await assertCasFile(finalPath, bytes, hex);
          } catch (winnerError) {
            publicationError = winnerError;
          }
        }
      }
      if (publicationError === undefined) {
        try {
          await writer.afterPublication(published);
        } catch (error) {
          publicationError = error;
        }
      }

      cleanupAttempted = true;
      try {
        await removeSnapshotTemporaryDurably(temporaryPath, canonicalCache, writer);
        cleanupConfirmed = true;
      } catch (cleanupError) {
        const failure = combinedManagedWriterError(
          "Capsule package snapshot cleanup failed",
          publicationError === undefined
            ? [cleanupError]
            : [publicationError, cleanupError],
        );
        SNAPSHOT_PUBLICATION_QUARANTINE.set(finalPath, failure);
        throw failure;
      }
      if (publicationError !== undefined) {
        if (published) {
          SNAPSHOT_PUBLICATION_QUARANTINE.set(finalPath, asManagedWriterError(publicationError));
        }
        throw publicationError;
      }

      try {
        await reservation?.commit(published ? bytes : 0, published ? finalPath : undefined);
        if (storage) {
          await storage.budget.claim({
            owner: storage.ownerKey,
            scope: storage.scope,
            path: finalPath,
            bytes,
          });
        }
      } catch (error) {
        if (published) {
          SNAPSHOT_PUBLICATION_QUARANTINE.set(finalPath, asManagedWriterError(error));
        }
        throw error;
      }

      return Object.freeze({
        format: CAPSULE_TREE_FORMAT,
        digest: `sha256:${hex}` as const,
        ...(packageHash === undefined
          ? {}
          : { packageDigest: `sha256:${packageHash.digest("hex")}` as const }),
        bytes,
        entries: entries.length,
        path: finalPath,
        createReadStream: () => openCasReadStream(finalPath),
      });
    });
  } catch (error) {
    if (!cleanupAttempted) {
      try {
        cleanupAttempted = true;
        await removeSnapshotTemporaryDurably(temporaryPath, canonicalCache, writer);
        cleanupConfirmed = true;
      } catch (cleanupError) {
        const failure = combinedManagedWriterError(
          "Capsule package snapshot cleanup failed",
          [error, cleanupError],
        );
        SNAPSHOT_PUBLICATION_QUARANTINE.set(finalPath, failure);
        throw normalizeCapsuleStorageError(failure, "Capsule package snapshot cleanup failed");
      }
    }
    if (!published && cleanupConfirmed) await reservation?.release();
    throw normalizeCapsuleStorageError(error, "Capsule package snapshot publication failed");
  }
}

function storageOptions(options: {
  ownerKey?: string;
  storageBudget?: CapsuleStorageBudgetLike;
  storageScope?: "package-snapshot" | "dependency-cache";
}): {
  ownerKey: string;
  budget: CapsuleStorageBudgetLike;
  scope: "package-snapshot" | "dependency-cache";
} | undefined {
  if (!options.storageBudget && !options.ownerKey) return undefined;
  if (!options.storageBudget || !options.ownerKey) {
    throw new Error("Capsule snapshot storage owner and budget must be supplied together");
  }
  return {
    ownerKey: options.ownerKey,
    budget: options.storageBudget,
    scope: options.storageScope ?? "package-snapshot",
  };
}

function snapshotWriter(
  overrides: Partial<CapsuleSnapshotWriterDependencies> | undefined,
): CapsuleSnapshotWriterDependencies {
  return { ...DEFAULT_SNAPSHOT_WRITER_DEPENDENCIES, ...overrides };
}

async function removeSnapshotTemporaryDurably(
  path: string,
  directory: string,
  writer: CapsuleSnapshotWriterDependencies,
): Promise<void> {
  await writer.removeTemporary(path);
  await writer.syncDirectory(directory);
}

async function withSnapshotPublicationLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = SNAPSHOT_PUBLICATION_TAILS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  SNAPSHOT_PUBLICATION_TAILS.set(key, current);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (SNAPSHOT_PUBLICATION_TAILS.get(key) === current) {
      SNAPSHOT_PUBLICATION_TAILS.delete(key);
    }
  }
}

function asManagedWriterError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function combinedManagedWriterError(message: string, errors: readonly unknown[]): Error {
  return errors.length === 1
    ? asManagedWriterError(errors[0])
    : new AggregateError(errors, message);
}

function encodedTreeBytes(entries: readonly TreeEntry[]): number {
  let bytes = CAPSULE_TREE_MAGIC.byteLength + HEADER_BYTES;
  for (const entry of entries) {
    bytes += HEADER_BYTES + entry.pathBytes.byteLength + entry.size;
    if (!Number.isSafeInteger(bytes) || bytes > MAX_SNAPSHOT_BYTES) {
      throw new Error("App package snapshot exceeds 1 GiB");
    }
  }
  return bytes;
}

async function prepareSnapshotCache(
  requestedCacheDir: string,
  forbiddenRoot?: { lexical: string; canonical: string },
): Promise<string> {
  const cacheDir = resolve(requestedCacheDir);
  const prospectiveCanonicalCache = await canonicalizeProspectivePath(cacheDir);
  if (forbiddenRoot && (
    isSameOrDescendant(forbiddenRoot.lexical, cacheDir)
    || isSameOrDescendant(forbiddenRoot.canonical, prospectiveCanonicalCache)
  )) {
    throw new Error("App package snapshot cache must be outside the App package");
  }
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const cacheInfo = await lstat(cacheDir, { bigint: true });
  if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) {
    throw new Error("App package snapshot cache must be a real directory");
  }
  const canonicalCache = await realpath(cacheDir);
  if (forbiddenRoot && isSameOrDescendant(forbiddenRoot.canonical, canonicalCache)) {
    throw new Error("App package snapshot cache must be outside the App package");
  }
  await chmod(canonicalCache, 0o700);
  return canonicalCache;
}

function normalizeVirtualEntries(
  input: readonly CapsuleVirtualTreeEntry[],
): VirtualSnapshotEntry[] {
  if (input.length > MAX_ENTRIES) throw new Error("Capsule tree has too many entries");
  const seenPaths = new Set<string>();
  const entries = input.map((entry): VirtualSnapshotEntry => {
    validateRelativePath(entry.path);
    if (seenPaths.has(entry.path)) throw new Error(`Duplicate capsule tree path: ${entry.path}`);
    seenPaths.add(entry.path);
    const pathBytes = Buffer.from(entry.path, "utf8");
    if (pathBytes.byteLength > MAX_PATH_BYTES) throw new Error(`Capsule tree path is too long: ${entry.path}`);
    if (entry.type === "directory") {
      return {
        type: TYPE_DIRECTORY,
        path: entry.path,
        pathBytes,
        mode: 0o755,
        size: 0,
      };
    }
    if (
      !Number.isSafeInteger(entry.contentBytes)
      || entry.contentBytes < 0
      || entry.contentBytes > MAX_FILE_BYTES
    ) {
      throw new Error(`Capsule tree file exceeds 512 MiB: ${entry.path}`);
    }
    const content = entry.content instanceof Uint8Array
      ? Buffer.from(entry.content)
      : entry.content;
    if (!isAsyncByteIterable(content)) {
      throw new Error(`Capsule tree file has no byte content: ${entry.path}`);
    }
    return {
      type: TYPE_FILE,
      path: entry.path,
      pathBytes,
      mode: entry.executable ? 0o755 : 0o644,
      size: entry.contentBytes,
      content,
    };
  });
  entries.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  ensureParentsPrecedeChildren(entries);
  return entries;
}

async function streamEntryContent(
  entry: SnapshotEntry | VirtualSnapshotEntry,
  emit: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  if ("absolutePath" in entry) {
    const input = await open(
      entry.absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      assertStableFile(entry, await input.stat({ bigint: true }));
      for await (const chunk of input.createReadStream({ autoClose: false })) await emit(chunk);
      assertStableFile(entry, await input.stat({ bigint: true }));
    } finally {
      await input.close();
    }
    return;
  }
  if (entry.content instanceof Uint8Array) {
    await emit(entry.content);
    return;
  }
  if (!entry.content) throw new Error(`Capsule tree file has no byte content: ${entry.path}`);
  for await (const chunk of entry.content) await emit(chunk);
}

function contentSizeError(entry: SnapshotEntry | VirtualSnapshotEntry): Error {
  return "absolutePath" in entry
    ? new Error(`Package file changed while snapshotting: ${entry.path}`)
    : new Error(`Capsule tree file did not match declared size: ${entry.path}`);
}

function isAsyncByteIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return value instanceof Uint8Array || (
    typeof value === "object"
    && value !== null
    && Symbol.asyncIterator in value
    && typeof value[Symbol.asyncIterator] === "function"
  );
}

async function collectEntries(
  root: string,
  canonicalRoot: string,
  rootInfo: BigIntStats,
): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  const seenPaths = new Set<string>();
  const portablePaths = new Map<string, string>();

  const visit = async (
    absoluteDirectory: string,
    relativeDirectory: string,
    expected: BigIntStats,
  ): Promise<void> => {
    assertStableDirectory(relativeDirectory, expected, await lstat(absoluteDirectory, { bigint: true }));
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => compareUtf8(left.name.normalize("NFC"), right.name.normalize("NFC")));
    for (const child of children) {
      if (relativeDirectory === "" && EXCLUDED_NAMES.has(child.name)) continue;
      const normalizedName = child.name.normalize("NFC");
      if (normalizedName !== child.name) {
        throw new Error(`Package path is not NFC-normalized: ${child.name}`);
      }
      const entryPath = relativeDirectory ? `${relativeDirectory}/${normalizedName}` : normalizedName;
      // Version admission and Capsule runtime packaging share the exact Core
      // projection path/exclusion contract.
      validateAppPackagePath(entryPath);
      validateRelativePath(entryPath);
      if (seenPaths.has(entryPath)) throw new Error(`Duplicate normalized package path: ${entryPath}`);
      seenPaths.add(entryPath);
      const portableKey = appPackagePortablePathKey(entryPath);
      const collision = portablePaths.get(portableKey);
      if (collision !== undefined) {
        throw new Error(`Package paths collide on a portable filesystem: ${collision}, ${entryPath}`);
      }
      portablePaths.set(portableKey, entryPath);

      const absolutePath = join(absoluteDirectory, child.name);
      const info = await lstat(absolutePath, { bigint: true });
      if (info.isSymbolicLink()) throw new Error(`Package symlinks are not supported: ${entryPath}`);
      const resolved = await realpath(absolutePath);
      assertContained(canonicalRoot, resolved);
      const pathBytes = Buffer.from(entryPath, "utf8");
      if (pathBytes.byteLength > MAX_PATH_BYTES) throw new Error(`Package path is too long: ${entryPath}`);

      if (info.isDirectory()) {
        entries.push(snapshotEntry(absolutePath, entryPath, pathBytes, TYPE_DIRECTORY, 0o755, 0, info));
        if (entries.length > MAX_ENTRIES) throw new Error("App package has too many entries");
        await visit(absolutePath, entryPath, info);
        continue;
      }
      if (!info.isFile()) throw new Error(`Unsupported package file type: ${entryPath}`);
      if (info.nlink !== 1n) throw new Error(`Package hard links are not supported: ${entryPath}`);
      const size = Number(info.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
        throw new Error(`Package file exceeds 512 MiB: ${entryPath}`);
      }
      entries.push(snapshotEntry(
        absolutePath,
        entryPath,
        pathBytes,
        TYPE_FILE,
        // App source executability is Capsule policy, not Host workspace
        // metadata. Dependency artifacts use the separate virtual-tree path
        // and retain the modes produced by the dependency build.
        0o755,
        size,
        info,
      ));
      if (entries.length > MAX_ENTRIES) throw new Error("App package has too many entries");
    }
    assertStableDirectory(relativeDirectory, expected, await lstat(absoluteDirectory, { bigint: true }));
  };

  await visit(root, "", rootInfo);
  entries.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  ensureParentsPrecedeChildren(entries);
  return entries;
}

function snapshotEntry(
  absolutePath: string,
  path: string,
  pathBytes: Buffer,
  type: typeof TYPE_DIRECTORY | typeof TYPE_FILE,
  mode: 0o755 | 0o644,
  size: number,
  info: BigIntStats,
): SnapshotEntry {
  return {
    absolutePath,
    path,
    pathBytes,
    type,
    mode,
    size,
    device: info.dev,
    inode: info.ino,
    modifiedNs: info.mtimeNs,
    changedNs: info.ctimeNs,
  };
}

function encodeHeader(entry: TreeEntry): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(entry.type, 0);
  header.writeUInt8(0, 1);
  header.writeUInt16BE(entry.mode, 2);
  header.writeUInt32BE(entry.pathBytes.byteLength, 4);
  header.writeBigUInt64BE(BigInt(entry.size), 8);
  return header;
}

function assertStableFile(
  entry: SnapshotEntry,
  info: BigIntStats,
): void {
  if (
    !info.isFile()
    || info.nlink !== 1n
    || info.dev !== entry.device
    || info.ino !== entry.inode
    || info.size !== BigInt(entry.size)
    || info.mtimeNs !== entry.modifiedNs
    || info.ctimeNs !== entry.changedNs
  ) {
    throw new Error(`Package file changed while snapshotting: ${entry.path}`);
  }
}

async function assertTreeStable(
  root: string,
  rootInfo: BigIntStats,
  entries: readonly SnapshotEntry[],
): Promise<void> {
  assertStableDirectory("", rootInfo, await lstat(root, { bigint: true }));
  for (const entry of entries) {
    const info = await lstat(entry.absolutePath, { bigint: true });
    if (entry.type === TYPE_FILE) assertStableFile(entry, info);
    else assertStableDirectoryEntry(entry, info);
  }
}

function assertStableDirectoryEntry(entry: SnapshotEntry, info: BigIntStats): void {
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || info.dev !== entry.device
    || info.ino !== entry.inode
    || info.mtimeNs !== entry.modifiedNs
    || info.ctimeNs !== entry.changedNs
  ) {
    throw new Error(`Package directory changed while snapshotting: ${entry.path}`);
  }
}

function assertStableDirectory(path: string, expected: BigIntStats, actual: BigIntStats): void {
  if (
    !actual.isDirectory()
    || actual.isSymbolicLink()
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.mtimeNs !== expected.mtimeNs
    || actual.ctimeNs !== expected.ctimeNs
  ) {
    throw new Error(`Package directory changed while snapshotting: ${path || "."}`);
  }
}

function ensureParentsPrecedeChildren(entries: readonly TreeEntry[]): void {
  const directories = new Set<string>();
  for (const entry of entries) {
    const parent = dirname(entry.path);
    if (parent !== "." && !directories.has(parent)) {
      throw new Error(`Package entry is missing its parent directory: ${entry.path}`);
    }
    if (entry.type === TYPE_DIRECTORY) directories.add(entry.path);
  }
}

function validateRelativePath(value: string): void {
  if (
    !value
    || value !== value.normalize("NFC")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || value.includes("//")
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid package path: ${JSON.stringify(value)}`);
  }
}

function assertContained(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) return;
  throw new Error(`Package entry escapes root: ${basename(candidate)}`);
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  let existing = path;
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(existing), ...missing);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

async function writeAll(
  output: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await output.write(chunk, offset, chunk.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error("Failed to write App package snapshot");
    offset += result.bytesWritten;
  }
}

async function assertCasFile(path: string, bytes: number, digest: string): Promise<void> {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const hash = createHash("sha256");
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(bytes)) {
      throw new Error("App package snapshot CAS collision");
    }
    let readBytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      readBytes += chunk.byteLength;
      hash.update(chunk);
    }
    const after = await input.stat({ bigint: true });
    if (
      readBytes !== bytes
      || !after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || hash.digest("hex") !== digest
    ) {
      throw new Error("App package snapshot CAS collision");
    }
    if ((Number(after.mode) & 0o777) !== 0o400) {
      throw new Error("App package snapshot CAS collision");
    }
  } finally {
    await input.close();
  }
}

function openCasReadStream(path: string): ReturnType<typeof createReadStream> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    return createReadStream(path, { fd, autoClose: true });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function decodeRecordType(header: Buffer): 0 | typeof TYPE_DIRECTORY | typeof TYPE_FILE {
  const type = header.readUInt8(0);
  if (type === 0) {
    if (!header.equals(Buffer.alloc(HEADER_BYTES))) {
      throw new Error("Capsule tree end record must be all zero");
    }
    return 0;
  }
  if (header.readUInt8(1) !== 0) throw new Error("Capsule tree record flags must be zero");
  if (type !== TYPE_DIRECTORY && type !== TYPE_FILE) {
    throw new Error(`Capsule tree record type is invalid: ${type}`);
  }
  return type;
}

function validateRecordHeader(
  type: typeof TYPE_DIRECTORY | typeof TYPE_FILE,
  mode: number,
  pathLength: number,
  contentLength: bigint,
): void {
  if (pathLength < 1 || pathLength > MAX_PATH_BYTES) {
    throw new Error("Capsule tree record path length is invalid");
  }
  if (type === TYPE_DIRECTORY) {
    if (mode !== 0o755 || contentLength !== 0n) {
      throw new Error("Capsule tree directory header is invalid");
    }
    return;
  }
  if (
    (mode !== 0o644 && mode !== 0o755)
    || contentLength > BigInt(MAX_FILE_BYTES)
  ) {
    throw new Error("Capsule tree file header is invalid");
  }
}

function decodeTreePath(bytes: Buffer): string {
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Capsule tree path is not valid UTF-8: ${String(error)}`);
  }
  if (!Buffer.from(path, "utf8").equals(bytes)) {
    throw new Error("Capsule tree path is not canonical UTF-8");
  }
  validateRelativePath(path);
  return path;
}

function treeParent(path: string): string | undefined {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? undefined : path.slice(0, separator);
}

class HashedFileReader {
  readonly #input: Awaited<ReturnType<typeof open>>;
  readonly #hash = createHash("sha256");
  #position = 0;
  #digested = false;

  constructor(input: Awaited<ReturnType<typeof open>>) {
    this.#input = input;
  }

  async readExact(bytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Capsule tree read length is invalid");
    const result = Buffer.allocUnsafe(bytes);
    let offset = 0;
    while (offset < bytes) {
      const read = await this.#input.read(result, offset, bytes - offset, this.#position);
      if (read.bytesRead <= 0) throw new Error("Capsule tree ended early");
      const chunk = result.subarray(offset, offset + read.bytesRead);
      this.#hash.update(chunk);
      this.#position += read.bytesRead;
      offset += read.bytesRead;
    }
    return result;
  }

  async skip(bytes: number): Promise<void> {
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = await this.readExact(Math.min(64 * 1024, remaining));
      remaining -= chunk.byteLength;
    }
  }

  async assertEof(expectedBytes: number): Promise<void> {
    if (this.#position !== expectedBytes) throw new Error("Capsule tree byte count does not match snapshot");
    const probe = Buffer.allocUnsafe(1);
    const read = await this.#input.read(probe, 0, 1, this.#position);
    if (read.bytesRead !== 0) throw new Error("Capsule tree has trailing bytes");
  }

  digest(): string {
    if (this.#digested) throw new Error("Capsule tree digest was already consumed");
    this.#digested = true;
    return this.#hash.digest("hex");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
