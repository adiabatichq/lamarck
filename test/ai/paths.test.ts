import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { generateText, streamText, embedMany, tool, stepCountIs, Output } from 'ai';
import { z } from 'zod';
import { createSystem } from '@lamarck/system/browser';
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
let outstanding = 0;
const disposed = vi.fn();
const callers = new Map<string, AppAuthContext>();
const signals = new Map<string, AbortController>();
const adapter: AiAdapter = {
  async describe(source) {
    return {
      models: [
        { id: `${source.provider}:fixture`, name: 'Fixture', provider: source.provider, type: 'language' },
        { id: `${source.provider}:embedding`, name: 'Embedding', provider: source.provider, type: 'embedding' },
      ],
      view: { id: source.id, name: source.name, provider: source.provider, kind: source.kind, status: 'ready', discovery: 'known', support: [
        { model: `${source.provider}:fixture`, streaming: true, structuredOutput: true, tools: true },
        { model: `${source.provider}:embedding`, streaming: false, structuredOutput: false, tools: false, maxEmbeddingsPerCall: 2, supportsParallelCalls: true },
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
  await vi.waitFor(() => expect(outstanding).toBe(0)); db.close(); await rm(root, { recursive: true, force: true });
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
      const result = await system.ai.withTools({ model: `${provider}:fixture`, accessSource: source.id, tools }, async ({ model, tools }) => generateText({ model, tools, prompt: 'lookup', stopWhen: stepCountIs(2) }));
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
