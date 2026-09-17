import { describe, test, expect, vi } from 'vitest';
import { AiInvocations } from '../src/ai/invocations';
import type { AppAuthContext, AuthAdmission } from '../src/auth';
import { encodeAi } from '@lamarck/system/protocol';
const input = { model: 'openai:fixture', accessSource: 'source', operation: 'generate' as const, options: encodeAi({}), callbacks: true };
function caller(id: string): AppAuthContext { return { kind: 'app', appId: id, channelId: id, workload: 'ui', authorization: {} } as AppAuthContext; }
function admission(id = 'a') { const controller = new AbortController(); return { controller, context: caller(id), signal: controller.signal, release: vi.fn() }; }
const limits = { perChannel: 2, global: 4, queueBytes: 1200, globalBytes: 3600, idleMs: 200, deadlineMs: 1000, pollMs: 10 };
describe('AI invocation lifetime', () => {
  test('holds admission to terminal and rejects cross-caller or duplicate tool replies', async () => {
    const calls = new AiInvocations(limits); const a = admission();
    const { invocationId } = calls.start(a, input, async context => context.tool('lookup', { query: 1 }, 'tool'));
    const first = await calls.next(a.context, invocationId, 0);
    expect(first.events[0]).toMatchObject({ type: 'tool', toolCallId: 'tool', sequence: 0 }); expect(a.release).not.toHaveBeenCalled();
    expect(() => calls.reply(caller('b'), invocationId, 'tool', 'bad', false)).toThrow('unavailable');
    calls.reply(a.context, invocationId, 'tool', 'ok', false);
    expect(() => calls.reply(a.context, invocationId, 'tool', 'duplicate', false)).toThrow();
    expect((await calls.next(a.context, invocationId, 1)).events[0]).toMatchObject({ type: 'complete', value: 'ok' });
    await vi.waitFor(() => expect(a.release).toHaveBeenCalledTimes(1)); expect(calls.size).toBe(0);
  });
  test('cancels outstanding callbacks on capability revocation and ignores terminal races', async () => {
    const calls = new AiInvocations(limits); const a = admission();
    const { invocationId } = calls.start(a, input, async context => context.tool('lookup', {}, 'tool'));
    await calls.next(a.context, invocationId, 0); a.controller.abort();
    await vi.waitFor(() => expect(a.release).toHaveBeenCalledTimes(1));
    expect(calls.size).toBe(0); calls.cancel(a.context, invocationId); calls.close();
    expect(a.release).toHaveBeenCalledTimes(1);
  });
  test('applies backpressure and releases a stalled consumer on idle timeout', async () => {
    const calls = new AiInvocations(limits); const a = admission(); let count = 0;
    calls.start(a, input, async context => { for (let i = 0; i < 20; i++) { await context.part('x'.repeat(400)); count++; } });
    await vi.waitFor(() => expect(count).toBe(2));
    await vi.waitFor(() => expect(calls.size).toBe(0));
    await vi.waitFor(() => expect(a.release).toHaveBeenCalledTimes(1));
  });
  test('shutdown waits for provider disposal and admission release', async () => {
    const calls = new AiInvocations(limits); const a = admission(); let dispose!: () => void;
    calls.start(a, input, async context => {
      await new Promise<void>(resolve => { context.signal.addEventListener('abort', () => { dispose = resolve; }, { once: true }); });
    });
    await Promise.resolve();
    let closed = false; const closing = calls.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); expect(a.release).not.toHaveBeenCalled();
    dispose(); await closing; expect(a.release).toHaveBeenCalledTimes(1);
  });
  test('rejects invalid sequence, concurrent polls and admission overflow', async () => {
    const calls = new AiInvocations(limits); const a = admission();
    const run = async (context: any) => context.tool('lookup', {}, 'tool');
    const first = calls.start(a, input, run); calls.start(admission(), input, run);
    expect(() => calls.start(admission(), input, run)).toThrow('Too many');
    await expect(calls.next(caller('b'), first.invocationId, 0)).rejects.toThrow();
    await expect(calls.next(a.context, first.invocationId, 100)).rejects.toThrow('cursor');
    calls.close(); await vi.waitFor(() => expect(a.release).toHaveBeenCalledTimes(1));
  });
});
