import { setTimeout as delay } from "node:timers/promises";

interface Job { runId: string; appId: string; jobId: string; triggerId?: string }
interface JobHost {
  jobAvailability(): Promise<boolean>;
  runJob(runId: string, appId: string, jobId: string, signal: AbortSignal, triggerId?: string): Promise<void>;
}

/** Private Host dispatch. A claim is never retried as execution: losing its
 * reply leaves Core's lease to report uncertainty, without duplicate effects. */
export class CapsuleJobWorker {
  private loop: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  constructor(private host: JobHost, private token: string, private fetch = globalThis.fetch) {}

  start(origin: string): void {
    if (this.loop) throw new Error("Job Host already running");
    const controller = this.controller = new AbortController();
    this.loop = (async () => {
      while (!controller.signal.aborted) {
        try {
          const available = await this.host.jobAvailability();
          const heartbeat = await this.request(origin, "heartbeat", { available, active: [...this.active.keys()] }, controller.signal);
          if (!Array.isArray(heartbeat.cancel) || heartbeat.cancel.some(id => typeof id !== "string")) throw new Error("Invalid job heartbeat response");
          for (const id of heartbeat.cancel as string[]) this.active.get(id)?.controller.abort(new Error("Job canceled by Core"));
          if (available && this.active.size < 4) {
            const { job } = await this.request(origin, "claim", {}, controller.signal);
            if (job !== null) {
              if (!isJob(job)) throw new Error("Invalid job claim");
              controller.signal.throwIfAborted();
              this.launch(origin, job, controller.signal);
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) console.warn("[triggers] job dispatch:", error instanceof Error ? error.message : error);
        }
        try { await delay(500, undefined, { signal: controller.signal }); } catch { break; }
      }
    })();
  }
  private launch(origin: string, job: Job, lifetime: AbortSignal) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime]);
    const task = Promise.resolve().then(async () => {
      let error: string | null = null;
      try { await this.host.runJob(job.runId, job.appId, job.jobId, signal, job.triggerId); }
      catch (cause) { error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 2000); }
      // Retain finished jobs in the heartbeat until completion is confirmed.
      // Lost completion replies may be retried; starting the job may not.
      while (!lifetime.aborted) {
        try { await this.request(origin, "complete", { runId: job.runId, error }, lifetime); break; }
        catch { try { await delay(500, undefined, { signal: lifetime }); } catch { break; } }
      }
    }).finally(() => this.active.delete(job.runId));
    this.active.set(job.runId, { controller, task });
  }
  async stop(): Promise<void> {
    this.controller?.abort(new Error("Host stopped"));
    for (const entry of this.active.values()) entry.controller.abort(new Error("Host stopped"));
    await Promise.allSettled([this.loop, ...[...this.active.values()].map(entry => entry.task)]);
    this.loop = null; this.controller = null;
  }
  private async request(origin: string, operation: string, body: unknown, lifetime: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetch(`${origin}/api/triggers/jobs/${operation}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.any([lifetime, AbortSignal.timeout(2000)]),
    });
    if (!response.ok) throw new Error(`Job control plane returned ${response.status}`);
    return await response.json() as Record<string, unknown>;
  }
}
function isJob(value: unknown): value is Job {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.runId === "string" && raw.runId.length <= 64 && typeof raw.appId === "string" && typeof raw.jobId === "string"
    && (raw.triggerId === undefined || typeof raw.triggerId === "string" && raw.triggerId.length <= 64);
}
