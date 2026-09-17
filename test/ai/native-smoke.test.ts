import { generateText, jsonSchema, tool } from 'ai';
import { expect, test } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CodexRpc, subscriptionEnv, aiExecutable } from '../../desktop/core/src/ai/runtime';
import { codexModel } from '../../desktop/core/src/ai/codex';
import { serve } from '../../desktop/core/src/node-server';
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

test.runIf(native).each([false, true])('native Codex contains tools and relays callbacks (tool call: %s)', async (useTool) => {
  const root = await mkdtemp(join(tmpdir(), 'ai-native-model-'));
  const requests: any[] = [], calls: any[] = [];
  const server = await serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json(); requests.push(body);
    const toolTurn = useTool && requests.length === 1;
    const output: any[] = toolTurn ? [{ type: 'function_call', id: 'fc', call_id: 'native-call', name: 'lookup', arguments: '{"value":"native"}', status: 'completed' }] : [{ type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'output_text', text: 'contained', annotations: [] }], status: 'completed' }];
    const response = { id: 'response-test', object: 'response', created_at: 1, model: 'fixture', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...output[0], ...(toolTurn ? {} : { content: [] }), status: 'in_progress' } },
      { type: 'response.content_part.added', item_id: 'msg', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg', output_index: 0, content_index: 0, delta: 'contained' },
      { type: 'response.output_text.done', item_id: 'msg', output_index: 0, content_index: 0, text: 'contained' },
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      { type: 'response.completed', response },
    ];
    return new Response(events.filter(event => !toolTurn || !['response.content_part.added', 'response.output_text.delta', 'response.output_text.done'].includes(event.type)).map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const rpc = new CodexRpc(root, process.env.LAMARCK_AI_CODEX_TEST_EXECUTABLE);
  const actualRequest = rpc.request.bind(rpc);
  rpc.request = (method, params: any) => actualRequest(method, method === 'thread/start' ? {
    ...params, modelProvider: 'fixture', config: { ...params.config,
      'model_providers.fixture': { name: 'fixture', base_url: `http://127.0.0.1:${server.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false },
      'features.enable_request_compression': false,
    },
  } : params);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
  try {
    await rpc.initialize();
    const model = codexModel('gpt-5.4', rpc, { id: 'smoke', caller: {} as any, signal: controller.signal, streamReady: async () => {}, part: async () => {}, tool: async (...args) => { calls.push(args); return 'ok'; } });
    const result = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [{ type: 'function', name: 'lookup', inputSchema: { type: 'object' } }] });
    expect(result.content).toContainEqual({ type: 'text', text: 'contained' });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.tools.map((tool: any) => tool.name ?? tool.type)).toEqual(['lookup']);
    expect(calls).toEqual(useTool ? [['lookup', { value: 'native' }, 'native-call']] : []);
  } finally { clearTimeout(timer); await rpc.close(); await server.stop(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test.runIf(native).each([false, true])('native Claude contains MCP tools and cleans up (cancel during callback: %s)', async cancelled => {
  const { AiSubscriptions } = await import('../../desktop/core/src/ai/subscriptions');
  const root = await mkdtemp(join(tmpdir(), 'ai-native-claude-'));
  const requests: any[] = [], calls: any[] = [];
  const server = await serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body: any = await request.json();
    if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 1 });
    requests.push(body);
    const used = body.messages?.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'));
    const content = used ? { type: 'text', text: 'contained' } : { type: 'tool_use', id: 'tool-fixture', name: 'mcp__lamarck__lookup', input: { value: 'fixture' } };
    const message = { id: `msg-${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [content], stop_reason: used ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!body.stream) return Response.json(message);
    const events = [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: used ? { type: 'text', text: '' } : { ...content, input: {} } },
      { type: 'content_block_delta', index: 0, delta: used ? { type: 'text_delta', text: 'contained' } : { type: 'input_json_delta', partial_json: '{"value":"fixture"}' } },
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
    spawnClaudeCodeProcess: (options: any) => {
      const child = spawn(process.env.LAMARCK_AI_CLAUDE_TEST_EXECUTABLE ?? options.command, options.args, { cwd: directory, env: { ...subscriptionEnv(directory), ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` }, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
      processes?.add(child); child.once('exit', () => processes?.delete(child));
      return child;
    },
  });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
  let handle: Awaited<ReturnType<AiSubscriptions['open']>> | undefined;
  try {
    const options: any = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use lookup then reply.' }] }], tools: [{ type: 'function', name: 'lookup', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] };
    handle = await subscriptions.open({ id: 'access-fixture', provider: 'anthropic', kind: 'subscription', name: 'fixture', allow: { mode: 'all' }, generation: 1, config: {} }, options, { id: 'native-claude', caller: {} as any, signal: controller.signal, streamReady: async () => {}, part: async () => {}, tool: async (...args) => { calls.push(args); if (cancelled) { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); } return 'tool-answer'; } });
    const generated = generateText({ model: handle.provider.languageModel('claude-sonnet-4-6'), prompt: 'Use lookup then reply.', tools: { lookup: tool({ inputSchema: jsonSchema(options.tools[0].inputSchema), execute: async () => { throw new Error('Provider-executed tool ran twice'); } }) }, abortSignal: controller.signal, maxRetries: 0 });
    if (cancelled) await expect(generated).rejects.toThrow();
    else { const result = await generated; expect(result.text).toContain('contained'); expect(result.toolCalls[0].toolName).toBe('lookup'); }
    expect(calls).toHaveLength(1); expect(calls[0].slice(0, 2)).toEqual(['lookup', { value: 'fixture' }]);
    const modelCalls = requests.filter(request => request.tools?.length);
    expect(modelCalls.length).toBeGreaterThan(0);
    for (const request of modelCalls) expect(request.tools.map((tool: any) => tool.name)).toEqual(['mcp__lamarck__lookup']);
    await handle.dispose(); handle = undefined;
    const files = await readdir(root, { recursive: true, withFileTypes: true });
    for (const file of files.filter(file => file.isFile())) {
      const contents = await readFile(join(file.parentPath, file.name), 'utf8');
      expect(contents, `retained content in ${file.name}`).not.toContain('Use lookup then reply.');
      expect(contents).not.toContain('tool-answer');
    }
  } finally { clearTimeout(timer); await handle?.dispose(); subscriptions.close(); await subscriptions.settled(); await server.stop(); await rm(root, { recursive: true, force: true }); }
}, 30000);
