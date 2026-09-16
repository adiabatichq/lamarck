import { open, readFile, writeFile } from "node:fs/promises";
import { constants, watch } from "node:fs";
import { performance } from "node:perf_hooks";
import type { RuntimeMemoryStatus } from "@lamarck/capsule";
import type { GuestResourceLease } from "./resource-admission";
import { GuestMemoryContainmentError, GuestResourceAdmissionError } from "./resource-admission";

export const RUNTIME_MEMORY_STEP_BYTES = 64 * 1024 * 1024;
// Initial grants stay 256/512 MiB. This ceiling matches the 2 GiB App parent;
// every increase must also fit the authoritative global ledger.
export const RUNTIME_MEMORY_POLICY_BYTES = 2 * 1024 * 1024 * 1024;
const RUNTIME_MEMORY_FLOOR_BYTES = 192 * 1024 * 1024;
const RUNTIME_MEMORY_IDLE_MS = 10_000;
const IDLE_GRANT_QUANTUM = 16 * 1024 * 1024;
const idleGrant = (used: number) => Math.ceil(used / 0.8 / IDLE_GRANT_QUANTUM) * IDLE_GRANT_QUANTUM;

/** Guest-only policy: avoid backing sparse workload allocations with huge pages. */
export async function configureGuestMemoryPages(): Promise<void> {
  try { await writeFile("/sys/kernel/mm/transparent_hugepage/enabled", "never"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Guest huge-page tuning unavailable:", String(error).slice(0, 256));
    }
  }
}

interface Measurement {
  usageBytes: number; anonBytes: number; kernelBytes: number;
  pressureTotalUs: number; highEvents: number; maxEvents: number;
  inactiveFileBytes?: number; dirtyFileBytes?: number; writebackFileBytes?: number;
}

export interface RuntimeMemoryKernel {
  workingBytes(): Promise<number>;
  measure?(): Promise<Measurement>;
  readLimit(): Promise<number>;
  writeLimit(bytes: number): Promise<void>;
  writeHigh(bytes: number): Promise<void>;
  reclaimCache?(bytes: number): Promise<void>;
  watchPressure?(observe: () => void): () => void;
}

const counters = (text: string) => Object.fromEntries(text.trim().split("\n").map(line => line.split(/\s+/)));
const count = (value: string | undefined): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid cgroup observation");
  return result;
};
export function linuxRuntimeMemoryKernel(path: string): RuntimeMemoryKernel {
  // Limit writes must not stall this shared controller in synchronous reclaim.
  const write = async (file: string, bytes: number) => {
    const handle = await open(`${path}/${file}`, constants.O_WRONLY | constants.O_NONBLOCK);
    try { await handle.writeFile(String(bytes)); } finally { await handle.close(); }
  };
  return {
    async workingBytes() { return count((await readFile(`${path}/memory.current`, "utf8")).trim()); },
    async measure() {
      const [current, stat, events, pressure] = await Promise.all(
        ["memory.current", "memory.stat", "memory.events", "memory.pressure"]
          .map(file => readFile(`${path}/${file}`, "utf8")));
      const memory = counters(stat!), event = counters(events!);
      const some = /^some avg10=([0-9.]+).* total=(\d+)$/m.exec(pressure!);
      if (!some) throw new Error("Missing cgroup pressure observation");
      return { usageBytes: count(current!.trim()), anonBytes: count(memory.anon), kernelBytes: count(memory.kernel),
        inactiveFileBytes: count(memory.inactive_file), dirtyFileBytes: count(memory.file_dirty), writebackFileBytes: count(memory.file_writeback),
        pressureTotalUs: count(some[2]), highEvents: count(event.high), maxEvents: count(event.max) };
    },
    async readLimit() {
      const limit = Number((await readFile(`${path}/memory.max`, "utf8")).trim());
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid kernel memory.max acknowledgement");
      return limit;
    },
    writeLimit: (bytes) => write("memory.max", bytes),
    writeHigh: (bytes) => write("memory.high", bytes),
    reclaimCache: (bytes) => writeFile(`${path}/memory.reclaim`, `${bytes} swappiness=0`),
    watchPressure(observe) {
      const watcher = watch(`${path}/memory.events`, observe);
      // The periodic observation remains the fallback if notifications fail.
      watcher.on("error", () => watcher.close());
      return () => watcher.close();
    },
  };
}

/** Pure decision; cumulative event/PSI deltas detect reclaim even when RSS is flat. */
function runtimeUnderPressure(sample: Measurement, previous: Measurement | undefined): boolean {
  return previous !== undefined && (sample.highEvents > previous.highEvents
    || sample.maxEvents > previous.maxEvents
    || sample.pressureTotalUs - previous.pressureTotalUs > 5_000);
}
export function runtimeNeedsHeadroom(sample: Measurement, previous: Measurement | undefined, grant: number): boolean {
  const pressure = runtimeUnderPressure(sample, previous);
  // Cache may refill after an idle trim. Without pressure, only demand from
  // anonymous/kernel memory should consume another global grant.
  return sample.usageBytes >= grant * 0.8 && (pressure
    || sample.anonBytes + sample.kernelBytes >= grant * 0.8);
}

/** One in-flight transaction. Grow promptly under pressure; return unused
 * headroom slowly, only after the smaller kernel limit is acknowledged. */
export class RuntimeMemoryController {
  #stopped = false;
  #inflight?: Promise<void>;
  #timer?: ReturnType<typeof setInterval>;
  #stopPressureWatch?: () => void;
  #sample?: Measurement;
  #sampleAt = 0;
  #highSamples = 0;
  #lowSamples = 0;
  #reconcile = false;
  #target = 0;
  #waitingSince = 0;
  #lastAttempt = 0;
  #idleSince?: number;
  #idleTarget = 0;
  #wait: RuntimeMemoryStatus["growthWait"] = "none";
  #error: RuntimeMemoryStatus["error"] = null;
  constructor(readonly lease: GuestResourceLease, readonly kernel: RuntimeMemoryKernel,
    readonly ceiling = RUNTIME_MEMORY_POLICY_BYTES,
    readonly containmentFailure: (error: Error) => void = () => {}) {}

  memoryStatus(): Omit<RuntimeMemoryStatus, "appHandle" | "workloadHandle"> {
    const now = performance.now();
    return { sampleAgeMs: this.#sample ? Math.floor(now - this.#sampleAt) : null,
      requestedGrowthBytes: Math.max(0, this.#target - this.lease.memoryBytes), growthWait: this.#wait,
      waitingMs: this.#waitingSince ? Math.floor(now - this.#waitingSince) : 0, error: this.#error };
  }

  async start(): Promise<void> {
    if (await this.kernel.readLimit() !== this.lease.memoryBytes) throw new GuestMemoryContainmentError("Initial Runtime grant was not enforced");
    await this.kernel.writeHigh(Math.floor(this.lease.memoryBytes * 0.9));
    const observe = () => { void this.poll().catch((error) => {
      this.#error = { code: "RUNTIME_OBSERVATION_FAILED", message: String(error).slice(0, 256) };
      if (error instanceof GuestMemoryContainmentError) {
        this.#stopped = true;
        if (this.#timer) clearInterval(this.#timer);
        this.#stopPressureWatch?.();
        this.containmentFailure(error);
      }
    }); };
    this.#timer = setInterval(observe, 250);
    this.#timer.unref();
    try {
      this.#stopPressureWatch = this.kernel.watchPressure?.(() => {
        if (this.#wait === "none" && this.lease.memoryBytes < this.ceiling
          && performance.now() - this.#sampleAt >= 50) observe();
      });
    } catch { /* The periodic observation remains authoritative. */ }
  }

  poll(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#inflight) return this.#inflight;
    const pending = this.#adjust().finally(() => { if (this.#inflight === pending) this.#inflight = undefined; });
    this.#inflight = pending;
    return pending;
  }

  async #adjust(): Promise<void> {
    const used = this.kernel.measure ? undefined : await this.kernel.workingBytes();
    const sample: Measurement = this.kernel.measure ? await this.kernel.measure()
      : { usageBytes: used!, anonBytes: used!, kernelBytes: 0, pressureTotalUs: 0, highEvents: 0, maxEvents: 0 };
    if (this.#stopped) return;
    const underPressure = runtimeUnderPressure(sample, this.#sample);
    const needsGrowth = runtimeNeedsHeadroom(sample, this.#sample, this.lease.memoryBytes);
    this.#sample = sample;
    this.#sampleAt = performance.now();
    const reclaimable = sample.dirtyFileBytes === 0 && sample.writebackFileBytes === 0
      ? sample.inactiveFileBytes ?? 0 : 0;
    // Unused headroom needs no reclaim. Retain the largest safe target seen
    // throughout the idle window; only actual cache eviction is step-bounded.
    let lower = Math.max(RUNTIME_MEMORY_FLOOR_BYTES,
      idleGrant(sample.usageBytes - Math.min(reclaimable, RUNTIME_MEMORY_STEP_BYTES)));
    if (underPressure || lower >= this.lease.memoryBytes || this.#reconcile) {
      this.#idleSince = undefined;
    } else if (this.#idleSince === undefined) {
      this.#idleSince = this.#sampleAt;
      this.#idleTarget = lower;
    } else this.#idleTarget = Math.max(this.#idleTarget, lower);
    this.#highSamples = needsGrowth ? this.#highSamples + 1 : 0;
    if (this.#reconcile) {
      try {
        // The previous transaction retained the larger commitment. Reconcile
        // that same limit before trusting it for any new headroom decision.
        await this.kernel.writeLimit(this.lease.memoryBytes);
        const effective = await this.kernel.readLimit();
        if (effective > this.lease.memoryBytes) throw new GuestMemoryContainmentError("Runtime kernel limit exceeds its commitment");
        if (effective !== this.lease.memoryBytes) throw new Error("Runtime limit could not be confirmed");
        await this.kernel.writeHigh(Math.floor(this.lease.memoryBytes * 0.9));
        this.#reconcile = false;
        this.#target = 0; this.#wait = "none"; this.#waitingSince = 0; this.#error = null;
        this.#highSamples = 0;
      } catch (error) {
        if (error instanceof GuestMemoryContainmentError) throw error;
        this.#wait = "exhausted";
        this.#error = { code: "CAPSULE_RESOURCE_EXHAUSTED", message: String(error).slice(0, 256) };
      }
      return;
    }
    this.#lowSamples = needsGrowth ? 0 : this.#lowSamples + 1;
    if (!needsGrowth) {
      if (this.#lowSamples < 4) return;
      this.#target = 0; this.#wait = "none"; this.#waitingSince = 0; this.#error = null;
      if (this.#idleSince !== undefined && this.#sampleAt - this.#idleSince >= RUNTIME_MEMORY_IDLE_MS) {
        this.#idleSince = undefined;
        lower = Math.max(lower, this.#idleTarget);
        if (sample.usageBytes > lower * 0.8 && reclaimable > 0 && this.kernel.reclaimCache) {
          const fresh = await this.kernel.measure?.();
          if (!fresh || fresh.dirtyFileBytes !== 0 || fresh.writebackFileBytes !== 0 || this.#stopped
            || fresh.usageBytes - (fresh.inactiveFileBytes ?? 0) > lower * 0.8) return;
          const bytes = Math.min(RUNTIME_MEMORY_STEP_BYTES, fresh.inactiveFileBytes ?? 0,
            Math.max(0, Math.ceil(fresh.usageBytes - lower * 0.8)) + 8 * 1024 ** 2);
          try { await this.kernel.reclaimCache(bytes); } catch { /* Partial reclaim is measured below. */ }
          const used = await this.kernel.workingBytes();
          if (this.#stopped || used > fresh.usageBytes) return;
          lower = Math.max(lower, idleGrant(used));
          if (lower >= this.lease.memoryBytes) return;
        }
        await this.#resize(lower);
      }
      return;
    }
    if ((!underPressure && this.#highSamples < 2) || !this.lease.resizeMemory) return;
    const target = Math.min(this.ceiling, this.lease.memoryBytes + RUNTIME_MEMORY_STEP_BYTES);
    if (target === this.lease.memoryBytes) {
      // Pressure at the enforced ceiling does not establish startup failure.
      // Keep the existing startup deadline, cancellation and process-exit paths.
      return;
    }
    if (this.#sampleAt - this.#lastAttempt < (underPressure && this.#wait === "none" ? 50 : 500)) return;
    this.#lastAttempt = this.#sampleAt;
    await this.#resize(target);
  }

  async #resize(target: number): Promise<void> {
    if (!this.lease.resizeMemory) return;
    const shrinking = target < this.lease.memoryBytes;
    this.#target = target;
    try {
      await this.lease.resizeMemory(target, async () => {
        if (shrinking) {
          // An old idle sample cannot authorize reclaim of a new allocation burst.
          if (await this.kernel.workingBytes() > target * 0.8 || this.#stopped) return this.kernel.readLimit();
          await this.kernel.writeHigh(Math.floor(target * 0.9));
        }
        if (this.#stopped) return this.kernel.readLimit();
        // Read back even after write failure. Ambiguous results retain the
        // larger ledger commitment; stop waits for this transaction to settle.
        try { await this.kernel.writeLimit(target); } catch { /* reconcile below */ }
        const effective = await this.kernel.readLimit();
        if (effective === target) await this.kernel.writeHigh(Math.floor(target * 0.9));
        return effective;
      });
      this.#target = 0; this.#wait = "none"; this.#waitingSince = 0; this.#error = null; this.#highSamples = 0;
      // The next poll reads the cgroup anew; no decision reuses the old sample.
    } catch (error) {
      if (error instanceof GuestMemoryContainmentError) throw error;
      this.#reconcile = !(error instanceof GuestResourceAdmissionError);
      if (shrinking) return; // Keep the old commitment; reconcile before another adjustment.
      this.#waitingSince ||= performance.now();
      this.#wait = error instanceof GuestResourceAdmissionError
        ? this.lease.growthWaitReason?.(target) ?? "exhausted" : "exhausted";
      this.#error = { code: "CAPSULE_RESOURCE_EXHAUSTED", message: String(error).slice(0, 256) };
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#stopPressureWatch?.();
    await this.#inflight?.catch(() => {});
  }
}
