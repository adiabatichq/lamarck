import { afterEach, describe, expect, test, vi } from 'vitest';
import type { D0Event } from '@lamarck/system/protocol';
import { RuntimeListeners, type EventMatcher } from '../src/triggers/listeners';

const query = { sql: 'SELECT id FROM events' };
const event: D0Event = { id: 'event', schema_version: '0.1', source: 'system:test', producer_ref: 'test', type: 'test', external_id: null, started_at: 1, ended_at: null, created_at: 1, payload: {} };
const matcher: EventMatcher = { eventBoundary: async () => 0, matchEvents: async () => ({ cursor: 1, events: [event] }) };
const registries: RuntimeListeners[] = [];
function registry() { const listeners = new RuntimeListeners(); registries.push(listeners); return listeners; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { for (const listeners of registries.splice(0)) listeners.close(); vi.useRealTimers(); });

describe('registration cancellation and lifetime', () => {
  test.each(['boundary', 'matching'] as const)('request abort during %s cancels initialization and immediately releases capacity', async (stage) => {
    const listeners = registry(); const runtime = new AbortController();
    for (let attempt = 0; attempt < 24; attempt++) {
      const request = new AbortController(); const waiting = deferred<any>();
      let initializationSignal!: AbortSignal;
      const match = vi.fn(async () => stage === 'matching' ? waiting.promise : { cursor: 0, events: [] });
      const starting = listeners.start('owner', matcher, query, runtime.signal, {
        requestSignal: request.signal,
        matcher: signal => {
          initializationSignal = signal;
          return { eventBoundary: async () => stage === 'boundary' ? waiting.promise : 0, matchEvents: match };
        },
      });
      const rejected = expect(starting).rejects.toThrow('request ended');
      if (stage === 'matching') await vi.waitFor(() => expect(match).toHaveBeenCalledTimes(1));
      request.abort(new Error('request ended')); await rejected;
      expect(initializationSignal.aborted).toBe(true);
      waiting.resolve(stage === 'boundary' ? 0 : { cursor: 0, events: [] });
      await Promise.resolve();
      if (stage === 'boundary') expect(match).not.toHaveBeenCalled();
    }
    const handles = await Promise.all(Array.from({ length: 12 }, () => listeners.start('owner', matcher, query, runtime.signal)));
    expect(handles).toHaveLength(12);
    await expect(listeners.start('owner', matcher, query, runtime.signal)).rejects.toThrow('limit');
  });

  test('pending registrations count toward admission; owner teardown cancels only that owner', async () => {
    const listeners = registry(); const runtime = new AbortController(); const waiting = deferred<number>();
    const blocked: EventMatcher = { ...matcher, eventBoundary: () => waiting.promise };
    const pending = Array.from({ length: 12 }, () => listeners.start('one', blocked, query, runtime.signal));
    const rejected = pending.map(start => expect(start).rejects.toThrow());
    await expect(listeners.start('one', matcher, query, runtime.signal)).rejects.toThrow('limit');
    const other = listeners.start('two', blocked, query, runtime.signal);
    listeners.closeOwner('one'); await Promise.all(rejected);
    waiting.resolve(0); const handle = await other;
    expect((await listeners.next('two', handle.subscriptionId, 0)).events).toEqual([event]);
    expect(await listeners.start('one', matcher, query, runtime.signal)).toHaveProperty('subscriptionId');
  });

  test('request abort after creation reclaims an unreceived handle without consuming the allowance', async () => {
    const listeners = registry(); const runtime = new AbortController();
    for (let attempt = 0; attempt < 24; attempt++) {
      const request = new AbortController();
      const handle = await listeners.start('one', matcher, query, runtime.signal, { requestSignal: request.signal });
      request.abort();
      await expect(listeners.next('one', handle.subscriptionId, 0)).rejects.toThrow('unavailable');
    }
    expect(await listeners.start('one', matcher, query, runtime.signal)).toHaveProperty('subscriptionId');
  });

  test('lost replies expire; wrong owners cannot confirm them; established listeners outlive requests and expiry', async () => {
    vi.useFakeTimers();
    const listeners = registry(); const runtime = new AbortController(); const request = new AbortController();
    const established = await listeners.start('two', matcher, query, runtime.signal, { requestSignal: request.signal });
    const first = await listeners.next('two', established.subscriptionId, 0);
    request.abort();
    for (let round = 0; round < 3; round++) {
      const lost = await Promise.all(Array.from({ length: 12 }, () => listeners.start('one', matcher, query, runtime.signal)));
      await expect(listeners.next('two', lost[0].subscriptionId, 0)).rejects.toThrow('unavailable');
      expect(() => listeners.cancel('two', lost[0].subscriptionId)).toThrow('unavailable');
      await vi.advanceTimersByTimeAsync(30_001);
      for (const handle of lost) await expect(listeners.next('one', handle.subscriptionId, 0)).rejects.toThrow('unavailable');
      expect(await listeners.next('two', established.subscriptionId, 0)).toEqual(first);
    }
    expect((await listeners.next('two', established.subscriptionId, first.sequence)).sequence).toBe(2);
    runtime.abort();
    await expect(listeners.next('two', established.subscriptionId, 2)).rejects.toThrow('unavailable');
  });
});
