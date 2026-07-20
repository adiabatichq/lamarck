export function normalizeDocMetadata(value: unknown): Record<string, unknown> | null {
  let metadata = value;
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata) as unknown;
    } catch {
      throw new Error("Core returned invalid document metadata JSON");
    }
  }

  if (metadata === null) return null;
  if (
    typeof metadata !== "object"
    || Array.isArray(metadata)
    || Object.getPrototypeOf(metadata) !== Object.prototype
  ) {
    throw new Error("Core returned document metadata that is not an object");
  }

  const record = metadata as Record<string, unknown>;
  if (Object.hasOwn(record, "locked") && typeof record.locked !== "boolean") {
    throw new Error("Core returned a non-boolean document metadata.locked value");
  }
  return record;
}
