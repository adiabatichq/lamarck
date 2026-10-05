import type { AppLifecycleService } from '../apps/lifecycle';
import type { ConnectorSupervisor } from '../connectors/supervisor';
import { isSourcePaused } from '../connectors/state';
import type { TriggerTargets, TriggerTarget } from './coordinator';
import { AppJobDispatch } from './app-jobs';
import type { TriggerRun } from './store';

export class HostTriggerTargets implements TriggerTargets {
  constructor(private apps: AppLifecycleService, private sources: ConnectorSupervisor, private jobs: AppJobDispatch) {}
  async list(): Promise<TriggerTarget[]> {
    const [apps, sources] = await Promise.all([this.apps.inventory(), this.sources.listAdmitted()]);
    const targets: TriggerTarget[] = [];
    for (const app of apps) for (const jobId of Object.keys(app.runtime?.jobs ?? {})) {
      const reason = app.manifestHealth.status !== 'valid' ? 'App manifest is invalid' : app.versionHealth.status === 'unavailable' ? 'App version authority is unavailable' : this.jobs.availability();
      targets.push({ id: `app:${app.id}:job:${jobId}`, appId: app.id, name: `${app.name} / ${jobId}`, kind: 'app-job', inputs: ['event', 'schedule'], available: !reason, reason });
    }
    const packages = this.sources.listInstalledConnectors();
    for (const source of sources) {
      if (packages.find(p => p.connectorId === source.connectorId)?.mode !== 'poll') continue;
      const reason = !source.supported ? 'Source is unsupported on this device' : source.ownership !== 'here' ? 'Source belongs to another device' : !['official', 'custom'].includes(source.packageTrust) ? 'Connector package is not trusted' : source.setupStatus !== 'ready' ? 'Source needs setup' : isSourcePaused(source) ? 'Source is paused' : source.running ? 'Source is already running' : null;
      targets.push({ id: `source:${source.id}:run`, sourceId: source.id, name: source.displayName ?? source.id, kind: 'source-run', inputs: ['schedule'], available: !reason, reason });
    }
    return targets;
  }
  async invoke(target: TriggerTarget, run: TriggerRun, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!target.inputs.includes(run.input.kind)) throw new Error('Target does not support this input');
    if (target.kind === 'app-job') return this.jobs.invoke(run, signal);
    const sourceId = target.sourceId!;
    const source = this.sources.getSource(sourceId);
    if (!source || isSourcePaused(source)) throw new Error('Source is unavailable or paused');
    const handle = this.sources.start(sourceId, { trigger: 'schedule' });
    const abort = () => handle.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      await handle.promise; signal.throwIfAborted();
      const result = this.sources.sourceRun(sourceId, handle.runId);
      if (result?.status !== 'success') throw new Error(result?.error ?? 'Source run interrupted');
    } finally { signal.removeEventListener('abort', abort); }
  }
}
