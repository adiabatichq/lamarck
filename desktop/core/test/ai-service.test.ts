import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { generateText, streamText, embed, tool } from 'ai';
import { APICallError, type LanguageModelV4 } from '@ai-sdk/provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { createSystem } from '@lamarck/system/browser';
import { decodeAi } from '@lamarck/system/protocol';
import { SYSTEM_SCHEMA_V1 } from '../src/db';
import { CredentialStore } from '../src/credentials/credential-store';
import { SqliteEncryptedSecretStore } from '../src/credentials/secret-store';
import { AiService, type AiAdapter } from '../src/ai/service';
let db: DatabaseSync, root: string, service: AiService;
const caller = { kind: 'app', appId: 'fixture', channelId: 'fixture', workload: 'ui', authorization: {} } as any;
beforeEach(async () => { db = new DatabaseSync(':memory:'); db.exec(SYSTEM_SCHEMA_V1); root = await mkdtemp(join(tmpdir(), 'ai-service-')); service = createService(); });
afterEach(async () => { vi.unstubAllGlobals(); await service.close(); db.close(); await rm(root, { recursive: true, force: true }); });
function createService(adapter?: AiAdapter) { return new AiService(db, new CredentialStore(db), new SqliteEncryptedSecretStore(db, new Uint8Array(32).fill(1)), root, adapter); }
function system() {
  return createSystem(async (operation, input: any): Promise<any> => {
    if (operation === 'ai.listOptions') return service.options(caller);
    if (operation === 'ai.start') return service.start({ context: caller, signal: new AbortController().signal, release() {} }, input);
    if (operation === 'ai.next') return service.invocations.next(caller, input.invocationId, input.sequence);
    if (operation === 'ai.cancel') { service.invocations.cancel(caller, input.invocationId); return { ok: true }; }
    if (operation === 'ai.toolResult') { service.invocations.reply(caller, input.invocationId, input.toolCallId, decodeAi(input.value), input.failed); return { ok: true }; }
    throw new Error('Unexpected operation');
  });
}
test('official API providers bind independent keys, preserve usage and embedding vectors, sanitize failures', async () => {
  const credentials: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers); credentials.push(headers.get('authorization') ?? headers.get('x-api-key')!);
    const body = JSON.parse(init.body as string);
    if (String(url).endsWith('/embeddings')) return Response.json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [1, 2] }], model: body.model, usage: { prompt_tokens: 2, total_tokens: 2 } });
    if (String(url).includes('anthropic')) return Response.json({ id: 'a', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'anthropic' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } });
    if (headers.get('authorization') === 'Bearer invalid') return Response.json({ error: { message: 'SENSITIVE PROVIDER BODY', type: 'invalid_request_error' } }, { status: 401 });
    return Response.json({ id: 'r', object: 'response', created_at: 1, model: body.model, status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'openai', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
  }));
  const sources = await Promise.all(['one', 'two', 'invalid'].map(apiKey => service.sources.save({ name: apiKey, provider: 'openai', kind: 'api-key', apiKey })));
  const anthropic = await service.sources.save({ name: 'Claude API', provider: 'anthropic', kind: 'api-key', apiKey: 'claude-key' });
  const ai = system().ai;
  const results = await Promise.all(sources.slice(0, 2).map(source => generateText({ model: ai.languageModel({ model: 'openai:gpt-5-mini', accessSource: source.id }), prompt: 'hi' })));
  expect(results.map(result => result.text)).toEqual(['openai', 'openai']); expect(results[0].usage.outputTokens).toBe(2);
  expect(credentials).toContain('Bearer one'); expect(credentials).toContain('Bearer two');
  expect((await generateText({ model: ai.languageModel({ model: 'anthropic:claude-sonnet-4-6', accessSource: anthropic.id }), prompt: 'hi' })).text).toBe('anthropic');
  expect(credentials).toContain('claude-key');
  expect((await embed({ model: ai.embeddingModel({ model: 'openai:text-embedding-3-small', accessSource: sources[0].id }), value: 'hi' })).embedding).toEqual([1, 2]);
  await expect(generateText({ model: ai.languageModel({ model: 'openai:gpt-5-mini', accessSource: sources[2].id }), prompt: 'hi', maxRetries: 0 })).rejects.toMatchObject({ name: 'AI_APICallError', statusCode: 401, message: 'AI provider request failed (HTTP 401)' });
  expect((await ai.listOptions()).accessSources.find(source => source.id === sources[2].id)?.status).toBe('unavailable');
});
test('local discovery and provider work; independent model metadata survives source removal and service restart', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/models')
    ? Response.json({ data: [{ id: 'fixture-local' }] })
    : Response.json({ id: 'r', object: 'chat.completion', created: 1, model: 'fixture-local', choices: [{ index: 0, message: { role: 'assistant', content: 'local' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })));
  const source = await service.sources.save({ name: 'Local', provider: 'local', kind: 'local', config: { endpoint: 'http://localhost:12345/v1' } });
  const ai = system().ai;
  expect((await ai.listOptions()).accessSources[0].support[0]).toMatchObject({ tools: false, structuredOutput: false });
  expect((await generateText({ model: ai.languageModel({ model: 'local:fixture-local', accessSource: source.id }), prompt: 'hi' })).text).toBe('local');
  await service.sources.remove(source.id); await service.close(); service = createService();
  expect((await service.options()).models.some(model => model.id === 'local:fixture-local')).toBe(true);
  expect((await service.options()).accessSources).toEqual([]);
});
test.each([
  { failure: 'HTTP 429', status: 429, maxRetries: 1, attempts: 2 },
  { failure: 'HTTP 429', status: 429, maxRetries: 0, attempts: 1 },
  { failure: 'HTTP 400', status: 400, maxRetries: 2, attempts: 1 },
  { failure: 'connection error', status: undefined, maxRetries: 1, attempts: 2 },
])('streamText startup $failure with maxRetries=$maxRetries matches the native provider', async ({ status, maxRetries, attempts }) => {
  let requests = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'fixture-local' }] });
    if (++requests === 1) {
      if (status === undefined) throw new TypeError('fetch failed', { cause: new Error('fixture connection reset') });
      return Response.json({ error: { message: 'provider failure' } }, { status });
    }
    const chunk = { id: 'r', object: 'chat.completion.chunk', created: 1, model: 'fixture-local' };
    return new Response([
      { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }));
  const source = await service.sources.save({ name: 'Local', provider: 'local', kind: 'local', config: { endpoint: 'http://localhost:12345/v1' } });
  const native = createOpenAICompatible({ name: 'local', baseURL: source.config.endpoint! }).languageModel('fixture-local');
  const proxy = system().ai.languageModel({ model: 'local:fixture-local', accessSource: source.id });
  for (const model of [native, proxy]) {
    requests = 0;
    const errors: unknown[] = [];
    const result = streamText({ model, prompt: 'hi', maxRetries, onError: ({ error }) => { errors.push(error); } });
    if (attempts === 2) { expect(await result.text).toBe('hello'); expect(errors).toEqual([]); }
    else { await result.consumeStream(); expect(errors).toHaveLength(1); expect(errors[0]).toMatchObject({ name: 'AI_APICallError', statusCode: status }); }
    expect(requests).toBe(attempts);
  }
  expect(service.invocations.size).toBe(0);
}, 10_000);

test('cancellation interrupts the stream readiness wait and aborts provider startup', async () => {
  const started = Promise.withResolvers<void>();
  const aborted = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'fixture-local' }] });
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { aborted(); reject(init.signal!.reason); }, { once: true });
      started.resolve();
    });
  }));
  const source = await service.sources.save({ name: 'Local', provider: 'local', kind: 'local', config: { endpoint: 'http://localhost:12345/v1' } });
  const controller = new AbortController();
  const pending = system().ai.languageModel({ model: 'local:fixture-local', accessSource: source.id }).doStream({ prompt: [], abortSignal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await started.promise;
  controller.abort();
  await rejected;
  expect(aborted).toHaveBeenCalledTimes(1);
  expect(service.invocations.size).toBe(0);
});

test.each(['stream', 'tool'] as const)('streamText does not replay after %s activity', async activity => {
  const dispose = vi.fn(async () => {});
  const started = vi.fn();
  await service.close();
  service = createService({
    async describe(source) { return { models: [], view: { ...source, status: 'ready', discovery: 'known', support: [{ model: 'openai:gpt-5-mini', streaming: true, structuredOutput: true, tools: true }] } }; },
    async open(_source, _options, context) {
      const model: LanguageModelV4 = {
        specificationVersion: 'v4', modelId: 'gpt-5-mini', provider: 'fixture', supportedUrls: {},
        async doGenerate() { throw new Error('Unexpected generation'); },
        async doStream() {
          started();
          const error = new APICallError({ message: 'failure', url: 'fixture:', requestBodyValues: {}, statusCode: 429, isRetryable: true });
          if (activity === 'tool') { await context.tool('lookup', {}, 'once'); throw error; }
          return { stream: new ReadableStream({ start(controller) { controller.error(error); } }) };
        },
      };
      return { provider: { specificationVersion: 'v4', languageModel: () => model, embeddingModel() { throw new Error('Unexpected'); }, imageModel() { throw new Error('Unexpected'); } }, dispose };
    },
  });
  const source = await service.sources.save({ provider: 'openai', kind: 'subscription', name: 'Fixture' });
  const execute = vi.fn(async () => 'side effect');
  const tools = { lookup: tool({ inputSchema: z.object({}), execute }) };
  const errors: unknown[] = [];
  await system().ai.withTools({ model: 'openai:gpt-5-mini', accessSource: source.id, tools }, async ({ model, tools }) => {
    await streamText({ model, tools, prompt: 'hi', maxRetries: 2, onError: ({ error }) => { errors.push(error); } }).consumeStream({ onError: error => { errors.push(error); } });
  });
  expect(errors).toHaveLength(1);
  expect(started).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(activity === 'tool' ? 1 : 0);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(service.invocations.size).toBe(0);
});
test('stale asynchronous discovery cannot publish model support after revocation', async () => {
  let resolve!: (value: any) => void;
  await service.close(); service = createService({ describe: () => new Promise(r => { resolve = r; }), open: async () => { throw new Error('Unexpected'); } });
  const source = await service.sources.save({ name: 'Private', provider: 'openai', kind: 'subscription' });
  const options = service.options(caller);
  await service.sources.save({ name: 'Private', provider: 'openai', kind: 'subscription', allow: { mode: 'apps', appIds: [] } }, source.id);
  resolve({ models: [{ id: 'openai:stale', provider: 'openai', name: 'Stale', type: 'language' }], view: { ...source, status: 'ready', discovery: 'known', support: [] } });
  const result = await options; expect(result.accessSources).toEqual([]); expect(result.models.some(model => model.id === 'openai:stale')).toBe(false);
});
