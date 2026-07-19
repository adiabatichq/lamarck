import type { JsonValue } from "@lamarck/system/protocol";

export type { JsonValue } from "@lamarck/system/protocol";

export function assertJsonValue(value: unknown, label = "JSON value"): asserts value is JsonValue {
  const seen = new Set<object>();
  validate(value, label, seen);
}

function validate(value: unknown, path: string, seen: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be a finite JSON number`);
    }
    return;
  }

  if (Array.isArray(value)) {
    checkSeen(value, path, seen);
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === undefined) {
        throw new Error(`${path}[${i}] must not be undefined`);
      }
      validate(value[i], `${path}[${i}]`, seen);
    }
    seen.delete(value);
    return;
  }

  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    checkSeen(value, path, seen);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined) {
        throw new Error(`${path}.${key} must not be undefined`);
      }
      validate(child, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }

  throw new Error(`${path} must be JSON-serializable`);
}

function checkSeen(value: object, path: string, seen: Set<object>): void {
  if (seen.has(value)) {
    throw new Error(`${path} must not contain circular references`);
  }
  seen.add(value);
}
