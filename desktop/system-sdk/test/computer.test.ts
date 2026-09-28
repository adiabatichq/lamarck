import { expect, test, vi } from 'vitest';
import { createSystem } from '../src/create-system';
import type { SystemInvoke } from '../src/protocol';

function fixture() {
  const result = { content: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }] };
  const invoke = vi.fn(async (op: string, input: any) => {
    if (op === 'computer.open') return { sessionId: input.sessionId, instructions: 'Inspect first', tools: [{ name: 'screenshot', inputSchema: { type: 'object', properties: {} } }] };
    if (op === 'computer.call') return result;
    if (op === 'computer.close') return { ok: true };
    throw new Error(op);
  });
  return { system: createSystem(invoke as SystemInvoke), invoke, result };
}
test('exposes standard tools with explicit image output and closes after the callback', async () => {
  const { system, invoke, result } = fixture();
  let retained: any;
  await system.computer.withTools(async ({ tools, instructions }) => {
    expect(instructions).toBe('Inspect first'); retained = tools.screenshot;
    const output = await tools.screenshot.execute!({}, { toolCallId: '1', messages: [], context: undefined });
    expect(output).toEqual(result);
    expect(await tools.screenshot.toModelOutput!({ toolCallId: '1', input: {}, output: output as any })).toEqual({ type: 'content', value: [{ type: 'file', data: { type: 'data', data: 'AQID' }, mediaType: 'image/png' }] });
  });
  expect(invoke.mock.calls.map(([op]) => op)).toEqual(['computer.open', 'computer.call', 'computer.close']);
  await expect(retained.execute({}, {})).rejects.toThrow('closed');
});
test('cancellation closes the Host scope and rejects further tools', async () => {
  const { system, invoke } = fixture(); const abort = new AbortController();
  await expect(system.computer.withTools(async ({ tools }) => {
    abort.abort();
    await tools.screenshot.execute!({}, { toolCallId: '1', messages: [], context: undefined });
  }, { abortSignal: abort.signal })).rejects.toThrow();
  expect(invoke.mock.calls.map(([op]) => op)).toEqual(['computer.open', 'computer.close']);
});
test('driver refusals become explicit model-facing errors, without choosing another action', async () => {
  const invoke = vi.fn(async (operation: string, input: any) => {
    if (operation === 'computer.open') return { sessionId: input.sessionId, instructions: '', tools: [{ name: 'click', inputSchema: { type: 'object' } }] };
    if (operation === 'computer.call') return { isError: true, content: [{ type: 'text', text: 'Stale capture; inspect the window again' }] };
    return { ok: true };
  });
  await createSystem(invoke as SystemInvoke).computer.withTools(async ({ tools }) => {
    const output = await tools.click.execute!({}, { toolCallId: '1', messages: [], context: undefined }) as any;
    expect(output.isError).toBe(true);
    expect(await tools.click.toModelOutput!({ toolCallId: '1', input: {}, output })).toEqual({ type: 'error-text', value: 'Stale capture; inspect the window again' });
  });
  expect(invoke.mock.calls.filter(([op]) => op === 'computer.call')).toHaveLength(1);
});
test('closes a scope that arrives after cancellation during permission approval', async () => {
  const { system, invoke } = fixture(); const abort = new AbortController();
  const promise = system.computer.withTools(async () => { throw new Error('should not run'); }, { abortSignal: abort.signal });
  abort.abort(); await expect(promise).rejects.toThrow();
  expect(invoke.mock.calls.map(([op]) => op)).toEqual(['computer.open', 'computer.close']);
});
test('cancels the Host permission request immediately, before open replies', async () => {
  const abort = new AbortController();
  let finish!: () => void;
  const invoke = vi.fn(async (operation: string, input: any) => {
    if (operation === 'computer.open') {
      await new Promise<void>(resolve => { finish = resolve; });
      return { sessionId: input.sessionId, tools: [], instructions: '' };
    }
    expect(operation).toBe('computer.close');
    finish();
    return { ok: true };
  });
  const system = createSystem(invoke as SystemInvoke);
  const promise = system.computer.withTools(async () => { throw new Error('must not run'); }, { abortSignal: abort.signal });
  abort.abort();
  expect(invoke.mock.calls.map(([op]) => op)).toEqual(['computer.open', 'computer.close']);
  await expect(promise).rejects.toThrow();
  expect(invoke.mock.calls[0][1].sessionId).toBe(invoke.mock.calls[1][1].sessionId);
});
test('a refused open does not attempt to close another scope', async () => {
  const invoke = vi.fn(async () => { throw new Error('Another scope is active'); });
  await expect(createSystem(invoke as SystemInvoke).computer.withTools(async () => {})).rejects.toThrow('Another scope');
  expect(invoke).toHaveBeenCalledTimes(1);
});
