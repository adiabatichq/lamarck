import { createAppProducerDescriptor, deriveProducerRef, ProducerDescriptorStore } from '../../desktop/core/src/producer-descriptor';
import { AiTurns } from '../../desktop/core/src/ai/turns';
import { GuardEngine } from '../../desktop/core/src/guard-service/engine';
import { ContentBlobStore } from '../../desktop/core/src/blob-store';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { redactString } from '../../desktop/core/src/ai/capture-redaction.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { generateText, streamText, embedMany, tool, stepCountIs, Output } from 'ai';
import { z } from 'zod';
import { APICallError } from '@ai-sdk/provider';
import { createSystem } from '@lamarck/system/browser';
import { decodeAi } from '@lamarck/system/protocol';
import { FramedRpcClient } from '../../desktop/system-sdk/dist/node-transport.js';
import { SystemBroker } from '../../desktop/shell/electron/capsule/system-broker';
import { SystemStreamServer } from '../../desktop/shell/electron/capsule/system-stream';
import { openWorkloadSdkBridge } from '../../desktop/capsule/src/oci/sdk-bridge';
import { AiService, type AiAdapter } from '../../desktop/core/src/ai/service';
import { handleAiRequest } from '../../desktop/core/src/ai/routes';
import { SYSTEM_SCHEMA_V1 } from '../../desktop/core/src/db';
import { CredentialStore } from '../../desktop/core/src/credentials/credential-store';
import { SqliteEncryptedSecretStore } from '../../desktop/core/src/credentials/secret-store';
import { serve, type NodeFetchServer } from '../../desktop/core/src/node-server';
import type { AppAuthContext } from '../../desktop/core/src/auth';

const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const finishReason = { unified: 'stop' as const, raw: 'stop' };
const cleanup: (() => unknown | Promise<unknown>)[] = [];
let service: AiService, broker: SystemBroker, db: DatabaseSync, root: string, server: NodeFetchServer;
let guard: GuardEngine;
const descriptor = (id = 'app-a') => createAppProducerDescriptor(id, '1'.repeat(40), { version: '0.1.0', commit: '2'.repeat(40), platform: 'darwin-arm64' });
const principal = (id = 'app-a') => ({ source: `app:${id}:ui`, producerRef: deriveProducerRef(descriptor(id)), tableGrants: [] });
function captured(id = 'app-a') { return guard.query(principal(id), 'SELECT * FROM events WHERE type = ? AND source = ? ORDER BY created_at, id', ['ai.turn', `app:${id}:ui`]).map((row: any) => ({ ...row, payload: JSON.parse(row.payload) })); }
function raw(event: any) { const value = new ContentBlobStore(root).resolve(event.payload.raw.contentRef); if (value.status !== 'resolved') throw new Error(JSON.stringify(value)); return JSON.parse(value.text); }
let outstanding = 0;
const disposed = vi.fn();
const callers = new Map<string, AppAuthContext>();
const signals = new Map<string, AbortController>();
const adapter: AiAdapter = {
  async describe(source) {
    return {
      models: [
        { id: `${source.provider}:${source.provider === 'anthropic' ? 'claude-sonnet-5' : 'fixture'}`, name: 'Fixture', provider: source.provider, type: 'language' },
        { id: `${source.provider}:embedding`, name: 'Embedding', provider: source.provider, type: 'embedding' },
        ...(source.provider === 'anthropic' ? [{ id: 'anthropic:claude-fable-5-1', name: 'Claude Fable 5.1', provider: 'anthropic', type: 'language' as const }] : []),
      ],
      view: { id: source.id, name: source.name, provider: source.provider, kind: source.kind, status: 'ready', discovery: 'known', support: [
        { model: `${source.provider}:${source.provider === 'anthropic' ? 'claude-sonnet-5' : 'fixture'}`, streaming: true, structuredOutput: true, tools: true },
        { model: `${source.provider}:embedding`, streaming: false, structuredOutput: false, tools: false, maxEmbeddingsPerCall: 2, supportsParallelCalls: true },
        ...(source.provider === 'anthropic' ? [{ model: 'anthropic:claude-fable-5-1', streaming: true, structuredOutput: true, tools: true }] : []),
      ] },
    };
  },
  async open(source, options, context) {
    const model = {
      specificationVersion: 'v4' as const, provider: source.provider, modelId: 'fixture', supportedUrls: {},
      async doGenerate(options: any) {
        if (JSON.stringify(options.prompt).includes('wait-for-abort')) await new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        if (options.tools?.length) {
          if (source.kind === 'subscription') {
            const output = await context.tool('lookup', { value: 'input' }, 'scoped-tool');
            return { content: [{ type: 'tool-call', toolName: 'lookup', toolCallId: 'scoped-tool', input: '{"value":"input"}', providerExecuted: true }, { type: 'tool-result', toolName: 'lookup', toolCallId: 'scoped-tool', result: output }, { type: 'text', text: String(output) }], usage, finishReason, warnings: [] } as any;
          }
          if (!options.prompt.some((m: any) => m.role === 'tool')) return { content: [{ type: 'tool-call', toolName: 'lookup', toolCallId: 'api-tool', input: '{"value":"input"}' }], usage, finishReason: { unified: 'tool-calls', raw: 'tool' }, warnings: [] } as any;
        }
        return { content: [{ type: 'text', text: options.responseFormat?.type === 'json' ? '{"answer":42}' : 'hello' }], usage, finishReason, warnings: [] } as any;
      },
      async doStream() {
        return { stream: new ReadableStream({ async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          await new Promise(resolve => setTimeout(resolve, 15));
          const text = options.tools?.length ? String(await context.tool('lookup', { value: 'input' }, 'stream-tool')) : 'hello';
          controller.enqueue({ type: 'text-start', id: 'text' });
          controller.enqueue({ type: 'text-delta', id: 'text', delta: text.slice(0, 3) });
          await new Promise(resolve => setTimeout(resolve, 15));
          controller.enqueue({ type: 'text-delta', id: 'text', delta: text.slice(3) });
          controller.enqueue({ type: 'text-end', id: 'text' });
          controller.enqueue({ type: 'finish', usage, finishReason }); controller.close();
        } }) } as any;
      },
    };
    return { provider: { specificationVersion: 'v4', languageModel: () => model, embeddingModel: () => ({ specificationVersion: 'v4', provider: source.provider, modelId: 'embedding', maxEmbeddingsPerCall: 2, supportsParallelCalls: true, doEmbed: async ({ values }) => ({ embeddings: values.map(v => [v.length]), usage: { tokens: values.length }, warnings: [] }) }), imageModel() { throw new Error('Unsupported'); } }, dispose: async () => { disposed(); } };
  },
};
beforeEach(async () => {
  disposed.mockClear(); callers.clear(); signals.clear(); outstanding = 0;
  root = await mkdtemp(join(tmpdir(), 'ai-path-'));
  db = new DatabaseSync(':memory:'); db.exec(SYSTEM_SCHEMA_V1);
  guard = new GuardEngine({ workspacePath: root });
  service = new AiService(db, new CredentialStore(db), new SqliteEncryptedSecretStore(db, new Uint8Array(32).fill(1)), root, adapter, new AiTurns(root, caller => ({ publishAiTurn: input => { new ProducerDescriptorStore(root).publish(descriptor(caller.appId)); return guard.publishAiTurn(principal(caller.appId), input); } })));
  server = await serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const token = request.headers.get('x-lamarck-app-capability')!;
    const caller = callers.get(token);
    if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });
    let released = false;
    outstanding++;
    const admission = { context: caller, signal: signals.get(token)!.signal, release() { if (!released) { released = true; outstanding--; } } };
    let retained = false;
    try {
      if (new URL(request.url).pathname === '/api/query') return Response.json({ rows: [{ appId: caller.appId }] });
      const result = await handleAiRequest(service, request, admission); retained = !!result.retained;
      return Response.json(result.body);
    } catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
    finally { if (!retained) admission.release(); }
  } });
  broker = new SystemBroker({ coreBaseUrl: async () => `http://127.0.0.1:${server.port}`, revokeCapability: async channelId => { for (const [token, caller] of callers) if (caller.channelId === channelId) signals.get(token)!.abort(); } });
});
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
  broker.unbindAll(); await service.close(); await broker.settledCaptures(); await server.stop();
  await vi.waitFor(() => expect(outstanding).toBe(0)); db.close(); guard.close(); await rm(root, { recursive: true, force: true });
});
function bind(id: string) {
  const caller = { kind: 'app', appId: id, workload: 'ui', channelId: `ch-${id}`, authorization: {} } as AppAuthContext;
  callers.set(id, caller); signals.set(id, new AbortController());
  broker.bindSender(id, { capability: id, channelId: caller.channelId });
}
async function systemFor(path: 'browser' | 'node', id = 'app-a') {
  bind(id);
  if (path === 'browser') {
    const compiled = buildSync({ entryPoints: ['desktop/shell/electron/app-preload.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'] }).outputFiles[0].text;
    let host: any;
    runInNewContext(compiled, { require: () => ({ contextBridge: { exposeInMainWorld: (_: string, value: unknown) => { host = value; } }, ipcRenderer: { invoke: (_: string, serialized: string) => broker.invokeSerialized(id, serialized) } }) });
    return createSystem(host.invoke);
  }
  const listener = createServer();
  listener.listen(join(root, `${id}.sock`)); await once(listener, 'listening');
  const accepted = once(listener, 'connection');
  const hostSide = createConnection(join(root, `${id}.sock`)); await once(hostSide, 'connect');
  const [guestSide] = await accepted as [Socket];
  listener.close();
  const streamServer = new SystemStreamServer(broker, { unbindOnClose: false });
  const detach = streamServer.attach(id, hostSide);
  const bridge = await openWorkloadSdkBridge({ bridgeRoot: join(root, id), socketPath: join(root, id, 'system.sock'), uid: process.getuid!(), gid: process.getgid!(), upstream: guestSide });
  const appSocket = createConnection(bridge.socketPath); await once(appSocket, 'connect');
  const client = new FramedRpcClient(appSocket);
  cleanup.push(async () => { client.close(); detach(); await bridge.close(); });
  return createSystem(client.invoke);
}
for (const path of ['browser', 'node'] as const) describe(`${path} Capsule channel`, () => {
  test('discovered subscription selection and App callbacks are independent of family names', async () => {
    const source = await service.sources.save({ provider: 'anthropic', kind: 'subscription', name: 'Fixture' });
    const system = await systemFor(path);
    const options = await system.ai.listOptions();
    expect(options.accessSources[0].support.map(support => support.model)).toContain('anthropic:claude-fable-5-1');
    const execute = vi.fn(async () => 'family-independent');
    const selection = { model: 'anthropic:claude-fable-5-1', accessSource: source.id };
    await system.ai.withTools({ ...selection, tools: { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) } }, async ({ model, tools }) => {
      expect((await generateText({ model, tools, prompt: 'hello' })).text).toBe('family-independent');
      expect(await streamText({ model, tools, prompt: 'hello' }).text).toBe('family-independent');
    });
    expect(execute).toHaveBeenCalledTimes(2);
    await expect(generateText({ model: system.ai.languageModel({ ...selection, model: 'anthropic:unknown' }), prompt: 'hello', maxRetries: 0 })).rejects.toThrow('does not support');
    expect(service.invocations.size).toBe(0);
  });
  test('discovery, text, incremental streaming, structured output, embedding batching', async () => {
    const source = await service.sources.save({ provider: 'openai', kind: 'api-key', name: 'Fixture', apiKey: 'private' });
    const system = await systemFor(path);
    const options = await system.ai.listOptions();
    expect(options.accessSources[0].id).toBe(source.id); expect(JSON.stringify(options)).not.toContain('private');
    const model = system.ai.languageModel({ model: 'openai:fixture', accessSource: source.id });
    const generated = await generateText({ model, prompt: 'hello' });
    expect(generated.text).toBe('hello');
    expect(generated.providerMetadata?.lamarck?.invocationId).toMatch(/^ai_/);
    const parts = []; for await (const text of streamText({ model, prompt: 'hello' }).textStream) parts.push(text);
    expect(parts).toEqual(['hel', 'lo']);
    expect((await generateText({ model, prompt: 'json', output: Output.object({ schema: z.object({ answer: z.number() }) }) })).output).toEqual({ answer: 42 });
    expect((await embedMany({ model: system.ai.embeddingModel({ model: 'openai:embedding', accessSource: source.id }), values: ['a', 'bb', 'ccc'] })).embeddings).toEqual([[1], [2], [3]]);
    await vi.waitFor(() => expect(outstanding).toBe(0));
  });
  test.each(['api-key', 'subscription'] as const)('%s tools execute once in originating App and can call System', async kind => {
    for (const provider of ['openai', 'anthropic']) {
      const source = await service.sources.save({ provider, kind, name: provider, ...(kind === 'api-key' ? { apiKey: 'secret' } : {}) });
      const id = `app-${provider}`;
      const system = await systemFor(path, id);
      const execute = vi.fn(async () => (await system.query('select identity')).rows[0] && id);
      const tools = { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) };
      const result = await system.ai.withTools({ model: `${provider}:${provider === 'anthropic' ? 'claude-sonnet-5' : 'fixture'}`, accessSource: source.id, tools }, async ({ model, tools }) => generateText({ model, tools, prompt: 'lookup', stopWhen: stepCountIs(2) }));
      expect(execute).toHaveBeenCalledTimes(1); expect(result.text).toBe(kind === 'subscription' ? id : 'hello');
      const events = captured(id); expect(events).toHaveLength(1);
      expect(events[0].payload.status).toBe('completed');
      expect(events[0].payload.content.text).toBe(result.text);
      expect(events[0].producer_ref).toBe(principal(id).producerRef);
      const records = raw(events[0]).records;
      expect(new ProducerDescriptorStore(root).resolve(events[0].producer_ref)).toEqual(descriptor(id));
      if (path === 'node' && kind === 'api-key' && process.env.LAMARCK_CAPTURE_EXAMPLE_DIR) {
        const { mkdir, writeFile, copyFile } = await import('node:fs/promises'); const directory = process.env.LAMARCK_CAPTURE_EXAMPLE_DIR;
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'event.json'), JSON.stringify(events[0], null, 2) + '\n');
        const resolvedRaw = new ContentBlobStore(root).resolve(events[0].payload.raw.contentRef);
        if (resolvedRaw.status !== 'resolved') throw new Error('Missing evidence raw content');
        await writeFile(join(directory, 'raw.json'), resolvedRaw.text);
        await writeFile(join(directory, 'producer.json'), JSON.stringify(descriptor(id), null, 2) + '\n');
        const digest = events[0].payload.raw.contentRef.digest.slice(7);
        await copyFile(join(root, '.lamarck', 'blobs', 'content', 'v1', 'sha256', digest.slice(0, 2), digest.slice(2, 4), `${digest}.gz`), join(directory, 'raw.json.gz'));
      }
      expect(records.filter((r: any) => r.kind === 'tool-end')).toHaveLength(1);
      expect(records.filter((r: any) => r.kind === 'model-start')).toHaveLength(kind === 'subscription' ? 1 : 2);
      expect(Object.keys(events[0].payload).sort()).toEqual(['callId', 'content', 'input', 'operation', 'raw', 'status', 'usage']);
    }
  });
  test('same discovery/invocation permission, policy withdrawal, cancellation and no fallback', async () => {
    const source = await service.sources.save({ provider: 'openai', kind: 'api-key', name: 'Only A', apiKey: 'a', allow: { mode: 'apps', appIds: ['app-a'] } });
    const system = await systemFor(path);
    const b = await systemFor(path, 'app-b');
    expect((await b.ai.listOptions()).accessSources).toEqual([]);
    await expect(generateText({ model: b.ai.languageModel({ model: 'openai:fixture', accessSource: source.id }), prompt: 'denied', maxRetries: 0 })).rejects.toThrow('unavailable');
    const call = generateText({ model: system.ai.languageModel({ model: 'openai:fixture', accessSource: source.id }), prompt: 'wait-for-abort', maxRetries: 0 });
    const rejected = expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(service.invocations.size).toBe(1));
    await service.sources.save({ provider: 'openai', kind: 'api-key', name: 'Only A', allow: { mode: 'apps', appIds: [] } }, source.id);
    await rejected; await vi.waitFor(() => expect(outstanding).toBe(0));
    expect((await system.ai.listOptions()).accessSources).toEqual([]);
    expect(service.invocations.size).toBe(0);
  });
  test('subscription stream callbacks continue over the channel and can call System', async () => {
    const source = await service.sources.save({ provider: 'openai', kind: 'subscription', name: 'Fixture' });
    const system = await systemFor(path);
    const execute = vi.fn(async () => (await system.query('select identity')).rows[0].appId);
    const tools = { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) };
    const text = await system.ai.withTools({ model: 'openai:fixture', accessSource: source.id, tools }, async ({ model, tools }) => streamText({ model, tools, prompt: 'lookup' }).text);
    expect(text).toBe('app-a');
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(outstanding).toBe(0));
  });
});
test('socket disconnect cancels calls while capability remains bound', async () => {
  const source = await service.sources.save({ provider: 'openai', kind: 'api-key', name: 'Source', apiKey: 'key' });
  const system = await systemFor('node');
  const call = generateText({ model: system.ai.languageModel({ model: 'openai:fixture', accessSource: source.id }), prompt: 'wait-for-abort', maxRetries: 0 });
  const rejected = expect(call).rejects.toThrow();
  await vi.waitFor(() => expect(service.invocations.size).toBe(1));
  await cleanup.pop()!(); await rejected;
  await vi.waitFor(() => expect(service.invocations.size).toBe(0));
  expect(broker.size).toBe(1);
});

test('stream startup retry retains both actual invocations in one completed event', async () => {
  const source = await service.sources.save({ provider: 'openai', kind: 'api-key', name: 'Fixture', apiKey: 'private' });
  const system = await systemFor('node');
  const original = adapter.open.bind(adapter);
  let attempts = 0;
  const spy = vi.spyOn(adapter, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    const model = handle.provider.languageModel('fixture');
    const stream = model.doStream.bind(model);
    model.doStream = async options => {
      if (++attempts === 1) throw new APICallError({ message: 'retry fixture', url: 'fixture:', requestBodyValues: {}, statusCode: 503, isRetryable: true });
      return stream(options);
    };
    return { ...handle, provider: { ...handle.provider, languageModel: () => model } };
  });
  try {
    expect(await streamText({ model: system.ai.languageModel({ model: 'openai:fixture', accessSource: source.id }), prompt: 'retry', maxRetries: 1 }).text).toBe('hello');
    await vi.waitFor(() => expect(captured()).toHaveLength(1));
    const events = captured(); expect(events).toHaveLength(1); expect(events[0].payload.status).toBe('completed');
    const records = raw(events[0]).records;
    expect(records.filter((r: any) => r.kind === 'model-start')).toHaveLength(2);
    expect(records.filter((r: any) => r.kind === 'model-end')).toHaveLength(2);
    expect(new Set(records.filter((r: any) => r.kind === 'model-start').map((r: any) => r.invocationId)).size).toBe(2);
  } finally { spy.mockRestore(); }
});

async function fixtureModel(path: 'browser' | 'node' = 'browser') {
  const source = await service.sources.save({ provider: 'openai', kind: 'api-key', name: 'Fixture', apiKey: 'private' });
  const system = await systemFor(path);
  return { system, source, model: system.ai.languageModel({ model: 'openai:fixture', accessSource: source.id }) };
}
function replaceModel(change: (model: any, context: any) => any) {
  const original = adapter.open.bind(adapter);
  return vi.spyOn(adapter, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    const model = change(handle.provider.languageModel('fixture'), args[2]);
    return { ...handle, provider: { ...handle.provider, languageModel: () => model } };
  });
}

test.each(['accept', 'reject'] as const)('persisted completed content precedes async validation %s without replay', async validation => {
  const { model } = await fixtureModel();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const validating = new Promise<void>(resolve => { entered = resolve; });
  const validator = vi.fn(async (_: unknown, context: z.RefinementCtx) => {
    entered(); await gate;
    if (validation === 'reject') context.addIssue({ code: 'custom', message: 'fixture rejected' });
  });
  let settled = false;
  const generation = generateText({ model, prompt: 'JSON', output: Output.object({ schema: z.object({ answer: z.number() }).superRefine(validator) }) }).then(value => ({ output: value.output }), error => ({ error: error.name })).finally(() => { settled = true; });
  try {
    await validating;
    const events = captured(); expect(events).toHaveLength(1); expect(settled).toBe(false);
    expect(events[0].payload.status).toBe('completed'); expect(events[0].payload.content.text).toBe('{"answer":42}');
    expect(raw(events[0]).records.at(-1).status).toBe('completed');
    const snapshot = JSON.stringify(events);
    release(); expect(await generation).toEqual(validation === 'accept' ? { output: { answer: 42 } } : { error: 'AI_NoObjectGeneratedError' });
    expect(validator).toHaveBeenCalledTimes(1); expect(JSON.stringify(captured())).toBe(snapshot);
  } finally { release(); }
});

test('concurrent calls and prepareStep model/source changes preserve actual attribution', async () => {
  const { model, system, source } = await fixtureModel('node');
  const other = await service.sources.save({ provider: 'anthropic', kind: 'api-key', name: 'Other', apiKey: 'private' });
  const next = system.ai.languageModel({ model: 'anthropic:claude-sonnet-5', accessSource: other.id });
  const execute = vi.fn(async () => 'tool output');
  await Promise.all([
    generateText({ model, prompt: 'multi', tools: { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) }, stopWhen: stepCountIs(2), prepareStep: ({ stepNumber }) => stepNumber ? { model: next } : undefined }),
    generateText({ model: next, prompt: 'concurrent' }),
  ]);
  const events = captured(); expect(events).toHaveLength(2); expect(execute).toHaveBeenCalledTimes(1);
  const multi = events.find((event: any) => event.payload.input.text.includes('multi'));
  const starts = raw(multi).records.filter((record: any) => record.kind === 'model-start');
  expect(starts.map((record: any) => [record.model, record.accessSource])).toEqual([['openai:fixture', source.id], ['anthropic:claude-sonnet-5', other.id]]);
  expect(new Set(events.map((event: any) => event.payload.callId)).size).toBe(2);
  expect(raw(events.find((event: any) => event !== multi)).records.filter((r: any) => r.kind === 'model-start')).toHaveLength(1);
});

test('handled App tool error is retained once and does not terminate generation', async () => {
  const { model } = await fixtureModel();
  const execute = vi.fn(async () => { throw new Error('fixture tool error'); });
  await generateText({ model, prompt: 'tools', tools: { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) }, stopWhen: stepCountIs(2) });
  expect(execute).toHaveBeenCalledTimes(1);
  const [event] = captured(); expect(event.payload.status).toBe('completed');
  const ends = raw(event).records.filter((r: any) => r.kind === 'tool-end');
  expect(ends).toHaveLength(1); expect(ends[0]).toMatchObject({ failed: true, output: { message: 'fixture tool error' } });
});

test('recording controls suppress content and disabled telemetry produces no event', async () => {
  const { model } = await fixtureModel();
  await generateText({ model, prompt: 'private input', telemetry: { recordInputs: false, recordOutputs: false } });
  const [event] = captured(); expect(event.payload.input).toBeUndefined(); expect(event.payload.content).toBeUndefined();
  expect(JSON.stringify(raw(event))).not.toContain('private input'); expect(JSON.stringify(raw(event))).not.toContain('hello');
  await generateText({ model, prompt: 'disabled', telemetry: { isEnabled: false } });
  await streamText({ model, prompt: 'disabled stream', telemetry: { isEnabled: false } }).consumeStream();
  expect(captured()).toHaveLength(1);
});

test('long UTF-8 content has truthful previews and resolvable redacted blobs', async () => {
  const { model } = await fixtureModel();
  const text = '語🙂 '.repeat(15000) + 'sk-' + 'x'.repeat(30);
  const spy = replaceModel(m => ({ ...m, doGenerate: async () => ({ content: [{ type: 'text', text }], usage, finishReason, warnings: [] }) }));
  try {
    await generateText({ model, prompt: '長🙂'.repeat(6000) });
    const [event] = captured();
    expect(event.payload.content.truncated).toBe(true); expect(Buffer.byteLength(event.payload.content.text)).toBeLessThanOrEqual(8192);
    expect(event.payload.content.text).not.toContain('\uFFFD');
    const content = new ContentBlobStore(root).resolve(event.payload.content.contentRef);
    expect(content.status).toBe('resolved'); if (content.status !== 'resolved') throw new Error('missing content');
    expect(content.text).toBe(text.replace(/sk-x+/, '[REDACTED_SECRET]'));
    expect(event.payload.content.bytes).toBe(Buffer.byteLength(content.text)); expect(event.payload.content.chars).toBe(content.text.length);
    expect(raw(event).records.filter((r: any) => r.kind === 'model-content').map((r: any) => r.content.text).join('')).toBe(content.text);
    if (process.env.LAMARCK_CAPTURE_EVIDENCE) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(process.env.LAMARCK_CAPTURE_EVIDENCE, JSON.stringify({ event, resolvedRaw: raw(event), resolvedContent: content.text }, null, 2));
    }
  } finally { spy.mockRestore(); }
});

test.each(['split footer', 'every marker character', 'multiple blocks and long surroundings'])('streamed private-key redaction: %s', async scenario => {
  const { model } = await fixtureModel();
  const key = '-----BEGIN PRIVATE KEY-----\nREVIEWFAKESECRETCONTENT\n-----END PRIVATE KEY-----\n';
  const second = '-----BEGIN RSA PRIVATE KEY-----\nSECONDFAKECONTENT\n-----END RSA PRIVATE KEY-----';
  const chunks = scenario === 'split footer' ? [key.slice(0, key.indexOf('END ') + 4), 'PRIVATE KEY-----\n']
    : scenario === 'every marker character' ? [...`before ${key}between ${second} after`]
    : ['語🙂 '.repeat(3000), key + 'between -----BEGIN RSA PRI', 'VATE KEY-----\nSECONDFAKECONTENT\n-----END RSA PRIVATE KEY--', '---', ' after -----BEGIN CERTIFICATE----- ordinary text'];
  const text = chunks.join(''); const expected = redactString(text);
  const handler = vi.fn(); vi.stubGlobal('reportError', handler);
  const spy = replaceModel(m => ({ ...m, doStream: async () => ({ stream: new ReadableStream({ start(stream) {
    stream.enqueue({ type: 'stream-start', warnings: [] }); stream.enqueue({ type: 'text-start', id: 't' });
    for (const delta of chunks) stream.enqueue({ type: 'text-delta', id: 't', delta });
    stream.enqueue({ type: 'text-end', id: 't' }); stream.enqueue({ type: 'finish', usage, finishReason }); stream.close();
  } }) }) }));
  try {
    const result = streamText({ model, prompt: 'synthetic redaction fixture' }); await result.consumeStream();
    expect(await result.text).toBe(text);
    await vi.waitFor(() => expect(captured()).toHaveLength(1));
    const [event] = captured(); expect(event.payload.status).toBe('completed');
    const readable = event.payload.content;
    const resolved = readable.contentRef ? new ContentBlobStore(root).resolve(readable.contentRef) : { status: 'resolved', text: readable.text };
    expect(resolved.status).toBe('resolved'); if (resolved.status !== 'resolved') throw new Error('Missing readable content');
    expect(resolved.text).toBe(expected); expect(expected.startsWith(readable.text)).toBe(true);
    expect(readable.chars).toBe(expected.length); expect(readable.bytes).toBe(Buffer.byteLength(expected));
    expect(readable.hash).toBe(`sha256:${createHash('sha256').update(expected).digest('hex')}`);
    const blob = new ContentBlobStore(root).resolve(event.payload.raw.contentRef);
    expect(blob.status).toBe('resolved'); if (blob.status !== 'resolved') throw new Error('Missing raw content');
    expect(event.payload.raw.bytes).toBe(Buffer.byteLength(blob.text));
    expect(event.payload.raw.hash).toBe(`sha256:${createHash('sha256').update(blob.text).digest('hex')}`);
    expect(blob.text).not.toContain('REVIEWFAKESECRETCONTENT'); expect(blob.text).not.toContain('SECONDFAKECONTENT');
    expect(JSON.parse(blob.text).records.filter((r: any) => r.kind === 'model-content' && r.content.type === 'text').map((r: any) => r.content.text).join('')).toBe(expected);
    expect(handler).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); vi.unstubAllGlobals(); }
});

test('malformed supplied usage reports capture error despite swallowed telemetry and publishes nothing', async () => {
  const { model } = await fixtureModel();
  const handler = vi.fn(); vi.stubGlobal('reportError', handler);
  const spy = replaceModel(m => ({ ...m, doGenerate: async () => ({ content: [{ type: 'text', text: 'answer' }], usage: { inputTokens: { total: 'bad' }, outputTokens: {} }, finishReason, warnings: [] }) }));
  try {
    await generateText({ model, prompt: 'malformed', maxRetries: 0 }).catch(() => {});
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    expect(captured()).toHaveLength(0); expect(handler.mock.calls[0][0].message).toContain('AI content capture failed');
  } finally { spy.mockRestore(); vi.unstubAllGlobals(); }
});

test('cancelled partial stream retains interrupted prefix and split secrets are redacted', async () => {
  const { model } = await fixtureModel();
  const controller = new AbortController();
  const spy = replaceModel((m, context) => ({ ...m, doStream: async () => ({ stream: new ReadableStream({ start(stream) {
    stream.enqueue({ type: 'stream-start', warnings: [] }); stream.enqueue({ type: 'text-start', id: 't' });
    stream.enqueue({ type: 'text-delta', id: 't', delta: 'prefix sk-xxxxxxxxxx' });
    stream.enqueue({ type: 'text-delta', id: 't', delta: 'xxxxxxxxxxxxxxxxxxxx ' });
    context.signal.addEventListener('abort', () => { try { stream.close(); } catch {} }, { once: true });
  } }) }) }));
  try {
    const stream = streamText({ model, prompt: 'cancel', abortSignal: controller.signal });
    try { for await (const text of stream.textStream) { if (text.includes('xxxxxxxxxxxxxxxxxxxx ')) controller.abort(); } } catch (error) { expect(controller.signal.aborted).toBe(true); }
    await vi.waitFor(() => expect(captured()).toHaveLength(1));
    const [event] = captured(); expect(event.payload.status).toBe('interrupted');
    expect(event.payload.content.text).toBe('prefix [REDACTED_SECRET] ');
    expect(JSON.stringify(raw(event))).not.toContain('sk-xxxx');
  } finally { spy.mockRestore(); }
});

test('terminal stream failure retains prefix and cannot be promoted by stream flush', async () => {
  const { model } = await fixtureModel();
  const spy = replaceModel(m => ({ ...m, doStream: async () => ({ stream: new ReadableStream({ start(stream) {
    stream.enqueue({ type: 'stream-start', warnings: [] }); stream.enqueue({ type: 'text-start', id: 't' });
    stream.enqueue({ type: 'text-delta', id: 't', delta: 'before failure ' });
    stream.enqueue({ type: 'error', error: new Error('terminal fixture failure') }); stream.close();
  } }) }) }));
  try {
    await streamText({ model, prompt: 'failure', maxRetries: 0, onError() {} }).consumeStream();
    await vi.waitFor(() => expect(captured()).toHaveLength(1));
    const [event] = captured(); expect(event.payload.status).toBe('failed'); expect(event.payload.content.text).toBe('before failure ');
    expect(raw(event).records.at(-1).status).toBe('failed');
  } finally { spy.mockRestore(); }
});

test('cancellation during an App tool records interrupted generation without replay', async () => {
  const { model } = await fixtureModel('node'); const controller = new AbortController();
  const execute = vi.fn(async (_: unknown, options: any) => { controller.abort(); options.abortSignal.throwIfAborted(); return 'unreachable'; });
  await generateText({ model, prompt: 'cancel tool', abortSignal: controller.signal, tools: { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) }, stopWhen: stepCountIs(2), maxRetries: 0 }).catch(() => {});
  await vi.waitFor(() => expect(captured()).toHaveLength(1));
  expect(execute).toHaveBeenCalledTimes(1); expect(captured()[0].payload.status).toBe('interrupted');
  expect(raw(captured()[0]).records.filter((r: any) => r.kind === 'tool-start')).toHaveLength(1);
});

test('failed persistence reaches App error handler while official generation still resolves', async () => {
  const { model } = await fixtureModel(); const handler = vi.fn(); vi.stubGlobal('reportError', handler);
  const persist = vi.spyOn(guard, 'publishAiTurn').mockRejectedValue(new Error('fixture storage unavailable'));
  try {
    expect((await generateText({ model, prompt: 'storage failure' })).text).toBe('hello');
    expect(handler).toHaveBeenCalled(); expect(captured()).toHaveLength(0);
    expect(handler.mock.calls[0][0].message).toContain('AI content capture failed');
  } finally { persist.mockRestore(); vi.unstubAllGlobals(); }
});

test('thrown stream transport failure retains observed output', async () => {
  const { model } = await fixtureModel();
  let reads = 0;
  const spy = replaceModel(m => ({ ...m, doStream: async () => ({ stream: new ReadableStream({ pull(stream) {
    const parts = [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'observed ' }];
    if (reads < parts.length) stream.enqueue(parts[reads++]); else throw new Error('reader failed');
  } }) }) }));
  try {
    await streamText({ model, prompt: 'reader failure', maxRetries: 0, onError() {} }).consumeStream({ onError() {} });
    await vi.waitFor(() => expect(captured()).toHaveLength(1));
    expect(captured()[0].payload.status).toBe('failed'); expect(captured()[0].payload.content.text).toBe('observed ');
  } finally { spy.mockRestore(); }
});

test.each(['browser', 'node'] as const)('SDK retry cancels an outstanding %s pull without closing the generation', async path => {
  const { model, source } = await fixtureModel(path); let attempts = 0;
  const handler = vi.fn(); vi.stubGlobal('reportError', handler);
  let firstInvocation: string | undefined;
  let sentError = false, pulling = false, cancelledWhilePulling = false;
  let pollEntered!: () => void, pollSettled!: () => void;
  const outstandingPoll = new Promise<void>(resolve => { pollEntered = resolve; });
  const settledPoll = new Promise<void>(resolve => { pollSettled = resolve; });
  const next = service.invocations.next.bind(service.invocations);
  const read = vi.spyOn(service.invocations, 'next').mockImplementation(async (...args) => {
    const held = args[1] === firstInvocation && sentError;
    if (held) { pulling = true; pollEntered(); }
    try {
      const result = await next(...args);
      if (args[1] === firstInvocation && result.events.some(event => event.type === 'part' && (decodeAi(event.value) as any).type === 'error')) sentError = true;
      return result;
    } finally { if (held) { pulling = false; pollSettled(); } }
  });
  const cancel = service.invocations.cancel.bind(service.invocations);
  const cancellation = vi.spyOn(service.invocations, 'cancel').mockImplementation((caller, id) => {
    if (id === firstInvocation) cancelledWhilePulling ||= pulling;
    return cancel(caller, id);
  });
  const spy = replaceModel((m, context) => ({ ...m, doStream: async (...args: any[]) => {
    if (++attempts > 1) return m.doStream(...args);
    firstInvocation = context.id;
    return { stream: new ReadableStream({ start(stream) {
      stream.enqueue({ type: 'stream-start', warnings: [] }); stream.enqueue({ type: 'text-start', id: 't' });
      stream.enqueue({ type: 'text-delta', id: 't', delta: 'retry prefix ' });
      stream.enqueue({ type: 'error', error: new Error('retryable streamed failure') });
      // Remain open: the next proxy pull must wait until SDK retry cancels it.
    } }) };
  } }));
  try {
    const result = streamText({ model, prompt: 'retry stream', streamRetries: 1, onError: async () => { await outstandingPoll; } });
    await result.consumeStream(); expect(await result.text).toBe('hello');
    await settledPoll; expect(cancelledWhilePulling).toBe(true); expect(attempts).toBe(2);
    await vi.waitFor(() => expect(captured()).toHaveLength(1));
    const [event] = captured(); expect(event.payload.status).toBe('completed'); expect(event.payload.content.text).toBe('hello');
    const records = raw(event).records;
    const starts = records.filter((r: any) => r.kind === 'model-start');
    expect(starts).toHaveLength(2); expect(new Set(starts.map((r: any) => r.invocationId)).size).toBe(2);
    for (const start of starts) expect(start).toMatchObject({ model: 'openai:fixture', accessSource: source.id, stepNumber: 0 });
    expect(records.filter((r: any) => r.kind === 'model-end')).toHaveLength(2);
    expect(records[0].callId).toBe(event.payload.callId); expect(event.external_id).toBe(`ai.turn:${event.payload.callId}`);
    expect(JSON.stringify(records)).toContain('retry prefix '); expect(records.filter((r: any) => r.kind === 'terminal')).toHaveLength(1);
    await vi.waitFor(() => expect(outstanding).toBe(0)); expect(service.invocations.size).toBe(0); expect(handler).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); read.mockRestore(); cancellation.mockRestore(); vi.unstubAllGlobals(); }
});

test('unverifiable cross-channel model correlation reports an error and publishes nothing', async () => {
  const { model, source } = await fixtureModel(); const other = await systemFor('browser', 'other');
  const handler = vi.fn(); vi.stubGlobal('reportError', handler);
  try {
    await generateText({ model, prompt: 'wrong channel', prepareStep: () => ({ model: other.ai.languageModel({ model: 'openai:fixture', accessSource: source.id }) }), maxRetries: 0 }).catch(() => {});
    expect(handler).toHaveBeenCalled(); expect(captured()).toHaveLength(0); expect(captured('other')).toHaveLength(0);
  } finally { vi.unstubAllGlobals(); }
});

test('ordinary App tool output is retained when the stop condition ends before another model call', async () => {
  const { model } = await fixtureModel(); const execute = vi.fn(async () => ({ answer: 'last tool output' }));
  await generateText({ model, prompt: 'one step', tools: { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) } });
  expect(execute).toHaveBeenCalledTimes(1);
  const [event] = captured(); expect(event.payload.status).toBe('completed'); expect(event.payload.content).toBeUndefined();
  const records = raw(event).records;
  expect(records.filter((r: any) => r.kind === 'model-start')).toHaveLength(1);
  expect(records.filter((r: any) => r.kind === 'tool-end')).toMatchObject([{ output: { answer: 'last tool output' } }]);
});
