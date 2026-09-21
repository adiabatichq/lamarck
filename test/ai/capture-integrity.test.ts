import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir, appendFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GuardEngine } from '../../desktop/core/src/guard-service/engine';
import { AiTurns } from '../../desktop/core/src/ai/turns';
import { captureDirectory } from '../../desktop/core/src/guard-service/ai-turn';
import { ContentBlobStore } from '../../desktop/core/src/blob-store';
import { captureData } from '@lamarck/system/protocol';

let root: string, guard: GuardEngine;
const principal = { source: 'app:fixture:job:run', producerRef: `producer:v1:sha256:${'2'.repeat(64)}`, tableGrants: [] };
const caller = { kind: 'app', appId: 'fixture', channelId: 'job', workload: 'job:run', authorization: {} } as any;
const report = vi.fn();
const admission = () => ({ context: caller, signal: new AbortController().signal, release() {} });
const rows = () => guard.query(principal, 'SELECT * FROM events WHERE type = ?', ['ai.turn']);
beforeEach(async () => { report.mockClear(); root = await mkdtemp(join(tmpdir(), 'ai-integrity-')); guard = new GuardEngine({ workspacePath: root }); });
afterEach(async () => { guard.close(); await rm(root, { recursive: true, force: true }); });
async function staged(callId = 'fixed', text = 'answer') {
  const token = randomUUID(); const directory = captureDirectory(root, token);
  const { mkdir } = await import('node:fs/promises'); await mkdir(directory, { recursive: true });
  const records = [
    { kind: 'start', callId, operation: 'generateText', time: 100, recordInputs: true, recordOutputs: true, exclusions: ['reasoning', 'credentials', 'runtime-context', 'binary-content'] },
    { kind: 'step', stepNumber: 0 },
    { kind: 'model-start', stepNumber: 0, invocationId: 'actual', model: 'openai:fixture', accessSource: 'access_fixture' },
    { kind: 'model-content', stepNumber: 0, invocationId: 'actual', content: { type: 'text', text } },
    { kind: 'model-end', stepNumber: 0, invocationId: 'actual' },
    { kind: 'terminal', status: 'completed', time: 200 },
  ];
  await Promise.all([writeFile(join(directory, 'raw.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n'), writeFile(join(directory, 'input.txt'), ''), writeFile(join(directory, 'answer.txt'), text), writeFile(join(directory, 'output.txt'), text)]);
  return { token, callId, operation: 'generateText' as const, startedAt: 100, endedAt: 200, status: 'completed' as const, recordCount: records.length };
}
test('matching publication is idempotent, conflict rejects, and generic ai.turn is reserved', async () => {
  const input = await staged(); const id = await guard.publishAiTurn(principal, input);
  expect(await guard.publishAiTurn(principal, input)).toBe(id);
  await expect(guard.publishAiTurn(principal, await staged('fixed', 'different'))).rejects.toThrow('Conflicting');
  expect(rows()).toHaveLength(1);
  expect(() => guard.writeEvent(principal, { type: 'ai.turn', startedAt: 1, payload: {} })).toThrow('reserved');
  const payload = JSON.parse(rows()[0].payload as string); expect(payload.usage).toBeUndefined();
  const resolved = new ContentBlobStore(root).resolve(payload.raw.contentRef);
  expect(resolved.status).toBe('resolved');
  if (resolved.status === 'resolved') { expect(JSON.parse(resolved.text).records).toHaveLength(6); expect(payload.raw.bytes).toBe(Buffer.byteLength(resolved.text)); expect(payload.raw.hash).toBe(`sha256:${createHash('sha256').update(resolved.text).digest('hex')}`); }
});
test.each(['missing', 'malformed', 'lost', 'lost-step-invocation', 'projection', 'extra', 'usage', 'corrupt-blob'])('invalid %s data cannot become an event', async fault => {
  const input = await staged(); const dir = captureDirectory(root, input.token);
  if (fault === 'missing') await rm(join(dir, 'raw.jsonl'));
  if (fault === 'malformed') await writeFile(join(dir, 'raw.jsonl'), '{broken}\n');
  if (fault === 'lost') { const lines = (await readFile(join(dir, 'raw.jsonl'), 'utf8')).split('\n'); lines.splice(2, 1); await writeFile(join(dir, 'raw.jsonl'), lines.join('\n')); input.recordCount--; }
  if (fault === 'lost-step-invocation') { const lines = (await readFile(join(dir, 'raw.jsonl'), 'utf8')).split('\n'); lines.splice(-2, 0, JSON.stringify({ kind: 'step', stepNumber: 1 })); await writeFile(join(dir, 'raw.jsonl'), lines.join('\n')); input.recordCount++; }
  if (fault === 'projection') await writeFile(join(dir, 'answer.txt'), 'invented fallback');
  if (fault === 'extra') await appendFile(join(dir, 'raw.jsonl'), '{"kind":"step","stepNumber":1}\n');
  if (fault === 'usage') (input as any).usage = { totalTokens: 'unknown' };
  if (fault === 'corrupt-blob') {
    const { prepareAiTurn } = await import('../../desktop/core/src/guard-service/ai-turn');
    const event = await prepareAiTurn(root, input); const hash = (event.payload as any).raw.hash.slice(7);
    await writeFile(join(root, '.lamarck', 'blobs', 'content', 'v1', 'sha256', hash.slice(0, 2), hash.slice(2, 4), `${hash}.gz`), 'corrupt');
  }
  await expect(guard.publishAiTurn(principal, input)).rejects.toThrow(); expect(rows()).toHaveLength(0);
});
test.each(['correlation', 'content', 'serialization', 'redaction', 'persistence'])('capture %s failure is reported with no substitute event', async fault => {
  const turns = new AiTurns(root, () => ({ publishAiTurn: async input => {
    if (fault === 'persistence') throw new Error('fixture disk failure');
    return guard.publishAiTurn(principal, input);
  } }), report);
  await turns.request(admission(), { action: 'start', callId: 'failed', operation: 'generateText', time: 1, recordInputs: true, recordOutputs: true });
  await turns.request(admission(), { action: 'record', callId: 'failed', record: { kind: 'step', stepNumber: 0 } });
  const policy = await import('../../desktop/core/src/ai/capture-redaction.mjs');
  const redact = fault === 'redaction' ? vi.spyOn(policy, 'redactValue').mockImplementation(() => { throw new Error('fixture redaction failure'); }) : undefined;
  try {
    const call = await turns.invocation(caller, { model: 'openai:fixture', accessSource: 'access_fixture', callbacks: false, operation: 'generate', options: {}, capture: { callId: 'failed', stepNumber: fault === 'correlation' ? 9 : 0 } }, 'actual');
    await call!.content(fault === 'content' ? { type: 'text' } : fault === 'serialization' ? { type: 'tool-result', toolCallId: 't', toolName: 'x', result: new Map() } : { type: 'text', text: 'answer' });
    await call!.finish();
    await turns.request(admission(), { action: 'end', callId: 'failed', status: 'completed', time: 2 });
    throw new Error('expected capture failure');
  } catch (error) { expect(String(error)).not.toContain('expected capture failure'); }
  redact?.mockRestore();
  expect(report).toHaveBeenCalled(); expect(rows()).toHaveLength(0);
  await turns.request(admission(), { action: 'discard', callId: 'failed', message: 'failed capture' }); await turns.close();
  expect(await readdir(join(root, '.lamarck', 'ai-capture'))).toEqual([]);
});
test('terminal failure wins over later completion and interrupted prefix permits missing ends', async () => {
  const turns = new AiTurns(root, () => ({ publishAiTurn: input => guard.publishAiTurn(principal, input) }), report);
  await turns.request(admission(), { action: 'start', callId: 'partial', operation: 'streamText', time: 1, recordInputs: true, recordOutputs: true });
  await turns.request(admission(), { action: 'record', callId: 'partial', record: { kind: 'step', stepNumber: 0 } });
  const call = await turns.invocation(caller, { model: 'openai:fixture', accessSource: 'access_fixture', callbacks: false, operation: 'stream', options: {}, capture: { callId: 'partial', stepNumber: 0 } }, 'actual');
  await call!.content({ type: 'text-start', id: 'text' });
  await call!.content({ type: 'text-delta', id: 'text', delta: 'partial' });
  const terminal = { action: 'end' as const, callId: 'partial', status: 'failed' as const, time: 2 };
  expect(await turns.request(admission(), terminal)).toEqual(await turns.request(admission(), terminal));
  await expect(turns.request(admission(), { ...terminal, status: 'completed' })).rejects.toThrow('Conflicting');
  const payload = JSON.parse(rows()[0].payload as string); expect(payload.status).toBe('failed'); expect(payload.content.text).toBe('partial');
});
test.each(['text end', 'failed', 'interrupted', 'partial opening', 'second block', 'limit'])('unsafe unfinished private key on %s reports capture failure and publishes nothing', async boundary => {
  const turns = new AiTurns(root, () => ({ publishAiTurn: input => guard.publishAiTurn(principal, input) }), report);
  const callId = 'unsafe-key';
  await turns.request(admission(), { action: 'start', callId, operation: 'streamText', time: 1, recordInputs: true, recordOutputs: true });
  await turns.request(admission(), { action: 'record', callId, record: { kind: 'step', stepNumber: 0 } });
  const call = (await turns.invocation(caller, { model: 'openai:fixture', accessSource: 'access_fixture', callbacks: false, operation: 'stream', options: {}, capture: { callId, stepNumber: 0 } }, 'actual'))!;
  await call.content({ type: 'text-start', id: 't' });
  const complete = '-----BEGIN PRIVATE KEY-----\nSAFEFAKECONTENT\n-----END PRIVATE KEY-----\n';
  await call.content({ type: 'text-delta', id: 't', delta: 'ordinary text ' + (boundary === 'second block' ? complete : '') + (boundary === 'partial opening' ? '-----BEGIN RSA PRIVATE KEY--' : '-----BEGIN PRIVATE KEY-----\nUNFINISHEDFAKECONTENT\n-----END ') });
  try {
    if (boundary === 'limit') await expect(call.content({ type: 'text-delta', id: 't', delta: 'x'.repeat(1024 * 1024) })).rejects.toThrow('staging limit');
    else if (boundary === 'failed' || boundary === 'interrupted') await expect(turns.request(admission(), { action: 'end', callId, status: boundary, time: 2 })).rejects.toThrow('incomplete private-key');
    else await expect(call.content({ type: 'text-end', id: 't' })).rejects.toThrow('incomplete private-key');
    expect(report).toHaveBeenCalled(); expect(rows()).toHaveLength(0);
  } finally {
    await turns.request(admission(), { action: 'discard', callId, message: 'fixture capture failed' }); await turns.close();
  }
  expect(await readdir(join(root, '.lamarck', 'ai-capture'))).toEqual([]);
});

test('serializer rejects unsupported values, accessors, cycles and excessive collection before publication', () => {
  for (const value of [NaN, BigInt(1), new Map(), { get value() { throw new Error('accessor executed'); } }, 'x'.repeat(1024 * 1024)]) expect(() => captureData(value)).toThrow();
  const cycle: any = {}; cycle.self = cycle; expect(() => captureData(cycle)).toThrow('limit');
});

test('Core redaction stays identical to the established connector policy', async () => {
  expect(await readFile('desktop/core/src/ai/capture-redaction.mjs', 'utf8')).toBe(await readFile('connectors/code-agent-transcripts/redaction.mjs', 'utf8'));
});

test('32 MiB capture publishes incrementally with bounded working memory', async () => {
  const input = await staged('large', ''); const dir = captureDirectory(root, input.token);
  const records = (await readFile(join(dir, 'raw.jsonl'), 'utf8')).trim().split('\n');
  await writeFile(join(dir, 'raw.jsonl'), records.slice(0, 3).join('\n') + '\n');
  const text = 'bounded text '.repeat(5000);
  for (let n = 0; n < 520; n++) {
    await appendFile(join(dir, 'raw.jsonl'), JSON.stringify({ kind: 'model-content', stepNumber: 0, invocationId: 'actual', content: { type: 'text', text } }) + '\n');
    await appendFile(join(dir, 'answer.txt'), text);
  }
  await appendFile(join(dir, 'raw.jsonl'), records.slice(4).join('\n') + '\n'); input.recordCount = 525;
  const baseline = process.memoryUsage().heapUsed; let peak = baseline;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 2);
  try {
    await guard.publishAiTurn(principal, input);
    const payload = JSON.parse(rows()[0].payload as string);
    expect(payload.raw.bytes).toBeGreaterThan(32 * 1024 * 1024); expect(payload.content.bytes).toBe(text.length * 520);
    expect(peak - baseline).toBeLessThan(48 * 1024 * 1024);
    console.log(`AI_CAPTURE_MEMORY: selected=${payload.raw.bytes} bytes, sampled heap growth=${Math.max(0, peak - baseline)} bytes`);
  } finally { clearInterval(sample); }
}, 15000);

test('private Guard process awaits blob publication and returns the persisted identity', async () => {
  const { build } = await import('esbuild');
  const { GuardProcessExecutor } = await import('../../desktop/core/src/guard-service/executor');
  const entryPath = join(root, 'guard-worker.cjs');
  await build({ stdin: { contents: `import { runGuardExecutorWorker } from './desktop/core/src/guard-service/executor-worker'; runGuardExecutorWorker(process.argv[2]);`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: entryPath });
  const input = await staged('process');
  guard.close();
  const executor = new GuardProcessExecutor({ entryPath, workspacePath: root, hardExecutionLimitMs: 15_000 });
  try {
    await executor.start();
    const id = await executor.dispatch('publish', 'publishAiTurn', { principal, input }); expect(typeof id).toBe('string');
    expect(await executor.dispatch('duplicate', 'publishAiTurn', { principal, input })).toBe(id);
    const result = await executor.dispatch('query', 'query', { principal, sql: 'SELECT id, payload FROM events WHERE type = ?', params: ['ai.turn'] }) as any[];
    expect(result).toHaveLength(1); expect(result[0].id).toBe(id);
    expect(new ContentBlobStore(root).resolve(JSON.parse(result[0].payload).raw.contentRef).status).toBe('resolved');
  } finally { await executor.close(); guard = new GuardEngine({ workspacePath: root }); }
});
