import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSystemDatabase } from '../src/db';
import { GuardEngine } from '../src/guard-service/engine';
import type { GuardPrincipal } from '../src/guard-service/protocol';
import { TriggerStore, type TriggerSettings, type TriggerRun } from '../src/triggers/store';
import { TriggerCoordinator, type TriggerTarget, type TriggerTargets } from '../src/triggers/coordinator';
import { manageTriggers } from '../src/triggers/management';
import type { EventMatcher } from '../src/triggers/listeners';
import { ConnectorSupervisor } from '../src/connectors/supervisor';
import { HostTriggerTargets } from '../src/triggers/targets';
import { AppJobDispatch } from '../src/triggers/app-jobs';
import type { AppLifecycleService } from '../src/apps/lifecycle';
import { DatabaseSync } from 'node:sqlite';
import { TestGuard, TEST_PRODUCER_REF } from './support/test-guard';

const principal: GuardPrincipal = { source: 'system:test', producerRef: TEST_PRODUCER_REF, tableGrants: '*', schemaGrant: true };
const config: TriggerSettings = { name: 'Inbox', enabled: true, target: 'app:notes:job:inbox', condition: { kind: 'event', sql: "SELECT e.id, 99 AS payload FROM events e JOIN json_each('[1,2]') j WHERE e.type = ?", params: ['test.event'] } };
const target: TriggerTarget = { id: config.target, kind: 'app-job', name: 'Notes / inbox', inputs: ['event', 'schedule'], available: true, reason: null };
let root: string, engine: GuardEngine, db: ReturnType<typeof openSystemDatabase>, store: TriggerStore, coordinator: TriggerCoordinator;
let now: number, catalog: TriggerTarget[], delivered: TriggerRun[];
let matcher: EventMatcher, targets: TriggerTargets;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trigger-coordinator-')); engine = new GuardEngine({ workspacePath: root }); db = openSystemDatabase(root); store = new TriggerStore(db);
  now = Date.parse('2026-10-02T00:00:00Z'); catalog = [{ ...target }]; delivered = [];
  matcher = { eventBoundary: async () => engine.eventBoundary(principal), matchEvents: async input => engine.matchEvents(principal, input) };
  targets = { list: async () => catalog, invoke: vi.fn(async (_, run) => { delivered.push(run); }) };
  coordinator = new TriggerCoordinator(store, matcher, targets, () => now);
});
afterEach(async () => { await coordinator.close(); engine.close(); if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
const append = (value = 42, type = 'test.event') => engine.writeEvent(principal, { type, startedAt: 1, payload: { value } });
const drain = async (count: number) => { for (let i = 0; i < count; i++) { await coordinator.tick(); await new Promise(resolve => setImmediate(resolve)); } };

test('durably admits original D0 envelopes, logically deduplicates SQL joins and resumes consumption after reopen', async () => {
  append(0); const record = await coordinator.create(config); const eventId = append(7); append(8, 'other.event');
  await drain(2);
  expect(delivered).toHaveLength(1); expect(delivered[0].input).toEqual({ kind: 'event', event: engine.matchEvents(principal, { sql: 'SELECT id FROM events WHERE id=?', params: [eventId], after: 0 }).events[0] });
  expect(store.runs(record.id)[0].status).toBe('success'); expect(store.get(record.id).cursor).toBe(engine.eventBoundary(principal));
  await coordinator.close(); db.close(); db = openSystemDatabase(root); store = new TriggerStore(db); coordinator = new TriggerCoordinator(store, matcher, targets, () => now);
  const freshId = append(9); await drain(2);
  expect(delivered).toHaveLength(2); expect(delivered[1].input).toMatchObject({ event: { id: freshId, payload: { value: 9 } } });
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
});
test('failed invocation is explicit and never retried automatically', async () => {
  targets.invoke = vi.fn(async () => { throw new Error('Target refused'); }); const record = await coordinator.create(config); append(); await drain(4);
  expect(store.runs(record.id)).toHaveLength(1); expect(store.runs(record.id)[0]).toMatchObject({ status: 'error', error: 'Target refused' }); expect(targets.invoke).toHaveBeenCalledOnce();
});
test('restart marks running effects interrupted and preserves pending snapshots for dispatch', async () => {
  const record = await coordinator.create(config); const a = store.insertRun(record, { kind: 'schedule', scheduledAt: now }, 'automatic', null, 'a', now);
  store.transition(a.id, 'pending', 'running'); store.insertRun(record, { kind: 'schedule', scheduledAt: now + 1 }, 'automatic', null, 'b', now + 1);
  await coordinator.close(); coordinator = new TriggerCoordinator(store, matcher, targets, () => now);
  expect(store.run(a.id)).toMatchObject({ status: 'interrupted', error: expect.stringContaining('external effects') }); await drain(2);
  expect(delivered).toHaveLength(1); expect(store.runs(record.id).map(r => r.status)).toEqual(['success', 'interrupted']);
});
test('stale asynchronous evaluation cannot admit or advance newer settings', async () => {
  const record = await coordinator.create(config); append();
  const gate = Promise.withResolvers<Awaited<ReturnType<EventMatcher['matchEvents']>>>();
  const match = matcher.matchEvents; let evaluated = false;
  matcher.matchEvents = async input => { const result = await match(input); if (!evaluated) { evaluated = true; return gate.promise.then(() => result); } return result; };
  const ticking = coordinator.tick(); await vi.waitFor(() => expect(evaluated).toBe(true));
  const updated = await coordinator.update(record.id, record.revision, { condition: { kind: 'event', sql: 'SELECT id FROM events WHERE type=?', params: ['other.event'] } });
  gate.resolve({ events: [], cursor: 0 }); await ticking;
  expect(store.get(record.id)).toMatchObject({ revision: updated.revision, cursor: updated.cursor }); expect(store.runs(record.id)).toEqual([]);
  await expect(coordinator.update(record.id, 1, { name: 'Stale edit' })).rejects.toThrow('reload');
});
test.each(['event', 'schedule'] as const)('a name edit preserves %s progress committed during asynchronous validation', async kind => {
  const settings = kind === 'event' ? config : { ...config, condition: { kind: 'schedule' as const, cron: '*/5 * * * *', timezone: 'UTC' } };
  const record = await coordinator.create(settings);
  if (kind === 'event') append(); else now += 5 * 60_000;
  const gate = Promise.withResolvers<void>(); let entered = false, first = true;
  targets.list = async () => { if (first) { first = false; entered = true; await gate.promise; } return catalog; };
  const editing = coordinator.update(record.id, record.revision, { name: 'Renamed' });
  await vi.waitFor(() => expect(entered).toBe(true)); await drain(2);
  const checkpoint = store.get(record.id); expect(delivered).toHaveLength(1);
  gate.resolve(); const edited = await editing;
  expect(edited.cursor).toBe(checkpoint.cursor); expect(edited.nextRunAt).toBe(checkpoint.nextRunAt);
  if (kind === 'event') append(); else now += 5 * 60_000;
  await drain(2); expect(delivered).toHaveLength(2); expect(delivered[1].settings.name).toBe('Renamed'); expect(store.get(record.id).error).toBeNull();
});
test('create, enable, condition edits and previews never replay prior events or consume a preview', async () => {
  append(0); const record = await coordinator.create({ ...config, enabled: false }); append(1);
  const before = store.get(record.id); const sample = await coordinator.preview(config);
  expect(sample).toMatchObject({ kind: 'event', events: expect.arrayContaining([expect.objectContaining({ type: 'test.event' })]) }); expect(store.get(record.id)).toEqual(before); expect(delivered).toEqual([]);
  await coordinator.enable(record.id, true); await drain(2); expect(delivered).toEqual([]);
  append(2); await coordinator.update(record.id, store.get(record.id).revision, { target: config.target, condition: { kind: 'event', sql: 'SELECT id FROM events' } });
  await drain(2); expect(delivered).toEqual([]); append(3); await drain(2); expect(delivered).toHaveLength(1);
});
test('saved native SQL LIMIT remains relational over the full dataset', async () => {
  append(); const record = await coordinator.create({ ...config, condition: { kind: 'event', sql: 'SELECT id FROM events ORDER BY rowid LIMIT 1' } }); append(); await drain(2);
  expect(delivered).toEqual([]); expect(store.get(record.id).cursor).toBe(engine.eventBoundary(principal));
});
test('unavailable target pauses progress and appears in management; recovery dispatches the saved backlog', async () => {
  const record = await coordinator.create(config); const before = record.cursor; append(); catalog[0].available = false; catalog[0].reason = 'Source paused'; await drain(2);
  expect(store.get(record.id)).toMatchObject({ cursor: before, error: 'Source paused' }); expect(await coordinator.list()).toMatchObject([{ available: false, unavailableReason: 'Source paused' }]);
  catalog[0].available = true; catalog[0].reason = null; await drain(2); expect(delivered).toHaveLength(1);
});
test('one lane per target and four total; immutable pending settings survive edits, disable and deletion', async () => {
  const gate = Promise.withResolvers<void>(); targets.invoke = vi.fn(async (_, run) => { delivered.push(run); await gate.promise; });
  const a = await coordinator.create(config); append(1); append(2); await coordinator.tick(); await vi.waitFor(() => expect(delivered).toHaveLength(1));
  const updated = await coordinator.update(a.id, 1, { name: 'New name' });
  await coordinator.enable(a.id, false, updated.revision); gate.resolve(); await drain(2); expect(delivered).toHaveLength(1);
  await coordinator.enable(a.id, true); await drain(2); expect(delivered).toHaveLength(2); expect(delivered[1].settings.name).toBe('Inbox');
  const queued = store.insertRun(store.get(a.id), { kind: 'schedule', scheduledAt: now }, 'automatic', null, 'queued', now);
  coordinator.remove(a.id, store.get(a.id).revision); expect(store.run(queued.id).status).toBe('canceled'); expect(coordinator.history(a.id)).toHaveLength(3);
});
test('blocked queues do not starve available target lanes', async () => {
  const blocked = await coordinator.create({ ...config, enabled: false });
  for (let i = 0; i < 500; i++) store.insertRun(blocked, { kind: 'schedule', scheduledAt: now }, 'automatic', null, `blocked:${i}`, now);
  catalog.push({ ...target, id: 'app:notes:job:other' }); const other = await coordinator.create({ ...config, target: catalog[1].id }); append(); await drain(2);
  expect(store.runs(other.id)[0].status).toBe('success'); expect(delivered).toHaveLength(1);
});
test('running cancellation aborts only its invocation, and shutdown records interrupted effects', async () => {
  targets.invoke = vi.fn(async (_, __, signal) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const record = await coordinator.create(config); append(); await coordinator.tick(); await new Promise(resolve => setImmediate(resolve));
  const run = store.runs(record.id)[0]; coordinator.cancelRun(run.id); await new Promise(resolve => setImmediate(resolve)); expect(store.run(run.id).status).toBe('canceled');
  append(); await coordinator.tick(); await new Promise(resolve => setImmediate(resolve)); const running = store.runs(record.id).find(r => r.status === 'running')!;
  await coordinator.close(); expect(store.run(running.id).status).toBe('interrupted');
});
test('a multi-day invocation remains running until its target completes', async () => {
  const completion = Promise.withResolvers<void>();
  let invocationSignal: AbortSignal;
  // Native AbortSignal.timeout uses an internal clock outside fake timers.
  // Drive that clock too so this covers elapsed time without waiting two days.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
  targets.invoke = vi.fn(async (_, run, signal) => {
    delivered.push(run); invocationSignal = signal;
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      completion.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
    });
  });
  try {
    const record = await coordinator.create(config); append(); await drain(1);
    const run = store.runs(record.id)[0]; expect(run.status).toBe('running');
    now += 2 * 24 * 60 * 60_000;
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000);
    expect(invocationSignal!.aborted).toBe(false);
    expect(store.run(run.id).status).toBe('running');
    completion.resolve(); await drain(1);
    expect(store.run(run.id)).toMatchObject({ status: 'success', endedAt: now });
    expect(delivered).toHaveLength(1);
  } finally {
    completion.resolve(); await new Promise(resolve => setImmediate(resolve));
    timeout.mockRestore(); vi.useRealTimers();
  }
});
test.each(['Japan', 'CET'])('schedule creation and preview accept native timezone alias %s', async timezone => {
  const settings = { ...config, condition: { kind: 'schedule' as const, cron: '0 9 * * *', timezone } };
  const record = await coordinator.create(settings);
  expect(await coordinator.preview(settings, 1)).toEqual({ kind: 'schedule', times: [record.nextRunAt] });
  now = record.nextRunAt!; await drain(2);
  expect(delivered[0].input).toEqual({ kind: 'schedule', scheduledAt: now });
  expect(store.runs(record.id)[0].status).toBe('success');
});
test('cron persists one due catch-up, direct schedule input and next occurrence; previews are inert', async () => {
  const schedule = { ...config, condition: { kind: 'schedule' as const, cron: '*/5 * * * *', timezone: 'Asia/Taipei' } };
  const record = await coordinator.create(schedule); const boundary = engine.eventBoundary(principal); expect(record.nextRunAt).toBe(now + 5 * 60_000);
  const preview = await coordinator.preview(schedule, 3); expect(preview).toMatchObject({ times: [now + 5 * 60_000, now + 10 * 60_000, now + 15 * 60_000] });
  now += 23 * 60_000; await drain(3); expect(delivered).toHaveLength(1); expect(delivered[0].input).toEqual({ kind: 'schedule', scheduledAt: record.nextRunAt });
  expect(store.get(record.id).nextRunAt).toBe(Date.parse('2026-10-02T00:25:00Z')); expect(engine.eventBoundary(principal)).toBe(boundary);
});
test('Host management validates settings, target input kinds and caller authority before persistence', async () => {
  await expect(manageTriggers(coordinator, 'trigger.create', { config }, false)).rejects.toMatchObject({ code: 'CLI_UNSUPPORTED_COMMAND' }); expect(store.list()).toEqual([]);
  const created = await manageTriggers(coordinator, 'trigger.create', { config: { ...config, enabled: undefined } }, true).catch(() => null); expect(created).toBeNull();
  for (const invalid of [{ ...config, revision: 999 }, { ...config, target: 'callback:ephemeral' }, { ...config, condition: { kind: 'event', sql: 'SELECT * FROM triggers' } }]) await expect(coordinator.create(invalid)).rejects.toThrow();
  catalog[0].inputs = ['schedule']; await expect(coordinator.create(config)).rejects.toThrow('support'); expect(store.list()).toEqual([]);
  await expect(coordinator.preview({ kind: 'unknown', sql: 'SELECT id FROM events' })).rejects.toThrow('Condition');
});

test('four active target lanes bound execution and leave the fifth durably pending', async () => {
  const gate = Promise.withResolvers<void>(); targets.invoke = vi.fn(async (_, run) => { delivered.push(run); await gate.promise; });
  catalog = Array.from({ length: 5 }, (_, i) => ({ ...target, id: `app:notes:job:lane-${i}` }));
  for (const lane of catalog) await coordinator.create({ ...config, target: lane.id }); append(); await coordinator.tick(); await new Promise(resolve => setImmediate(resolve));
  expect(delivered).toHaveLength(4); expect(store.pending()).toHaveLength(1); await coordinator.tick(); expect(delivered).toHaveLength(4);
  gate.resolve(); await drain(3); expect(delivered).toHaveLength(5);
});
test('pending snapshots whose old target disappears are visibly blocked while newer settings still work', async () => {
  const record = await coordinator.create(config); const pending = store.insertRun(record, { kind: 'schedule', scheduledAt: now }, 'automatic', null, 'old-target', now);
  catalog = [{ ...target, id: 'app:notes:job:new' }]; await coordinator.update(record.id, 1, { target: catalog[0].id }); append(); await drain(2);
  expect(store.run(pending.id)).toMatchObject({ status: 'pending', error: 'Queued target is missing' }); expect(delivered).toHaveLength(1); expect(delivered[0].settings.target).toBe(catalog[0].id);
});

test('a due schedule invokes a concrete Source through real supervisor state and execution gates', async () => {
  const data = new DatabaseSync(join(root, '.lamarck', 'data.db'));
  const supervisor = new ConnectorSupervisor({ systemDb: db, guard: new TestGuard({ db: data, source: 'system:test' }), workspacePath: root, systemIdentity: { version: '0.0.0-test', commit: 'a'.repeat(40), platform: 'darwin-arm64' }, inProcessProducer: { producerRef: TEST_PRODUCER_REF as never, prepareProducer() {} }, platform: 'darwin' });
  let executions = 0;
  supervisor.register({ manifestVersion: 1, id: 'poller', name: 'Poller', description: 'Isolated Source fixture', eventCatalog: './events.json', entry: './index.ts', runtime: { mode: 'poll' }, source: { identity: 'single' }, auth: { type: 'none' } }, { async run(context) { executions++; expect(context).not.toHaveProperty('invocation'); expect(context).not.toHaveProperty('event'); await context.state.set({ completed: true }); } });
  try {
    const source = await supervisor.addSource({ connectorId: 'poller' });
    await coordinator.close(); coordinator = new TriggerCoordinator(store, matcher, new HostTriggerTargets({ inventory: async () => [] } as unknown as AppLifecycleService, supervisor, new AppJobDispatch()), () => now);
    const record = await coordinator.create({ ...config, target: `source:${source.id}:run`, condition: { kind: 'schedule', cron: '* * * * *', timezone: 'UTC' } });
    now += 60_000; await drain(3); expect(executions).toBe(1); expect(store.runs(record.id)[0].status).toBe('success'); expect(supervisor.getSource(source.id)?.syncState).toEqual({ completed: true });
    await supervisor.pauseSource(source.id); now += 60_000; await drain(2); expect(executions).toBe(1); expect(store.get(record.id).error).toBe('Source is paused');
  } finally { await coordinator.close(); data.close(); }
});
