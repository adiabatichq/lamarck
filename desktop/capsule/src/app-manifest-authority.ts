import { createHash } from "node:crypto";

export const APP_MANIFEST_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const APP_MANIFEST_MAX_BYTES = 1024 * 1024;

export type AppManifestDigest = `sha256:${string}`;

/**
 * Hashes the semantic JSON value of a manifest, independent of source
 * whitespace and object-key order. Arrays remain ordered because command argv
 * order is authority-bearing.
 */
export function digestNormalizedAppManifest(value: unknown): AppManifestDigest {
  const canonical = canonicalJson(value, "$", new Set());
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error(`${path} contains a non-JSON value`);
  }
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => (
        canonicalJson(item, `${path}[${index}]`, ancestors)
      )).join(",")}]`;
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(object[key], `${path}.${key}`, ancestors)}`
    )).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
