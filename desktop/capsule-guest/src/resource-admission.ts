import { readFile, statfs } from "node:fs/promises";
import { CAPSULE_GUEST_FILESYSTEM_RESERVE_BYTES } from "@lamarck/capsule";

const MiB = 1024 * 1024;
export const GUEST_MANAGEMENT_MEMORY_BYTES = 384 * MiB;
export const SHARED_BUILD_MEMORY_BYTES = 512 * MiB;

export interface GuestResourceRequest {
  readonly diskBytes?: number;
  readonly memoryBytes?: number;
  readonly kind?: "build" | "runtime";
  /** A Host-owned reservation for the complete Build -> Runtime transition. */
  readonly launchKey?: string;
}
export interface GuestResourceLease {
  readonly key: string;
  readonly diskBytes: number;
  readonly memoryBytes: number;
  /** Move held disk capacity to a durable output without releasing it first. */
  transferDisk?(key: string, bytes: number): GuestResourceLease;
  /** Reserve before writing memory.max; apply must READ BACK the effective limit. */
  growMemory?(bytes: number, apply: () => Promise<number>): Promise<void>;
  release(): void;
}
export interface GuestResourceAdmissionLike {
  reserve(key: string, request: GuestResourceRequest): Promise<GuestResourceLease>;
}
export interface GuestResourceAdmissionSnapshot {
  readonly diskBudgetBytes: number;
  readonly memoryBudgetBytes: number;
  readonly memoryCeilingBytes: number;
  readonly sharedBuildMemoryBytes: number;
  readonly reservedDiskBytes: number;
  readonly reservedMemoryBytes: number;
  readonly runtimeMemoryBytes: number;
  readonly reservations: number;
}
export class GuestResourceAdmissionError extends Error {
  readonly code = "CAPSULE_RESOURCE_EXHAUSTED";
  constructor(message: string) { super(message); this.name = "GuestResourceAdmissionError"; }
}
export class GuestMemoryContainmentError extends Error {
  readonly fatalGuest = true;
}
interface Reservation {
  diskBytes: number;
  memoryBytes: number;
  kind?: "build" | "runtime";
  launchKey?: string;
  futureRuntime: number;
  busy: boolean;
  releaseRequested: boolean;
}

/** One ledger of kernel grants, future handoffs, and bounded disk commitments.
 * Every mutation before an await is a short transaction on the Guest event loop.
 * Sequential phases borrow the same launch grant; existing Runtimes stay separate.
 */
export class GuestResourceAdmission implements GuestResourceAdmissionLike {
  #diskBudgetBytes: number;
  #memoryBudgetBytes: number;
  readonly #memoryCeilingBytes: number;
  readonly #sharedBuildMemoryBytes: number;
  readonly #reservations = new Map<string, Reservation>();

  constructor(options: { diskBudgetBytes: number; memoryBudgetBytes: number; sharedBuildMemoryBytes?: number }) {
    this.#diskBudgetBytes = positive(options.diskBudgetBytes, "diskBudgetBytes");
    this.#memoryBudgetBytes = positive(options.memoryBudgetBytes, "memoryBudgetBytes");
    this.#memoryCeilingBytes = this.#memoryBudgetBytes;
    this.#sharedBuildMemoryBytes = nonnegative(options.sharedBuildMemoryBytes ?? 0, "sharedBuildMemoryBytes");
  }

  static async fromSystem(options: {
    stateRoot: string; meminfoPath?: string; diskReserveBytes?: number; memoryReserveBytes?: number;
  }): Promise<GuestResourceAdmission> {
    const filesystem = await statfs(options.stateRoot, { bigint: true });
    const disk = Number(filesystem.bavail * filesystem.bsize);
    const total = parseGuestMemory(await readFile(options.meminfoPath ?? "/proc/meminfo", "utf8")).totalBytes;
    return new GuestResourceAdmission({
      diskBudgetBytes: positive(disk - (options.diskReserveBytes ?? CAPSULE_GUEST_FILESYSTEM_RESERVE_BYTES), "Guest disk after safety reserve"),
      memoryBudgetBytes: positive(total - (options.memoryReserveBytes ?? GUEST_MANAGEMENT_MEMORY_BYTES), "Guest memory after management reserve"),
      sharedBuildMemoryBytes: SHARED_BUILD_MEMORY_BYTES,
    });
  }

  reserveLaunch(key: string, runtimeBytes: number, buildBytes: number): GuestResourceLease {
    positive(runtimeBytes, "Runtime grant"); nonnegative(buildBytes, "Build grant");
    return this.#reserve(key, { memoryBytes: Math.max(runtimeBytes, buildBytes) }, runtimeBytes);
  }

  releaseLaunch(key: string): void {
    const record = this.#reservations.get(key);
    if (!record) return; // Lost acknowledgement is safe to retry.
    if (record.kind || record.launchKey) throw new Error("Not a launch reservation");
    this.#release(key, record);
  }

  async reserve(key: string, request: GuestResourceRequest): Promise<GuestResourceLease> {
    return this.#reserve(key, request, 0);
  }

  #reserve(key: string, request: GuestResourceRequest, futureRuntime: number): GuestResourceLease {
    validateKey(key);
    if (this.#reservations.has(key)) throw new Error(`Guest resource reservation already exists: ${key}`);
    const memoryBytes = nonnegative(request.memoryBytes ?? 0, "memoryBytes");
    const diskBytes = nonnegative(request.diskBytes ?? 0, "diskBytes");
    if (!memoryBytes && !diskBytes) throw new Error("Guest resource reservation must request disk or memory");
    const parent = request.launchKey ? this.#reservations.get(request.launchKey) : undefined;
    if (request.launchKey && (!parent || parent.releaseRequested || parent.kind || parent.memoryBytes < memoryBytes)) {
      throw new GuestResourceAdmissionError("Launch grant is missing or insufficient for its next phase");
    }
    const runtime = request.kind === "runtime" ? memoryBytes : futureRuntime;
    const transferredFuture = parent && request.kind === "runtime" ? Math.min(parent.futureRuntime, memoryBytes) : 0;
    this.#check(diskBytes, parent ? 0 : memoryBytes, runtime - transferredFuture);
    if (parent) { parent.memoryBytes -= memoryBytes; parent.futureRuntime -= transferredFuture; }
    const record: Reservation = { diskBytes, memoryBytes, kind: request.kind, launchKey: request.launchKey,
      futureRuntime, busy: false, releaseRequested: false };
    this.#reservations.set(key, record);
    return this.#lease(key, record);
  }

  #lease(key: string, record: Reservation): GuestResourceLease {
    return Object.freeze({
      key, get diskBytes() { return record.diskBytes; }, get memoryBytes() { return record.memoryBytes; },
      transferDisk: (targetKey: string, bytes: number) => {
        validateKey(targetKey); positive(bytes, "disk transfer");
        if (record.releaseRequested || this.#reservations.get(key) !== record || record.busy) throw new Error("Reservation is closing or changing");
        if (this.#reservations.has(targetKey) || bytes > record.diskBytes) throw new Error("Invalid disk reservation transfer");
        const target: Reservation = { diskBytes: bytes, memoryBytes: 0, futureRuntime: 0, busy: false, releaseRequested: false };
        record.diskBytes -= bytes;
        this.#reservations.set(targetKey, target);
        return this.#lease(targetKey, target);
      },
      growMemory: async (bytes: number, apply: () => Promise<number>) => {
        positive(bytes, "memory grant");
        if (record.releaseRequested || !this.#reservations.has(key) || record.busy) throw new Error("Grant is closing or already changing");
        if (bytes < record.memoryBytes) throw new Error("Live memory grants cannot shrink");
        if (bytes === record.memoryBytes) return;
        const previous = record.memoryBytes;
        const delta = bytes - previous;
        this.#check(0, delta, record.kind === "runtime" ? delta : 0);
        record.memoryBytes = bytes; // Capacity is held BEFORE the kernel can observe a larger hard limit.
        record.busy = true;
        try {
          const effective = await apply();
          if (effective !== previous && effective !== bytes) throw new GuestMemoryContainmentError("Unexpected effective memory limit");
          record.memoryBytes = effective;
          if (effective !== bytes) throw new Error("Kernel did not accept the requested memory grant");
        } finally {
          // If apply/readback fails ambiguously, keep the larger commitment.
          record.busy = false;
          if (record.releaseRequested) this.#release(key, record);
        }
      },
      release: () => this.#release(key, record),
    });
  }

  #release(key: string, record: Reservation): void {
    record.releaseRequested = true;
    if (record.busy || this.#reservations.get(key) !== record) return;
    const parent = record.launchKey ? this.#reservations.get(record.launchKey) : undefined;
    if (parent) {
      parent.memoryBytes += record.memoryBytes;
      if (record.kind === "runtime") parent.futureRuntime += record.memoryBytes;
    }
    this.#reservations.delete(key);
  }

  #check(disk: number, memory: number, runtime: number): void {
    const state = this.snapshot();
    if (state.reservedDiskBytes + disk > this.#diskBudgetBytes) throw new GuestResourceAdmissionError("Guest state disk admission denied: bounded commitments exceed available capacity");
    if (state.reservedMemoryBytes + memory > this.#memoryBudgetBytes) throw new GuestResourceAdmissionError("Guest memory admission denied: capacity has not been supplied");
    if (state.runtimeMemoryBytes + runtime > this.#memoryCeilingBytes - this.#sharedBuildMemoryBytes) {
      throw new GuestResourceAdmissionError("Runtime capacity exhausted: the shared Build reserve must remain available");
    }
  }

  /** Fence admissions BEFORE asking the Host to reclaim any pages. */
  prepareMemoryCapacity(bytes: number): void {
    positive(bytes, "memory capacity");
    if (bytes > this.#memoryBudgetBytes || bytes < this.snapshot().reservedMemoryBytes) {
      throw new GuestResourceAdmissionError("Memory reclamation would cross an active commitment");
    }
    this.#memoryBudgetBytes = bytes;
  }

  /** Only call with capacity actually read from the Guest kernel after supply. */
  acknowledgeMemoryCapacity(usableBytes: number): void {
    const bytes = Math.min(positive(usableBytes, "acknowledged capacity"), this.#memoryCeilingBytes);
    if (bytes < this.snapshot().reservedMemoryBytes) throw new GuestResourceAdmissionError("Guest usable memory fell below its active commitments");
    this.#memoryBudgetBytes = bytes;
  }

  /** ext4 growth is irreversible; increment by the VERIFIED filesystem delta. */
  acknowledgeDiskGrowth(additionalBytes: number): void {
    this.#diskBudgetBytes = positive(this.#diskBudgetBytes + nonnegative(additionalBytes, "disk growth"), "disk budget");
  }

  snapshot(): GuestResourceAdmissionSnapshot {
    let disk = 0, memory = 0, runtime = 0;
    for (const item of this.#reservations.values()) {
      disk += item.diskBytes; memory += item.memoryBytes;
      runtime += item.kind === "runtime" ? item.memoryBytes : item.futureRuntime;
    }
    return Object.freeze({ diskBudgetBytes: this.#diskBudgetBytes, memoryBudgetBytes: this.#memoryBudgetBytes,
      memoryCeilingBytes: this.#memoryCeilingBytes, sharedBuildMemoryBytes: this.#sharedBuildMemoryBytes,
      reservedDiskBytes: disk, reservedMemoryBytes: memory, runtimeMemoryBytes: runtime, reservations: this.#reservations.size });
  }
}

const NOOP_LEASE: GuestResourceLease = Object.freeze({ key: "noop", diskBytes: 0, memoryBytes: 0, release() {} });
/** Unit-test seam; main.ts always supplies a real ledger. */
export const UNBOUNDED_GUEST_RESOURCE_ADMISSION: GuestResourceAdmissionLike = Object.freeze({ async reserve() { return NOOP_LEASE; } });

export function parseGuestMemory(source: string): { totalBytes: number; availableBytes: number; balloonBytes: number } {
  const field = (name: string, required = false) => {
    const matches = [...source.matchAll(new RegExp(`^${name}:\\s+(\\d+)\\s+kB\\s*$`, "gm"))];
    if (matches.length !== 1) {
      if (!required && matches.length === 0) return 0;
      throw new GuestResourceAdmissionError(`/proc/meminfo must contain exactly one ${name} value`);
    }
    return nonnegative(Number(matches[0]![1]) * 1024, name);
  };
  return { totalBytes: positive(field("MemTotal", true), "MemTotal"), availableBytes: field("MemAvailable"), balloonBytes: field("Balloon") };
}
/** MemTotal may include balloon pages when DEFLATE_ON_OOM is negotiated.
 * Linux 6.18.39 exposes the current NR_BALLOON_PAGES as Balloon in meminfo.
 * Compare against the immutable boot total to avoid subtracting twice on
 * devices that already reduce MemTotal. Leave room for per-CPU stat drift. */
export function usableGuestMemory(memory: ReturnType<typeof parseGuestMemory>, bootTotal: number): number {
  return Math.max(0, Math.min(memory.totalBytes,
    bootTotal - memory.balloonBytes - (memory.balloonBytes > 0 ? 8 * MiB : 0)));
}
function positive(value: number, label: string): number {
  if (value <= 0) throw new GuestResourceAdmissionError(`${label} must be positive`);
  return nonnegative(value, label);
}
function nonnegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new GuestResourceAdmissionError(`${label} must be a nonnegative safe integer`);
  return value;
}
function validateKey(value: string): void {
  if (typeof value !== "string" || !value.length || value.length > 512 || value.includes("\0")) throw new Error("Guest resource reservation key is invalid");
}
