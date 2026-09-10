import { readFile, statfs } from "node:fs/promises";
import type { HostRequest, JsonValue } from "@lamarck/capsule";
import { GuestResourceAdmission, GUEST_MANAGEMENT_MEMORY_BYTES, parseGuestMemory, usableGuestMemory } from "./resource-admission";
import { runFixedCommand } from "./fixed-command";

export class GuestCapacityController {
  #diskTail: Promise<unknown> = Promise.resolve();
  constructor(readonly admission: GuestResourceAdmission, readonly stateRoot: string) {}

  async status() {
    const memory = parseGuestMemory(await readFile("/proc/meminfo", "utf8"));
    const fs = await statfs(this.stateRoot, { bigint: true });
    const pressure = async (resource: string) => {
      try {
        const text = await readFile(`/proc/pressure/${resource}`, "utf8");
        return Number(/^some avg10=([0-9.]+)/m.exec(text)?.[1] ?? 0);
      } catch { return null; }
    };
    return { ...this.admission.snapshot(), ...memory,
      usableMemoryBytes: usableGuestMemory(memory, this.admission.snapshot().memoryCeilingBytes + GUEST_MANAGEMENT_MEMORY_BYTES),
      cpuPressureAvg10: await pressure("cpu"), ioPressureAvg10: await pressure("io"), memoryPressureAvg10: await pressure("memory"),
      filesystemBytes: Number(fs.blocks * fs.bsize), freeDiskBytes: Number(fs.bavail * fs.bsize) };
  }

  async handle(request: HostRequest): Promise<JsonValue> {
    switch (request.op) {
      case "resources.status": return this.status();
      case "resources.memory.prepare":
        this.admission.prepareMemoryCapacity(request.body.memoryBytes);
        return this.status();
      case "resources.memory.commit": {
        const memory = parseGuestMemory(await readFile("/proc/meminfo", "utf8"));
        const usable = usableGuestMemory(memory, this.admission.snapshot().memoryCeilingBytes + GUEST_MANAGEMENT_MEMORY_BYTES);
        this.admission.acknowledgeMemoryCapacity(Math.min(request.body.memoryBytes, usable - GUEST_MANAGEMENT_MEMORY_BYTES));
        return this.status();
      }
      case "resources.launch.reserve":
        this.admission.reserveLaunch(request.body.launchKey, request.body.runtimeMemoryBytes, request.body.buildMemoryBytes);
        return this.status();
      case "resources.launch.release":
        this.admission.releaseLaunch(request.body.launchKey);
        return this.status();
      case "resources.disk.grow": {
        const operation = this.#diskTail.catch(() => {}).then(async () => {
          const before = await statfs(this.stateRoot, { bigint: true });
          // This private authenticated command is issued only after Host backing
          // is durable. The helper accepts no path or filesystem chosen by Apps.
          try {
            await runFixedCommand("/usr/libexec/lamarck-grow-state", [String(request.body.bytes)]);
          } finally {
            // The ioctl can partially succeed or its acknowledgement can be
            // lost. Reconcile real capacity once; never restore an old budget.
            const after = await statfs(this.stateRoot, { bigint: true });
            const delta = Number(after.blocks * after.bsize - before.blocks * before.bsize);
            if (delta < 0) throw new Error("Guest state filesystem unexpectedly shrank");
            this.admission.acknowledgeDiskGrowth(delta);
          }
          return { ...await this.status(), stateCapacityBytes: request.body.bytes };
        });
        this.#diskTail = operation;
        return operation;
      }
      default: throw new Error("Not a capacity operation");
    }
  }
}
