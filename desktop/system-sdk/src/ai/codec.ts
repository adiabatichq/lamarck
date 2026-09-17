import type { JsonValue } from '../protocol.js';

export const AI_MAX_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
/** Tagged containers avoid collisions with arbitrary user JSON/schema keys. */
export function encodeAi(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): JsonValue {
    if (depth > MAX_DEPTH) throw new Error('AI value is nested too deeply');
    if (value === undefined) return ['undefined'];
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof URL) throw new Error('AI URL inputs are unsupported; pass file bytes instead');
    if (value instanceof Uint8Array) {
      let text = '';
      for (let offset = 0; offset < value.length; offset += 8192) text += String.fromCharCode(...value.subarray(offset, offset + 8192));
      return ['bytes', btoa(text)];
    }
    if (value instanceof Date && Number.isFinite(value.getTime())) return ['date', value.toISOString()];
    if (!value || typeof value !== 'object') throw new Error('AI values must be serializable data');
    if (ancestors.has(value)) throw new Error('AI values must not contain cycles');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return ['array', value.map(item => visit(item, depth + 1))];
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('AI values must be plain data');
      return ['object', Object.entries(value).map(([key, item]) => [key, visit(item, depth + 1)])];
    } finally { ancestors.delete(value); }
  }
  const result = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > AI_MAX_VALUE_BYTES) throw new Error('AI value exceeds the size limit');
  return result;
}
export function decodeAi(value: JsonValue): unknown {
  if (new TextEncoder().encode(JSON.stringify(value)).length > AI_MAX_VALUE_BYTES) throw new Error('AI value exceeds the size limit');
  function visit(value: JsonValue, depth: number): unknown {
    if (depth > MAX_DEPTH) throw new Error('AI value is nested too deeply');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
    if (!Array.isArray(value)) throw new Error('Invalid AI encoding');
    const [tag, data] = value;
    if (tag === 'undefined' && value.length === 1) return undefined;
    if (value.length !== 2) throw new Error('Invalid AI encoding');
    if (tag === 'bytes' && typeof data === 'string') return Uint8Array.from(atob(data), c => c.charCodeAt(0));
    if (tag === 'date' && typeof data === 'string' && Number.isFinite(Date.parse(data))) return new Date(data);
    if (tag === 'array' && Array.isArray(data)) return data.map(item => visit(item, depth + 1));
    if (tag === 'object' && Array.isArray(data)) {
      const entries = data.map(item => {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string') throw new Error('Invalid AI object');
        return [item[0], visit(item[1], depth + 1)] as const;
      });
      if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Duplicate AI object key');
      return Object.fromEntries(entries);
    }
    throw new Error('Invalid AI encoding');
  }
  return visit(value, 0);
}
