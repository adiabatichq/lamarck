import { describe, expect, test, vi } from 'vitest';
import { generateText, streamText, embed, embedMany, Output, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { createSystem } from '../src/create-system';
import { encodeAi, decodeAi } from '../src/ai/codec';
import type { SystemInvoke } from '../src/protocol';

const usage = { inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function fixture(mode = 'text') {
  let id = 0;
  const calls = new Map<string, any>();
  const cancelled: string[] = [];
  const invoke = vi.fn(async (op: string, input: any): Promise<any> => {
    if (op === 'ai.listOptions') return { models: [], accessSources: [{ id: 'source', support: [{ model: 'openai:embedding', maxEmbeddingsPerCall: 2, supportsParallelCalls: true }] }] };
    if (op === 'ai.start') {
      expect(Object.keys(input).sort()).toEqual(['accessSource', 'callbacks', 'model', 'operation', 'options']);
      const invocationId = String(++id); calls.set(invocationId, { input, sequence: 0, polls: 0 }); return { invocationId };
    }
    if (op === 'ai.cancel') { cancelled.push(input.invocationId); return { ok: true }; }
    const call = calls.get(input.invocationId);
    if (op === 'ai.toolResult') { call.reply = decodeAi(input.value); return { ok: true }; }
    if (op === 'ai.next') {
      call.polls++;
      const options = decodeAi(call.input.options) as any;
      const event = (type: string, value: unknown) => ({ type, sequence: call.sequence++, value: encodeAi(value) });
      if ((mode.startsWith('empty-poll') || mode === 'stream-callback') && call.polls === 1) return { events: [{ type: 'ready', sequence: call.sequence++ }, event('part', { type: 'stream-start', warnings: [] })] };
      if (mode.startsWith('empty-poll') && call.polls <= 3) return { events: [] };
      if (mode === 'empty-poll-error') return { events: [{ type: 'error', sequence: call.sequence++, error: { code: 'provider', message: 'failed after polling', retryable: false } }] };
      if ((mode === 'callback' && call.polls === 1) || (mode === 'stream-callback' && call.polls === 2)) return { events: [{ type: 'tool', sequence: call.sequence++, toolCallId: 'tool-1', name: 'lookup', input: encodeAi({ value: 'valid' }) }] };
      if ((mode === 'callback' || mode === 'stream-callback') && call.reply === undefined) { await new Promise(resolve => setTimeout(resolve, 1)); return { events: [] }; }
      const text = mode === 'json' ? '{"answer":42}' : mode === 'callback' ? String(call.reply) : 'hello';
      if (call.input.operation === 'embed') return { events: [event('complete', { embeddings: options.values.map((v: string) => [v.length, 1]), usage: { tokens: options.values.length }, warnings: [] })] };
      if (call.input.operation === 'stream') return { events: [
        ...(call.sequence === 0 ? [{ type: 'ready', sequence: call.sequence++ }, event('part', { type: 'stream-start', warnings: [] })] : []),
        event('part', { type: 'text-start', id: 'text' }),
        event('part', { type: 'text-delta', id: 'text', delta: 'hel' }), event('part', { type: 'text-delta', id: 'text', delta: 'lo' }),
        event('part', { type: 'text-end', id: 'text' }), event('part', { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }), event('complete', null),
      ] };
      const firstToolStep = mode === 'api-tool' && !options.prompt.some((message: any) => message.role === 'tool');
      return { events: [event('complete', {
        content: firstToolStep ? [{ type: 'tool-call', toolCallId: 'api-tool', toolName: 'lookup', input: '{"value":"valid"}' }] : [{ type: 'text', text }],
        finishReason: { unified: firstToolStep ? 'tool-calls' : 'stop', raw: 'stop' }, usage, warnings: [],
      })] };
    }
    throw new Error(op);
  });
  const system = createSystem(invoke as SystemInvoke);
  return { system, invoke, cancelled, model: system.ai.languageModel({ model: 'openai:test', accessSource: 'source' }) };
}
describe('official Vercel operations through System model proxies', () => {
  test('generateText preserves text, usage and standard model identity', async () => {
    const { model } = fixture();
    const result = await generateText({ model, prompt: 'hello' });
    expect(result.text).toBe('hello');
    expect(result.usage.inputTokens).toBe(2);
    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBe('lamarck');
  });
  test('App-configured official telemetry remains independent of System transport', async () => {
    const { model } = fixture(); const onStart = vi.fn(), onEnd = vi.fn();
    const telemetry = { integrations: [{ onStart, onEnd }] };
    expect((await generateText({ model, prompt: 'hello', telemetry })).text).toBe('hello');
    const streamed = streamText({ model, prompt: 'hello', telemetry }); await streamed.consumeStream();
    expect(await streamed.text).toBe('hello');
    expect(onStart).toHaveBeenCalledTimes(2); expect(onEnd).toHaveBeenCalledTimes(2);
    expect((globalThis as any)[Symbol.for('@lamarck/system/ai-capture-v1')]).toBeUndefined();
  });
  test('streams incremental parts and structured output', async () => {
    const { model } = fixture();
    const values: string[] = [];
    for await (const part of streamText({ model, prompt: 'hello' }).textStream) values.push(part);
    expect(values).toEqual(['hel', 'lo']);
    const json = fixture('json');
    const result = await generateText({ model: json.model, prompt: 'answer', output: Output.object({ schema: z.object({ answer: z.number() }) }) });
    expect(result.output).toEqual({ answer: 42 });
  });
  test('embeddings preserve batching metadata', async () => {
    const { system, invoke } = fixture();
    const model = system.ai.embeddingModel({ model: 'openai:embedding', accessSource: 'source' });
    expect((await embed({ model, value: 'abc' })).embedding).toEqual([3, 1]);
    const result = await embedMany({ model, values: ['a', 'bb', 'ccc', 'dddd', 'eeeee'] });
    expect(result.embeddings).toEqual([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]);
    expect(invoke.mock.calls.filter(([op]) => op === 'ai.start')).toHaveLength(4);
  });
  test('streamText keeps polling after empty batches', async () => {
    const { model, invoke } = fixture('empty-poll');
    const result = streamText({ model, prompt: 'hello' });
    expect(await result.text).toBe('hello');
    expect(invoke.mock.calls.filter(([op]) => op === 'ai.next')).toHaveLength(4);
  }, 1000);
  test('streamText surfaces terminal errors after empty batches', async () => {
    const { model } = fixture('empty-poll-error');
    const errors: unknown[] = [];
    const result = streamText({ model, prompt: 'hello', onError: ({ error }) => { errors.push(error); } });
    await result.consumeStream({ onError: error => { errors.push(error); } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: 'failed after polling' });
  }, 1000);
  test('streamText keeps receiving while a tools-only batch executes', async () => {
    const { system } = fixture('stream-callback');
    const execute = vi.fn(async ({ value }: { value: string }) => { await new Promise(resolve => setTimeout(resolve, 10)); return value; });
    const tools = { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) };
    const text = await system.ai.withTools({ model: 'openai:test', accessSource: 'source', tools }, async ({ model, tools }) => streamText({ model, tools, prompt: 'lookup' }).text);
    expect(text).toBe('hello');
    expect(execute).toHaveBeenCalledTimes(1);
  }, 1000);
  test('API tools remain in Vercel App-side execution', async () => {
    const { model } = fixture('api-tool');
    const execute = vi.fn(async () => 'tool-result');
    const result = await generateText({ model, prompt: 'lookup', tools: { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) }, stopWhen: stepCountIs(2) });
    expect(result.text).toBe('hello');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test('subscription callbacks use the original Capsule schema and function', async () => {
    const { system } = fixture('callback');
    const execute = vi.fn(async ({ value }: { value: string }) => value.toUpperCase());
    const tools = { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) };
    const result = await system.ai.withTools({ model: 'openai:test', accessSource: 'source', tools }, async ({ model, tools }) => generateText({ model, tools, prompt: 'lookup' }));
    expect(result.text).toBe('VALID');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({ value: 'valid' });
  });
  test('rejects a retained stream when its tool scope closes', async () => {
    const { system, cancelled } = fixture();
    await expect(system.ai.withTools({ model: 'openai:test', accessSource: 'source', tools: {} }, async ({ model }) => model.doStream({ prompt: [] }))).rejects.toThrow('Consume');
    expect(cancelled.length).toBe(1);
  });
  test('pre-aborted calls do not start and URL inputs never download in App', async () => {
    const { model, invoke } = fixture();
    await expect(generateText({ model, prompt: 'stop', abortSignal: AbortSignal.abort() })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    await expect(generateText({ model, messages: [{ role: 'user', content: [{ type: 'image', image: new URL('https://example.invalid/image.png') }] }] })).rejects.toThrow('URL inputs');
    expect(invoke).not.toHaveBeenCalled();
  });
});
describe('AI codec', () => {
  test('round trips bytes, dates, undefined and collision-shaped JSON', () => {
    const data = { bytes: new Uint8Array([0, 255, 7]), date: new Date(1234), empty: undefined, schema: { type: 'object', properties: { bytes: ['bytes', 'hello'] } } };
    expect(decodeAi(encodeAi(data))).toEqual(data);
  });
  test('rejects functions, classes, cycles, malformed frames and excessive depth', () => {
    expect(() => encodeAi({ execute() {} })).toThrow();
    expect(() => encodeAi(new Map())).toThrow();
    const cycle: any = {}; cycle.self = cycle;
    expect(() => encodeAi(cycle)).toThrow('cycles');
    expect(() => decodeAi(['object', [['x', 1], ['x', 2]]])).toThrow('Duplicate');
    let deep: any = {}; for (let i = 0; i < 70; i++) deep = { deep };
    expect(() => encodeAi(deep)).toThrow('deeply');
  });
});
