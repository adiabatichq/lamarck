import { describe, expect, test, vi } from 'vitest';
import { generateText, streamText, Output, jsonSchema, tool } from 'ai';
import { codexModel } from '../src/ai/codex';

const answer = { activities: [{ summary: 'Implement Timeline' }] };
const finalText = JSON.stringify(answer);
const schema = jsonSchema<typeof answer>({ type: 'object', properties: { activities: { type: 'array', items: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } } }, required: ['activities'], additionalProperties: false });
type Message = { id: string; phase: 'commentary' | 'final_answer' | null; text: string; startPhase?: 'commentary' | 'final_answer' | null; deltaText?: string };
const final: Message = { id: 'final', phase: 'final_answer', text: finalText };

function fixture(before: Message[], after: Message[]) {
  const lookup = vi.fn(async () => ({ value: answer, modelOutput: { type: 'json', value: answer } }));
  const outerExecute = vi.fn();
  const rpc = {
    onEvent: (_method: string, _params: any) => {},
    onRequest: async (_method: string, _params: any): Promise<any> => {},
    onClose() {}, close: vi.fn(async () => {}),
    async request(method: string): Promise<any> {
      if (method === 'model/list') return { data: [{ model: 'fixture', supportedReasoningEfforts: [] }] };
      if (method === 'thread/start') return { thread: { id: 'thread' }, model: 'fixture' };
      if (method !== 'turn/start') throw new Error(`Unexpected method ${method}`);
      const send = (method: string, params: any) => rpc.onEvent(method, { threadId: 'thread', ...params });
      const message = (item: Message) => {
        send('item/started', { item: { type: 'agentMessage', id: item.id, phase: item.startPhase === undefined ? item.phase : item.startPhase, text: '' } });
        const text = item.deltaText ?? item.text;
        for (const delta of [text.slice(0, 5), text.slice(5)]) send('item/agentMessage/delta', { itemId: item.id, delta });
        send('item/completed', { item: { type: 'agentMessage', id: item.id, phase: item.phase, text: item.text } });
      };
      queueMicrotask(() => { void (async () => {
        send('item/reasoning/summaryTextDelta', { itemId: 'reason', delta: 'Use lookup' });
        before.forEach(message);
        await rpc.onRequest('item/tool/call', { threadId: 'thread', tool: 'lookup', callId: 'lookup-call', arguments: {} });
        after.forEach(message);
        send('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1 } } });
        send('turn/completed', { turn: { status: 'completed' } });
      })(); });
      return { turn: { id: 'turn' } };
    },
  };
  const model = codexModel('fixture', rpc as any, { signal: new AbortController().signal, tool: lookup } as any);
  const tools = { lookup: tool({ inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }), execute: outerExecute }) };
  async function run(streaming: boolean, structured = true) {
    const options = { model, tools, prompt: 'Summarize activities using lookup.', maxRetries: 0, ...(structured ? { output: Output.object({ schema }) } : {}) };
    if (!streaming) return generateText(options);
    const result = streamText({ ...options, onError() {} });
    const complete = Promise.all([result.text, result.output, result.toolCalls, result.toolResults, result.reasoningText, result.usage]);
    void complete.catch(() => {});
    const deltas: string[] = [];
    for await (const text of result.textStream) deltas.push(text);
    const [text, output, toolCalls, toolResults, reasoningText, usage] = await complete;
    return { text, output, toolCalls, toolResults, reasoningText, usage, deltas };
  }
  return { run, lookup, outerExecute };
}

describe.each([false, true])('Codex structured output streaming=%s', streaming => {
  test('uses the final message after commentary and a native tool loop', async () => {
    const { run, lookup, outerExecute } = fixture([
      { id: 'empty', phase: 'commentary', text: '{"activities":[]}' },
      { id: 'progress', phase: 'commentary', text: 'Looking up activities now.' },
    ], [final]);
    const result = await run(streaming);
    expect(result.text).toBe(finalText);
    expect(result.output).toEqual(answer);
    expect(result.reasoningText).toBe('Use lookup');
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(result.toolCalls).toMatchObject([{ toolName: 'lookup', providerExecuted: true }]);
    expect(result.toolResults).toMatchObject([{ toolName: 'lookup', output: answer }]);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('lookup', {}, 'lookup-call');
    expect(outerExecute).not.toHaveBeenCalled();
    if ('deltas' in result) expect(result.deltas.join('')).toBe(finalText);
  });
  test('accepts an explicit final phase supplied at message completion', async () => {
    const { run } = fixture([], [{ ...final, startPhase: null }]);
    expect((await run(streaming)).output).toEqual(answer);
  });
  test.each([
    { name: 'unknown phase', messages: [{ ...final, phase: null }] },
    { name: 'commentary only', messages: [{ ...final, phase: 'commentary' }] },
    { name: 'missing final', messages: [] },
    { name: 'multiple finals', messages: [final, { ...final, id: 'second-final' }] },
    { name: 'changed final phase', messages: [{ ...final, phase: 'commentary', startPhase: 'final_answer' }] },
    { name: 'incomplete final deltas', messages: [{ ...final, deltaText: '{"activities":[]}' }] },
  ] satisfies { name: string; messages: Message[] }[])('rejects $name instead of guessing a JSON result', async ({ messages }) => {
    const { run } = fixture([], messages);
    await expect(run(streaming)).rejects.toMatchObject({ code: 'subscription_failed' });
  });
  test('lets Vercel reject invalid final JSON without extracting or repairing it', async () => {
    const invalid = `{"activities":[]}${finalText}`;
    const { run } = fixture([{ id: 'valid-commentary', phase: 'commentary', text: finalText }], [{ ...final, text: invalid }]);
    await expect(run(streaming)).rejects.toMatchObject({ name: 'AI_NoObjectGeneratedError', text: invalid });
  });
  test('preserves commentary in ordinary text generation', async () => {
    const { run } = fixture([{ id: 'progress', phase: 'commentary', text: 'Looking up activities. ' }], [final]);
    expect((await run(streaming, false)).text).toBe(`Looking up activities. ${finalText}`);
  });
});
