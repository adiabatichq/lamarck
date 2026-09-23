import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { generateText, streamText, embedMany, tool, stepCountIs, Output } from 'ai';
import { z } from 'zod';
import { createSystem } from '@lamarck/system/browser';
import { decodeAi, SYSTEM_OPERATIONS } from '@lamarck/system/protocol';
import { APICallError } from '@ai-sdk/provider';
import { GuardEngine } from '../../desktop/core/src/guard-service/engine';
import { RemoteGuard, type GuardRpcClient } from '../../desktop/core/src/remote-guard';
import { ContentBlobStore } from '../../desktop/core/src/blob-store';
import { VfsService } from '../../desktop/core/src/vfs';
import { D1ObserverState } from '../../desktop/core/src/d1-observer-state';
import { D1Sequencer } from '../../desktop/core/src/d1-sequencer';
import { createAppProducerDescriptor, deriveProducerRef, ProducerDescriptorStore } from '../../desktop/core/src/producer-descriptor';
import { isAppSystemRoute } from '../../desktop/core/src/app-runtime-policy';
import { D0_SCHEMA_VERSION } from '../../desktop/core/src/schema';
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
let guard: GuardEngine, vfs: VfsService;
let expectedTurns: unknown[] = [], expectedBlobs: string[] = [];
const descriptor = (id = 'app-a') => createAppProducerDescriptor(id, '1'.repeat(40), { version: '0.1.0', commit: '2'.repeat(40), platform: 'darwin-arm64' });
const principal = (id = 'app-a') => ({ source: `app:${id}:ui`, producerRef: deriveProducerRef(descriptor(id)), tableGrants: ['answers'] });
const turnRows = () => guard.query(principal(), 'SELECT * FROM events WHERE type = ?', ['ai.turn']);
const blobFiles = () => readdir(join(root, '.lamarck', 'blobs'), { recursive: true }).then(paths => paths.sort()).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
function writer(id: string) {
  return new RemoteGuard({ call: async (method: string, params: Record<string, unknown>) => guard.dispatch(method, params) } as GuardRpcClient,
    { source: principal(id).source, producerRef: principal(id).producerRef, writeTables: ['answers'], schemaGrant: false, prepareProducer: () => { new ProducerDescriptorStore(root).publish(descriptor(id)); } });
}
let service: AiService, broker: SystemBroker, db: DatabaseSync, root: string, server: NodeFetchServer;
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
  guard = new GuardEngine({ workspacePath: root }); expectedTurns = []; expectedBlobs = [];
  vfs = new VfsService(root, new D1ObserverState(db), new ContentBlobStore(root), new D1Sequencer()); await vfs.initialize();
  service = new AiService(db, new CredentialStore(db), new SqliteEncryptedSecretStore(db, new Uint8Array(32).fill(1)), root, adapter);
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
      const path = new URL(request.url).pathname;
      if (path === '/api/events') return Response.json({ ok: true, id: await writer(caller.appId).writeEvent(await request.json()) });
      if (path === '/api/mutate') { const body = await request.json(); return Response.json(await writer(caller.appId).mutate(body.sql, body.params)); }
      if (path === '/api/content-ref/resolve') return Response.json(new ContentBlobStore(root).resolve((await request.json()).ref));
      if (path === '/api/vfs/command') { const body = await request.json(); return Response.json(await vfs.command({ guard: writer(caller.appId), fileGrants: ['answer.txt'], trustedHost: false, workloadId: caller.channelId }, body.command, body.options)); }
      const result = await handleAiRequest(service, request, admission); retained = !!result.retained;
      return Response.json(result.body);
    } catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
    finally { if (!retained) admission.release(); }
  } });
  broker = new SystemBroker({ coreBaseUrl: async () => `http://127.0.0.1:${server.port}`, revokeCapability: async channelId => { for (const [token, caller] of callers) if (caller.channelId === channelId) signals.get(token)!.abort(); } });
});
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
  broker.unbindAll(); await service.close(); await server.stop();
  await vi.waitFor(() => expect(outstanding).toBe(0)); await vfs.close();
  try {
    expect(turnRows()).toEqual(expectedTurns);
    expect(existsSync(join(root, '.lamarck', 'ai-capture'))).toBe(false);
    expect(await blobFiles()).toEqual(expectedBlobs);
  } finally { db.close(); guard.close(); await rm(root, { recursive: true, force: true }); }
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

test('stream startup failure follows the official retry policy', async () => {
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
    expect(attempts).toBe(2);
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

test.each(['accept', 'reject'] as const)('async output validation %s runs once without automatic recording', async validation => {
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
    expect(settled).toBe(false); expect(turnRows()).toEqual([]);
    release(); expect(await generation).toEqual(validation === 'accept' ? { output: { answer: 42 } } : { error: 'AI_NoObjectGeneratedError' });
    expect(validator).toHaveBeenCalledTimes(1);
  } finally { release(); }
});

test('concurrent calls and prepareStep model/source changes preserve actual attribution', async () => {
  const { model, system, source } = await fixtureModel('node');
  const other = await service.sources.save({ provider: 'anthropic', kind: 'api-key', name: 'Other', apiKey: 'private' });
  const next = system.ai.languageModel({ model: 'anthropic:claude-sonnet-5', accessSource: other.id });
  const execute = vi.fn(async () => 'tool output');
  const opened = vi.spyOn(adapter, 'open');
  try {
    await Promise.all([
      generateText({ model, prompt: 'multi', tools: { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) }, stopWhen: stepCountIs(2), prepareStep: ({ stepNumber }) => stepNumber ? { model: next } : undefined }),
      generateText({ model: next, prompt: 'concurrent' }),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls.map(([source]) => source.id).sort()).toEqual([source.id, other.id, other.id].sort());
  } finally { opened.mockRestore(); }
});

test('handled App tool error executes once and does not terminate generation', async () => {
  const { model } = await fixtureModel();
  const execute = vi.fn(async () => { throw new Error('fixture tool error'); });
  await generateText({ model, prompt: 'tools', tools: { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) }, stopWhen: stepCountIs(2) });
  expect(execute).toHaveBeenCalledTimes(1);
});

test('user cancellation delivers the observed prefix and releases the stream', async () => {
  const { model } = await fixtureModel();
  const controller = new AbortController();
  const spy = replaceModel((m, context) => ({ ...m, doStream: async () => ({ stream: new ReadableStream({ start(stream) {
    stream.enqueue({ type: 'stream-start', warnings: [] }); stream.enqueue({ type: 'text-start', id: 't' });
    stream.enqueue({ type: 'text-delta', id: 't', delta: 'partial ' });
    stream.enqueue({ type: 'text-delta', id: 't', delta: 'answer ' });
    context.signal.addEventListener('abort', () => { try { stream.close(); } catch {} }, { once: true });
  } }) }) }));
  try {
    const stream = streamText({ model, prompt: 'cancel', abortSignal: controller.signal });
    let observed = '';
    try { for await (const text of stream.textStream) { observed += text; if (text.includes('answer ')) controller.abort(); } } catch { expect(controller.signal.aborted).toBe(true); }
    expect(observed).toBe('partial answer '); expect(controller.signal.aborted).toBe(true);
  } finally { spy.mockRestore(); }
});

test('terminal stream error part delivers prefix and error to the App', async () => {
  const { model } = await fixtureModel();
  const spy = replaceModel(m => ({ ...m, doStream: async () => ({ stream: new ReadableStream({ start(stream) {
    stream.enqueue({ type: 'stream-start', warnings: [] }); stream.enqueue({ type: 'text-start', id: 't' });
    stream.enqueue({ type: 'text-delta', id: 't', delta: 'before failure ' });
    stream.enqueue({ type: 'error', error: new Error('terminal fixture failure') }); stream.close();
  } }) }) }));
  try {
    const onError = vi.fn();
    const result = streamText({ model, prompt: 'failure', maxRetries: 0, onError }); await result.consumeStream();
    expect(await result.text).toBe('before failure '); expect(onError).toHaveBeenCalledOnce();
  } finally { spy.mockRestore(); }
});

test('cancellation during an App tool does not replay the tool', async () => {
  const { model } = await fixtureModel('node'); const controller = new AbortController();
  const execute = vi.fn(async (_: unknown, options: any) => { controller.abort(); options.abortSignal.throwIfAborted(); return 'unreachable'; });
  await generateText({ model, prompt: 'cancel tool', abortSignal: controller.signal, tools: { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) }, stopWhen: stepCountIs(2), maxRetries: 0 }).catch(() => {});
  expect(execute).toHaveBeenCalledTimes(1); expect(controller.signal.aborted).toBe(true);
});

test('thrown stream read failure reaches the App', async () => {
  const { model } = await fixtureModel();
  let reads = 0;
  const spy = replaceModel(m => ({ ...m, doStream: async () => ({ stream: new ReadableStream({ pull(stream) {
    const parts = [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'observed ' }];
    if (reads < parts.length) stream.enqueue(parts[reads++]); else throw new Error('reader failed');
  } }) }) }));
  try {
    const onError = vi.fn();
    await streamText({ model, prompt: 'reader failure', maxRetries: 0, onError }).consumeStream({ onError });
    expect(onError).toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

test.each(['browser', 'node'] as const)('SDK retry cancels an outstanding %s pull without closing the generation', async path => {
  const { model } = await fixtureModel(path); let attempts = 0;
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
    await vi.waitFor(() => expect(outstanding).toBe(0)); expect(service.invocations.size).toBe(0); expect(handler).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); read.mockRestore(); cancellation.mockRestore(); vi.unstubAllGlobals(); }
});

test('ordinary App tool output is returned when the stop condition ends before another model call', async () => {
  const { model } = await fixtureModel(); const execute = vi.fn(async () => ({ answer: 'last tool output' }));
  const result = await generateText({ model, prompt: 'one step', tools: { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) } });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(result.steps[0].toolResults[0].output).toEqual({ answer: 'last tool output' });
});

for (const path of ['browser', 'node'] as const) test.each(['api-key', 'subscription'] as const)(`${path} %s tools preserve File/Table evidence and explicit App events`, async kind => {
  const source = await service.sources.save({ provider: 'openai', kind, name: 'Fixture', ...(kind === 'api-key' ? { apiKey: 'synthetic' } : {}) });
  const system = await systemFor(path);
  const host = { source: 'system:server', producerRef: principal().producerRef, tableGrants: '*' as const, schemaGrant: true };
  guard.schemaApply(host, guard.schemaPlan(host, 'CREATE TABLE answers (id TEXT NOT NULL PRIMARY KEY, answer TEXT)'), true);
  new ProducerDescriptorStore(root).publish(descriptor()); expectedBlobs = await blobFiles();
  const execute = vi.fn(async () => {
    const written = await system.vfs.command('tee answer.txt', { stdin: 'saved answer' });
    expect(written.exitCode, written.stderr).toBe(0);
    await system.mutate('INSERT INTO answers (id, answer) VALUES (?, ?)', ['one', 'saved answer']);
    await system.writeEvent({ type: 'fixture.answer.delivered', startedAt: 123, payload: { answer: 'saved answer' }, source: 'forged-source', producerRef: 'forged-producer' } as any);
    return 'saved answer';
  });
  const tools = { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute }) };
  await system.ai.withTools({ model: 'openai:fixture', accessSource: source.id, tools }, ({ model, tools }) => generateText({ model, tools, prompt: 'save answer', stopWhen: stepCountIs(2) }));
  expect(execute).toHaveBeenCalledOnce();
  expect(await readFile(join(root, 'files', 'answer.txt'), 'utf8')).toBe('saved answer');
  expect(guard.query(principal(), 'SELECT * FROM answers')).toEqual([{ id: 'one', answer: 'saved answer' }]);
  const events = guard.query(principal(), 'SELECT * FROM events WHERE source = ?', [principal().source]) as any[];
  expect(events.map(event => event.type).sort()).toEqual(['fixture.answer.delivered', 'workspace.files.changed', 'workspace.table.rows.inserted']);
  for (const event of events) expect(event.producer_ref).toBe(principal().producerRef);
  expect(new ProducerDescriptorStore(root).resolve(principal().producerRef)).toEqual(descriptor());
  expect(JSON.parse(events.find(event => event.type === 'fixture.answer.delivered').payload)).toEqual({ answer: 'saved answer' });
  await expect(system.writeEvent({ type: 'ai.turn', startedAt: 123, payload: {} })).rejects.toThrow('reserved');
});

test.each(['browser', 'node'] as const)('%s resolves historical turn content without modifying retained data', async path => {
  const { system, model } = await fixtureModel(path);
  const text = JSON.stringify({ version: 1, records: [{ kind: 'model-content', content: { type: 'text', text: 'historical answer' } }] });
  const blob = new ContentBlobStore(root).writeText({ text, mediaType: 'application/json' });
  // Seed pre-existing D0 bytes directly in this isolated fixture, never through
  // the reserved generic write API. No production backfill/compatibility path.
  const old = new DatabaseSync(guard.databasePath);
  try { old.prepare('INSERT INTO events (id, schema_version, source, producer_ref, type, external_id, started_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('historical', D0_SCHEMA_VERSION, principal().source, principal().producerRef, 'ai.turn', 'ai.turn:historical', 1, JSON.stringify({ callId: 'historical', raw: { contentRef: blob.ref } })); }
  finally { old.close(); }
  expectedTurns = turnRows(); expectedBlobs = await blobFiles();
  const before = await system.resolveContentRef(blob.ref);
  expect(before).toMatchObject({ status: 'resolved', text });
  expect((await generateText({ model, prompt: 'new request' })).text).toBe('hello');
  expect(await streamText({ model, prompt: 'new stream' }).text).toBe('hello');
  expect(await system.resolveContentRef(blob.ref)).toEqual(before); expect(turnRows()).toEqual(expectedTurns);
});

test('removed capture operation and route are unavailable', async () => {
  bind('app-a');
  expect(SYSTEM_OPERATIONS).not.toContain('ai.capture');
  expect(isAppSystemRoute('/api/ai/capture', 'POST')).toBe(false);
  await expect(broker.invoke('app-a', 'ai.capture' as any, {})).rejects.toThrow();
  const request = new Request('http://localhost/api/ai/capture', { method: 'POST', body: '{}' });
  await expect(handleAiRequest(service, request, { context: callers.get('app-a')!, signal: new AbortController().signal, release() {} })).rejects.toThrow();
});
