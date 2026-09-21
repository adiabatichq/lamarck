import type { JsonValue } from '../protocol.js';

/** Selected content only. Runtime objects are rejected, never stringified. */
export function captureData(value: unknown): JsonValue {
  let budget = 2 * 1024 * 1024;
  const visit = (value: unknown, depth: number): JsonValue => {
    if (depth > 32 || (budget -= 8) < 0) throw new Error('AI capture value exceeds the structural limit');
    if (typeof value === 'string') {
      // Check length before allocating an encoded copy; the conservative UTF-16
      // bound keeps both the traversal and subsequent JSON serialization bounded.
      if ((budget -= value.length * 3) < 0) throw new Error('AI capture value exceeds the byte limit');
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (const item of value) result.push(visit(item, depth + 1));
      return result;
    }
    if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('AI capture requires serializable content');
    const result: Record<string, JsonValue> = {};
    for (const key in value) if (Object.hasOwn(value, key)) {
      if ((budget -= key.length * 3) < 0) throw new Error('AI capture value exceeds the byte limit');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) throw new Error('AI capture does not execute content accessors');
      if (descriptor.value !== undefined) Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
    }
    return result;
  };
  return visit(value, 0);
}
export function captureBlock(value: unknown): JsonValue | undefined {
  if (!value || typeof value !== 'object') throw new Error('AI capture content block must be an object');
  const block = value as Record<string, unknown>;
  if (typeof block.type !== 'string') throw new Error('AI capture block type is required');
  if (['reasoning', 'reasoning-start', 'reasoning-delta', 'reasoning-end', 'reasoning-file'].includes(block.type)) return undefined;
  if (['file', 'image'].includes(block.type)) {
    for (const field of ['mediaType', 'filename']) if (block[field] !== undefined && typeof block[field] !== 'string') throw new Error(`Malformed AI content ${field}`);
    const data = block.url ?? block.data ?? block.image;
    let reference: unknown;
    if (data instanceof URL) reference = data.href;
    else if (typeof data === 'string' && /^https?:\/\//.test(data)) reference = data;
    else if (data && typeof data === 'object' && 'type' in data) {
      if (data.type === 'url' && 'url' in data) reference = data.url instanceof URL ? data.url.href : data.url;
      if (data.type === 'reference' && 'reference' in data) reference = data.reference;
    }
    // Selected file descriptors can be validated again by Guard without having
    // access to excluded bytes.
    if (block.reference !== undefined) reference = block.reference;
    if (data === undefined && reference === undefined && block.omitted !== 'binary-content') throw new Error('Missing file content');
    return captureData({ type: block.type, mediaType: block.mediaType, filename: block.filename, ...(reference !== undefined ? { reference } : { omitted: 'binary-content' }) });
  }
  const allowed: Record<string, string[]> = {
    text: ['text'], 'text-start': ['id'], 'text-delta': ['id', 'delta'], 'text-end': ['id'],
    'tool-call': ['toolCallId', 'toolName', 'input', 'providerExecuted'],
    'tool-result': ['toolCallId', 'toolName', 'output', 'result', 'providerExecuted', 'preliminary'],
    'tool-error': ['toolCallId', 'toolName', 'input', 'error'],
    'tool-input-start': ['id', 'toolName', 'providerExecuted'], 'tool-input-delta': ['id', 'delta'], 'tool-input-end': ['id'],
    source: ['sourceType', 'id', 'url', 'title', 'mediaType', 'filename'],
    'tool-approval-request': ['approvalId', 'toolCallId'], 'tool-approval-response': ['approvalId', 'approved', 'reason'],
  };
  const fields = allowed[block.type];
  if (!fields) throw new Error(`Unsupported AI capture content block: ${block.type}`);
  const required: Record<string, string[]> = {
    text: ['text'], 'text-start': ['id'], 'text-delta': ['id', 'delta'], 'text-end': ['id'],
    'tool-call': ['toolCallId', 'toolName', 'input'], 'tool-result': ['toolCallId', 'toolName'],
    'tool-error': ['toolCallId', 'toolName', 'error'], 'tool-input-start': ['id', 'toolName'],
    'tool-input-delta': ['id', 'delta'], 'tool-input-end': ['id'], source: ['sourceType', 'id'],
    'tool-approval-request': ['approvalId', 'toolCallId'], 'tool-approval-response': ['approvalId', 'approved'],
  };
  for (const field of required[block.type] ?? []) if (block[field] === undefined) throw new Error(`Missing AI content ${field}`);
  if (block.type === 'tool-result' && block.output === undefined && block.result === undefined) throw new Error('Missing tool result content');
  for (const field of ['text', 'id', 'delta', 'toolCallId', 'toolName', 'approvalId', 'sourceType', 'url', 'title', 'mediaType', 'filename', 'reason']) if (block[field] !== undefined && typeof block[field] !== 'string') throw new Error(`Malformed AI content ${field}`);
  for (const field of ['approved', 'providerExecuted', 'preliminary']) if (block[field] !== undefined && typeof block[field] !== 'boolean') throw new Error(`Malformed AI content ${field}`);
  const result: Record<string, unknown> = { type: block.type };
  for (const field of fields) if (block[field] !== undefined) result[field] = field === 'error' && block[field] instanceof Error ? { name: block[field].name, message: block[field].message } : block[field];
  return captureData(result);
}
export function captureMessage(value: unknown): JsonValue {
  if (!value || typeof value !== 'object') throw new Error('AI capture message is required');
  const message = value as Record<string, unknown>;
  if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role as string)) throw new Error('Invalid AI capture message role');
  if (typeof message.content === 'string') return captureData({ role: message.role as string, content: message.content });
  if (!Array.isArray(message.content)) throw new Error('Invalid AI capture message content');
  return { role: message.role as string, content: message.content.map(captureBlock).filter((v): v is JsonValue => v !== undefined) };
}
