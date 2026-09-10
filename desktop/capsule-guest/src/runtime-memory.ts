import { readFile, writeFile } from "node:fs/promises";
import type { GuestResourceLease } from "./resource-admission";
import { GuestMemoryContainmentError } from "./resource-admission";

export const RUNTIME_MEMORY_STEP_BYTES = 64 * 1024 * 1024;
export const RUNTIME_MEMORY_POLICY_BYTES = 512 * 1024 * 1024;

export interface RuntimeMemoryKernel {
  workingBytes(): Promise<number>;
  readLimit(): Promise<number>;
  writeLimit(bytes: number): Promise<void>;
  writeHigh(bytes: number): Promise<void>;
}

export function linuxRuntimeMemoryKernel(path: string): RuntimeMemoryKernel {
  return {
    async workingBytes() {
      const values = Object.fromEntries((await readFile(`${path}/memory.stat`, "utf8")).trim().split("\n")
        .map((line) => line.split(/\s+/)));
      // Clean file cache is reclaimable, not a reason to permanently grow G.
      return Number(values.anon ?? 0) + Number(values.kernel ?? 0) + Number(values.shmem ?? 0);
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

/** This controller improves headroom; memory.max contains even instantaneous
 * allocations when the controller is delayed, stopped, or out of capacity. */
export class RuntimeMemoryController {
  #stopped = false;
  #inflight?: Promise<void>;
  #timer?: ReturnType<typeof setInterval>;
  constructor(readonly lease: GuestResourceLease, readonly kernel: RuntimeMemoryKernel,
    readonly ceiling = RUNTIME_MEMORY_POLICY_BYTES,
    readonly containmentFailure: (error: Error) => void = () => {}) {}

  async start(): Promise<void> {
    if (await this.kernel.readLimit() !== this.lease.memoryBytes) throw new GuestMemoryContainmentError("Initial Runtime grant was not enforced");
    await this.kernel.writeHigh(Math.floor(this.lease.memoryBytes * 0.9));
    this.#timer = setInterval(() => { void this.poll().catch((error) => {
      if (error instanceof GuestMemoryContainmentError) {
        this.#stopped = true;
        if (this.#timer) clearInterval(this.#timer);
        this.containmentFailure(error);
      }
    }); }, 100);
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
    if (!this.lease.growMemory || this.lease.memoryBytes >= this.ceiling) return;
    const used = await this.kernel.workingBytes();
    if (this.#stopped || used < this.lease.memoryBytes * 0.8) return;
    const target = Math.min(this.ceiling, this.lease.memoryBytes + RUNTIME_MEMORY_STEP_BYTES);
    await this.lease.growMemory(target, async () => {
      if (this.#stopped) return this.kernel.readLimit();
      // Failed writes can still have taken effect. Read back even on failure;
      // an unreadable limit retains the larger ledger commitment until teardown.
      try { await this.kernel.writeLimit(target); } catch { /* reconcile below */ }
      const effective = await this.kernel.readLimit();
      if (effective === target) await this.kernel.writeHigh(Math.floor(target * 0.9));
      return effective;
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#inflight?.catch(() => {});
  }
}
