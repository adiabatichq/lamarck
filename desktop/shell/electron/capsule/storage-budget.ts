import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  statfs,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const GIBIBYTE = 1024 * 1024 * 1024;

/** One policy shared by every Host-side Capsule storage writer. */
export const CAPSULE_STORAGE_POLICY = Object.freeze({
  aggregateBytes: 64 * GIBIBYTE,
  perAppBytes: 24 * GIBIBYTE,
  filesystemReserveBytes: 4 * GIBIBYTE,
  vmStateDiskBytes: 16 * GIBIBYTE,
});

export type CapsuleStorageScope =
  | "vm-state"
  | "package-snapshot"
  | "dependency-cache"
  | "artifact-cas";

export interface CapsuleStorageReservation {
  readonly bytes: number;
  /**
   * Converts only newly durable bytes into committed usage. `path` identifies
   * the final object so later GC can return its charge. CAS race losers commit
   * zero after their temporary file has been removed.
   */
  commit(persistedBytes: number, path?: string): Promise<void>;
  /** Releases an unpublished reservation after all temporary bytes are gone. */
  release(): Promise<void>;
}

export interface CapsuleStorageFileReservation {
  /** Reconciles an externally-created fixed file, committing only if present. */
  settle(): Promise<void>;
  /** Releases only when the external writer was never started. */
  release(): Promise<void>;
}

export interface CapsuleStorageBudgetSnapshot {
  readonly aggregateBytes: number;
  readonly perAppBytes: number;
  readonly usedBytes: number;
  readonly reservedBytes: number;
  readonly reservations: number;
  readonly ownerUsedBytes: Readonly<Record<string, number>>;
  readonly ownerReservedBytes: Readonly<Record<string, number>>;
}

export interface CapsuleStorageBudgetLike {
  reserve(options: {
    owner: string;
    scope: CapsuleStorageScope;
    bytes: number;
  }): Promise<CapsuleStorageReservation>;
  reserveFile(options: {
    owner: string;
    scope: CapsuleStorageScope;
    path: string;
    bytes: number;
  }): Promise<CapsuleStorageFileReservation>;
  claim(options: {
    owner: string;
    scope: CapsuleStorageScope;
    path: string;
    bytes: number;
  }): Promise<void>;
  unclaim(options: { owner: string; path: string; bytes: number }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<number>;
}

export class CapsuleStorageAdmissionError extends Error {
  readonly code = "CAPSULE_STORAGE_EXHAUSTED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CapsuleStorageAdmissionError";
  }
}

interface ReservationRecord {
  readonly owner: string;
  readonly scope: CapsuleStorageScope;
  readonly bytes: number;
}

interface FileCharge {
  readonly bytes: number;
  /** Physical bytes count once globally; every referencing App is charged. */
  readonly owners: Set<string>;
}

interface StorageBudgetDependencies {
  availableBytes(path: string): Promise<number>;
}

const DEFAULT_DEPENDENCIES: StorageBudgetDependencies = {
  async availableBytes(path) {
    const details = await statfs(path, { bigint: true });
    const bytes = details.bavail * details.bsize;
    if (bytes < 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CapsuleStorageAdmissionError(
        "Capsule filesystem free space is outside the supported range",
      );
    }
    return Number(bytes);
  },
};

/**
 * Process-wide two-phase admission for Host-private Capsule storage.
 *
 * Every reservation is serialized. The full expected byte count remains
 * charged until the temporary file is gone, including the brief CAS publish
 * interval in which temporary and final directory entries coexist.
 */
export class CapsuleStorageBudget implements CapsuleStorageBudgetLike {
  readonly #requestedRoots: readonly string[];
  readonly #aggregateBytes: number;
  readonly #perAppBytes: number;
  readonly #filesystemReserveBytes: number;
  readonly #dependencies: StorageBudgetDependencies;
  readonly #reservations = new Map<number, ReservationRecord>();
  readonly #files = new Map<string, FileCharge>();
  readonly #ownerUsed = new Map<string, number>();
  readonly #ownerReserved = new Map<string, number>();
  #roots: readonly string[] | undefined;
  #usedBytes = 0;
  #reservedBytes = 0;
  #nextReservation = 1;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    roots: readonly string[];
    aggregateBytes?: number;
    perAppBytes?: number;
    filesystemReserveBytes?: number;
    dependencies?: Partial<StorageBudgetDependencies>;
  }) {
    if (options.roots.length < 1) throw new Error("Capsule storage requires a managed root");
    this.#requestedRoots = Object.freeze(options.roots.map((path) => {
      if (!isAbsolute(path)) throw new Error("Capsule storage roots must be absolute");
      return resolve(path);
    }));
    this.#aggregateBytes = positiveBytes(
      options.aggregateBytes ?? CAPSULE_STORAGE_POLICY.aggregateBytes,
      "aggregateBytes",
    );
    this.#perAppBytes = positiveBytes(
      options.perAppBytes ?? CAPSULE_STORAGE_POLICY.perAppBytes,
      "perAppBytes",
    );
    this.#filesystemReserveBytes = nonnegativeBytes(
      options.filesystemReserveBytes ?? CAPSULE_STORAGE_POLICY.filesystemReserveBytes,
      "filesystemReserveBytes",
    );
    if (this.#perAppBytes > this.#aggregateBytes) {
      throw new Error("Capsule per-App storage quota cannot exceed the aggregate quota");
    }
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  }

  async reserve(options: {
    owner: string;
    scope: CapsuleStorageScope;
    bytes: number;
  }): Promise<CapsuleStorageReservation> {
    const owner = validateOwner(options.owner);
    const scope = validateScope(options.scope);
    const bytes = positiveBytes(options.bytes, "reservation bytes");
    const id = await this.#locked(async () => {
      const roots = await this.#prepare();
      const ownerUsed = this.#ownerUsed.get(owner) ?? 0;
      const ownerReserved = this.#ownerReserved.get(owner) ?? 0;
      if (this.#usedBytes + this.#reservedBytes + bytes > this.#aggregateBytes) {
        throw new CapsuleStorageAdmissionError(
          `Capsule ${scope} admission exceeds the shared ${this.#aggregateBytes} byte quota`,
        );
      }
      if (isAppOwner(owner) && ownerUsed + ownerReserved + bytes > this.#perAppBytes) {
        throw new CapsuleStorageAdmissionError(
          `Capsule ${scope} admission exceeds App ${owner}'s ${this.#perAppBytes} byte quota`,
        );
      }
      const available = await this.#dependencies.availableBytes(roots[0]!);
      if (available < this.#filesystemReserveBytes + this.#reservedBytes + bytes) {
        throw new CapsuleStorageAdmissionError(
          `Capsule ${scope} admission would consume the fixed Host filesystem reserve`,
        );
      }
      const next = this.#nextReservation++;
      this.#reservations.set(next, { owner, scope, bytes });
      this.#reservedBytes += bytes;
      this.#ownerReserved.set(owner, ownerReserved + bytes);
      return next;
    });

    let finished = false;
    return Object.freeze({
      bytes,
      commit: async (persistedBytes: number, path?: string) => {
        if (finished) throw new Error("Capsule storage reservation was already settled");
        const persisted = nonnegativeBytes(persistedBytes, "persistedBytes");
        if (persisted > bytes) throw new Error("Capsule storage commit exceeds its reservation");
        const canonicalPath = persisted === 0
          ? undefined
          : await this.#canonicalManagedFilePath(path);
        await this.#finish(id, persisted, canonicalPath);
        finished = true;
      },
      release: async () => {
        if (finished) return;
        await this.#finish(id, 0);
        finished = true;
      },
    });
  }

  async reserveFile(options: {
    owner: string;
    scope: CapsuleStorageScope;
    path: string;
    bytes: number;
  }): Promise<CapsuleStorageFileReservation> {
    const expectedBytes = positiveBytes(options.bytes, "external file bytes");
    const path = resolve(options.path);
    await this.#locked(async () => {
      await this.#prepare();
      this.#assertManaged(path);
    });
    const existing = await safeRegularFileSize(path);
    if (existing !== undefined) {
      if (existing !== expectedBytes) {
        throw new CapsuleStorageAdmissionError("Capsule fixed storage file has an unexpected size");
      }
      await this.claim({ ...options, path, bytes: expectedBytes });
      return NOOP_FILE_RESERVATION;
    }

    const reservation = await this.reserve({
      owner: options.owner,
      scope: options.scope,
      bytes: expectedBytes,
    });
    let settled = false;
    return Object.freeze({
      settle: async () => {
        if (settled) return;
        const actual = await safeRegularFileSize(path);
        if (actual === undefined) {
          await reservation.release();
        } else if (actual === expectedBytes) {
          await reservation.commit(actual, path);
        } else {
          throw new CapsuleStorageAdmissionError(
            "Capsule external storage writer produced an unexpected file size",
          );
        }
        settled = true;
      },
      release: async () => {
        if (settled) return;
        if (await safeRegularFileSize(path) !== undefined) {
          throw new CapsuleStorageAdmissionError(
            "Capsule external storage reservation cannot be released after publication",
          );
        }
        await reservation.release();
        settled = true;
      },
    });
  }

  async claim(options: {
    owner: string;
    scope: CapsuleStorageScope;
    path: string;
    bytes: number;
  }): Promise<void> {
    const owner = validateOwner(options.owner);
    validateScope(options.scope);
    const bytes = positiveBytes(options.bytes, "claimed bytes");
    const path = await this.#canonicalManagedFilePath(options.path);
    await this.#locked(async () => {
      await this.#prepare();
      const charge = this.#files.get(path);
      if (!charge || charge.bytes !== bytes) {
        throw new CapsuleStorageAdmissionError("Capsule storage claim does not match a managed file");
      }
      if (charge.owners.has(owner)) return;
      const ownerUsed = this.#ownerUsed.get(owner) ?? 0;
      if (isAppOwner(owner) && ownerUsed + bytes > this.#perAppBytes) {
        throw new CapsuleStorageAdmissionError(
          `Capsule storage claim exceeds App ${owner}'s ${this.#perAppBytes} byte quota`,
        );
      }
      charge.owners.add(owner);
      this.#ownerUsed.set(owner, ownerUsed + bytes);
    });
  }

  async unclaim(options: { owner: string; path: string; bytes: number }): Promise<void> {
    const owner = validateOwner(options.owner);
    const bytes = positiveBytes(options.bytes, "unclaimed bytes");
    const path = await this.#canonicalManagedFilePath(options.path);
    await this.#locked(async () => {
      const charge = this.#files.get(path);
      if (!charge || charge.bytes !== bytes || !charge.owners.has(owner)) return;
      charge.owners.delete(owner);
      this.#debitOwner(owner, bytes);
    });
  }

  async remove(pathValue: string, options: { recursive?: boolean } = {}): Promise<number> {
    const requestedPath = resolve(pathValue);
    return await this.#locked(async () => {
      await this.#prepare();
      const path = await realpath(requestedPath).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT")) return requestedPath;
        throw error;
      });
      this.#assertManaged(path);
      const affected = [...this.#files.entries()].filter(([file]) => (
        file === path || (options.recursive === true && isDescendant(path, file))
      ));
      try {
        await rm(path, { force: true, recursive: options.recursive === true });
      } catch (error) {
        throw normalizeCapsuleStorageError(error, "Capsule storage GC failed");
      }
      let removed = 0;
      for (const [file, charge] of affected) {
        this.#files.delete(file);
        this.#usedBytes -= charge.bytes;
        removed += charge.bytes;
        for (const owner of charge.owners) this.#debitOwner(owner, charge.bytes);
      }
      return removed;
    });
  }

  async snapshot(): Promise<CapsuleStorageBudgetSnapshot> {
    return await this.#locked(async () => {
      await this.#prepare();
      return Object.freeze({
        aggregateBytes: this.#aggregateBytes,
        perAppBytes: this.#perAppBytes,
        usedBytes: this.#usedBytes,
        reservedBytes: this.#reservedBytes,
        reservations: this.#reservations.size,
        ownerUsedBytes: Object.freeze(Object.fromEntries(this.#ownerUsed)),
        ownerReservedBytes: Object.freeze(Object.fromEntries(this.#ownerReserved)),
      });
    });
  }

  async #finish(id: number, persistedBytes: number, path?: string): Promise<void> {
    await this.#locked(async () => {
      const reservation = this.#reservations.get(id);
      if (!reservation) throw new Error("Capsule storage reservation disappeared");
      if (persistedBytes > 0) {
        if (!path) throw new Error("Capsule storage commit requires its final managed path");
        if (this.#files.has(path)) {
          throw new CapsuleStorageAdmissionError("Capsule storage path was already committed");
        }
      }
      this.#reservations.delete(id);
      this.#reservedBytes -= reservation.bytes;
      this.#debitReserved(reservation.owner, reservation.bytes);
      if (persistedBytes === 0) return;
      this.#files.set(path!, { bytes: persistedBytes, owners: new Set([reservation.owner]) });
      this.#usedBytes += persistedBytes;
      this.#ownerUsed.set(
        reservation.owner,
        (this.#ownerUsed.get(reservation.owner) ?? 0) + persistedBytes,
      );
    });
  }

  async #prepare(): Promise<readonly string[]> {
    if (this.#roots) return this.#roots;
    const roots: string[] = [];
    let device: bigint | undefined;
    for (const requested of this.#requestedRoots) {
      await mkdir(requested, { recursive: true, mode: 0o700 });
      const info = await lstat(requested, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new CapsuleStorageAdmissionError("Capsule managed storage root is not a real directory");
      }
      if (device !== undefined && info.dev !== device) {
        throw new CapsuleStorageAdmissionError("Capsule managed storage roots must share one filesystem");
      }
      device = info.dev;
      roots.push(await realpath(requested));
    }
    for (let index = 0; index < roots.length; index += 1) {
      for (let other = index + 1; other < roots.length; other += 1) {
        if (isSameOrDescendant(roots[index]!, roots[other]!) || isSameOrDescendant(roots[other]!, roots[index]!)) {
          throw new CapsuleStorageAdmissionError("Capsule managed storage roots must not overlap");
        }
      }
    }
    for (const root of roots) await this.#scan(root);
    this.#roots = Object.freeze(roots);
    return this.#roots;
  }

  async #scan(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const details = await lstat(path, { bigint: true });
      if (details.isDirectory() && !details.isSymbolicLink()) {
        await this.#scan(path);
        continue;
      }
      if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1n) {
        throw new CapsuleStorageAdmissionError(
          `Capsule managed storage contains an unsupported entry: ${path}`,
        );
      }
      const bytes = Number(details.size);
      nonnegativeBytes(bytes, "managed file bytes");
      if (this.#usedBytes + bytes > Number.MAX_SAFE_INTEGER) {
        throw new CapsuleStorageAdmissionError("Capsule managed storage usage is too large");
      }
      this.#files.set(path, { bytes, owners: new Set() });
      this.#usedBytes += bytes;
    }
  }

  async #canonicalManagedFilePath(pathValue: string | undefined): Promise<string> {
    if (!pathValue || !isAbsolute(pathValue)) {
      throw new Error("Capsule storage commit path must be absolute");
    }
    const path = await realpath(resolve(pathValue));
    await this.#locked(async () => {
      await this.#prepare();
      this.#assertManaged(path);
    });
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const details = await handle.stat({ bigint: true });
      if (!details.isFile() || details.nlink !== 1n) {
        throw new CapsuleStorageAdmissionError("Capsule committed storage is not a regular single-link file");
      }
    } finally {
      await handle.close();
    }
    return path;
  }

  #assertManaged(path: string): void {
    if (
      !this.#roots?.some((root) => isDescendant(root, path))
      && !this.#requestedRoots.some((root) => isDescendant(root, path))
    ) {
      throw new CapsuleStorageAdmissionError("Capsule storage path is outside managed roots");
    }
  }

  #debitOwner(owner: string, bytes: number): void {
    const next = (this.#ownerUsed.get(owner) ?? 0) - bytes;
    if (next < 0) throw new Error("Capsule owner storage ledger underflow");
    if (next === 0) this.#ownerUsed.delete(owner);
    else this.#ownerUsed.set(owner, next);
  }

  #debitReserved(owner: string, bytes: number): void {
    const next = (this.#ownerReserved.get(owner) ?? 0) - bytes;
    if (next < 0) throw new Error("Capsule owner reservation ledger underflow");
    if (next === 0) this.#ownerReserved.delete(owner);
    else this.#ownerReserved.set(owner, next);
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prior = this.#tail;
    this.#tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const NOOP_FILE_RESERVATION: CapsuleStorageFileReservation = Object.freeze({
  async settle() {},
  async release() {},
});

export function normalizeCapsuleStorageError(error: unknown, message: string): Error {
  if (error instanceof CapsuleStorageAdmissionError) return error;
  if (isNodeError(error, "ENOSPC") || isNodeError(error, "EDQUOT")) {
    return new CapsuleStorageAdmissionError(message, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function validateOwner(value: string): string {
  if (value === "host" || /^[a-f0-9]{64}$/.test(value)) return value;
  throw new Error("Capsule storage owner must be host or a canonical App key");
}

function isAppOwner(value: string): boolean {
  return value !== "host";
}

function validateScope(value: string): CapsuleStorageScope {
  if (
    value === "vm-state"
    || value === "package-snapshot"
    || value === "dependency-cache"
    || value === "artifact-cas"
  ) return value;
  throw new Error("Capsule storage scope is invalid");
}

function positiveBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function nonnegativeBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
  return value;
}

async function safeRegularFileSize(path: string): Promise<number | undefined> {
  try {
    const details = await lstat(path, { bigint: true });
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1n) {
      throw new CapsuleStorageAdmissionError("Capsule fixed storage path is not a regular single-link file");
    }
    return nonnegativeBytes(Number(details.size), "fixed storage file bytes");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isDescendant(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  return root === candidate || isDescendant(root, candidate);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
