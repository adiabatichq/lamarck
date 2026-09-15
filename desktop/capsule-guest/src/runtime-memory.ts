import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { RuntimeMemoryStatus } from "@lamarck/capsule";
import type { GuestResourceLease } from "./resource-admission";
import { GuestMemoryContainmentError, GuestResourceAdmissionError } from "./resource-admission";

export const RUNTIME_MEMORY_STEP_BYTES = 64 * 1024 * 1024;
// Initial grants stay 256/512 MiB. This ceiling matches the 2 GiB App parent;
// every increase must also fit the authoritative global ledger.
export const RUNTIME_MEMORY_POLICY_BYTES = 2 * 1024 * 1024 * 1024;
interface Measurement {
  usageBytes: number; anonBytes: number; kernelBytes: number;
  pressureTotalUs: number; highEvents: number; maxEvents: number;
}

export interface RuntimeMemoryKernel {
  workingBytes(): Promise<number>;
  measure?(): Promise<Measurement>;
  readLimit(): Promise<number>;
  writeLimit(bytes: number): Promise<void>;
  writeHigh(bytes: number): Promise<void>;
}

const counters = (text: string) => Object.fromEntries(text.trim().split("\n").map(line => line.split(/\s+/)));
const count = (value: string | undefined): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid cgroup observation");
  return result;
};
export function linuxRuntimeMemoryKernel(path: string): RuntimeMemoryKernel {
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
        pressureTotalUs: count(some[2]), highEvents: count(event.high), maxEvents: count(event.max) };
    },
    async readLimit() {
      const limit = Number((await readFile(`${path}/memory.max`, "utf8")).trim());
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid kernel memory.max acknowledgement");
      return limit;
    },
    async writeLimit(bytes) { await writeFile(`${path}/memory.max`, String(bytes)); },
    async writeHigh(bytes) { await writeFile(`${path}/memory.high`, String(bytes)); },
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
  return sample.usageBytes >= grant * 0.8 && (pressure
    || sample.anonBytes + sample.kernelBytes >= grant * 0.7);
}

/** One in-flight transaction, bounded observations, and grow-only grants. Peak
 * commitments remain held until verified workload teardown, even after GC. */
export class RuntimeMemoryController {
  #stopped = false;
  #inflight?: Promise<void>;
  #timer?: ReturnType<typeof setInterval>;
  #sample?: Measurement;
  #sampleAt = 0;
  #highSamples = 0;
  #lowSamples = 0;
  #reconcile = false;
  #target = 0;
  #waitingSince = 0;
  #lastAttempt = 0;
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
    this.#timer = setInterval(() => { void this.poll().catch((error) => {
      this.#error = { code: "RUNTIME_OBSERVATION_FAILED", message: String(error).slice(0, 256) };
      if (error instanceof GuestMemoryContainmentError) {
        this.#stopped = true;
        if (this.#timer) clearInterval(this.#timer);
        this.containmentFailure(error);
      }
    }); }, 250);
    this.#timer.unref();
  }

  poll(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#inflight) return this.#inflight;
    const pending = this.#grow().finally(() => { if (this.#inflight === pending) this.#inflight = undefined; });
    this.#inflight = pending;
    return pending;
  }

  async #grow(): Promise<void> {
    const used = this.kernel.measure ? undefined : await this.kernel.workingBytes();
    const sample: Measurement = this.kernel.measure ? await this.kernel.measure()
      : { usageBytes: used!, anonBytes: used!, kernelBytes: 0, pressureTotalUs: 0, highEvents: 0, maxEvents: 0 };
    if (this.#stopped) return;
    const needsGrowth = runtimeNeedsHeadroom(sample, this.#sample, this.lease.memoryBytes);
    this.#sample = sample;
    this.#sampleAt = performance.now();
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
      return;
    }
    if (this.#highSamples < 2 || !this.lease.growMemory) return;
    const target = Math.min(this.ceiling, this.lease.memoryBytes + RUNTIME_MEMORY_STEP_BYTES);
    if (target === this.lease.memoryBytes) {
      // Pressure at the enforced ceiling does not establish startup failure.
      // Keep the existing startup deadline, cancellation and process-exit paths.
      return;
    }
    if (this.#sampleAt - this.#lastAttempt < 500) return;
    this.#lastAttempt = this.#sampleAt;
    this.#target = target;
    try {
      await this.lease.growMemory(target, async () => {
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
      this.#waitingSince ||= performance.now();
      this.#wait = error instanceof GuestResourceAdmissionError
        ? this.lease.growthWaitReason?.(target) ?? "exhausted" : "exhausted";
      this.#error = { code: "CAPSULE_RESOURCE_EXHAUSTED", message: String(error).slice(0, 256) };
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#inflight?.catch(() => {});
  }
}
