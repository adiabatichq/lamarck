import { CliError } from "./errors.js";

export const CLI_PROTOCOL_VERSION = 1 as const;
// A schema change may contain 300 KiB of UTF-8 text. JSON escaping can expand
// each input byte up to six bytes, so V1 reserves a bounded 2 MiB frame.
export const CLI_MAX_CONTROL_BYTES = 2 * 1024 * 1024;
export const CLI_MAX_INLINE_BYTES = 20 * 1024 * 1024;
export const MANAGED_CLI_SOCKET_PATH = "/run/lamarck/cli.sock" as const;
export const MANAGED_APP_EDIT_ROOT = "/mnt/lamarck-apps" as const;

export type CliEnvironment = "host" | "managed";
export interface CliHostCapabilities {
  readonly protocolVersion: 1;
  readonly environment: CliEnvironment;
  /** Advertised support, independent of this client's business catalog. */
  readonly supportedOperations: readonly string[];
}
export interface CliByteStreams { readonly stdoutBytes: number; readonly stderrBytes: number }
export interface CliErrorValue { readonly code: string; readonly message: string }
export interface CliWireRequest {
  readonly requestId: string;
  readonly operation: string;
  readonly input: Record<string, unknown>;
  readonly upload?: CliUpload;
}
export type CliWireResponse =
  | { readonly requestId: string; readonly ok: true; readonly result: unknown; readonly byteStreams?: CliByteStreams }
  | { readonly requestId: string; readonly ok: false; readonly error: CliErrorValue };
export type CliUpload = {
  readonly kind: "app-package";
  readonly archiveDigest: string;
  readonly archiveBytes: number;
  readonly baseVersion: string | null;
  readonly basePackageDigest: string;
} | {
  readonly kind: "file-stdin";
  readonly bytes: number;
};


const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const OPERATION = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;
export function isCliOperationName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && OPERATION.test(value);
}

export function encodeCliFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength < 1 || payload.byteLength > CLI_MAX_CONTROL_BYTES) {
    throw new Error("CLI control frame is outside the V1 bound");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export function parseCliFrame(value: Uint8Array): unknown {
  if (value.byteLength < 1 || value.byteLength > CLI_MAX_CONTROL_BYTES) {
    throw new Error("CLI control payload is outside the V1 bound");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch (error) {
    throw new Error("CLI control payload is not valid UTF-8 JSON", { cause: error });
  }
}

export function parseCliCapabilities(value: unknown, expected?: CliEnvironment): CliHostCapabilities {
  const object = exactObject(value, ["environment", "protocolVersion", "supportedOperations"], "CLI hello");
  if (object.protocolVersion !== CLI_PROTOCOL_VERSION) {
    throw new CliError("CLI_HOST_INCOMPATIBLE", `Lamarck CLI protocol V${String(object.protocolVersion)} is incompatible with V${CLI_PROTOCOL_VERSION}.`);
  }
  if (object.environment !== "host" && object.environment !== "managed") throw new Error("CLI hello environment is invalid");
  if (expected && object.environment !== expected) throw new Error("CLI hello environment does not match its transport");
  if (!Array.isArray(object.supportedOperations)
    || object.supportedOperations.some((item) => !isCliOperationName(item))) {
    throw new Error("CLI hello operations are invalid");
  }
  const operations = object.supportedOperations as string[];
  if (new Set(operations).size !== operations.length) throw new Error("CLI hello operations contain duplicates");
  return Object.freeze({ protocolVersion: 1, environment: object.environment, supportedOperations: Object.freeze([...operations]) });
}

/** Validate framing and upload authority without knowing Host business operations. */
export function parseCliRequestEnvelope(value: unknown, allowAppPackage = false): CliWireRequest {
  const raw = record(value, "CLI request");
  exactKeys(raw, raw.upload === undefined ? ["input", "operation", "requestId"] : ["input", "operation", "requestId", "upload"], "CLI request");
  if (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId)) throw new Error("CLI request id is invalid");
  if (!isCliOperationName(raw.operation)) throw new Error("CLI operation is invalid");
  const input = record(raw.input, "CLI input");
  if (raw.operation === "file.command" && input.stdinBase64 !== undefined) throw new Error("CLI inline file bytes are not allowed on this boundary");
  const upload = raw.upload === undefined ? undefined : validateUpload(raw.upload, raw.operation, input);
  if (upload?.kind === "app-package" && !allowAppPackage) throw new Error("Local App save cannot submit package authority");
  return { requestId: raw.requestId, operation: raw.operation, input, ...(upload === undefined ? {} : { upload }) };
}

export function parseCliWireResponse(value: unknown, requestId?: string): CliWireResponse {
  const raw = record(value, "CLI response");
  if (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId)) throw new Error("CLI response id is invalid");
  if (requestId !== undefined && raw.requestId !== requestId) throw new Error("CLI response attribution mismatch");
  if (raw.ok === true) {
    exactOptionalKeys(raw, ["ok", "requestId", "result"], ["byteStreams"], "CLI response");
    const byteStreams = raw.byteStreams === undefined ? undefined : parseByteStreams(raw.byteStreams);
    return {
      requestId: raw.requestId,
      ok: true,
      result: raw.result,
      ...(byteStreams === undefined ? {} : { byteStreams }),
    } as CliWireResponse;
  }
  if (raw.ok === false) {
    exactKeys(raw, ["error", "ok", "requestId"], "CLI response");
    return { requestId: raw.requestId, ok: false, error: parseCliErrorValue(raw.error) };
  }
  throw new Error("CLI response status is invalid");
}

export function parseCliErrorValue(value: unknown): CliErrorValue {
  const raw = exactObject(value, ["code", "message"], "CLI error");
  if (typeof raw.code !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(raw.code) || typeof raw.message !== "string" || !raw.message) {
    throw new Error("CLI error is invalid");
  }
  return { code: raw.code, message: raw.message };
}

export function validateUpload(
  value: unknown,
  operation: string,
  input: Record<string, unknown>,
): CliUpload {
  const raw = record(value, "CLI upload");
  if (raw.kind === "app-package") {
    exactKeys(raw, ["archiveBytes", "archiveDigest", "basePackageDigest", "baseVersion", "kind"], "CLI App upload");
    if (operation !== "app.save" || typeof raw.archiveDigest !== "string" || !DIGEST.test(raw.archiveDigest)
      || typeof raw.basePackageDigest !== "string" || !DIGEST.test(raw.basePackageDigest)
      || (raw.baseVersion !== null && (typeof raw.baseVersion !== "string" || !VERSION.test(raw.baseVersion)))
      || !Number.isSafeInteger(raw.archiveBytes) || Number(raw.archiveBytes) < 1) throw new Error("CLI App upload is invalid");
    return raw as unknown as CliUpload;
  }
  exactKeys(raw, ["bytes", "kind"], "CLI file upload");
  if (raw.kind !== "file-stdin" || operation !== "file.command"
    || (Array.isArray(input.argv) ? input.argv[0] : undefined) !== "tee"
    || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0 || Number(raw.bytes) > CLI_MAX_INLINE_BYTES) {
    throw new Error("CLI file upload is invalid");
  }
  return raw as unknown as CliUpload;
}

function parseByteStreams(value: unknown): CliByteStreams {
  const raw = exactObject(value, ["stderrBytes", "stdoutBytes"], "CLI byte streams");
  if (!Number.isSafeInteger(raw.stdoutBytes) || Number(raw.stdoutBytes) < 0 || Number(raw.stdoutBytes) > CLI_MAX_INLINE_BYTES
    || !Number.isSafeInteger(raw.stderrBytes) || Number(raw.stderrBytes) < 0 || Number(raw.stderrBytes) > CLI_MAX_INLINE_BYTES) {
    throw new Error("CLI byte streams are outside the V1 bound");
  }
  return { stdoutBytes: Number(raw.stdoutBytes), stderrBytes: Number(raw.stderrBytes) };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const object = record(value, label); exactKeys(object, keys, label); return object;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} has unexpected or missing fields`);
}
function exactOptionalKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  for (const key of required) if (!(key in value)) throw new Error(`${label} is missing ${key}`);
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error(`${label} has an unexpected field`);
}

export { CliStreamReader, writeCliBytes } from "./stream.js";
