import { expect, test, vi } from 'vitest';
import { AppJobDispatch } from '../src/triggers/app-jobs';
import type { TriggerRun } from '../src/triggers/store';
const run = (id = 'run-a'): TriggerRun => ({ id, triggerId: 'trigger-a', revision: 2, settings: { name: 'Inbox', enabled: true, target: 'app:notes:job:inbox', condition: { kind: 'event', sql: 'SELECT id FROM events' } }, input: { kind: 'event', event: { id: 'original', payload: { text: 'unaltered' } } as never }, status: 'running', origin: 'automatic', retryOf: null, createdAt: 1, startedAt: 2, endedAt: null, error: null });
test('Host claims once; only the exact App job channel can read immutable event/schedule input', async () => {
  const release = vi.fn(), dispatch = new AppJobDispatch(() => 100, release); dispatch.heartbeat(true, []);
  const done = dispatch.invoke(run(), new AbortController().signal);
  expect(dispatch.claim()).toEqual({ runId: 'run-a', appId: 'notes', jobId: 'inbox', triggerId: 'trigger-a' }); expect(dispatch.claim()).toBeNull();
  expect(() => dispatch.bind('wrong', 'run-a', 'other', 'job:inbox')).toThrow('unavailable'); expect(() => dispatch.bind('wrong', 'run-a', 'notes', 'ui')).toThrow('unavailable');
  dispatch.bind('channel-a', 'run-a', 'notes', 'job:inbox');
  expect(dispatch.input('channel-a')).toEqual({ version: 1, triggerId: 'trigger-a', runId: 'run-a', revision: 2, input: run().input }); expect(() => dispatch.input('channel-b')).toThrow('unavailable');
  dispatch.complete('run-a', null); await done; expect(release).toHaveBeenCalledWith('channel-a'); expect(() => dispatch.input('channel-a')).toThrow();
  const scheduled = { ...run('run-b'), input: { kind: 'schedule' as const, scheduledAt: 1234 } }; const scheduledDone = dispatch.invoke(scheduled, new AbortController().signal); dispatch.claim(); dispatch.bind('channel-b', 'run-b', 'notes', 'job:inbox');
  expect(dispatch.input('channel-b').input).toEqual(scheduled.input); dispatch.complete('run-b', null); await scheduledDone;
});
test('canceled/late replies cannot expose input, finish another run, or reclaim another channel', async () => {
  const release = vi.fn(), dispatch = new AppJobDispatch(() => 100, release); dispatch.heartbeat(true, []);
  const a = new AbortController(), b = new AbortController(); const first = dispatch.invoke(run(), a.signal); const second = dispatch.invoke(run('run-b'), b.signal);
  const rejected = expect(first).rejects.toThrow('Canceled'); dispatch.claim(); dispatch.claim(); dispatch.bind('a', 'run-a', 'notes', 'job:inbox'); dispatch.bind('b', 'run-b', 'notes', 'job:inbox');
  a.abort(new Error('Canceled')); expect(() => dispatch.input('a')).toThrow(); expect(dispatch.heartbeat(true, ['run-a', 'run-b'])).toEqual(['run-a']); dispatch.complete('run-a', null); await rejected; expect(dispatch.input('b').runId).toBe('run-b'); expect(release.mock.calls).toEqual([['a']]); expect(dispatch.heartbeat(true, ['run-a', 'run-b'])).toEqual(['run-a']);
  dispatch.complete('run-b', null); await second;
});
test('lost claim reply is reclaimed without redispatch; late bind cannot revive it', async () => {
  let now = 100; const dispatch = new AppJobDispatch(() => now); dispatch.heartbeat(true, []);
  const done = dispatch.invoke(run(), new AbortController().signal); const rejection = expect(done).rejects.toThrow('response lost'); dispatch.claim(); now += 30_001; dispatch.heartbeat(true, []); await rejection;
  expect(dispatch.claim()).toBeNull(); expect(() => dispatch.bind('late', 'run-a', 'notes', 'job:inbox')).toThrow(); dispatch.complete('run-a', null);
});
test('lost Host heartbeat reports uncertainty and revokes bound job authority', async () => {
  let now = 100; const release = vi.fn(), dispatch = new AppJobDispatch(() => now, release); dispatch.heartbeat(true, []);
  const done = dispatch.invoke(run(), new AbortController().signal); const rejection = expect(done).rejects.toThrow('heartbeat lost'); dispatch.claim(); dispatch.bind('a', 'run-a', 'notes', 'job:inbox');
  now += 15_001; expect(dispatch.availability()).toContain('unavailable'); await rejection; expect(release).toHaveBeenCalledWith('a');
  expect(dispatch.heartbeat(true, ['run-a'])).toEqual(['run-a']); expect(dispatch.availability()).toContain('cleaning');
  const next = dispatch.invoke(run('run-b'), new AbortController().signal); expect(dispatch.claim()).toBeNull();
  dispatch.heartbeat(true, []); expect(dispatch.claim()?.runId).toBe('run-b'); dispatch.complete('run-b', null); await next;
});

test('canceling a claimed job keeps admission until Host cleanup or Core teardown, preventing overlap', async () => {
  const dispatch = new AppJobDispatch(() => 100); dispatch.heartbeat(true, []); const cancel = new AbortController();
  let settled = false; const done = dispatch.invoke(run(), cancel.signal).catch(() => { settled = true; }); dispatch.claim(); cancel.abort(new Error('cancel')); await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false); expect(dispatch.heartbeat(true, ['run-a'])).toEqual(['run-a']); dispatch.complete('run-a', 'cleanup confirmed'); await done; expect(settled).toBe(true);
  dispatch.heartbeat(true, []);
  const another = dispatch.invoke(run('run-b'), new AbortController().signal); const rejected = expect(another).rejects.toThrow('Host stopped'); dispatch.claim(); dispatch.close(); await rejected;
});
