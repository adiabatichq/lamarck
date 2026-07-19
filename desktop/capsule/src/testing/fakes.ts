import type {
  CapsuleVmBackend,
  CapsuleVmInstance,
  RuncDriver,
  RuncExecution,
  RuncLaunchRequest,
  WorkloadExit,
} from "../drivers";
import { assertRuncLaunchRequest } from "../drivers";
import type { Clock } from "../protocol/tickets";

export class FakeClock implements Clock {
  constructor(private timestamp = 0) {}

  now(): number {
    return this.timestamp;
  }

  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("FakeClock can only advance by a non-negative integer");
    }
    this.timestamp += milliseconds;
  }
}

export type FakeRuncCall =
  | { type: "start"; containerId: string; request: RuncLaunchRequest }
  | { type: "stop"; containerId: string; graceMs: number }
  | { type: "delete"; containerId: string };

export class FakeRuncDriver implements RuncDriver {
  readonly available = true;
  readonly calls: FakeRuncCall[] = [];
  private exits: WorkloadExit[] = [];
  private startError: Error | undefined;

  enqueueExit(exit: WorkloadExit): void {
    this.exits.push({ ...exit });
  }

  failNextStart(error: Error): void {
    this.startError = error;
  }

  async start(request: RuncLaunchRequest): Promise<RuncExecution> {
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new Error("Fake runc start aborted");
    }
    assertRuncLaunchRequest(request);
    this.calls.push({ type: "start", containerId: request.plan.containerId, request });
    if (this.startError) {
      const error = this.startError;
      this.startError = undefined;
      throw error;
    }
    const exit = this.exits.shift() ?? { exitCode: 0, signal: null };
    return {
      containerId: request.plan.containerId,
      wait: async () => ({ ...exit }),
    };
  }

  async stop(containerId: string, graceMs: number): Promise<void> {
    this.calls.push({ type: "stop", containerId, graceMs });
  }

  async delete(containerId: string): Promise<void> {
    this.calls.push({ type: "delete", containerId });
  }
}

export type FakeVmCall = { type: "boot" } | { type: "stop"; instanceId: string };

export class FakeVmBackend implements CapsuleVmBackend {
  readonly available = true;
  readonly calls: FakeVmCall[] = [];
  private sequence = 0;
  private bootError: Error | undefined;

  failNextBoot(error: Error): void {
    this.bootError = error;
  }

  async boot(): Promise<CapsuleVmInstance> {
    this.calls.push({ type: "boot" });
    if (this.bootError) {
      const error = this.bootError;
      this.bootError = undefined;
      throw error;
    }
    const instanceId = `fake-vm-${++this.sequence}`;
    return {
      instanceId,
      stop: async () => {
        this.calls.push({ type: "stop", instanceId });
      },
    };
  }
}
