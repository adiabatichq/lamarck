import { validateFullGitCommit } from "../system-identity";

export type AppVersionTrigger = "save" | "activate" | "restore";

export interface AppVersionRecordV1 {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly version: string;
  readonly parentVersion: string | null;
  readonly trigger: AppVersionTrigger;
  readonly createdAt: number;
  readonly message?: string;
  readonly author?: string;
  readonly restoredFrom?: string;
}

export function validateAppVersionRecordV1(value: unknown): AppVersionRecordV1 {
  if (!isObject(value)) throw new Error("App version record must be an object");
  const allowed = new Set([
    "schemaVersion",
    "appId",
    "version",
    "parentVersion",
    "trigger",
    "createdAt",
    "message",
    "author",
    "restoredFrom",
  ]);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Unknown App version record field: ${unexpected}`);
  if (value.schemaVersion !== 1) throw new Error("App version record schemaVersion must be 1");
  if (typeof value.appId !== "string" || value.appId.length === 0) {
    throw new Error("App version record appId is invalid");
  }
  const version = validateFullGitCommit(value.version, "App version record version");
  const parentVersion = value.parentVersion === null
    ? null
    : validateFullGitCommit(value.parentVersion, "App version record parentVersion");
  if (value.trigger !== "save" && value.trigger !== "activate" && value.trigger !== "restore") {
    throw new Error("App version record trigger is invalid");
  }
  if (!Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0) {
    throw new Error("App version record createdAt is invalid");
  }
  const message = optionalTrimmed(value.message, "message");
  const author = optionalTrimmed(value.author, "author");
  const restoredFrom = value.restoredFrom === undefined
    ? undefined
    : validateFullGitCommit(value.restoredFrom, "App version record restoredFrom");
  if (value.trigger === "restore" && restoredFrom === undefined) {
    throw new Error("Restore App version record requires restoredFrom");
  }
  if (value.trigger !== "restore" && restoredFrom !== undefined) {
    throw new Error("Only restore App version records may contain restoredFrom");
  }
  return Object.freeze({
    schemaVersion: 1,
    appId: value.appId,
    version,
    parentVersion,
    trigger: value.trigger,
    createdAt: Number(value.createdAt),
    ...(message === undefined ? {} : { message }),
    ...(author === undefined ? {} : { author }),
    ...(restoredFrom === undefined ? {} : { restoredFrom }),
  });
}

export function canonicalizeAppVersionRecordV1(value: unknown): string {
  const record = validateAppVersionRecordV1(value);
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    appId: record.appId,
    version: record.version,
    parentVersion: record.parentVersion,
    trigger: record.trigger,
    createdAt: record.createdAt,
    ...(record.message === undefined ? {} : { message: record.message }),
    ...(record.author === undefined ? {} : { author: record.author }),
    ...(record.restoredFrom === undefined ? {} : { restoredFrom: record.restoredFrom }),
  });
}

export function parseCanonicalAppVersionRecordV1(value: string): AppVersionRecordV1 {
  // Git tag messages are line-oriented; isomorphic-git normalizes one final
  // LF even when the supplied canonical JSON has none.
  const canonicalJson = value.endsWith("\n") ? value.slice(0, -1) : value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalJson);
  } catch (error) {
    throw new Error("App version record is not valid JSON", { cause: error });
  }
  const record = validateAppVersionRecordV1(parsed);
  if (canonicalizeAppVersionRecordV1(record) !== canonicalJson) {
    throw new Error("App version record is not canonical JSON");
  }
  return record;
}

function optionalTrimmed(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`App version record ${field} must be non-empty trimmed text`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
