import type { RequestBodyFor } from "./guest-session";
import type { HostOperation, JsonValue } from "@lamarck/capsule";
import type { CapsuleStorageBudgetLike } from "./storage-budget";

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const MANAGEMENT = 384 * MiB;
const CACHE_HEADROOM = 256 * MiB;
export interface GuestCapacity {
  memoryBudgetBytes: number; memoryCeilingBytes: number; reservedMemoryBytes: number;
  diskBudgetBytes: number;
  runtimeMemoryBytes: number; sharedBuildMemoryBytes: number; reservedDiskBytes: number;
  projectedRuntimeMemoryBytes?: number;
  cpuPressureAvg10?: number | null; ioPressureAvg10?: number | null; memoryPressureAvg10?: number | null;
  totalBytes: number; usableMemoryBytes: number; availableBytes: number; filesystemBytes: number; freeDiskBytes: number;
}
interface Session {
  request<T extends HostOperation>(op: T, body: RequestBodyFor<T>): Promise<JsonValue>;
}
interface Helper {
  setMemory(bytes: number): Promise<number>;
  growState(bytes: number): Promise<number>;
  acknowledgeState(bytes: number): Promise<number>;
}
export class CapacityExhaustedError extends Error {
  readonly code = "CAPSULE_RESOURCE_EXHAUSTED";
}

export function parseGuestCapacity(value: unknown): GuestCapacity {
  if (!value || typeof value !== "object") throw new Error("Missing Guest capacity acknowledgement");
  const fields = ["diskBudgetBytes", "memoryBudgetBytes", "memoryCeilingBytes", "reservedMemoryBytes", "runtimeMemoryBytes", "sharedBuildMemoryBytes", "reservedDiskBytes", "totalBytes", "usableMemoryBytes", "availableBytes", "filesystemBytes", "freeDiskBytes"] as const;
  for (const key of fields) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0 || item > 64 * GiB) throw new Error(`Invalid Guest capacity ${key}`);
  }
  for (const key of ["cpuPressureAvg10", "ioPressureAvg10", "memoryPressureAvg10"]) {
    const pressure = (value as Record<string, unknown>)[key];
    if (pressure !== undefined && pressure !== null && (typeof pressure !== "number" || !Number.isFinite(pressure) || pressure < 0 || pressure > 100)) throw new Error("Invalid Guest pressure acknowledgement");
  }
  const state = value as GuestCapacity;
  if (state.projectedRuntimeMemoryBytes !== undefined && (!Number.isSafeInteger(state.projectedRuntimeMemoryBytes)
    || state.projectedRuntimeMemoryBytes < 0 || state.projectedRuntimeMemoryBytes > state.runtimeMemoryBytes)) throw new Error("Invalid projected Runtime commitments");
  if (state.memoryBudgetBytes > state.memoryCeilingBytes || state.memoryCeilingBytes > 4 * GiB
    || state.reservedMemoryBytes > state.memoryBudgetBytes || state.runtimeMemoryBytes > state.reservedMemoryBytes) throw new Error("Inconsistent Guest memory commitments");
  return state;
}

/** Private coordination of the one VM. Guest capacity, boot ceiling and Host
 * footprint are deliberately separate; no balloon command is a memory grant. */
export class VmCapacityCoordinator {
  #memoryTail: Promise<unknown> = Promise.resolve();
  #diskTail: Promise<unknown> = Promise.resolve();
  #diskAdmissionTail: Promise<unknown> = Promise.resolve();
  #pendingImportDisk = 0;
  #lastActivity: number;
  #lastReclaim = 0;
  #closed = false;
  readonly #building = new Set<string>();
  #timer?: ReturnType<typeof setInterval>;
  constructor(readonly session: Session, readonly helper: Helper,
    readonly storage: CapsuleStorageBudgetLike, readonly statePath: string,
    public stateDiskBytes: number, readonly bootMemoryBytes = 4 * GiB,
    readonly now = Date.now) { this.#lastActivity = now(); }

  start(): void {
    this.#timer = setInterval(() => { void this.observeIdle().catch(() => {}); }, 5_000);
    this.#timer.unref();
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    await Promise.allSettled([this.#memoryTail, this.#diskTail, this.#diskAdmissionTail]);
  }
  async status(): Promise<GuestCapacity> { return parseGuestCapacity(await this.session.request("resources.status", {})); }

  /** Serialize only supply + the Guest reservation acknowledgement. Build
   * execution and existing viewer traffic never hold this transaction. */
  withDiskAdmission<T>(bytes: number, reserve: () => Promise<T>): Promise<T> {
    const operation = this.#diskAdmissionTail.catch(() => {}).then(async () => {
      if (this.#closed) throw new Error("VM capacity coordinator is closed");
      const state = await this.status();
      const required = state.reservedDiskBytes + this.#pendingImportDisk + bytes;
      if (required > state.diskBudgetBytes) {
        // Physical device bytes include ext4 metadata and its safety reserve.
        // Grow from the measured usable-budget deficit, not logical file size.
        await this.growState(this.stateDiskBytes + Math.ceil((required - state.diskBudgetBytes) * 1.05) + 64 * MiB);
        if ((await this.status()).diskBudgetBytes < required) throw new CapacityExhaustedError("Guest filesystem did not supply the required disk commitments");
      }
      return reserve();
    });
    this.#diskAdmissionTail = operation;
    return operation;
  }

  async reserveImport(bytes: number): Promise<() => void> {
    await this.withDiskAdmission(bytes, async () => { this.#pendingImportDisk += bytes; });
    let released = false;
    return () => { if (!released) { released = true; this.#pendingImportDisk -= bytes; } };
  }

  async reserveLaunch(key: string, runtimeBytes: number, buildBytes: number,
    replacement?: RequestBodyFor<"resources.launch.reserve">["replacement"]): Promise<void> {
    return this.#memoryTransaction(async () => {
      this.#lastActivity = this.now();
      const state = await this.status();
      // Replacement credit is calculated only by the Guest from its live lease.
      if (!replacement && (state.projectedRuntimeMemoryBytes ?? state.runtimeMemoryBytes) + runtimeBytes > state.memoryCeilingBytes - state.sharedBuildMemoryBytes) {
        throw new CapacityExhaustedError("This App exceeds available Runtime capacity; existing Apps remain active");
      }
      if (buildBytes > 0 && this.#building.size > 0 && ((state.cpuPressureAvg10 ?? 0) > 50
        || (state.ioPressureAvg10 ?? 0) > 10 || (state.memoryPressureAvg10 ?? 0) > 1)) {
        throw new CapacityExhaustedError("Guest pressure permits only one concurrent Build");
      }
      const required = state.reservedMemoryBytes + Math.max(runtimeBytes, buildBytes);
      if (required > state.memoryCeilingBytes) throw new CapacityExhaustedError("Transient Build capacity is currently occupied");
      await this.#supply(required, state);
      try {
        await this.session.request("resources.launch.reserve", { launchKey: key, runtimeMemoryBytes: runtimeBytes, buildMemoryBytes: buildBytes,
          ...(replacement ? { replacement } : {}) });
        if (buildBytes > 0) this.#building.add(key);
      } catch (error) {
        // The reserve may have reached the Guest even if its reply was lost.
        // Release is idempotent; never leave an ownerless launch commitment.
        await this.session.request("resources.launch.release", { launchKey: key });
        if ((error as { code?: string }).code === "CAPSULE_RESOURCE_EXHAUSTED") throw new CapacityExhaustedError(String(error));
        throw error;
      }
    });
  }
  async releaseLaunch(key: string): Promise<void> {
    this.#lastActivity = this.now();
    await this.session.request("resources.launch.release", { launchKey: key });
    this.#building.delete(key);
  }

  async #supply(required: number, state: GuestCapacity): Promise<void> {
    if (required <= state.memoryBudgetBytes) return;
    // Boot kernel overhead is not grantable memory and cannot be ballooned in.
    const overhead = this.bootMemoryBytes - state.memoryCeilingBytes;
    const target = Math.min(this.bootMemoryBytes, align(required + overhead + CACHE_HEADROOM, 64 * MiB));
    await this.helper.setMemory(target);
    const expectedUsable = target - (this.bootMemoryBytes - state.memoryCeilingBytes - MANAGEMENT);
    const deadline = Date.now() + 5_000;
    do {
      const measured = await this.status();
      // A previous inflation may still be in flight. An old, larger reading
      // must not acknowledge a newer target before that transition is observed.
      if (measured.usableMemoryBytes <= expectedUsable + 16 * MiB
        && measured.usableMemoryBytes - MANAGEMENT >= required) {
        const ack = parseGuestCapacity(await this.session.request("resources.memory.commit", { memoryBytes: Math.min(state.memoryCeilingBytes, target - overhead) }));
        if (ack.memoryBudgetBytes >= required) return;
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (!this.#closed);
    throw new CapacityExhaustedError("Guest memory supply did not become available; no new grant was issued");
  }

  async observeIdle(): Promise<void> {
    return this.#memoryTransaction(async () => {
      if (this.#closed) return;
      const state = await this.status();
      // Keep growth headroom supplied even when the balloon was previously idle.
      if (state.reservedMemoryBytes > state.memoryBudgetBytes - 128 * MiB && state.memoryBudgetBytes < state.memoryCeilingBytes) {
        await this.#supply(Math.min(state.memoryCeilingBytes, state.reservedMemoryBytes + CACHE_HEADROOM), state);
        this.#lastActivity = this.now();
        return;
      }
      if (this.now() - this.#lastActivity < 30_000 || this.now() - this.#lastReclaim < 30_000) return;
      const overhead = this.bootMemoryBytes - state.memoryCeilingBytes;
      const target = Math.max(768 * MiB, align(state.reservedMemoryBytes + overhead + CACHE_HEADROOM, 64 * MiB));
      const budget = target - overhead;
      if (budget > state.memoryBudgetBytes - 256 * MiB || state.availableBytes < 256 * MiB) return;
      await this.session.request("resources.memory.prepare", { memoryBytes: budget });
      await this.helper.setMemory(target);
      // Admission stays fenced at the smaller budget even if balloon inflation
      // is delayed. A later supply commits only observed Guest capacity.
      this.#lastReclaim = this.now();
    });
  }

  async growState(required: number): Promise<number> {
    const operation = this.#diskTail.catch(() => {}).then(async () => {
      if (this.#closed) throw new Error("VM capacity coordinator is closed");
      if (required <= this.stateDiskBytes) return this.stateDiskBytes;
      const target = align(required, GiB);
      if (target > 64 * GiB) throw new CapacityExhaustedError("Guest state capacity ceiling exhausted");
      if (!this.storage.reserveStateGrowth) throw new Error("Host storage growth accounting is unavailable");
      const reservation = await this.storage.reserveStateGrowth(this.statePath, target);
      try {
        const backed = await this.helper.growState(target);
        if (backed < target || backed > 64 * GiB) throw new Error("Host did not supply the required disk backing");
        const ack = await this.session.request("resources.disk.grow", { bytes: backed });
        if (!ack || typeof ack !== "object" || Array.isArray(ack) || ack.stateCapacityBytes !== backed) throw new Error("Guest did not acknowledge filesystem growth");
        await this.helper.acknowledgeState(backed);
        this.stateDiskBytes = backed;
        return backed;
      } finally {
        // Partial completion is a durable high-water commitment, including when
        // the command or Guest ack was lost. It is never rolled back by truncation.
        await reservation.settle();
      }
    });
    this.#diskTail = operation;
    return operation;
  }
  #memoryTransaction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#memoryTail.catch(() => {}).then(operation);
    this.#memoryTail = result;
    return result;
  }
}
function align(value: number, unit: number): number { return Math.ceil(value / unit) * unit; }

interface QueuedLaunch {
  admit(): Promise<void>; signal: AbortSignal; resolve(release: () => void): void; reject(error: unknown): void;
  build: boolean;
  cancel(): void;
}
/** Only waits for finite Builds/preparations, never for a long-lived App to close. */
export class BuildProgressQueue {
  #active = 0;
  #activeBuilds = 0;
  #queue: QueuedLaunch[] = [];
  #pumping = false;
  #pumpAgain = false;
  acquire(admit: () => Promise<void>, signal: AbortSignal, build = true): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#queue.length >= 64) return Promise.reject(new Error("Build queue is full"));
    return new Promise((resolve, reject) => {
      const item: QueuedLaunch = { admit, signal, build, resolve, reject, cancel: () => {
        this.#remove(item);
        reject(signal.reason ?? new Error("Build cancelled"));
        void this.#pump();
      } };
      signal.addEventListener("abort", item.cancel, { once: true });
      this.#queue.push(item);
      void this.#pump();
    });
  }
  #remove(item: QueuedLaunch): void {
    const index = this.#queue.indexOf(item);
    if (index >= 0) this.#queue.splice(index, 1);
    item.signal.removeEventListener("abort", item.cancel);
  }
  async #pump(): Promise<void> {
    if (this.#pumping) { this.#pumpAgain = true; return; }
    this.#pumping = true;
    try {
      while (this.#queue.length) {
        // Keep FIFO when a Build slot is free; otherwise let the oldest
        // cached launch attempt normal resource admission past waiting Builds.
        const item = this.#queue.find(candidate => !candidate.build || this.#activeBuilds < 2);
        if (!item) return;
        if (item.signal.aborted) { item.cancel(); continue; }
        item.signal.removeEventListener("abort", item.cancel);
        try { await item.admit(); }
        catch (error) {
          if (error instanceof CapacityExhaustedError && this.#active > 0 && !item.signal.aborted) {
            item.signal.addEventListener("abort", item.cancel, { once: true });
            return;
          }
          this.#remove(item); item.reject(error); continue;
        }
        // Cancellation during admission cannot drop a successfully held grant:
        // the caller gets the release handle and owns authoritative cleanup.
        this.#remove(item);
        this.#active += 1;
        if (item.build) this.#activeBuilds += 1;
        let released = false;
        item.resolve(() => {
          if (released) return;
          released = true; this.#active -= 1;
          if (item.build) this.#activeBuilds -= 1;
          void this.#pump();
        });
      }
    } finally {
      this.#pumping = false;
      // A release/cancellation while admit() awaited must not lose its wakeup.
      if (this.#pumpAgain) { this.#pumpAgain = false; void this.#pump(); }
    }
  }
}
