import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, link, rm, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { captureBlock, captureMessage, type ContentBlobRef, type JsonValue } from '@lamarck/system/protocol';
import { assertJsonValue } from '../json';
import type { GuardEventInput, AiTurnPublication } from './protocol';

export const CAPTURE_RECORD_BYTES = 8 * 1024 * 1024;
export function captureDirectory(workspace: string, token: string): string {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid AI capture staging identity');
  return join(workspace, '.lamarck', 'ai-capture', token);
}
export function validateUsage(value: unknown): asserts value is JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid AI usage');
  const groups: Record<string, string[]> = {
    inputTokenDetails: ['noCacheTokens', 'cacheReadTokens', 'cacheWriteTokens'],
    outputTokenDetails: ['textTokens', 'reasoningTokens'],
    inputTokens: ['total', 'noCache', 'cacheRead', 'cacheWrite'],
    outputTokens: ['total', 'text', 'reasoning'],
  };
  const count = (item: unknown) => { if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) throw new Error('Malformed supplied AI usage value'); };
  for (const [key, item] of Object.entries(value)) {
    if (groups[key] && item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [field, number] of Object.entries(item)) { if (!groups[key].includes(field)) throw new Error('Unknown AI usage field'); count(number); }
    } else {
      if (!['inputTokens', 'outputTokens', 'totalTokens'].includes(key)) throw new Error('Malformed supplied AI usage value');
      count(item);
    }
  }
}
export function validateRecord(value: unknown): asserts value is Record<string, JsonValue> {
  assertJsonValue(value, 'AI capture record');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid AI capture record');
  const record = value as Record<string, JsonValue>;
  if (!['start', 'input', 'step', 'model-start', 'model-input', 'model-content', 'model-end', 'tool-start', 'tool-end', 'terminal'].includes(record.kind as string)) throw new Error('Unknown AI capture record kind');
  const kind = record.kind as string;
  const fields: Record<string, string[]> = {
    start: ['callId', 'operation', 'time', 'recordInputs', 'recordOutputs', 'exclusions'], input: ['message'], step: ['stepNumber'],
    'model-start': ['invocationId', 'stepNumber', 'model', 'accessSource'],
    'model-input': ['invocationId', 'stepNumber', 'message'], 'model-content': ['invocationId', 'stepNumber', 'content'],
    'model-end': ['invocationId', 'stepNumber', 'usage', 'finishReason', 'responseModelId', 'error'],
    'tool-start': ['invocationId', 'stepNumber', 'toolName', 'toolCallId', 'input'],
    'tool-end': ['invocationId', 'stepNumber', 'toolName', 'toolCallId', 'failed', 'output'],
    terminal: ['status', 'time', 'usage'],
  };
  for (const field of Object.keys(record)) if (field !== 'kind' && !fields[kind].includes(field)) throw new Error('Unexpected AI record field');
  const nonempty = (field: string) => { if (typeof record[field] !== 'string' || !record[field] || (record[field] as string).length > 256) throw new Error(`Invalid AI record ${field}`); };
  if (['step', 'model-start', 'model-input', 'model-content', 'model-end', 'tool-start', 'tool-end'].includes(kind) && (!Number.isSafeInteger(record.stepNumber) || (record.stepNumber as number) < 0)) throw new Error('Invalid capture step number');
  if (kind.startsWith('model-') || record.invocationId !== undefined) nonempty('invocationId');
  if (kind === 'model-start') { nonempty('model'); nonempty('accessSource'); }
  if (kind.startsWith('tool-')) { nonempty('toolCallId'); nonempty('toolName'); }
  if (kind === 'tool-end' && typeof record.failed !== 'boolean') throw new Error('Tool outcome required');
  if (kind === 'input' || kind === 'model-input') captureMessage(record.message);
  if (kind === 'model-content' && captureBlock(record.content) === undefined) throw new Error('Excluded content in selected AI records');
  if (kind === 'start' || kind === 'terminal') {
    if (!Number.isSafeInteger(record.time) || (record.time as number) < 0) throw new Error('Invalid AI observation timestamp');
    if (kind === 'start') {
      nonempty('callId');
      if (!['generateText', 'streamText'].includes(record.operation as string) || typeof record.recordInputs !== 'boolean' || typeof record.recordOutputs !== 'boolean' || JSON.stringify(record.exclusions) !== JSON.stringify(['reasoning', 'credentials', 'runtime-context', 'binary-content'])) throw new Error('Invalid AI capture policy');
    } else if (!['completed', 'failed', 'interrupted'].includes(record.status as string)) throw new Error('Invalid AI terminal status');
  }
  if (record.responseModelId !== undefined) nonempty('responseModelId');
  if (record.finishReason !== undefined && !(typeof record.finishReason === 'string' || (record.finishReason && typeof record.finishReason === 'object' && !Array.isArray(record.finishReason) && typeof record.finishReason.unified === 'string' && (record.finishReason.raw === undefined || typeof record.finishReason.raw === 'string')))) throw new Error('Malformed AI finish reason');
  if (record.usage !== undefined) validateUsage(record.usage);
}
async function* lines(path: string) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(10); if (end < 0) break;
      if (end > CAPTURE_RECORD_BYTES) throw new Error('Oversized staged AI record');
      yield new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, end));
      pending = pending.subarray(end + 1);
    }
    if (pending.length > CAPTURE_RECORD_BYTES) throw new Error('Oversized staged AI record');
  }
  if (pending.length) throw new Error('Incomplete staged AI record');
}
async function verifyBlob(path: string, expected: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), createGunzip(), new Transform({ transform(chunk, _, done) { hash.update(chunk); done(); } }));
  if (`sha256:${hash.digest('hex')}` !== expected) throw new Error('AI content blob digest mismatch');
}
async function syncDirectory(path: string) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
async function writeBlob(workspace: string, chunks: AsyncIterable<Uint8Array | string>, mediaType: ContentBlobRef['mediaType']) {
  const temporaryRoot = join(workspace, '.lamarck', 'ai-capture');
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const temporary = join(temporaryRoot, `${randomUUID()}.gz`);
  const hash = createHash('sha256'); let bytes = 0;
  try {
    await pipeline(Readable.from(chunks), new Transform({ transform(chunk, _, done) { bytes += chunk.length; hash.update(chunk); done(null, chunk); } }), createGzip(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const file = await open(temporary, 'r'); try { await file.sync(); } finally { await file.close(); }
    const hex = hash.digest('hex'); const digest = `sha256:${hex}`;
    const directory = join(workspace, '.lamarck', 'blobs', 'content', 'v1', 'sha256', hex.slice(0, 2), hex.slice(2, 4));
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${hex}.gz`);
    try { await link(temporary, destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    for (let parent = directory; parent !== dirname(workspace); parent = dirname(parent)) { await syncDirectory(parent); if (parent === workspace) break; }
    await verifyBlob(destination, digest);
    return { bytes, hash: digest, contentRef: { kind: 'content-blob', version: 1, digest, mediaType, encoding: 'gzip' } as ContentBlobRef };
  } finally { await rm(temporary, { force: true }); }
}
async function readable(workspace: string, path: string) {
  const hash = createHash('sha256'); const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, chars = 0, previewBytes = 0, text = '';
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length; hash.update(chunk);
    const decoded = decoder.decode(chunk, { stream: true }); chars += decoded.length;
    if (previewBytes < 8192) for (const character of decoded) {
      const size = Buffer.byteLength(character); if (previewBytes + size > 8192) { previewBytes = 8192; break; }
      text += character; previewBytes += size;
    }
  }
  chars += decoder.decode().length;
  if (!bytes) return undefined;
  const digest = `sha256:${hash.digest('hex')}`;
  const blob = bytes > 8192 ? await writeBlob(workspace, createReadStream(path), 'text/plain; charset=utf-8') : undefined;
  if (blob && (blob.bytes !== bytes || blob.hash !== digest)) throw new Error('AI text changed during publication');
  return { text, chars, bytes, hash: digest, truncated: bytes > 8192, ...(blob ? { contentRef: blob.contentRef } : {}) };
}
/** Guard alone publishes the required CAS objects and constructs the D0 payload. */
export async function prepareAiTurn(workspace: string, input: AiTurnPublication): Promise<GuardEventInput> {
  if (!input || typeof input.callId !== 'string' || !input.callId || input.callId.length > 256 || !['generateText', 'streamText'].includes(input.operation) || !['completed', 'failed', 'interrupted'].includes(input.status)) throw new Error('Invalid AI turn boundary');
  if (!Number.isSafeInteger(input.startedAt) || !Number.isSafeInteger(input.endedAt) || input.startedAt < 0 || input.endedAt < input.startedAt || !Number.isSafeInteger(input.recordCount) || input.recordCount < 2) throw new Error('Invalid AI capture times/count');
  if (input.usage !== undefined) validateUsage(input.usage);
  const directory = captureDirectory(workspace, input.token);
  if (!(await lstat(directory)).isDirectory()) throw new Error('Missing AI capture staging');
  for (const name of ['raw.jsonl', 'input.txt', 'answer.txt', 'output.txt']) if (!(await lstat(join(directory, name))).isFile()) throw new Error('Invalid AI staging file');
  let inputHash = createHash('sha256'), answerHash = createHash('sha256'), outputHash = createHash('sha256');
  let inputBytes = 0, answerBytes = 0, outputBytes = 0;
  let modelCount = 0, stepModelCount = 0, step = -1, policy: Record<string, JsonValue> | undefined;
  const invocations = new Set<string>(), tools = new Map<string, { invocationId: string | undefined; name: string }>();
  let count = 0; let terminal: Record<string, JsonValue> | undefined;
  const raw = await writeBlob(workspace, (async function* () {
    yield '{"version":1,"records":[';
    for await (const line of lines(join(directory, 'raw.jsonl'))) {
      const record: unknown = JSON.parse(line); validateRecord(record);
      if (terminal) throw new Error('Record after AI terminal boundary');
      if (!count && (record.kind !== 'start' || record.callId !== input.callId || record.time !== input.startedAt || record.operation !== input.operation)) throw new Error('Missing/mismatched AI start observation');
      if (!count) policy = record;
      else if (record.kind === 'start') throw new Error('Duplicate AI start observation');
      if (record.kind === 'step') { if (record.stepNumber !== step + 1 || (step >= 0 && !stepModelCount)) throw new Error('Lost AI step/model observation'); step++; stepModelCount = 0; }
      if (record.stepNumber !== undefined && record.stepNumber !== step) throw new Error('Uncorrelated staged AI step');
      const id = record.invocationId as string;
      if (record.kind === 'model-start') {
        if (invocations.has(id) || invocations.size >= 8) throw new Error('Invalid staged model start');
        invocations.add(id); modelCount++; stepModelCount++; answerHash = createHash('sha256'); answerBytes = 0;
      } else if (id && !invocations.has(id) && !(record.kind === 'tool-end' && tools.get(record.toolCallId as string)?.invocationId === id)) throw new Error('Lost model start observation');
      if (record.kind === 'model-end') invocations.delete(id);
      if (record.kind === 'tool-start') { if (tools.has(record.toolCallId as string) || tools.size >= 32) throw new Error('Invalid staged tool start'); tools.set(record.toolCallId as string, { invocationId: id, name: record.toolName as string }); }
      if (record.kind === 'tool-end') { const tool = tools.get(record.toolCallId as string); if (!tool || tool.invocationId !== id || tool.name !== record.toolName) throw new Error('Lost tool start observation'); tools.delete(record.toolCallId as string); }
      if (['input', 'model-input'].includes(record.kind as string) && policy?.recordInputs !== true) throw new Error('Excluded input was retained');
      if ((record.kind === 'tool-start' && (policy?.recordInputs === true) !== (record.input !== undefined)) || (record.kind === 'tool-end' && (policy?.recordOutputs === true) !== (record.output !== undefined))) throw new Error('Invalid staged tool recording selection');
      if (record.kind === 'model-content' && policy?.recordOutputs !== true) throw new Error('Excluded output was retained');
      if (record.kind === 'input') {
        const message = record.message as any;
        const body = typeof message.content === 'string' ? message.content : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
        if (body) { const text = `${message.role}:\n${body}\n\n`; inputHash.update(text); inputBytes += Buffer.byteLength(text); }
      }
      if (record.kind === 'model-content' && (record.content as any).type === 'text') {
        const text = (record.content as any).text; answerHash.update(text); outputHash.update(text); answerBytes += Buffer.byteLength(text); outputBytes += Buffer.byteLength(text);
      }
      if (record.kind === 'terminal') {
        if (input.status === 'completed' && (!modelCount || !stepModelCount || invocations.size || tools.size)) throw new Error('Missing completed model/tool observations');
        terminal = record;
      }
      yield (count++ ? ',' : '') + line;
    }
    if (count !== input.recordCount || !terminal || terminal.status !== input.status || terminal.time !== input.endedAt || JSON.stringify(terminal.usage) !== JSON.stringify(input.usage)) throw new Error('Missing/mismatched AI terminal observations');
    yield ']}';
  })(), 'application/json');
  const projectedInput = await readable(workspace, join(directory, 'input.txt'));
  const content = await readable(workspace, join(directory, input.status === 'completed' ? 'answer.txt' : 'output.txt'));
  const expectedInput = `sha256:${inputHash.digest('hex')}`;
  const expectedContent = `sha256:${(input.status === 'completed' ? answerHash : outputHash).digest('hex')}`;
  if ((projectedInput?.bytes ?? 0) !== inputBytes || (projectedInput && projectedInput.hash !== expectedInput) || (content?.bytes ?? 0) !== (input.status === 'completed' ? answerBytes : outputBytes) || (content && content.hash !== expectedContent)) throw new Error('AI readable projection does not match selected records');
  const payload = { callId: input.callId, operation: input.operation, status: input.status, ...(projectedInput ? { input: projectedInput } : {}), ...(content ? { content } : {}), raw: { format: 'vercel-ai-turn-v1', recordCount: count, ...raw }, ...(input.usage !== undefined ? { usage: input.usage } : {}) };
  assertJsonValue(payload);
  return { type: 'ai.turn', externalId: `ai.turn:${input.callId}`, startedAt: input.startedAt, endedAt: input.endedAt, payload };
}
