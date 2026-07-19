import { readFile, statfs } from "node:fs/promises";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;
const DEFAULT_DISK_RESERVE_BYTES = 2 * GIBIBYTE;
const MINIMUM_MEMORY_RESERVE_BYTES = 256 * MEBIBYTE;

export interface GuestResourceRequest {
  readonly diskBytes?: number;
  readonly memoryBytes?: number;
}

export interface GuestResourceLease {
  readonly key: string;
  readonly diskBytes: number;
  readonly memoryBytes: number;
  release(): void;
}

export interface GuestResourceAdmissionLike {
  reserve(key: string, request: GuestResourceRequest): Promise<GuestResourceLease>;
}

export interface GuestResourceAdmissionSnapshot {
  readonly diskBudgetBytes: number;
  readonly memoryBudgetBytes: number;
  readonly reservedDiskBytes: number;
  readonly reservedMemoryBytes: number;
  readonly reservations: number;
}

export class GuestResourceAdmissionError extends Error {
  readonly code = "CAPSULE_RESOURCE_EXHAUSTED";

  constructor(message: string) {
    super(message);
    this.name = "GuestResourceAdmissionError";
  }
}

interface Reservation {
  readonly diskBytes: number;
  readonly memoryBytes: number;
}

/**
 * One Guest-wide reservation ledger for every bounded App, Build, workload,
 * and newly persisted CAS object. The budgets are derived once after stale
 * scratch recovery, so sparse volumes cannot collectively promise more than
 * the shared VM can actually supply.
 */
export class GuestResourceAdmission implements GuestResourceAdmissionLike {
  readonly #diskBudgetBytes: number;
  readonly #memoryBudgetBytes: number;
  readonly #reservations = new Map<string, Reservation>();
  #reservedDiskBytes = 0;
  #reservedMemoryBytes = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    diskBudgetBytes: number;
    memoryBudgetBytes: number;
  }) {
    this.#diskBudgetBytes = boundedCapacity(options.diskBudgetBytes, "diskBudgetBytes");
    this.#memoryBudgetBytes = boundedCapacity(options.memoryBudgetBytes, "memoryBudgetBytes");
  }

  static async fromSystem(options: {
    stateRoot: string;
    meminfoPath?: string;
    diskReserveBytes?: number;
    memoryReserveBytes?: number;
  }): Promise<GuestResourceAdmission> {
    const filesystem = await statfs(options.stateRoot, { bigint: true });
    const availableDiskBytes = safeBigIntBytes(
      filesystem.bavail * filesystem.bsize,
      "available Guest state disk",
    );
    const totalMemoryBytes = parseMemTotalBytes(
      await readFile(options.meminfoPath ?? "/proc/meminfo", "utf8"),
    );
    const diskReserveBytes = boundedReserve(
      options.diskReserveBytes ?? DEFAULT_DISK_RESERVE_BYTES,
      "diskReserveBytes",
    );
    const memoryReserveBytes = boundedReserve(
      options.memoryReserveBytes
        ?? Math.max(MINIMUM_MEMORY_RESERVE_BYTES, Math.floor(totalMemoryBytes / 4)),
      "memoryReserveBytes",
    );
    if (availableDiskBytes <= diskReserveBytes) {
      throw new GuestResourceAdmissionError(
        "Guest state disk does not have enough free space to preserve its safety reserve",
      );
    }
    if (totalMemoryBytes <= memoryReserveBytes) {
      throw new GuestResourceAdmissionError(
        "Guest memory does not have enough capacity to preserve its supervisor reserve",
      );
    }
    return new GuestResourceAdmission({
      diskBudgetBytes: availableDiskBytes - diskReserveBytes,
      memoryBudgetBytes: totalMemoryBytes - memoryReserveBytes,
    });
  }

  async reserve(keyValue: string, request: GuestResourceRequest): Promise<GuestResourceLease> {
    const key = validateReservationKey(keyValue);
    const diskBytes = boundedRequest(request.diskBytes ?? 0, "diskBytes");
    const memoryBytes = boundedRequest(request.memoryBytes ?? 0, "memoryBytes");
    if (diskBytes === 0 && memoryBytes === 0) {
      throw new Error("Guest resource reservation must request disk or memory");
    }

    let releaseGate!: () => void;
    const prior = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    await prior;
    try {
      if (this.#reservations.has(key)) {
        throw new Error(`Guest resource reservation already exists: ${key}`);
      }
      if (this.#reservedDiskBytes + diskBytes > this.#diskBudgetBytes) {
        throw new GuestResourceAdmissionError(
          `Guest state disk admission denied ${key}: ${diskBytes} bytes exceed the remaining shared budget`,
        );
      }
      if (this.#reservedMemoryBytes + memoryBytes > this.#memoryBudgetBytes) {
        throw new GuestResourceAdmissionError(
          `Guest memory admission denied ${key}: ${memoryBytes} bytes exceed the remaining shared budget`,
        );
      }
      this.#reservations.set(key, { diskBytes, memoryBytes });
      this.#reservedDiskBytes += diskBytes;
      this.#reservedMemoryBytes += memoryBytes;
    } finally {
      releaseGate();
    }

    let released = false;
    return Object.freeze({
      key,
      diskBytes,
      memoryBytes,
      release: () => {
        if (released) return;
        const reservation = this.#reservations.get(key);
        if (!reservation) {
          throw new Error(`Guest resource reservation disappeared: ${key}`);
        }
        released = true;
        this.#reservations.delete(key);
        this.#reservedDiskBytes -= reservation.diskBytes;
        this.#reservedMemoryBytes -= reservation.memoryBytes;
      },
    });
  }

  snapshot(): GuestResourceAdmissionSnapshot {
    return Object.freeze({
      diskBudgetBytes: this.#diskBudgetBytes,
      memoryBudgetBytes: this.#memoryBudgetBytes,
      reservedDiskBytes: this.#reservedDiskBytes,
      reservedMemoryBytes: this.#reservedMemoryBytes,
      reservations: this.#reservations.size,
    });
  }
}

const NOOP_LEASE: GuestResourceLease = Object.freeze({
  key: "noop",
  diskBytes: 0,
  memoryBytes: 0,
  release() {},
});

/** Test/backward-compatible seam. Production always installs the bounded ledger. */
export const UNBOUNDED_GUEST_RESOURCE_ADMISSION: GuestResourceAdmissionLike = Object.freeze({
  async reserve() {
    return NOOP_LEASE;
  },
});

function parseMemTotalBytes(source: string): number {
  const matches = [...source.matchAll(/^MemTotal:\s+(\d+)\s+kB\s*$/gm)];
  if (matches.length !== 1) {
    throw new GuestResourceAdmissionError("/proc/meminfo must contain exactly one MemTotal value");
  }
  const kibibytes = Number(matches[0]![1]);
  if (!Number.isSafeInteger(kibibytes) || kibibytes < 1) {
    throw new GuestResourceAdmissionError("/proc/meminfo contains an invalid MemTotal value");
  }
  return boundedCapacity(kibibytes * 1024, "MemTotal");
}

function safeBigIntBytes(value: bigint, label: string): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new GuestResourceAdmissionError(`${label} is outside the supported range`);
  }
  return Number(value);
}

function boundedCapacity(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GuestResourceAdmissionError(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedReserve(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GuestResourceAdmissionError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function boundedRequest(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Guest resource ${label} must be a nonnegative safe integer`);
  }
  return value;
}

function validateReservationKey(value: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 512
    || value.includes("\0")
  ) {
    throw new Error("Guest resource reservation key is invalid");
  }
  return value;
}
