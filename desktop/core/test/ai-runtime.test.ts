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
  test('native process fixture streams and relays only declared invocation tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-codex-fixture-'));
    const executable = join(root, 'codex');
    await writeFile(executable, `#!${process.execPath}
const {createInterface}=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') {
   if(!m.params.ephemeral || m.params.environments.length || m.params.allowProviderModelFallback!==false || m.params.config['features.shell_tool']!==false) process.exit(2);
   send({id:m.id,result:{thread:{id:'thread'}}});
 }
 if(m.method==='turn/start') { send({id:m.id,result:{turn:{id:'turn'}}}); send({id:99,method:'item/tool/call',params:{threadId:'thread',tool:'lookup',callId:'tool',arguments:{value:'yes'}}}); }
 if(m.id===99 && m.result) {
   send({method:'item/agentMessage/delta',params:{threadId:'thread',itemId:'text',delta:'hello'}});
   send({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});
 }
});
`, { mode: 0o755 });
    const rpc = new CodexRpc(root, executable);
    try {
      await rpc.initialize();
      const calls: unknown[] = [];
      const model = codexModel('fixture', rpc, { id: 'invocation', caller: {} as any, signal: new AbortController().signal, streamReady: async () => {}, part: async () => {}, tool: async (...args) => { calls.push(args); return 'result'; } });
      const result = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [{ type: 'function', name: 'lookup', inputSchema: { type: 'object' } }] });
      expect(result.content).toContainEqual({ type: 'text', text: 'hello' });
      expect(calls).toEqual([['lookup', { value: 'yes' }, 'tool']]);
      expect(result.content.find(part => part.type === 'tool-call')).toMatchObject({ providerExecuted: true });
    } finally { await rpc.close(); await rm(root, { recursive: true, force: true }); }
  });
});
