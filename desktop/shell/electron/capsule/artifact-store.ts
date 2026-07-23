import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
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
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  normalizeCapsuleStorageError,
  type CapsuleStorageBudgetLike,
  type CapsuleStorageReservation,
} from "./storage-budget";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const APP_KEY_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ACTIVATION_BYTES = 4 * 1024;

export interface HostArtifactIdentity {
  readonly digest: `sha256:${string}`;
  readonly bytes: number;
}

export interface HostArtifact extends HostArtifactIdentity {
  readonly path: string;
  createReadStream(): ReturnType<typeof createReadStream>;
}

export interface HostArtifactActivation {
  readonly artifact: HostArtifact;
  readonly packageDigest: `sha256:${string}`;
  readonly imageDigest: `sha256:${string}`;
  /** Present together on V2 pointers; absent on legacy V1 pointers. */
  readonly installDigest?: `sha256:${string}`;
  readonly dependencyDigest?: `sha256:${string}`;
}

interface HostArtifactWriterDependencies {
  removeTemporary(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  afterPublication(published: boolean): Promise<void>;
}

const DEFAULT_ARTIFACT_WRITER_DEPENDENCIES: HostArtifactWriterDependencies = {
  async removeTemporary(path) {
    await rm(path, { force: true });
  },
  syncDirectory,
  async afterPublication() {},
};

/**
 * Host-private artifact CAS plus atomic per-App activation pointers.
 *
 * Guest output is never executed on the Host. Every read revalidates the
 * immutable file identity and digest before bytes cross back into a Guest.
 */
export class HostArtifactStore {
  readonly #requestedRoot: string;
  readonly #storageBudget: CapsuleStorageBudgetLike | undefined;
  readonly #afterActivationPointerRename: (() => Promise<void>) | undefined;
  readonly #writer: HostArtifactWriterDependencies;
  readonly #publicationTails = new Map<string, Promise<void>>();
  #root: string | undefined;
  #quarantined: Error | undefined;

  constructor(root: string, options: {
    storageBudget?: CapsuleStorageBudgetLike;
    /** Test seam for a failure after the activation pointer becomes visible. */
    afterActivationPointerRename?: () => Promise<void>;
    /** Deterministic managed-writer seams; production uses unlink(2) and directory fsync. */
    artifactWriter?: Partial<HostArtifactWriterDependencies>;
  } = {}) {
    this.#requestedRoot = resolve(root);
    this.#storageBudget = options.storageBudget;
    this.#afterActivationPointerRename = options.afterActivationPointerRename;
    this.#writer = {
      ...DEFAULT_ARTIFACT_WRITER_DEPENDENCIES,
      ...options.artifactWriter,
    };
  }

  async receive(
    ownerKey: string,
    digestValue: string,
    expectedBytes: number,
    source: AsyncIterable<Uint8Array>,
  ): Promise<HostArtifact> {
    const owner = validateAppKey(ownerKey);
    const digest = validateDigest(digestValue);
    validateArtifactBytes(expectedBytes);
    const root = await this.#prepare();
    const destination = this.#casPath(root, digest);
    let reservation: CapsuleStorageReservation | undefined;
    if (this.#storageBudget) {
      reservation = await this.#storageBudget.reserve({
        owner,
        scope: "artifact-cas",
        bytes: expectedBytes,
      });
    }

    const directory = dirname(destination);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(directory);
    const temporary = join(
      directory,
      `.artifact-${process.pid}-${randomBytes(16).toString("hex")}.tmp`,
    );
    let output: Awaited<ReturnType<typeof open>>;
    try {
      output = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      await reservation?.release();
      throw normalizeCapsuleStorageError(error, "Host artifact storage is full");
    }
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const rawChunk of source) {
        if (!(rawChunk instanceof Uint8Array)) {
          throw new Error("Guest artifact stream emitted non-byte content");
        }
        const chunk = Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
        bytes += chunk.byteLength;
        if (bytes > expectedBytes) throw new Error("Guest artifact exceeded its authenticated size");
        hash.update(chunk);
        await writeAll(output, chunk);
      }
      if (bytes !== expectedBytes) {
        throw new Error(`Guest artifact ended at ${bytes} bytes; expected ${expectedBytes}`);
      }
      const actualDigest = `sha256:${hash.digest("hex")}`;
      if (actualDigest !== digest) throw new Error("Guest artifact digest mismatch");
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
        await this.#removeTemporaryDurably(temporary, directory);
      } catch (cleanupError) {
        failures.push(cleanupError);
        const failure = combinedError("Host artifact temporary cleanup failed", failures);
        this.#quarantined = failure;
        throw normalizeCapsuleStorageError(failure, "Host artifact storage cleanup failed");
      }
      await reservation?.release();
      throw normalizeCapsuleStorageError(
        combinedError("Host artifact write failed", failures),
        "Host artifact storage is full",
      );
    }
    try {
      await output.close();
    } catch (error) {
      try {
        await this.#removeTemporaryDurably(temporary, directory);
      } catch (cleanupError) {
        const failure = combinedError(
          "Host artifact temporary cleanup failed",
          [error, cleanupError],
        );
        this.#quarantined = failure;
        throw normalizeCapsuleStorageError(failure, "Host artifact storage cleanup failed");
      }
      await reservation?.release();
      throw normalizeCapsuleStorageError(error, "Host artifact storage is full");
    }

    let published = false;
    let cleanupAttempted = false;
    let cleanupConfirmed = false;
    try {
      return await this.#withPublicationLock(digest, async () => {
        this.#assertWriterAvailable();
        let publicationError: unknown;
        try {
          await link(temporary, destination);
          published = true;
        } catch (error) {
          if (!isNodeError(error, "EEXIST")) {
            publicationError = error;
          } else {
            try {
              const winner = await this.#readVerified(destination, digest, expectedBytes);
              if (!winner) throw new Error("Host artifact CAS collision is invalid");
            } catch (winnerError) {
              publicationError = winnerError;
            }
          }
        }
        if (publicationError === undefined) {
          try {
            await this.#writer.afterPublication(published);
          } catch (error) {
            publicationError = error;
          }
        }

        cleanupAttempted = true;
        try {
          // The hard-link winner must remove its temporary name and make that
          // unlink durable before any same-digest publisher can accept it.
          await this.#removeTemporaryDurably(temporary, directory);
          cleanupConfirmed = true;
        } catch (cleanupError) {
          const failure = combinedError(
            "Host artifact temporary cleanup failed",
            publicationError === undefined
              ? [cleanupError]
              : [publicationError, cleanupError],
          );
          this.#quarantined = failure;
          throw failure;
        }
        if (publicationError !== undefined) {
          if (published) this.#quarantined = asError(publicationError);
          throw publicationError;
        }

        try {
          await reservation?.commit(
            published ? expectedBytes : 0,
            published ? destination : undefined,
          );
          await this.#storageBudget?.claim({
            owner,
            scope: "artifact-cas",
            path: destination,
            bytes: expectedBytes,
          });
          const artifact = await this.#readVerified(destination, digest, expectedBytes);
          if (!artifact) {
            throw new Error("Host artifact disappeared after publication accounting");
          }
          return artifact;
        } catch (error) {
          if (published) this.#quarantined = asError(error);
          throw error;
        }
      });
    } catch (error) {
      if (!cleanupAttempted) {
        try {
          cleanupAttempted = true;
          await this.#removeTemporaryDurably(temporary, directory);
          cleanupConfirmed = true;
        } catch (cleanupError) {
          const failure = combinedError(
            "Host artifact temporary cleanup failed",
            [error, cleanupError],
          );
          this.#quarantined = failure;
          throw normalizeCapsuleStorageError(failure, "Host artifact publication failed");
        }
      }
      if (!published && cleanupConfirmed) {
        await reservation?.release();
      }
      throw normalizeCapsuleStorageError(error, "Host artifact publication failed");
    }
  }

  async find(digestValue: string, expectedBytes?: number): Promise<HostArtifact | undefined> {
    const digest = validateDigest(digestValue);
    if (expectedBytes !== undefined) validateArtifactBytes(expectedBytes);
    const root = await this.#prepare();
    return await this.#withPublicationLock(digest, async () => {
      this.#assertWriterAvailable();
      return await this.#readVerified(this.#casPath(root, digest), digest, expectedBytes);
    });
  }

  async require(digestValue: string, expectedBytes?: number): Promise<HostArtifact> {
    const artifact = await this.find(digestValue, expectedBytes);
    if (!artifact) throw new Error("Host artifact is missing or failed integrity verification");
    return artifact;
  }

  async activate(
    appKeyValue: string,
    artifactValue: HostArtifactIdentity,
    provenance: {
      packageDigest: string;
      imageDigest: string;
      installDigest?: string;
      dependencyDigest?: string;
    },
  ): Promise<void> {
    const appKey = validateAppKey(appKeyValue);
    const digest = validateDigest(artifactValue.digest);
    const packageDigest = validateDigest(provenance.packageDigest);
    const imageDigest = validateDigest(provenance.imageDigest);
    if ((provenance.installDigest === undefined) !== (provenance.dependencyDigest === undefined)) {
      throw new Error("Artifact install and dependency digests must appear together");
    }
    const installDigest = provenance.installDigest === undefined
      ? undefined
      : validateDigest(provenance.installDigest);
    const dependencyDigest = provenance.dependencyDigest === undefined
      ? undefined
      : validateDigest(provenance.dependencyDigest);
    validateArtifactBytes(artifactValue.bytes);
    const artifact = await this.require(digest, artifactValue.bytes);
    const previous = await this.active(appKey);
    await this.#storageBudget?.claim({
      owner: appKey,
      scope: "artifact-cas",
      path: artifact.path,
      bytes: artifact.bytes,
    });
    const root = await this.#prepare();
    const directory = join(root, "active");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(directory);
    const destination = join(directory, `${appKey}.json`);
    const temporary = join(
      directory,
      `.activation-${process.pid}-${randomBytes(16).toString("hex")}.tmp`,
    );
    const payload = Buffer.from(`${JSON.stringify({
      version: installDigest === undefined ? 1 : 2,
      digest,
      bytes: artifactValue.bytes,
      packageDigest,
      imageDigest,
      ...(installDigest === undefined ? {} : { installDigest, dependencyDigest }),
    })}\n`, "utf8");
    let renamed = false;
    try {
      const output = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await writeAll(output, payload);
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(temporary, destination);
      renamed = true;
      await this.#afterActivationPointerRename?.();
      await chmod(destination, 0o600);
      await syncDirectory(directory);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (renamed) {
        try {
          await this.#restoreActivationPointer(directory, destination, previous);
        } catch (rollbackError) {
          const quarantine = new AggregateError(
            [error, rollbackError],
            "Host artifact activation commit failed and its previous pointer could not be restored",
          );
          this.#quarantined = quarantine;
          throw quarantine;
        }
      }
      if (previous?.artifact.path !== artifact.path) {
        try {
          await this.#storageBudget?.unclaim({
            owner: appKey,
            path: artifact.path,
            bytes: artifact.bytes,
          });
        } catch (accountingError) {
          throw new AggregateError(
            [error, accountingError],
            "Host artifact activation and owner rollback failed",
          );
        }
      }
      throw error;
    }
    if (previous && previous.artifact.path !== artifact.path) {
      await this.#storageBudget?.unclaim({
        owner: appKey,
        path: previous.artifact.path,
        bytes: previous.artifact.bytes,
      });
    }
  }

  async deactivate(appKeyValue: string): Promise<void> {
    const appKey = validateAppKey(appKeyValue);
    const root = await this.#prepare();
    const previous = await this.active(appKey);
    const directory = join(root, "active");
    await assertPrivateDirectory(directory);
    const destination = join(directory, `${appKey}.json`);
    try {
      // rm without recursive follows neither symlinks nor directories. A
      // malformed directory at the pointer path therefore fails closed.
      await rm(destination);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    await syncDirectory(directory);
    if (previous) {
      await this.#storageBudget?.unclaim({
        owner: appKey,
        path: previous.artifact.path,
        bytes: previous.artifact.bytes,
      });
    }
  }

  async active(appKeyValue: string): Promise<HostArtifactActivation | undefined> {
    const appKey = validateAppKey(appKeyValue);
    const root = await this.#prepare();
    const path = join(root, "active", `${appKey}.json`);
    let input: Awaited<ReturnType<typeof open>>;
    try {
      input = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      if (isNodeError(error, "ELOOP")) {
        throw new Error("Host artifact activation pointer is invalid", { cause: error });
      }
      throw error;
    }
    let bytes: Buffer;
    try {
      const details = await input.stat({ bigint: true });
      if (
        !details.isFile()
        || details.nlink !== 1n
        || details.size < 1n
        || details.size > BigInt(MAX_ACTIVATION_BYTES)
        || (Number(details.mode) & 0o777) !== 0o600
      ) {
        throw new Error("Host artifact activation pointer is invalid");
      }
      bytes = await input.readFile();
      const after = await input.stat({ bigint: true });
      assertSameFile(details, after, "Host artifact activation pointer changed while reading");
      if (bytes.byteLength !== Number(details.size)) {
        throw new Error("Host artifact activation pointer was truncated while reading");
      }
    } finally {
      await input.close();
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new Error("Host artifact activation pointer is not valid UTF-8 JSON");
    }
    if (!isPlainObject(value)) {
      throw new Error("Host artifact activation pointer has an invalid schema");
    }
    const legacy = value.version === 1 && hasExactKeys(value, [
      "version", "digest", "bytes", "packageDigest", "imageDigest",
    ]);
    const current = value.version === 2 && hasExactKeys(value, [
      "version",
      "digest",
      "bytes",
      "packageDigest",
      "imageDigest",
      "installDigest",
      "dependencyDigest",
    ]);
    if (!legacy && !current) {
      throw new Error("Unsupported Host artifact activation version or schema");
    }
    const digest = validateDigest(value.digest);
    const packageDigest = validateDigest(value.packageDigest);
    const imageDigest = validateDigest(value.imageDigest);
    const installDigest = current ? validateDigest(value.installDigest) : undefined;
    const dependencyDigest = current ? validateDigest(value.dependencyDigest) : undefined;
    validateArtifactBytes(value.bytes);
    const artifact = await this.require(digest, value.bytes);
    await this.#storageBudget?.claim({
      owner: appKey,
      scope: "artifact-cas",
      path: artifact.path,
      bytes: artifact.bytes,
    });
    return Object.freeze({
      artifact,
      packageDigest,
      imageDigest,
      ...(installDigest === undefined ? {} : { installDigest, dependencyDigest }),
    });
  }

  /** Keeps every activation/LKG pointer and evicts all reconstructable CAS residue. */
  async pruneUnreferenced(): Promise<number> {
    const root = await this.#prepare();
    const pinned = new Set<string>();
    const activeDirectory = join(root, "active");
    for (const entry of await readdir(activeDirectory, { withFileTypes: true })) {
      const match = /^([a-f0-9]{64})\.json$/.exec(entry.name);
      if (!entry.isFile() || !match) {
        if (entry.isFile() && entry.name.startsWith(".activation-")) {
          await rm(join(activeDirectory, entry.name), { force: true });
          continue;
        }
        throw new Error("Host artifact activation directory contains an invalid entry");
      }
      const activation = await this.active(match[1]!);
      if (activation) pinned.add(activation.artifact.path);
    }

    let removedBytes = 0;
    const casRoot = join(root, "cas", "sha256");
    for (const prefix of await readdir(casRoot, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) {
        throw new Error("Host artifact CAS contains an invalid prefix entry");
      }
      const directory = join(casRoot, prefix.name);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (!entry.isFile() || (
          !/^[a-f0-9]{64}$/.test(entry.name)
          && !entry.name.startsWith(".artifact-")
        )) {
          throw new Error("Host artifact CAS contains an invalid entry");
        }
        if (pinned.has(path)) continue;
        if (this.#storageBudget) {
          removedBytes += await this.#storageBudget.remove(path);
        } else {
          const details = await lstat(path);
          await rm(path);
          removedBytes += details.size;
        }
      }
      await syncDirectory(directory);
    }
    return removedBytes;
  }

  async #prepare(): Promise<string> {
    if (this.#quarantined) {
      throw new Error("Host artifact store is quarantined after an ambiguous managed write", {
        cause: this.#quarantined,
      });
    }
    if (this.#root) return this.#root;
    await mkdir(this.#requestedRoot, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.#requestedRoot);
    const root = await realpath(this.#requestedRoot);
    await mkdir(join(root, "cas", "sha256"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "active"), { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(join(root, "cas"));
    await assertPrivateDirectory(join(root, "cas", "sha256"));
    await assertPrivateDirectory(join(root, "active"));
    this.#root = root;
    return root;
  }

  #assertWriterAvailable(): void {
    if (this.#quarantined) {
      throw new Error("Host artifact store is quarantined after an ambiguous managed write", {
        cause: this.#quarantined,
      });
    }
  }

  async #removeTemporaryDurably(path: string, directory: string): Promise<void> {
    await this.#writer.removeTemporary(path);
    await this.#writer.syncDirectory(directory);
  }

  async #withPublicationLock<T>(
    digest: `sha256:${string}`,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.#publicationTails.get(digest) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#publicationTails.set(digest, current);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.#publicationTails.get(digest) === current) {
        this.#publicationTails.delete(digest);
      }
    }
  }

  async #restoreActivationPointer(
    directory: string,
    destination: string,
    previous: HostArtifactActivation | undefined,
  ): Promise<void> {
    if (!previous) {
      await rm(destination);
      await syncDirectory(directory);
      return;
    }
    const temporary = join(
      directory,
      `.activation-rollback-${process.pid}-${randomBytes(16).toString("hex")}.tmp`,
    );
    const payload = Buffer.from(`${JSON.stringify({
      version: previous.installDigest === undefined ? 1 : 2,
      digest: previous.artifact.digest,
      bytes: previous.artifact.bytes,
      packageDigest: previous.packageDigest,
      imageDigest: previous.imageDigest,
      ...(previous.installDigest === undefined
        ? {}
        : {
            installDigest: previous.installDigest,
            dependencyDigest: previous.dependencyDigest,
          }),
    })}\n`, "utf8");
    try {
      const output = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await writeAll(output, payload);
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(temporary, destination);
      await chmod(destination, 0o600);
      await syncDirectory(directory);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  #casPath(root: string, digest: `sha256:${string}`): string {
    const hex = digest.slice("sha256:".length);
    return join(root, "cas", "sha256", hex.slice(0, 2), hex);
  }

  async #readVerified(
    path: string,
    digest: `sha256:${string}`,
    expectedBytes?: number,
  ): Promise<HostArtifact | undefined> {
    let input: Awaited<ReturnType<typeof open>>;
    try {
      input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      const before = await input.stat({ bigint: true });
      if (
        !before.isFile()
        || before.nlink !== 1n
        || before.size < 1n
        || before.size > BigInt(MAX_ARTIFACT_BYTES)
        || (Number(before.mode) & 0o777) !== 0o400
        || (expectedBytes !== undefined && before.size !== BigInt(expectedBytes))
      ) {
        throw new Error("Host artifact CAS entry is invalid");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      for (;;) {
        const result = await input.read(buffer, 0, buffer.byteLength, position);
        if (result.bytesRead === 0) break;
        position += result.bytesRead;
        hash.update(buffer.subarray(0, result.bytesRead));
      }
      const after = await input.stat({ bigint: true });
      assertSameFile(before, after, "Host artifact CAS entry changed while hashing");
      if (`sha256:${hash.digest("hex")}` !== digest) {
        throw new Error("Host artifact CAS digest verification failed");
      }
      const bytes = Number(before.size);
      return Object.freeze({
        digest,
        bytes,
        path,
        createReadStream: () => openVerifiedReadStream(path, before),
      });
    } finally {
      await input.close();
    }
  }
}

function validateDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error("Artifact digest must be canonical lowercase sha256");
  }
  return value as `sha256:${string}`;
}

function validateArtifactBytes(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_ARTIFACT_BYTES) {
    throw new Error("Artifact byte length is outside the supported range");
  }
}

function validateAppKey(value: unknown): string {
  if (typeof value !== "string" || !APP_KEY_PATTERN.test(value)) {
    throw new Error("Host App activation key is invalid");
  }
  return value;
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten < 1) throw new Error("Artifact write made no progress");
    offset += result.bytesWritten;
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

async function assertPrivateDirectory(path: string): Promise<void> {
  const details = await lstat(path, { bigint: true });
  if (!details.isDirectory() || details.isSymbolicLink() || (Number(details.mode) & 0o077) !== 0) {
    throw new Error(`Host artifact store directory is not private: ${path}`);
  }
}

function assertSameFile(before: BigIntStats, after: BigIntStats, message: string): void {
  if (
    !after.isFile()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs
  ) {
    throw new Error(message);
  }
}

function openVerifiedReadStream(path: string, expected: BigIntStats): ReturnType<typeof createReadStream> {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const current = fstatSync(descriptor, { bigint: true });
    assertSameFile(expected, current, "Host artifact changed before streaming");
    return createReadStream(path, { fd: descriptor, autoClose: true });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function combinedError(message: string, errors: readonly unknown[]): Error {
  return errors.length === 1
    ? asError(errors[0])
    : new AggregateError(errors, message);
}
