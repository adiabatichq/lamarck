import { expect, test, vi } from 'vitest';
import { createSubscribe } from '../src/subscription';
import type { D0Event } from '../src/protocol';
const event = { id: 'd0', payload: { value: 42 } } as unknown as D0Event;
test('handler stays local; acknowledgement follows completion and cancellation stops the batch', async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const calls: unknown[] = [];
  const transport = { start: vi.fn(async () => ({ subscriptionId: 'private-id' })), next: vi.fn(async (input: unknown) => { calls.push(input); return { sequence: 1, events: [event, event] }; }), cancel: vi.fn(async () => ({})) };
  const handler = vi.fn(async () => { await blocked; });
  const subscription = await createSubscribe(transport)({ sql: 'SELECT id FROM events' }, handler);
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  expect(calls).toEqual([{ subscriptionId: 'private-id', acknowledged: 0 }]);
  await subscription.cancel(); unblock(); await subscription.done;
  expect(handler).toHaveBeenCalledTimes(1); expect(transport.cancel).toHaveBeenCalledTimes(1);
  expect(transport.start).toHaveBeenCalledWith({ sql: 'SELECT id FROM events' });
});
test('handler errors are observable and cancel their listener', async () => {
  const transport = { start: async () => ({ subscriptionId: 's' }), next: async () => ({ sequence: 1, events: [event] }), cancel: vi.fn(async () => ({})) };
  const subscription = await createSubscribe(transport)({ sql: 'SELECT id FROM events' }, () => { throw new Error('handler failed'); });
  await expect(subscription.done).rejects.toThrow('handler failed'); expect(transport.cancel).toHaveBeenCalledOnce();
});
test('aborted runtime cannot register or deliver', async () => {
  const runtime = new AbortController(); runtime.abort();
  const start = vi.fn();
  await expect(createSubscribe({ start, next: vi.fn(), cancel: vi.fn() }, runtime.signal)({ sql: 'SELECT id FROM events' }, vi.fn())).rejects.toThrow('runtime ended');
  expect(start).not.toHaveBeenCalled();
});
