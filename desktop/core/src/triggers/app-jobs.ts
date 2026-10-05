import type { JobInvocation } from '@lamarck/system/protocol';
import type { TriggerRun } from './store';

export interface JobDispatch { runId: string; appId: string; jobId: string; triggerId: string; }
interface WaitingJob { dispatch: JobDispatch; run: TriggerRun; claimedAt: number | null; signal: AbortSignal; resolve(): void; reject(error: Error): void; }
/** Private Core/Host rendezvous. Run IDs are Host-issued; App channels can read
 * only their bound immutable input, and cannot claim or complete executions. */
export class AppJobDispatch {
  private jobs = new Map<string, WaitingJob>();
  private channels = new Map<string, string>();
  private lastHeartbeat = 0;
  private capable = false;
  private unknownActive = false;
  constructor(private now = Date.now, private releaseChannel: (id: string) => void = () => {}) {}
  availability(): string | null {
    if (this.now() - this.lastHeartbeat > 15_000) for (const entry of this.jobs.values()) if (entry.claimedAt !== null) entry.reject(new Error('App job Host heartbeat lost; external effects may have occurred'));
    if (!this.capable || this.now() - this.lastHeartbeat >= 5000) return 'App job Capsule Host is unavailable';
    return this.unknownActive ? 'App job Host is cleaning interrupted work' : null;
  }
  heartbeat(available: boolean, active: string[]): string[] {
    this.capable = available; this.lastHeartbeat = this.now();
    for (const entry of this.jobs.values()) {
      if (entry.claimedAt !== null && this.now() - entry.claimedAt > 30_000 && !active.includes(entry.run.id)) entry.reject(new Error('Job start response lost or Host job disappeared; external effects may have occurred'));
    }
    // A reconnecting Host may still own work whose completion became uncertain.
    // Cancel those exact runs and wait for their cleanup before new admission.
    this.unknownActive = active.some(id => !this.jobs.has(id));
    return active.filter(id => !this.jobs.has(id) || this.jobs.get(id)!.signal.aborted);
  }
  invoke(run: TriggerRun, signal: AbortSignal): Promise<void> {
    const match = /^app:([^:]+):job:([^:]+)$/.exec(run.settings.target);
    if (!match) return Promise.reject(new Error('Invalid App job target'));
    return new Promise((resolve, reject) => {
      const revokeChannels = () => {
        for (const [channel, id] of this.channels) if (id === run.id) { this.channels.delete(channel); this.releaseChannel(channel); }
      };
      const cleanup = () => { this.jobs.delete(run.id); signal.removeEventListener('abort', abort); revokeChannels(); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const abort = () => {
        revokeChannels();
        // A claimed job holds its target lane until the Host confirms cleanup.
        // The heartbeat asks that exact Host run to stop. Unclaimed work has
        // no Guest resources and can release admission immediately.
        if (this.jobs.get(run.id)?.claimedAt == null) fail(signal.reason instanceof Error ? signal.reason : new Error('Job canceled'));
      };
      const entry: WaitingJob = { run, signal, claimedAt: null, dispatch: { runId: run.id, appId: match[1], jobId: match[2], triggerId: run.triggerId }, resolve: () => { cleanup(); resolve(); }, reject: fail };
      if (signal.aborted) { abort(); return; }
      this.jobs.set(run.id, entry); signal.addEventListener('abort', abort, { once: true });
    });
  }
  claim(): JobDispatch | null {
    if (this.availability()) return null;
    const job = [...this.jobs.values()].find(entry => entry.claimedAt === null);
    if (!job) return null;
    job.claimedAt = this.now(); return job.dispatch;
  }
  complete(runId: string, error: string | null): void {
    const job = this.jobs.get(runId);
    if (!job || job.claimedAt === null) return;
    if (job.signal.aborted) job.reject(job.signal.reason instanceof Error ? job.signal.reason : new Error('Job canceled'));
    else if (error) job.reject(new Error(error)); else job.resolve();
  }
  bind(channelId: string, runId: string, appId: string, workload: string): void {
    const job = this.jobs.get(runId);
    if (!job || job.claimedAt === null || job.signal.aborted || job.dispatch.appId !== appId || `job:${job.dispatch.jobId}` !== workload) throw new Error('Job invocation is unavailable for this workload');
    this.channels.set(channelId, runId);
  }
  input(channelId: string): JobInvocation {
    const id = this.channels.get(channelId); const job = id ? this.jobs.get(id) : undefined;
    if (!job || job.signal.aborted) throw new Error('Job invocation is unavailable for this workload');
    return { version: 1, triggerId: job.run.triggerId, runId: job.run.id, revision: job.run.revision, input: job.run.input };
  }
  close() { for (const job of this.jobs.values()) job.reject(new Error('Host stopped during execution; external effects may have occurred')); }
  unbind(channelId: string) { this.channels.delete(channelId); }
}
