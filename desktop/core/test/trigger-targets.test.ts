import { expect, test, vi } from 'vitest';
import { HostTriggerTargets } from '../src/triggers/targets';
import { AppJobDispatch } from '../src/triggers/app-jobs';
import type { AppLifecycleService } from '../src/apps/lifecycle';
import type { ConnectorSupervisor } from '../src/connectors/supervisor';
import type { TriggerRun } from '../src/triggers/store';
function fixture() {
  const source = { id: 'source-a', connectorId: 'poller', displayName: 'Inbox', supported: true, ownership: 'here', packageTrust: 'custom', setupStatus: 'ready', running: false, pausedAt: undefined, resumeAt: undefined };
  const sources = { listAdmitted: vi.fn(async () => [source, { ...source, id: 'watch-a', connectorId: 'watcher' }]), listInstalledConnectors: () => [{ connectorId: 'poller', mode: 'poll' }, { connectorId: 'watcher', mode: 'watch' }], getSource: () => source, start: vi.fn(), sourceRun: vi.fn(() => ({ status: 'success' })) };
  const apps = { inventory: async () => [{ id: 'notes', name: 'Notes', manifestHealth: { status: 'valid' }, versionHealth: { status: 'healthy' }, runtime: { jobs: { inbox: { command: ['node', 'job.js'] } } } }] };
  const jobs = new AppJobDispatch(); jobs.heartbeat(true, []);
  return { source, sources, targets: new HostTriggerTargets(apps as unknown as AppLifecycleService, sources as unknown as ConnectorSupervisor, jobs) };
}
test('only concrete poll Sources and declared App jobs are catalog targets', async () => {
  const { targets } = fixture(); expect(await targets.list()).toMatchObject([{ id: 'app:notes:job:inbox', inputs: ['event', 'schedule'], available: true }, { id: 'source:source-a:run', inputs: ['schedule'], available: true }]);
});
test.each([['supported', false], ['ownership', 'other-device'], ['packageTrust', 'modified'], ['setupStatus', 'setup'], ['pausedAt', 1], ['running', true]])('catalog honors the Source %s gate', async (key, value) => {
  const { source, targets } = fixture(); Object.assign(source, { [key]: value }); expect((await targets.list())[1]).toMatchObject({ available: false, reason: expect.any(String) });
});
test('Source schedule invokes its existing execution authority and cancellation targets only that handle', async () => {
  const { sources, targets } = fixture(); const gate = Promise.withResolvers<void>(); const abort = vi.fn(() => gate.resolve()); sources.start.mockReturnValue({ runId: 'source-run', promise: gate.promise, abort });
  const target = (await targets.list())[1]; const run = { input: { kind: 'schedule', scheduledAt: 1 } } as TriggerRun; const controller = new AbortController();
  const done = targets.invoke(target, run, controller.signal); const rejection = expect(done).rejects.toThrow('canceled'); expect(sources.start).toHaveBeenCalledWith('source-a', { trigger: 'schedule' }); controller.abort(new Error('canceled')); await rejection; expect(abort).toHaveBeenCalledOnce();
  await expect(targets.invoke(target, { input: { kind: 'event' } } as TriggerRun, new AbortController().signal)).rejects.toThrow('support'); expect(sources.start).toHaveBeenCalledOnce();
});
