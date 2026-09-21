import { generateText, streamText, Output, jsonSchema, tool } from 'ai';
import { expect, test, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CodexRpc, subscriptionEnv, aiExecutable } from '../../desktop/core/src/ai/runtime';
import { codexModel, codexModels } from '../../desktop/core/src/ai/codex';
import { serve } from '../../desktop/core/src/node-server';
import { DatabaseSync } from 'node:sqlite';
import { createSystem } from '@lamarck/system/browser';
import { decodeAi } from '@lamarck/system/protocol';
import { SYSTEM_SCHEMA_V1 } from '../../desktop/core/src/db';
import { CredentialStore } from '../../desktop/core/src/credentials/credential-store';
import { SqliteEncryptedSecretStore } from '../../desktop/core/src/credentials/secret-store';
import { AiTurns } from '../../desktop/core/src/ai/turns';
import { GuardEngine } from '../../desktop/core/src/guard-service/engine';
import { ContentBlobStore } from '../../desktop/core/src/blob-store';
import { AiService, type AiAdapter } from '../../desktop/core/src/ai/service';
const native = process.env.LAMARCK_AI_NATIVE_SMOKE === '1';
test.runIf(native)('pinned subscription runtimes start with isolated, logged-out sources', async () => {
  const roots = await Promise.all([1, 2].map(() => mkdtemp(join(tmpdir(), 'ai-native-'))));
  try {
    for (const root of roots) {
      const rpc = new CodexRpc(root, process.env.LAMARCK_AI_CODEX_TEST_EXECUTABLE);
      try {
        await rpc.initialize(); const status = await rpc.request('account/read', { refreshToken: false });
        expect(status.account).toBeNull();
        const models = await rpc.request('model/list', { includeHidden: false }); expect(Array.isArray(models.data)).toBe(true);
        const supported = await codexModels(rpc);
        for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
          expect(models.data.some((model: any) => model.model === id)).toBe(true);
          expect(supported.some(model => model.model === id)).toBe(true);
        }
      } finally { await rpc.close(); }
      const status = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.env.LAMARCK_AI_CLAUDE_TEST_EXECUTABLE ?? aiExecutable('anthropic'), ['auth', 'status', '--json'], { cwd: root, env: subscriptionEnv(root), stdio: ['ignore', 'pipe', 'pipe'] });
        let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stderr.resume();
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Claude status timed out')); }, 15000);
        child.once('error', reject); child.once('exit', () => { clearTimeout(timer); resolve(text); });
      });
      expect(JSON.parse(status).loggedIn).toBe(false);
    }
  } finally { for (const root of roots) await rm(root, { recursive: true, force: true }); }
}, 45000);

test.runIf(native).each([
  ...['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex'].flatMap(id => [false, true].map(streaming => ({ id, codeMode: false, streaming, cancelled: false }))),
  ...['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].flatMap(id => [false, true].map(streaming => ({ id, codeMode: true, streaming, cancelled: false }))),
  ...[{ id: 'gpt-6-astra', codeMode: true }, { id: 'gpt-5.5', codeMode: false }].map(row => ({ ...row, streaming: true, cancelled: true })),
])('native Codex $id codeMode=$codeMode streaming=$streaming cancelled=$cancelled through Host', async ({ id, codeMode, streaming, cancelled }) => {
  const root = await mkdtemp(join(tmpdir(), 'ai-native-model-'));
  const requests: any[] = [], children: number[] = [];
  const controller = new AbortController();
  const probe = codeMode && !streaming;
  const denialProbe = !streaming;
  const source = `
    const forbidden = ['process', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Deno', 'Bun'];
    const exposed = forbidden.filter(name => typeof globalThis[name] !== 'undefined');
    let imports = false; try { await import('node:fs'); imports = true; } catch {}
    let undeclared = false; try { await tools.exec_command({cmd: 'echo boundary-violation'}); undeclared = true; } catch {}
    let agent = false; try { await tools.spawn_agent({message: 'boundary-violation'}); agent = true; } catch {}
    text({ boundary: { exposed, imports, undeclared, agent }, tools: ALL_TOOLS.map(tool => tool.name).sort() });
    text(await tools.lookup({value: 'native'}));
  `;
  const server = await serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body: any = await request.json(); requests.push(body);
    if (denialProbe && requests.length === 1) return codexResponse([
      ...['exec_command', 'shell_command', 'read_file', 'spawn_agent', 'browser', 'mcp__other__lookup'].map((name, index) => ({ type: 'function_call', id: `denied-${index}`, call_id: `denied-${index}`, name, arguments: '{"cmd":"printf boundary-violation","path":"fixture-canary","message":"boundary-violation"}', status: 'completed' })),
      { type: 'function_call', id: 'denied-agent', call_id: 'denied-agent', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"message":"boundary-violation"}', status: 'completed' },
      { type: 'function_call', id: 'denied-namespace', call_id: 'denied-namespace', name: 'lookup', namespace: 'foreign', arguments: '{"value":"wrong namespace"}', status: 'completed' },
    ]);
    const toolTurn = requests.length === (denialProbe ? 2 : 1);
    const output = toolTurn ? [codeMode
      ? { type: 'custom_tool_call', id: 'fc', call_id: 'native-call', name: 'exec', input: probe ? source : 'text(await tools.lookup({value: "native"}));', status: 'completed' }
      : { type: 'function_call', id: 'fc', call_id: 'native-call', name: 'lookup', arguments: '{"value":"native"}', status: 'completed' }]
      : [{ type: 'reasoning', id: 'reason', summary: [{ type: 'summary_text', text: 'fixture reasoning' }] }, { type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'output_text', text: streaming ? '{"answer":"contained"}' : 'contained', annotations: [] }], status: 'completed' }];
    return codexResponse(output);
  } });
  const rpc = new CodexRpc(root, process.env.LAMARCK_AI_CODEX_TEST_EXECUTABLE);
  const actualRequest = rpc.request.bind(rpc);
  rpc.request = (method, params: any) => {
    // Only legacy catalog availability is a fixture; refreshed profiles use
    // actual native discovery. All models use the unmodified native protocol.
    if (method === 'model/list' && !codeMode) return Promise.resolve({ data: [{ model: id, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null });
    return actualRequest(method, method === 'thread/start' ? {
      ...params, modelProvider: 'fixture', config: { ...params.config,
        'model_providers.fixture': { name: 'fixture', base_url: `http://127.0.0.1:${server.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false },
        'features.enable_request_compression': false,
      },
    } : params);
  };
  const host = await fixtureHost(root, {
    async describe(access) {
      const models = (await codexModels(rpc)).map(model => ({ id: `openai:${model.model}`, name: model.model, provider: 'openai', type: 'language' as const }));
      return { models, view: { ...access, status: 'ready', discovery: 'known', support: models.map(model => ({ model: model.id, streaming: true, structuredOutput: true, tools: true })) } };
    },
    async open(_access, _options, context) {
      return { provider: { specificationVersion: 'v4', languageModel: (model: string) => codexModel(model, rpc, context) } as any, dispose: () => rpc.close() };
    },
  });
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    await rpc.initialize();
    const access = await host.service.sources.save({ name: 'Fixture', provider: 'openai', kind: 'subscription' });
    const execute = vi.fn(async (_input: unknown) => {
      const process = (rpc as any).child;
      const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
      for (const line of result.stdout.split('\n')) { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); if (match && Number(match[2]) === process.pid && match[3].includes('codex-code-mode-host')) children.push(Number(match[1])); }
      if (cancelled) { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); }
      return 'app-result';
    });
    const generated = host.system.ai.withTools({ model: `openai:${id}`, accessSource: access.id, tools: { lookup: tool({ inputSchema: jsonSchema({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }), execute }) } }, async ({ model, tools }) => {
      const options = { model, tools, reasoning: 'minimal' as const, prompt: 'Use lookup then reply.', abortSignal: controller.signal, maxRetries: 0, ...(streaming ? { output: Output.object({ schema: jsonSchema<{ answer: string }>({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }) }) } : {}) };
      if (!streaming) return generateText(options);
      const result = streamText(options);
      const deltas: string[] = []; for await (const text of result.textStream) deltas.push(text);
      if (!cancelled) expect(deltas.length).toBeGreaterThan(1);
      return { text: await result.text, toolCalls: await result.toolCalls, reasoningText: await result.reasoningText, output: await result.output };
    });
    if (cancelled) await expect(generated).rejects.toThrow();
    else {
      const result = await generated;
      expect(result.text).toContain('contained');
      expect(result.reasoningText).toBe('fixture reasoning');
      expect(result.toolCalls).toHaveLength(1); expect(result.toolCalls[0]).toMatchObject({ toolName: 'lookup', providerExecuted: true });
      if (streaming) expect(result.output).toEqual({ answer: 'contained' });
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({ value: 'native' });
    expect(requests).toHaveLength(cancelled ? 1 : denialProbe ? 3 : 2);
    if (denialProbe) {
      const denied = requests[1].input.filter((item: any) => item.type === 'function_call_output' && item.call_id.startsWith('denied-'));
      expect(denied).toHaveLength(8);
      for (const item of denied) expect(JSON.stringify(item.output)).toMatch(/unsupported|unknown|unavailable|not found/i);
    }
    for (const request of requests) {
      expect(request.model).toBe(id); expect(request.reasoning.effort).toBe('low');
      if (streaming) expect(request.text.format.type).toBe('json_schema');
      if (!codeMode) { expect(request.tools.map((tool: any) => tool.name ?? tool.type)).toEqual(['lookup']); expect(request.input.some((item: any) => item.type === 'additional_tools')).toBe(false); }
    }
    if (probe) {
      const items = requests.at(-1).input.filter((item: any) => item.type === 'custom_tool_call_output').flatMap((item: any) => item.output);
      const report = JSON.parse(items.find((item: any) => item.text?.startsWith('{"boundary"')).text);
      expect(report.boundary).toEqual({ exposed: [], imports: false, undeclared: false, agent: false });
      expect(report.tools).toContain('lookup');
      expect(report.tools.every((name: string) => ['lookup', 'clock__curr_time'].includes(name))).toBe(true);
    }
    await host.close();
    if (codeMode) expect(children).toHaveLength(1);
    await vi.waitFor(() => { for (const pid of children) expect(() => process.kill(pid, 0)).toThrow(); });
    expect(host.service.invocations.size).toBe(0);
  } finally { clearTimeout(timer); await host.close(); await rpc.close(); await server.stop(); await rm(root, { recursive: true, force: true }); }
}, 30000);

function codexResponse(output: any[]): Response {
  const response = { id: 'response-test', object: 'response', created_at: 1, model: 'fixture', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const events: any[] = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }];
  for (const [index, item] of output.entries()) {
    events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, ...(item.type === 'message' ? { content: [] } : item.type === 'reasoning' ? { summary: [] } : {}), status: 'in_progress' } });
    if (item.type === 'message') {
      const text = item.content[0].text;
      events.push({ type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      for (const delta of [text.slice(0, 4), text.slice(4)]) events.push({ type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta });
      events.push({ type: 'response.output_text.done', item_id: item.id, output_index: index, content_index: 0, text });
    }
    if (item.type === 'reasoning') events.push({ type: 'response.reasoning_summary_text.delta', item_id: item.id, summary_index: 0, delta: item.summary[0].text });
    events.push({ type: 'response.output_item.done', output_index: index, item });
  }
  events.push({ type: 'response.completed', response });
  return new Response(events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function fixtureHost(root: string, adapter: AiAdapter) {
  const db = new DatabaseSync(':memory:'); db.exec(SYSTEM_SCHEMA_V1);
  const captureRoot = await mkdtemp(join(tmpdir(), 'ai-native-capture-'));
  const guard = new GuardEngine({ workspacePath: captureRoot });
  const principal = { source: 'app:fixture:ui', producerRef: `producer:v1:sha256:${'4'.repeat(64)}`, tableGrants: [] };
  const captureErrors: unknown[] = [];
  const service = new AiService(db, new CredentialStore(db), new SqliteEncryptedSecretStore(db, new Uint8Array(32).fill(1)), root, adapter, new AiTurns(captureRoot, () => ({ publishAiTurn: input => guard.publishAiTurn(principal, input) }), error => captureErrors.push(error)));
  const caller = { kind: 'app', appId: 'fixture', channelId: 'native-fixture', workload: 'ui', authorization: {} } as any;
  const system = createSystem(async (operation, input: any): Promise<any> => {
    if (operation === 'ai.capture') return service.turns!.request({ context: caller, signal: new AbortController().signal, release() {} }, input);
    if (operation === 'ai.listOptions') return service.options(caller);
    if (operation === 'ai.start') return service.start({ context: caller, signal: new AbortController().signal, release() {} }, input);
    if (operation === 'ai.next') return service.invocations.next(caller, input.invocationId, input.sequence);
    if (operation === 'ai.cancel') { service.invocations.cancel(caller, input.invocationId); return { ok: true }; }
    if (operation === 'ai.toolResult') {
      expect(() => service.invocations.reply({ ...caller, channelId: 'foreign-channel' }, input.invocationId, input.toolCallId, 'wrong-owner', false)).toThrow('unavailable');
      service.invocations.reply(caller, input.invocationId, input.toolCallId, decodeAi(input.value), input.failed); return { ok: true };
    }
    throw new Error('Unexpected operation');
  });
  let closed = false;
  return { service, system, async close() { if (!closed) { closed = true; await service.close(); db.close(); try { expect(captureErrors).toEqual([]); const events = guard.query(principal, 'SELECT payload FROM events WHERE type = ?', ['ai.turn']); expect(events.length).toBeGreaterThan(0); for (const event of events) expect(new ContentBlobStore(captureRoot).resolve(JSON.parse(event.payload as string).raw.contentRef).status).toBe('resolved'); } finally { guard.close(); await rm(captureRoot, { recursive: true, force: true }); } } } };
}

test.runIf(native).each([
  { id: 'default', streaming: false, cancelled: false, structured: false },
  { id: 'default', streaming: false, cancelled: false, structured: false, refused: true },
  { id: 'sonnet[1m]', streaming: true, cancelled: false, structured: false },
  ...['claude-fable-5-1', 'claude-opus-5[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'].flatMap(id => [false, true].map(streaming => ({ id, streaming, cancelled: false, structured: true }))),
  { id: 'claude-sonnet-5', streaming: true, cancelled: false, structured: false },
  { id: 'claude-haiku-4-5-20251001', streaming: false, cancelled: false, structured: false },
  { id: 'sonnet', streaming: false, cancelled: true, structured: false },
])('native Claude $id streaming=$streaming cancellation=$cancelled structured=$structured refusal=$refused contains MCP tools', async ({ id, streaming, cancelled, structured, refused }: { id: string; streaming: boolean; cancelled: boolean; structured: boolean; refused?: boolean }) => {
  const { AiSubscriptions } = await import('../../desktop/core/src/ai/subscriptions');
  const root = await mkdtemp(join(tmpdir(), 'ai-native-claude-'));
  const requests: any[] = [], calls: any[] = [];
  const server = await serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body: any = await request.json();
    if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 1 });
    requests.push(body);
    const used = body.messages?.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'));
    const content = refused ? { type: 'text', text: 'fixture refusal' } : used ? (structured ? { type: 'tool_use', id: 'structured-fixture', name: 'StructuredOutput', input: { answer: 'contained' } } : { type: 'text', text: 'contained' }) : { type: 'tool_use', id: 'tool-fixture', name: 'mcp__lamarck__lookup', input: { value: 'fixture' } };
    const message = { id: `msg-${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [content], stop_reason: refused ? 'refusal' : content.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!body.stream) return Response.json(message);
    const events = [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} } },
      { type: 'content_block_delta', index: 0, delta: content.type === 'text' ? { type: 'text_delta', text: 'contained' } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const subscriptions = new AiSubscriptions({} as any, root);
  const original = (subscriptions as any).claudeOptions.bind(subscriptions);
  // Explicitly configured deterministic test upstream, never ambient credentials.
  (subscriptions as any).claudeOptions = (directory: string, processes: Set<any>) => ({ ...original(directory, processes),
    // Fixture-only native picker availability; resolution and execution still
    // run in the pinned executable, without an account or inference discovery.
    settings: { modelPicker: { options: [{ model: 'claude-fable-5-1' }, { model: 'fable' }] } },
    spawnClaudeCodeProcess: (options: any) => {
      const child = spawn(process.env.LAMARCK_AI_CLAUDE_TEST_EXECUTABLE ?? options.command, options.args, { cwd: directory, env: { ...subscriptionEnv(directory), ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` }, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
      processes?.add(child); child.once('exit', () => processes?.delete(child));
      return child;
    },
  });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
  const auth = vi.spyOn(subscriptions as any, 'command').mockResolvedValue('{"loggedIn":true,"authMethod":"claude.ai"}');
  const host = await fixtureHost(root, {
    async describe(source) { const result = await subscriptions.describe(source); return { models: result.models, view: { ...source, ...result, discovery: 'known' } }; },
    open: (source, options, context) => subscriptions.open(source, options, context),
  });
  try {
    const access = await host.service.sources.save({ provider: 'anthropic', kind: 'subscription', name: 'Native fixture' });
    const description = await host.system.ai.listOptions();
    expect(description.accessSources[0].support.map(support => support.model)).toEqual(expect.arrayContaining(['anthropic:default', 'anthropic:claude-opus-5[1m]', 'anthropic:sonnet', 'anthropic:claude-sonnet-5', 'anthropic:haiku', 'anthropic:claude-haiku-4-5-20251001', 'anthropic:claude-fable-5-1']));
    expect(requests).toEqual([]);
    const options: any = { ...(structured ? { responseFormat: { type: 'json', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } } : {}), prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use lookup then reply.' }] }], tools: [{ type: 'function', name: 'lookup', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] };
    const generated = host.system.ai.withTools({ model: `anthropic:${id}`, accessSource: access.id, tools: { lookup: tool({ inputSchema: jsonSchema(options.tools[0].inputSchema), execute: async input => { calls.push(input); if (cancelled) { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); } return 'tool-answer'; } }) } }, async ({ model, tools }) => {
      const callOptions = { ...(structured ? { output: Output.object({ schema: jsonSchema<{ answer: string }>(options.responseFormat.schema) }) } : {}), reasoning: 'high' as const, model, tools, prompt: 'Use lookup then reply.', abortSignal: controller.signal, maxRetries: 0 };
      if (!streaming) return generateText(callOptions);
      const result = streamText(callOptions); return { text: await result.text, toolCalls: await result.toolCalls, output: structured ? await result.output : undefined };
    });
    if (cancelled || refused) await expect(generated).rejects.toThrow();
    else { const result = await generated; expect(result.text).toContain('contained'); if (structured) expect(result.output).toEqual({ answer: 'contained' }); else expect(result.toolCalls[0].toolName).toBe('lookup'); }
    expect(calls).toHaveLength(refused ? 0 : 1); if (!refused) expect(calls[0]).toEqual({ value: 'fixture' });
    const modelCalls = requests.filter(request => request.tools?.length);
    expect(modelCalls.length).toBeGreaterThan(0);
    for (const request of modelCalls) { expect(request.model).toBe(({ default: 'claude-opus-5', fable: 'claude-fable-5-1', sonnet: 'claude-sonnet-5', 'sonnet[1m]': 'claude-sonnet-5', 'claude-opus-5[1m]': 'claude-opus-5' } as Record<string, string>)[id] ?? id); expect(request.thinking?.type).toBe(id.includes('haiku') ? 'enabled' : 'adaptive'); expect(request.output_config?.effort).toBe(id.includes('haiku') ? undefined : 'high'); expect(request.tools.map((tool: any) => tool.name).sort()).toEqual(structured ? ['StructuredOutput', 'mcp__lamarck__lookup'] : ['mcp__lamarck__lookup']); }
    await host.close();
    const files = await readdir(root, { recursive: true, withFileTypes: true });
    for (const file of files.filter(file => file.isFile())) {
      const contents = await readFile(join(file.parentPath, file.name), 'utf8');
      expect(contents, `retained content in ${file.name}`).not.toContain('Use lookup then reply.');
      expect(contents).not.toContain('tool-answer');
    }
  } finally { clearTimeout(timer); await host.close(); auth.mockRestore(); subscriptions.close(); await subscriptions.settled(); await server.stop(); await rm(root, { recursive: true, force: true }); }
}, 30000);
