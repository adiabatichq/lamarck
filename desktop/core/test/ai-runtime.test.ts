import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRpc, subscriptionEnv, aiExecutable } from '../src/ai/runtime';
import { AiSubscriptions } from '../src/ai/subscriptions';
import { codexModel, CODEX_CONTAINMENT } from '../src/ai/codex';
import { generateText, streamText } from 'ai';

describe('subscription process and Codex relay', () => {
  test('does not inherit API keys, Host authority, loaders, settings or paid fallback', () => {
    process.env.LAMARCK_AI_TEST_SECRET = 'secret';
    try {
      const env = subscriptionEnv('/private/source');
      expect(env.LAMARCK_AI_TEST_SECRET).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CODEX_HOME).toBe('/private/source'); expect(env.CLAUDE_CONFIG_DIR).toBe('/private/source');
      expect(CODEX_CONTAINMENT['features.shell_tool']).toBe(false);
      expect(CODEX_CONTAINMENT['features.multi_agent']).toBe(false);
      expect(CODEX_CONTAINMENT['agents.enabled']).toBe(false);
    } finally { delete process.env.LAMARCK_AI_TEST_SECRET; }
  });
  test('pending interactive login does not block source discovery', async () => {
    const subscriptions = new AiSubscriptions({} as any, '/unused-fixture');
    let reject!: (error: Error) => void;
    const opening = vi.spyOn(subscriptions as any, 'session').mockImplementation(() => new Promise((_, rejectSession) => { reject = rejectSession; }));
    const source = { id: 'source', provider: 'openai', kind: 'subscription', generation: 1, config: {}, allow: { mode: 'all' }, name: 'Fixture' } as const;
    await subscriptions.login(source);
    expect(await subscriptions.describe(source)).toEqual({ status: 'login-required', models: [], support: [] });
    expect(opening).toHaveBeenCalledTimes(1);
    subscriptions.close(); reject(new Error('Fixture closed')); await subscriptions.settled();
  });
  test('Claude keeps upstream discovery identities and revalidates selection when opening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-claude-discovery-'));
    const subscriptions = new AiSubscriptions({} as any, root);
    const source = { id: 'fixture', provider: 'anthropic', kind: 'subscription', generation: 1, config: {}, allow: { mode: 'all' }, name: 'Fixture' } as const;
    vi.spyOn(subscriptions as any, 'command').mockResolvedValue('{"loggedIn":true,"authMethod":"claude.ai"}');
    const discovery = vi.spyOn(subscriptions as any, 'claudeModels').mockResolvedValue([
      { value: 'default', resolvedModel: 'upstream-identity[1m]', displayName: 'Native default' },
      { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Native model' },
      { value: 'unfamiliar-family', displayName: 'Custom identity' },
    ]);
    try {
      const description = await subscriptions.describe(source);
      expect(description.support.map(row => row.model)).toEqual(['anthropic:default', 'anthropic:upstream-identity[1m]', 'anthropic:fable', 'anthropic:claude-fable-5-1', 'anthropic:unfamiliar-family']);
      // A stale concrete resolution or a guessed unmodified ID grants nothing.
      discovery.mockResolvedValue([{ value: 'default', resolvedModel: 'changed-upstream-identity', displayName: 'Native default' }, { value: 'unfamiliar-family', displayName: 'Custom identity' }]);
      const handle = await subscriptions.open(source, { prompt: [] }, { signal: new AbortController().signal } as any);
      try {
        for (const id of ['upstream-identity[1m]', 'upstream-identity', 'claude-fable-5-1', 'unknown']) expect(() => handle.provider.languageModel(id)).toThrow('unavailable');
        expect(handle.provider.languageModel('default').modelId).toBe('default');
        expect(handle.provider.languageModel('changed-upstream-identity').modelId).toBe('changed-upstream-identity');
        expect(handle.provider.languageModel('unfamiliar-family').modelId).toBe('unfamiliar-family');
      } finally { await handle.dispose(); }
      expect(discovery).toHaveBeenCalledTimes(2);
    } finally { subscriptions.close(); await subscriptions.settled(); await rm(root, { recursive: true, force: true }); }
  });
  test('Codex refuses native model substitution before starting inference', async () => {
    const rpc = { request: vi.fn(async (method: string) => method === 'model/list' ? { data: [{ model: 'selected', supportedReasoningEfforts: [] }] } : { thread: { id: 'thread' }, model: 'substitute' }) };
    await expect(codexModel('selected', rpc as any, { signal: new AbortController().signal } as any).doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] })).rejects.toThrow('did not retain');
    expect(rpc.request.mock.calls.map(([method]) => method)).toEqual(['model/list', 'thread/start']);
  });
  test.each([
    { id: 'gpt-5.4', reasoning: 'minimal', effort: 'low', warning: 'compatibility' },
    { id: 'gpt-5.4', reasoning: 'none', effort: undefined, warning: 'unsupported' },
    { id: 'gpt-5.4', reasoning: 'provider-default', effort: undefined, warning: undefined },
    { id: 'gpt-5.3-codex', reasoning: 'none', effort: 'none', warning: undefined },
    { id: 'fixture-high', reasoning: 'high', effort: 'high', warning: undefined },
    { id: 'fixture-limited', reasoning: 'xhigh', effort: undefined, warning: 'unsupported' },
  ] as const)('native process fixture selects $id with $reasoning reasoning and only App tools', async ({ id, reasoning, effort, warning }) => {
    const root = await mkdtemp(join(tmpdir(), 'ai-codex-fixture-'));
    const executable = join(root, 'codex');
    await writeFile(executable, `#!${process.execPath}
const {createInterface}=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='model/list') send({id:m.id,result:{data: ${JSON.stringify(['gpt-5.4', 'gpt-5.3-codex', 'fixture-high', 'fixture-limited'].map(model => ({ model, supportedReasoningEfforts: (model === 'gpt-5.4' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['none', 'low', 'medium', 'high']).map(reasoningEffort => ({ reasoningEffort })) })))},nextCursor:null}});
 if(m.method==='thread/start') {
   if(!m.params.ephemeral || m.params.environments.length || m.params.allowProviderModelFallback!==false || m.params.config['features.shell_tool']!==false) process.exit(2);
   send({id:m.id,result:{thread:{id:'thread'},model:m.params.model}});
 }
 if(m.method==='turn/start') { send({id:m.id,result:{turn:{id:'turn'}}}); send({id:99,method:'item/tool/call',params:{threadId:'thread',tool:'lookup',callId:'tool',arguments:{value:'yes'}}}); }
 if(m.id===99 && m.result) {
   send({method:'item/agentMessage/delta',params:{threadId:'thread',itemId:'text',delta:'hello'}});
   send({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});
 }
});
`, { mode: 0o755 });
    const rpc = new CodexRpc(root, executable);
    const requests = vi.spyOn(rpc, 'request');
    try {
      await rpc.initialize();
      const calls: unknown[] = [];
      const model = codexModel(id, rpc, { id: 'invocation', caller: {} as any, signal: new AbortController().signal, streamReady: async () => {}, part: async () => {}, tool: async (...args) => { calls.push(args); return 'result'; } });
      const result = await model.doGenerate({ reasoning, responseFormat: { type: 'json', schema: { type: 'object' } }, prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [{ type: 'function', name: 'lookup', inputSchema: { type: 'object' } }] });
      const thread = requests.mock.calls.find(([method]) => method === 'thread/start')![1] as any;
      const turn = requests.mock.calls.find(([method]) => method === 'turn/start')![1] as any;
      expect(thread.model).toBe(id); expect(turn.model).toBe(id); expect(turn.effort).toBe(effort); expect(turn.outputSchema).toEqual({ type: 'object' });
      expect(result.warnings).toEqual(warning ? [expect.objectContaining({ type: warning, feature: 'reasoning' })] : []);
      expect(result.content).toContainEqual({ type: 'text', text: 'hello' });
      expect(calls).toEqual([['lookup', { value: 'yes' }, 'tool']]);
      for (const params of [{ threadId: 'foreign', tool: 'lookup' }, { threadId: 'thread', tool: 'unknown' }, { threadId: 'thread', namespace: 'foreign', tool: 'lookup' }]) expect(await rpc.onRequest('item/tool/call', params)).toEqual({ decision: 'decline' });
      expect(await rpc.onRequest('item/tool/requestUserInput', {})).toEqual({ decision: 'decline' });
      expect(calls).toHaveLength(1);
      expect(result.content.find(part => part.type === 'tool-call')).toMatchObject({ providerExecuted: true });
      requests.mockClear();
      await expect(codexModel('catalog-only', rpc, {} as any).doGenerate({ prompt: [] })).rejects.toMatchObject({ code: 'unsupported' });
      expect(requests.mock.calls.some(([method]) => method === 'thread/start' || method === 'turn/start')).toBe(false);
    } finally { await rpc.close(); await rm(root, { recursive: true, force: true }); }
  });
});
