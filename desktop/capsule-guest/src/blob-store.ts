import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rm, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type { ImportedBlobKind } from "@lamarck/capsule";
import { validateArtifactDigest } from "@lamarck/capsule";
import {
  UNBOUNDED_GUEST_RESOURCE_ADMISSION,
  type GuestResourceAdmissionLike,
} from "./resource-admission";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY
  | constants.O_CREAT
  | constants.O_EXCL
  | constants.O_NOFOLLOW;
const IO_CHUNK_BYTES = 256 * 1024;
const GIBIBYTE = 1024 * 1024 * 1024;
export const GUEST_BLOB_OWNER_QUOTA_BYTES = 12 * GIBIBYTE;

export class BlobIntegrityError extends Error {
  readonly code = "CAPSULE_BLOB_INTEGRITY";
}

export class GuestBlobStorageError extends Error {
  readonly code = "CAPSULE_RESOURCE_EXHAUSTED";

  constructor(message: string) {
    super(message);
    this.name = "GuestBlobStorageError";
  }
}

export class GuestBlobStorageUncertainError extends Error {
  readonly code = "CAPSULE_GUEST_STORAGE_UNCERTAIN";
  readonly fatalGuest = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GuestBlobStorageUncertainError";
  }
}

interface StableFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface BlobReferenceOptions {
  /** Stable SHA-256 App key derived and authenticated by the Host. */
  ownerKey: string;
  /** Lifecycle reference owned by an import, Build, or prepared App. */
  referenceId: string;
}

interface BlobRecord {
  readonly kind: ImportedBlobKind;
  readonly digest: string;
  readonly bytes: number;
  readonly path: string;
  readonly references: Map<string, string>;
  resourceLease?: Awaited<ReturnType<GuestResourceAdmissionLike["reserve"]>>;
  unlinked?: boolean;
}

export interface GuestBlobStoreSnapshot {
  readonly blobs: number;
  readonly references: number;
  readonly ownerBytes: Readonly<Record<string, number>>;
  readonly ownerPendingBytes: Readonly<Record<string, number>>;
}

export class GuestBlobStore {
  private readonly admission: GuestResourceAdmissionLike;
  private readonly ownerQuotaBytes: number;
  private readonly syncPublishedBlobDirectory: (path: string) => Promise<void>;
  private readonly syncReleasedBlobDirectory: (path: string) => Promise<void>;
  private readonly beforePublishedReferenceAcquire: (() => void | Promise<void>) | undefined;
  private readonly records = new Map<string, BlobRecord>();
  private readonly references = new Map<string, BlobRecord>();
  private readonly ownerBytes = new Map<string, number>();
  private readonly ownerPendingBytes = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    options: {
      admission?: GuestResourceAdmissionLike;
      ownerQuotaBytes?: number;
      /** Test seam for durability failure after last-reference unlink. */
      syncReleasedBlobDirectory?: (path: string) => Promise<void>;
      /** Test seam for durability failure after CAS publication. */
      syncPublishedBlobDirectory?: (path: string) => Promise<void>;
      /** Test seam for reference-ledger failure after a CAS publication wins. */
      beforePublishedReferenceAcquire?: () => void | Promise<void>;
    } = {},
  ) {
    this.admission = options.admission ?? UNBOUNDED_GUEST_RESOURCE_ADMISSION;
    this.ownerQuotaBytes = positiveSafeInteger(
      options.ownerQuotaBytes ?? GUEST_BLOB_OWNER_QUOTA_BYTES,
      "ownerQuotaBytes",
    );
    this.syncPublishedBlobDirectory = options.syncPublishedBlobDirectory ?? syncDirectory;
    this.syncReleasedBlobDirectory = options.syncReleasedBlobDirectory ?? syncDirectory;
    this.beforePublishedReferenceAcquire = options.beforePublishedReferenceAcquire;
  }

  path(kind: ImportedBlobKind, digestValue: string): string {
    const digest = validateArtifactDigest(digestValue, "digest");
    return `${this.root}/${kind}/sha256/${digest.slice("sha256:".length)}`;
  }

  async has(kind: ImportedBlobKind, digest: string, expectedBytes?: number): Promise<boolean> {
    try {
      const handle = await open(this.path(kind, digest), READ_FLAGS);
      try {
        await verifyOpenCasFile(handle, digest, expectedBytes);
        return true;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async receive(
    kind: ImportedBlobKind,
    digestValue: string,
    expectedBytes: number,
    source: AsyncIterable<Uint8Array>,
    referenceOptions: BlobReferenceOptions,
  ): Promise<{ digest: string; bytes: number; path: string; reused: boolean }> {
    const digest = validateArtifactDigest(digestValue, "digest");
    assertBlobBytes(expectedBytes);
    const ownerKey = validateOwnerKey(referenceOptions.ownerKey);
    const referenceId = validateReferenceId(referenceOptions.referenceId);
    const destination = this.path(kind, digest);
    if (await this.has(kind, digest, expectedBytes)) {
      await this.acquireReference({ ownerKey, referenceId, kind, digest, bytes: expectedBytes });
      return { digest, bytes: expectedBytes, path: destination, reused: true };
    }

    const importNonce = randomBytes(16).toString("hex");
    await this.reserveOwnerPending(ownerKey, expectedBytes);
    let ownerPending = true;
    const resourceLease = await this.admission.reserve(
      `blob:${kind}:${digest}:${importNonce}`,
      { diskBytes: expectedBytes },
    ).catch(async (error) => {
      await this.releaseOwnerPending(ownerKey, expectedBytes);
      ownerPending = false;
      throw error;
    });
    const temporary = `${destination}.partial-${importNonce}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const hash = createHash("sha256");
    let bytes = 0;
    let registeredReference = false;
    let resourceLeaseRetained = false;
    try {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      handle = await open(temporary, WRITE_FLAGS, 0o600);
      for await (const rawChunk of source) {
        const chunk = Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
        bytes += chunk.byteLength;
        if (bytes > expectedBytes) {
          throw new BlobIntegrityError("Blob stream exceeded its authenticated byte length");
        }
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      if (bytes !== expectedBytes) {
        throw new BlobIntegrityError(`Blob stream ended at ${bytes} bytes; expected ${expectedBytes}`);
      }
      const actualDigest = `sha256:${hash.digest("hex")}`;
      if (actualDigest !== digest) {
        throw new BlobIntegrityError(`Blob digest mismatch: expected ${digest}, received ${actualDigest}`);
      }
      await handle.sync();
      await handle.chmod(0o400);
      await handle.sync();
      const sealed = await handle.stat({ bigint: true });
      assertCasMetadata(sealed, expectedBytes);
      await handle.close();
      handle = undefined;

      const wonPublish = await this.locked(async () => {
        let record = this.records.get(destination);
        let won = false;
        let createdRecord = false;
        if (!record) {
          try {
            await link(temporary, destination);
            won = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          if (!won && !await this.has(kind, digest, expectedBytes)) {
            throw new BlobIntegrityError("CAS publish race produced an invalid winner");
          }
          record = {
            kind,
            digest,
            bytes: expectedBytes,
            path: destination,
            references: new Map(),
            ...(won ? { resourceLease } : {}),
          };
          this.records.set(destination, record);
          createdRecord = true;
          resourceLeaseRetained = won;
        } else {
          assertRecord(record, kind, digest, expectedBytes);
        }
        try {
          await this.beforePublishedReferenceAcquire?.();
          this.acquireReferenceLocked(record, ownerKey, referenceId, true);
        } catch (error) {
          if (createdRecord && record.references.size === 0) {
            if (won) {
              await rm(destination);
              resourceLeaseRetained = false;
              this.records.delete(destination);
              await syncDirectory(dirname(destination));
            } else {
              this.records.delete(destination);
            }
          }
          throw error;
        }
        ownerPending = false;
        registeredReference = true;
        return won;
      });
      await rm(temporary, { force: true });
      await this.syncPublishedBlobDirectory(dirname(destination));
      if (!wonPublish) {
        resourceLease.release();
      }
      if (!await this.has(kind, digest, expectedBytes)) {
        throw new BlobIntegrityError("published CAS blob failed post-publish verification");
      }
      return { digest, bytes, path: destination, reused: !wonPublish };
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (handle) {
        try {
          await handle.close();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      try {
        await rm(temporary, { force: true });
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (registeredReference) {
        try {
          await this.release(referenceId);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (ownerPending) {
        try {
          await this.releaseOwnerPending(ownerKey, expectedBytes);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (!resourceLeaseRetained) resourceLease.release();
      if (cleanupFailures.length > 0) {
        throw new GuestBlobStorageUncertainError(
          "Guest CAS publication failed and its storage cleanup was not durable",
          {
            cause: new AggregateError(
              [error, ...cleanupFailures],
              "Guest CAS publication cleanup failed",
            ),
          },
        );
      }
      throw error;
    }
  }

  /** Import a trusted sealer output while retaining one O_NOFOLLOW source handle. */
  async importLocalFile(
    kind: ImportedBlobKind,
    path: string,
    options: BlobReferenceOptions & { signal?: AbortSignal; maximumBytes?: number },
  ): Promise<{ digest: string; bytes: number; path: string; reused: boolean }> {
    const signal = options.signal;
    throwIfAborted(signal);
    const handle = await open(path, READ_FLAGS);
    try {
      const before = await handle.stat({ bigint: true });
      assertRegularSingleLink(before, "local artifact source");
      if ((before.mode & 0o022n) !== 0n) {
        throw new BlobIntegrityError("local artifact source cannot be group/world writable");
      }
      const bytes = Number(before.size);
      assertBlobBytes(bytes);
      if (options.maximumBytes !== undefined) {
        assertBlobBytes(options.maximumBytes);
        if (bytes > options.maximumBytes) {
          throw new BlobIntegrityError(
            `local artifact exceeds its ${options.maximumBytes} byte storage-plan ceiling`,
          );
        }
      }
      const digest = await hashOpenFile(handle, bytes, "sha256", signal);
      const afterHash = await handle.stat({ bigint: true });
      assertStableIdentity(before, afterHash, "local artifact changed while hashing");
      throwIfAborted(signal);
      const source = readOpenFile(handle, bytes, signal);
      const imported = await this.receive(kind, `sha256:${digest}`, bytes, source, options);
      throwIfAborted(signal);
      const afterImport = await handle.stat({ bigint: true });
      assertStableIdentity(before, afterImport, "local artifact changed while importing");
      return imported;
    } finally {
      await handle.close();
    }
  }

  /** Pins a verified CAS object to one authenticated lifecycle owner. */
  async acquireReference(options: BlobReferenceOptions & {
    kind: ImportedBlobKind;
    digest: string;
    bytes: number;
  }): Promise<boolean> {
    const ownerKey = validateOwnerKey(options.ownerKey);
    const referenceId = validateReferenceId(options.referenceId);
    const digest = validateArtifactDigest(options.digest, "digest");
    assertBlobBytes(options.bytes);
    const path = this.path(options.kind, digest);
    return await this.locked(async () => {
      let record = this.records.get(path);
      if (!record) {
        if (!await this.has(options.kind, digest, options.bytes)) {
          throw new BlobIntegrityError("Cannot reference a missing Guest CAS blob");
        }
        record = {
          kind: options.kind,
          digest,
          bytes: options.bytes,
          path,
          references: new Map(),
        };
        this.records.set(path, record);
      } else {
        assertRecord(record, options.kind, digest, options.bytes);
      }
      return this.acquireReferenceLocked(record, ownerKey, referenceId, false);
    });
  }

  async releaseExpected(options: {
    ownerKey: string;
    kind: ImportedBlobKind;
    digest: string;
    referenceId: string;
    bytes: number;
  }): Promise<boolean> {
    const ownerKey = validateOwnerKey(options.ownerKey);
    const digest = validateArtifactDigest(options.digest, "digest");
    const referenceId = validateReferenceId(options.referenceId);
    assertBlobBytes(options.bytes);
    const path = this.path(options.kind, digest);
    return await this.locked(async () => {
      const record = this.references.get(referenceId);
      if (!record) return false;
      if (
        record.path !== path
        || record.kind !== options.kind
        || record.digest !== digest
        || record.bytes !== options.bytes
        || record.references.get(referenceId) !== ownerKey
      ) {
        throw new BlobIntegrityError("Guest blob reference does not match its authenticated owner and identity");
      }
      return await this.releaseLocked(referenceId, record);
    });
  }

  async releaseAll(): Promise<void> {
    for (const referenceId of [...this.references.keys()]) await this.release(referenceId);
  }

  /**
   * Releases one Build/App/import hold. The last reference atomically evicts
   * the disposable Guest CAS object and returns its shared disk reservation.
   */
  async release(referenceIdValue: string): Promise<boolean> {
    const referenceId = validateReferenceId(referenceIdValue);
    return await this.locked(async () => {
      const record = this.references.get(referenceId);
      if (!record) return false;
      return await this.releaseLocked(referenceId, record);
    });
  }

  snapshot(): GuestBlobStoreSnapshot {
    return Object.freeze({
      blobs: this.records.size,
      references: this.references.size,
      ownerBytes: Object.freeze(Object.fromEntries(this.ownerBytes)),
      ownerPendingBytes: Object.freeze(Object.fromEntries(this.ownerPendingBytes)),
    });
  }

  /** Return a stream that revalidates digest and file identity while reading. */
  async open(kind: ImportedBlobKind, digestValue: string): Promise<Readable> {
    const digest = validateArtifactDigest(digestValue, "digest");
    const handle = await open(this.path(kind, digest), READ_FLAGS);
    const before = await handle.stat({ bigint: true });
    assertCasMetadata(before);
    const expectedBytes = Number(before.size);
    const expectedHex = digest.slice("sha256:".length);
    return Readable.from((async function* () {
      const hash = createHash("sha256");
      try {
        let position = 0;
        while (position < expectedBytes) {
          const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, expectedBytes - position));
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
          if (bytesRead === 0) throw new BlobIntegrityError("CAS blob truncated while streaming");
          position += bytesRead;
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          yield chunk;
        }
        const after = await handle.stat({ bigint: true });
        assertStableIdentity(before, after, "CAS blob changed while streaming");
        if (hash.digest("hex") !== expectedHex) {
          throw new BlobIntegrityError("CAS blob digest changed while streaming");
        }
      } finally {
        await handle.close();
      }
    })());
  }

  private acquireReferenceLocked(
    record: BlobRecord,
    ownerKey: string,
    referenceId: string,
    consumePending: boolean,
  ): boolean {
    const existing = this.references.get(referenceId);
    if (record.unlinked) {
      throw new GuestBlobStorageUncertainError(
        "Guest CAS blob was unlinked but its durable release is not yet confirmed",
      );
    }
    if (existing) {
      if (existing !== record || existing.references.get(referenceId) !== ownerKey) {
        throw new BlobIntegrityError("Guest blob reference identity cannot be reused");
      }
      // Every consumePending call comes from a receive() which owns one
      // matching pending reservation, including a same-reference publish race.
      if (consumePending) this.debitOwnerPending(ownerKey, record.bytes);
      return false;
    }
    const ownerAlreadyReferences = [...record.references.values()].includes(ownerKey);
    if (!ownerAlreadyReferences) {
      const used = this.ownerBytes.get(ownerKey) ?? 0;
      const pending = this.ownerPendingBytes.get(ownerKey) ?? 0;
      const effectivePending = consumePending ? pending - record.bytes : pending;
      if (effectivePending < 0 || used + effectivePending + record.bytes > this.ownerQuotaBytes) {
        throw new GuestBlobStorageError(
          `Guest blob owner ${ownerKey} exceeds the ${this.ownerQuotaBytes} byte quota`,
        );
      }
      this.ownerBytes.set(ownerKey, used + record.bytes);
    }
    record.references.set(referenceId, ownerKey);
    this.references.set(referenceId, record);
    if (consumePending) this.debitOwnerPending(ownerKey, record.bytes);
    return true;
  }

  private async releaseLocked(referenceId: string, record: BlobRecord): Promise<boolean> {
    const ownerKey = record.references.get(referenceId);
    if (!ownerKey) throw new Error("Guest blob reference ledger is inconsistent");
    if (record.references.size === 1) {
      // Do not retire the only authoritative ledger entry until unlink and
      // directory durability both succeed. A failed GC remains retryable.
      if (!record.unlinked) {
        await rm(record.path);
        record.unlinked = true;
      }
      try {
        await this.syncReleasedBlobDirectory(dirname(record.path));
      } catch (error) {
        throw new GuestBlobStorageUncertainError(
          "Guest CAS unlink could not be made durable",
          { cause: error },
        );
      }
      record.references.delete(referenceId);
      this.references.delete(referenceId);
      this.debitOwner(ownerKey, record.bytes);
      this.records.delete(record.path);
      record.resourceLease?.release();
      return true;
    }
    record.references.delete(referenceId);
    this.references.delete(referenceId);
    if (![...record.references.values()].includes(ownerKey)) {
      this.debitOwner(ownerKey, record.bytes);
    }
    return true;
  }

  private async reserveOwnerPending(ownerKey: string, bytes: number): Promise<void> {
    await this.locked(async () => {
      const used = this.ownerBytes.get(ownerKey) ?? 0;
      const pending = this.ownerPendingBytes.get(ownerKey) ?? 0;
      if (used + pending + bytes > this.ownerQuotaBytes) {
        throw new GuestBlobStorageError(
          `Guest blob owner ${ownerKey} exceeds the ${this.ownerQuotaBytes} byte quota`,
        );
      }
      this.ownerPendingBytes.set(ownerKey, pending + bytes);
    });
  }

  private async releaseOwnerPending(ownerKey: string, bytes: number): Promise<void> {
    await this.locked(async () => this.debitOwnerPending(ownerKey, bytes));
  }

  private debitOwnerPending(ownerKey: string, bytes: number): void {
    const next = (this.ownerPendingBytes.get(ownerKey) ?? 0) - bytes;
    if (next < 0) throw new Error("Guest blob owner pending ledger underflow");
    if (next === 0) this.ownerPendingBytes.delete(ownerKey);
    else this.ownerPendingBytes.set(ownerKey, next);
  }

  private debitOwner(ownerKey: string, bytes: number): void {
    const next = (this.ownerBytes.get(ownerKey) ?? 0) - bytes;
    if (next < 0) throw new Error("Guest blob owner ledger underflow");
    if (next === 0) this.ownerBytes.delete(ownerKey);
    else this.ownerBytes.set(ownerKey, next);
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prior = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function verifyOpenCasFile(
  handle: Awaited<ReturnType<typeof open>>,
  digest: string,
  expectedBytes?: number,
): Promise<void> {
  const before = await handle.stat({ bigint: true });
  assertCasMetadata(before, expectedBytes);
  const bytes = Number(before.size);
  const actual = await hashOpenFile(handle, bytes, "sha256");
  const after = await handle.stat({ bigint: true });
  assertStableIdentity(before, after, "CAS blob changed during verification");
  if (`sha256:${actual}` !== digest) throw new BlobIntegrityError("CAS blob digest is corrupt");
}

async function hashOpenFile(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: number,
  algorithm: "sha256" | "sha512",
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash(algorithm);
  let position = 0;
  while (position < bytes) {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, bytes - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) throw new BlobIntegrityError("file truncated while hashing");
    position += bytesRead;
    hash.update(buffer.subarray(0, bytesRead));
  }
  return hash.digest("hex");
}

async function* readOpenFile(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: number,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  let position = 0;
  while (position < bytes) {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, bytes - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) throw new BlobIntegrityError("local source truncated while importing");
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("CAS import aborted");
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten < 1) throw new BlobIntegrityError("CAS temporary file made no write progress");
    offset += bytesWritten;
  }
}

function assertCasMetadata(
  details: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>> & { mode: bigint; nlink: bigint; size: bigint },
  expectedBytes?: number,
): void {
  assertRegularSingleLink(details, "CAS blob");
  if ((details.mode & 0o777n) !== 0o400n) throw new BlobIntegrityError("CAS blob mode must be 0400");
  const bytes = Number(details.size);
  assertBlobBytes(bytes);
  if (expectedBytes !== undefined && bytes !== expectedBytes) {
    throw new BlobIntegrityError(`CAS blob size ${bytes} differs from expected ${expectedBytes}`);
  }
}

function assertRegularSingleLink(
  details: { isFile(): boolean; nlink: bigint },
  label: string,
): void {
  if (!details.isFile() || details.nlink !== 1n) {
    throw new BlobIntegrityError(`${label} must be one regular, single-link file`);
  }
}

function stableIdentity(details: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): StableFileIdentity {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
  };
}

function assertStableIdentity(
  before: Parameters<typeof stableIdentity>[0],
  after: Parameters<typeof stableIdentity>[0],
  message: string,
): void {
  const left = stableIdentity(before);
  const right = stableIdentity(after);
  if (
    left.dev !== right.dev
    || left.ino !== right.ino
    || left.size !== right.size
    || left.mtimeNs !== right.mtimeNs
    || left.ctimeNs !== right.ctimeNs
  ) throw new BlobIntegrityError(message);
}

function assertBlobBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8 * 1024 * 1024 * 1024) {
    throw new BlobIntegrityError("Blob byte length is outside the v1 bounds");
  }
}

function assertRecord(
  record: BlobRecord,
  kind: ImportedBlobKind,
  digest: string,
  bytes: number,
): void {
  if (record.kind !== kind || record.digest !== digest || record.bytes !== bytes) {
    throw new BlobIntegrityError("Guest CAS identity collision");
  }
}

function validateOwnerKey(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new BlobIntegrityError("Guest blob owner key is invalid");
  }
  return value;
}

function validateReferenceId(value: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !/^[A-Za-z0-9:._-]+$/.test(value)
  ) {
    throw new BlobIntegrityError("Guest blob reference identity is invalid");
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, READ_FLAGS);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
