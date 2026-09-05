import { CliError } from "./errors.js";
import {
  CLI_MAX_CONTROL_BYTES,
  CLI_MAX_INLINE_BYTES,
  CLI_OPERATIONS,
  CLI_PROTOCOL_VERSION,
  HOST_CLI_OPERATIONS,
  MANAGED_CLI_OPERATIONS,
  type CliEnvironment,
  type CliByteStreams,
  type CliErrorValue,
  type CliHostCapabilities,
  type CliOperation,
  type CliRequest,
  type CliResponse,
  type CliUpload,
} from "./operations.js";

const operationSet = new Set<string>(CLI_OPERATIONS);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

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
    || object.supportedOperations.some((item) => typeof item !== "string" || !operationSet.has(item))) {
    throw new Error("CLI hello operations are invalid");
  }
  const operations = object.supportedOperations as CliOperation[];
  if (new Set(operations).size !== operations.length) throw new Error("CLI hello operations contain duplicates");
  const canonical = object.environment === "host" ? HOST_CLI_OPERATIONS : MANAGED_CLI_OPERATIONS;
  if (JSON.stringify(operations) !== JSON.stringify(canonical)) {
    throw new CliError("CLI_HOST_INCOMPATIBLE", "Lamarck Desktop and this CLI support different operations.");
  }
  return Object.freeze({ protocolVersion: 1, environment: object.environment, supportedOperations: Object.freeze([...operations]) });
}

export function parseCliRequest(
  value: unknown,
  options: boolean | { readonly allowUpload?: boolean; readonly allowInlineFileBytes?: boolean } = false,
): CliRequest {
  const allowUpload = typeof options === "boolean" ? options : options.allowUpload === true;
  const allowInlineFileBytes = typeof options === "object" && options.allowInlineFileBytes === true;
  const raw = record(value, "CLI request");
  const expected = raw.upload === undefined ? ["input", "operation", "requestId"] : ["input", "operation", "requestId", "upload"];
  exactKeys(raw, expected, "CLI request");
  if (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId)) throw new Error("CLI request id is invalid");
  if (typeof raw.operation !== "string" || !operationSet.has(raw.operation)) throw new Error("CLI operation is invalid");
  const operation = raw.operation as CliOperation;
  const input = validateInput(operation, raw.input, allowInlineFileBytes);
  let upload: CliUpload | undefined;
  if (raw.upload !== undefined) {
    if (!allowUpload) throw new Error("CLI request upload is not allowed");
    upload = validateUpload(raw.upload, operation, input);
  }
  return { requestId: raw.requestId, operation, input, ...(upload === undefined ? {} : { upload }) } as CliRequest;
}

export function parseCliResponse(value: unknown, requestId?: string): CliResponse {
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
    } as CliResponse;
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

function validateInput(
  operation: CliOperation,
  value: unknown,
  allowInlineFileBytes: boolean,
): Record<string, unknown> {
  const input = record(value, `CLI ${operation} input`);
  const empty = () => exactKeys(input, [], `CLI ${operation} input`);
  const id = (field: string) => {
    exactKeys(input, [field], `CLI ${operation} input`);
    text(input[field], field);
  };
  switch (operation) {
    case "source.list": case "connector.list": case "app.list": empty(); break;
    case "query": id("sql"); break;
    case "source.inspect": case "source.run": case "source.pause": case "source.resume": id("sourceId"); break;
    case "source.run.status":
      exactKeys(input, ["runId", "sourceId"], `CLI ${operation} input`); text(input.sourceId, "sourceId"); text(input.runId, "runId"); break;
    case "connector.install": id("packageId"); break;
    case "connector.inspect": case "connector.update": case "connector.remove": id("connectorId"); break;
    case "app.inspect": case "app.versions": case "app.refresh": case "app.archive": id("appId"); break;
    case "schema.change":
      exactOptionalKeys(input, ["ddl"], ["author", "context"], `CLI ${operation} input`);
      boundedUtf8Text(input.ddl, "ddl", 300 * 1024);
      optionalText(input.author, "author"); optionalText(input.context, "context"); break;
    case "file.command":
      exactOptionalKeys(input, ["argv"], ["author", "stdinBase64"], `CLI ${operation} input`); argv(input.argv); optionalText(input.author, "author"); optionalText(input.stdinBase64, "stdinBase64"); break;
    case "file.import":
      exactOptionalKeys(input, ["argv"], ["author"], `CLI ${operation} input`); argv(input.argv); optionalText(input.author, "author"); break;
    case "file.export": exactKeys(input, ["argv"], `CLI ${operation} input`); argv(input.argv); break;
    case "app.create":
      exactKeys(input, ["appId", "description", "name"], `CLI ${operation} input`); text(input.appId, "appId"); text(input.name, "name"); text(input.description, "description"); break;
    case "app.save":
      exactOptionalKeys(input, ["appId"], ["author", "message"], `CLI ${operation} input`); text(input.appId, "appId"); optionalText(input.author, "author"); optionalText(input.message, "message"); break;
    case "app.restore":
      exactOptionalKeys(input, ["appId", "version"], ["author", "message"], `CLI ${operation} input`); text(input.appId, "appId"); text(input.version, "version"); optionalText(input.author, "author"); optionalText(input.message, "message"); break;
  }
  if (operation === "file.command" && input.stdinBase64 !== undefined && !allowInlineFileBytes) {
    throw new Error("CLI inline file bytes are not allowed on this boundary");
  }
  return input;
}

function validateUpload(
  value: unknown,
  operation: CliOperation,
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
    || (input.argv as unknown[])[0] !== "tee"
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

function argv(value: unknown): void {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string")) throw new Error("CLI file argv is invalid");
}
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.length) throw new Error(`CLI ${field} is invalid`);
}
function boundedUtf8Text(value: unknown, field: string, maxBytes: number): asserts value is string {
  text(value, field);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`CLI ${field} is outside the V1 bound`);
}
function optionalText(value: unknown, field: string): void { if (value !== undefined) text(value, field); }
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
