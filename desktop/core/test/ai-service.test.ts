import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { generateText, streamText, embed, tool, Output, stepCountIs } from 'ai';
import { APICallError, type LanguageModelV4 } from '@ai-sdk/provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { createSystem } from '@lamarck/system/browser';
import { decodeAi } from '@lamarck/system/protocol';
import { SYSTEM_SCHEMA_V1 } from '../src/db';
import { CredentialStore } from '../src/credentials/credential-store';
import { SqliteEncryptedSecretStore } from '../src/credentials/secret-store';
import { AiService, type AiAdapter } from '../src/ai/service';
import { AiTurns } from '../src/ai/turns';
import { GuardEngine } from '../src/guard-service/engine';
import { AI_CATALOG } from '../src/ai/catalog';
let guard: GuardEngine;
const principal = { source: 'app:fixture:ui', producerRef: `producer:v1:sha256:${'5'.repeat(64)}`, tableGrants: [] };
let db: DatabaseSync, root: string, service: AiService;
const caller = { kind: 'app', appId: 'fixture', channelId: 'fixture', workload: 'ui', authorization: {} } as any;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ai-service-')); db = new DatabaseSync(join(root, 'system.db')); db.exec(SYSTEM_SCHEMA_V1); guard = new GuardEngine({ workspacePath: root }); service = createService(); });
afterEach(async () => { vi.unstubAllGlobals(); await service.close(); db.close(); guard.close(); await rm(root, { recursive: true, force: true }); });
function createService(adapter?: AiAdapter) { return new AiService(db, new CredentialStore(db), new SqliteEncryptedSecretStore(db, new Uint8Array(32).fill(1)), root, adapter, new AiTurns(root, () => ({ publishAiTurn: input => guard.publishAiTurn(principal, input) }))); }
async function restartService() { await service.close(); db.close(); db = new DatabaseSync(join(root, 'system.db')); service = createService(); }
function system() {
  return createSystem(async (operation, input: any): Promise<any> => {
    if (operation === 'ai.capture') return service.turns!.request({ context: caller, signal: new AbortController().signal, release() {} }, input);
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
  const results = await Promise.all(sources.slice(0, 2).map(source => generateText({ model: ai.languageModel({ model: 'openai:gpt-5.6-luna', accessSource: source.id }), prompt: 'hi' })));
  expect(results.map(result => result.text)).toEqual(['openai', 'openai']); expect(results[0].usage.outputTokens).toBe(2);
  expect(credentials).toContain('Bearer one'); expect(credentials).toContain('Bearer two');
  expect((await generateText({ model: ai.languageModel({ model: 'anthropic:claude-sonnet-5', accessSource: anthropic.id }), prompt: 'hi' })).text).toBe('anthropic');
  expect(credentials).toContain('claude-key');
  expect((await embed({ model: ai.embeddingModel({ model: 'openai:text-embedding-3-small', accessSource: sources[0].id }), value: 'hi' })).embedding).toEqual([1, 2]);
  await expect(generateText({ model: ai.languageModel({ model: 'openai:gpt-5.6-luna', accessSource: sources[2].id }), prompt: 'hi', maxRetries: 0 })).rejects.toMatchObject({ name: 'AI_APICallError', statusCode: 401, message: 'AI provider request failed (HTTP 401)' });
  expect((await ai.listOptions()).accessSources.find(source => source.id === sources[2].id)?.status).toBe('unavailable');
});
test('the shipped catalog is available without sources and independent of source creation/removal', async () => {
  expect(AI_CATALOG.filter(model => model.type === 'language').map(model => model.id)).toEqual([
    'openai:gpt-6-astra', 'openai:gpt-5.6-sol', 'openai:gpt-5.6-terra', 'openai:gpt-5.6-luna',
    'anthropic:claude-fable-5-1', 'anthropic:claude-opus-5', 'anthropic:claude-sonnet-5', 'anthropic:claude-haiku-4-5-20251001',
  ]);
  expect(AI_CATALOG.filter(model => model.type === 'embedding').map(model => model.id)).toEqual(['openai:text-embedding-3-small', 'openai:text-embedding-3-large']);
  expect(AI_CATALOG.every(model => model.name !== model.id.split(':')[1])).toBe(true);
  expect(await service.options()).toEqual({ models: AI_CATALOG, accessSources: [] });
  const source = await service.sources.save({ name: 'API', provider: 'openai', kind: 'api-key', apiKey: 'fixture-key' });
  expect((await service.options()).models).toEqual(AI_CATALOG);
  await service.sources.remove(source.id);
  expect(await service.options()).toEqual({ models: AI_CATALOG, accessSources: [] });
});
test('local discovery stays in memory while source configuration persists across restart', async () => {
  let discoveryFails = false, discoveries = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/models')) {
      discoveries++;
      return discoveryFails ? new Response(null, { status: 503 }) : Response.json({ data: [{ id: 'fixture-local' }] });
    }
    return Response.json({ id: 'r', object: 'chat.completion', created: 1, model: 'fixture-local', choices: [{ index: 0, message: { role: 'assistant', content: 'local' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }));
  const source = await service.sources.save({ name: 'Local', provider: 'local', kind: 'local', config: { endpoint: 'http://localhost:12345/v1' } });
  const ai = system().ai;
  expect((await ai.listOptions()).accessSources[0].support[0]).toMatchObject({ tools: false, structuredOutput: false });
  expect((await generateText({ model: ai.languageModel({ model: 'local:fixture-local', accessSource: source.id }), prompt: 'hi' })).text).toBe('local');
  expect(discoveries).toBe(1);

  await restartService();
  expect(service.sources.get(source.id)).toEqual(source);
  discoveryFails = true;
  const failed = await ai.listOptions();
  expect(failed.models).toEqual(AI_CATALOG);
  expect(failed.accessSources[0]).toMatchObject({ id: source.id, status: 'unavailable', discovery: 'failed', support: [] });
  expect(discoveries).toBe(2);

  await restartService();
  discoveryFails = false;
  const rediscovered = await ai.listOptions();
  expect(rediscovered.models).toContainEqual({ id: 'local:fixture-local', name: 'fixture-local', provider: 'local', type: 'language' });
  expect(rediscovered.accessSources[0]).toMatchObject({ id: source.id, status: 'ready', discovery: 'known' });
  expect(discoveries).toBe(3);

  await service.sources.remove(source.id);
  expect((await service.options()).models.some(model => model.id === 'local:fixture-local')).toBe(true);
  expect((await service.options()).accessSources).toEqual([]);
  await restartService();
  expect(await service.options()).toEqual({ models: AI_CATALOG, accessSources: [] });
  expect(discoveries).toBe(3);
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
    async describe(source) { return { models: [], view: { ...source, status: 'ready', discovery: 'known', support: [{ model: 'openai:gpt-5.6-luna', streaming: true, structuredOutput: true, tools: true }] } }; },
    async open(_source, _options, context) {
      const model: LanguageModelV4 = {
        specificationVersion: 'v4', modelId: 'gpt-5.6-luna', provider: 'fixture', supportedUrls: {},
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
  await system().ai.withTools({ model: 'openai:gpt-5.6-luna', accessSource: source.id, tools }, async ({ model, tools }) => {
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

function openaiResponse(body: any, text = 'hello') {
  const message = { type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }], status: 'completed' };
  const response = { id: 'response', object: 'response', created_at: 1, model: body.model, status: 'completed', output: [message], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
  if (!body.stream) return Response.json(response);
  return eventStream([
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', item_id: 'msg', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'msg', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: 'msg', output_index: 0, content_index: 0, text },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ]);
}
function eventStream(events: any[]) {
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
function anthropicResponse(body: any, content: any = { type: 'text', text: 'hello' }) {
  const message = { id: 'msg', type: 'message', role: 'assistant', model: body.model, content: [content], stop_reason: content.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 } };
  if (!body.stream) return Response.json(message);
  return eventStream([
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} } },
    { type: 'content_block_delta', index: 0, delta: content.type === 'text' ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);
}

test.each(['generate', 'stream'] as const)('Astra Responses options and warnings survive %s through the Host', async mode => {
  const requests: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body as string); requests.push(body); return openaiResponse(body);
  }));
  const source = await service.sources.save({ name: 'API', provider: 'openai', kind: 'api-key', apiKey: 'fixture' });
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const options = {
      model: system().ai.languageModel({ model: 'openai:gpt-6-astra', accessSource: source.id }), prompt: 'hello', maxRetries: 0,
      temperature: 0.4, topP: 0.7,
      providerOptions: { openai: { reasoningEffort: effort, logprobs: 2, include: ['message.output_text.logprobs'], promptCacheRetention: '24h', promptCacheOptions: { ttl: '30m' } } },
    };
    const result = mode === 'generate' ? await generateText(options) : streamText(options);
    expect(await result.text).toBe('hello');
    expect((await result.usage).outputTokens).toBe(3);
    expect(await result.finishReason).toBe('stop');
    const body = requests.at(-1);
    expect(body.model).toBe('gpt-6-astra');
    expect(body.temperature).toBeUndefined(); expect(body.top_p).toBeUndefined(); expect(body.top_logprobs).toBeUndefined();
    expect(body.include ?? []).not.toContain('message.output_text.logprobs');
    expect(body.prompt_cache_retention).toBeUndefined(); expect(body.prompt_cache_options).toEqual({ ttl: '30m' });
    const features = (await result.warnings)?.map(warning => 'feature' in warning ? warning.feature : '') ?? [];
    expect(features).toEqual(expect.arrayContaining(['temperature', 'topP', 'logprobs', 'promptCacheRetention']));
    if (['none', 'minimal'].includes(effort)) { expect(body.reasoning?.effort).toBeUndefined(); expect(features).toContain('reasoningEffort'); }
    else { expect(body.reasoning.effort).toBe(effort); expect(features).not.toContain('reasoningEffort'); }
  }
});

test.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])('%s preserves its own Responses sampling and reasoning behavior', async id => {
  const requests: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { const body = JSON.parse(init.body as string); requests.push(body); return openaiResponse(body); }));
  const source = await service.sources.save({ name: 'API', provider: 'openai', kind: 'api-key', apiKey: 'fixture' });
  for (const effort of ['none', 'high'] as const) {
    const result = await generateText({ model: system().ai.languageModel({ model: `openai:${id}`, accessSource: source.id }), prompt: 'hello', reasoning: effort, temperature: 0.4, topP: 0.7, providerOptions: { openai: { logprobs: 2, promptCacheRetention: '24h' } } });
    expect(result.text).toBe('hello');
    expect(requests.at(-1)).toMatchObject({ model: id, reasoning: { effort }, prompt_cache_retention: '24h' });
    if (effort === 'none') { expect(requests.at(-1)).toMatchObject({ temperature: 0.4, top_p: 0.7, top_logprobs: 2 }); expect(result.warnings).toEqual([]); }
    else { expect(requests.at(-1).temperature).toBeUndefined(); expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ feature: 'temperature' })])); }
  }
});

const claudeModels = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
test.each(claudeModels)('%s API preserves exact selection, reasoning, JSON and streamed App tool results', async id => {
  const requests: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string); requests.push(body);
    const toolRequest = body.tools?.length && !body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === 'tool_result'));
    return anthropicResponse(body, toolRequest ? { type: 'tool_use', id: 'lookup-call', name: 'lookup', input: { value: 'fixture' } } : { type: 'text', text: body.output_config?.format ? '{"answer":"hello"}' : 'hello' });
  }));
  const source = await service.sources.save({ name: 'API', provider: 'anthropic', kind: 'api-key', apiKey: 'fixture' });
  const selection = { model: `anthropic:${id}`, accessSource: source.id };
  for (const streaming of [false, true]) {
    const options = { model: system().ai.languageModel(selection), prompt: 'hello', reasoning: 'high' as const, output: Output.object({ schema: z.object({ answer: z.string() }) }) };
    const result = streaming ? streamText(options) : await generateText(options);
    expect(await result.output).toEqual({ answer: 'hello' }); expect((await result.usage).outputTokens).toBe(3);
    const body = requests.at(-1);
    expect(body.model).toBe(id); expect(body.output_config.format.type).toBe('json_schema');
    expect(body.thinking.type).toBe(id.includes('haiku') ? 'enabled' : 'adaptive');
    if (id.includes('haiku')) { expect(body.thinking.budget_tokens).toBeGreaterThan(0); expect(body.output_config.effort).toBeUndefined(); }
    else expect(body.output_config.effort).toBe('high');
  }
  const execute = vi.fn(async () => 'lookup-result');
  await system().ai.withTools({ ...selection, tools: { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) } }, async ({ model, tools }) => {
    const result = streamText({ model, tools, prompt: 'lookup', stopWhen: stepCountIs(2) });
    expect(await result.text).toBe('hello'); expect(await result.finishReason).toBe('stop');
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(requests.every(body => body.model === id)).toBe(true);
  expect(JSON.stringify(requests.at(-1).messages)).toContain('lookup-result');
});

test.each([false, true].flatMap(adaptive => ['generate', 'stream'].map(mode => ({ adaptive, mode }))))('Anthropic thinking block binding survives $mode (adaptive: $adaptive)', async ({ adaptive, mode }) => {
  const requests: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { const body = JSON.parse(init.body as string); requests.push(body); return anthropicResponse(body); }));
  const source = await service.sources.save({ name: 'API', provider: 'anthropic', kind: 'api-key', apiKey: 'fixture' });
  const bridged = system().ai.languageModel({ model: 'anthropic:claude-fable-5-1', accessSource: source.id });
  const native = createAnthropic({ apiKey: 'fixture' })('claude-fable-5-1');
  const warnings = [];
  for (const model of [native, bridged]) {
    const options = { model, prompt: 'hello', temperature: 0.5, providerOptions: { anthropic: { thinking: { ...(adaptive ? { type: 'adaptive' } : {}), blockBinding: { prefixMismatchBehavior: 'drop_block' } } } } };
    const result = mode === 'generate' ? await generateText(options) : streamText(options);
    expect(await result.text).toBe('hello'); warnings.push(await result.warnings);
  }
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1].thinking).toEqual({ ...(adaptive ? { type: 'adaptive' } : {}), block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  expect(warnings[1]).toEqual(warnings[0]);
  if (adaptive) expect(warnings[1]).toContainEqual(expect.objectContaining({ type: 'unsupported', feature: 'temperature' }));
});

test.each(['generate', 'stream'])('Anthropic invalid settings surface provider errors through %s without inference', async mode => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const source = await service.sources.save({ name: 'API', provider: 'anthropic', kind: 'api-key', apiKey: 'fixture' });
  for (const bridged of [false, true]) {
    const model = bridged ? system().ai.languageModel({ model: 'anthropic:claude-fable-5-1', accessSource: source.id }) : createAnthropic({ apiKey: 'fixture' })('claude-fable-5-1');
    const options = { model, prompt: 'hello', maxRetries: 0, providerOptions: { anthropic: { thinking: { blockBinding: { prefixMismatchBehavior: 'invalid' } } } } };
    if (mode === 'generate') await expect(generateText(options)).rejects.toMatchObject(bridged ? { code: 'provider_error' } : { name: 'AI_InvalidArgumentError' });
    else {
      const errors: unknown[] = [];
      await streamText({ ...options, onError: ({ error }) => { errors.push(error); } }).consumeStream();
      expect(errors).toHaveLength(1); expect(errors[0]).toMatchObject(bridged ? { code: 'provider_error' } : { name: 'AI_InvalidArgumentError' });
    }
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('subscription eligibility follows discovery and capabilities independently of model family', async () => {
  const ids = ['claude-fable-5-1', 'fable[1m]', 'best', 'fixture-unfamiliar-family'];
  const generate = vi.fn(async () => ({ content: [{ type: 'text', text: 'hello' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: {}, outputTokens: {} }, warnings: [] }));
  const select = vi.fn(id => ({ specificationVersion: 'v4', provider: 'fixture', modelId: id, supportedUrls: {}, doGenerate: generate }));
  await service.close(); service = createService({ open: async () => ({ provider: { specificationVersion: 'v4', languageModel: select } as any, dispose: async () => {} }), async describe(source) {
    return { models: ids.map(id => ({ id: `anthropic:${id}`, provider: 'anthropic', name: id, type: 'language' })), view: { ...source, status: 'ready', discovery: 'known', support: ids.map(id => ({ model: `anthropic:${id}`, streaming: false, structuredOutput: false, tools: false })) } };
  } });
  const source = await service.sources.save({ name: 'Subscription', provider: 'anthropic', kind: 'subscription' });
  const ai = system().ai;
  expect((await ai.listOptions()).accessSources[0].support.map(support => support.model)).toEqual(ids.map(id => `anthropic:${id}`));
  for (const id of ids) {
    expect((await generateText({ model: ai.languageModel({ model: `anthropic:${id}`, accessSource: source.id }), prompt: 'hello' })).text).toBe('hello');
    expect(select).toHaveBeenLastCalledWith(id);
  }
  const model = ai.languageModel({ model: `anthropic:${ids[0]}`, accessSource: source.id });
  await expect(generateText({ model: ai.languageModel({ model: 'anthropic:unknown', accessSource: source.id }), prompt: 'hello', maxRetries: 0 })).rejects.toMatchObject({ code: 'unsupported' });
  await expect(generateText({ model, prompt: 'hello', output: Output.object({ schema: z.object({ answer: z.string() }) }), maxRetries: 0 })).rejects.toMatchObject({ code: 'unsupported' });
  await expect(generateText({ model, prompt: 'hello', providerOptions: { anthropic: { model: 'override' } }, maxRetries: 0 })).rejects.toMatchObject({ code: 'unsupported' });
  await service.sources.save({ name: source.name, provider: source.provider, kind: source.kind, allow: { mode: 'apps', appIds: [] } }, source.id);
  await expect(generateText({ model, prompt: 'hello', maxRetries: 0 })).rejects.toMatchObject({ code: 'source_denied' });
  expect(generate).toHaveBeenCalledTimes(ids.length);
});
