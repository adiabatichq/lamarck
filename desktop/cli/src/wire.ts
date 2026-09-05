import { Readable, type Writable } from "node:stream";
import {
  CLI_MAX_INLINE_BYTES,
  type CliOperation,
  type CliResponse,
  type FileCommandResult,
} from "./operations.js";
import { encodeCliFrame, parseCliFrame, parseCliResponse } from "./protocol.js";
import { CliStreamReader, writeCliBytes } from "./stream.js";

export async function writeCliResponse(
  stream: Writable,
  operation: CliOperation,
  response: CliResponse,
): Promise<void> {
  const prepared = prepareCliResponse(operation, response);
  await writeCliBytes(stream, encodeCliFrame(prepared.control));
  for (const bytes of prepared.bytes) await writeCliBytes(stream, bytes);
}

export async function readCliResponse(
  reader: CliStreamReader,
  operation: CliOperation,
  requestId: string,
): Promise<CliResponse> {
  const response = parseCliResponse(parseCliFrame(await reader.readFrame()), requestId);
  return hydrateCliResponse(reader, operation, response);
}

export function encodeCliHttpResponse(operation: CliOperation, response: CliResponse): Buffer {
  const prepared = prepareCliResponse(operation, response);
  return Buffer.concat([encodeCliFrame(prepared.control), ...prepared.bytes]);
}

export async function decodeCliHttpResponse(
  value: Uint8Array,
  operation: CliOperation,
  requestId: string,
): Promise<CliResponse> {
  if (value.byteLength > 2 * CLI_MAX_INLINE_BYTES + 128 * 1024) {
    throw new Error("CLI HTTP response is outside the V1 bound");
  }
  const reader = new CliStreamReader(Readable.from(Buffer.from(value)));
  const response = await readCliResponse(reader, operation, requestId);
  if ((await reader.readToEnd(1)).byteLength !== 0) throw new Error("CLI HTTP response has trailing bytes");
  return response;
}

function prepareCliResponse(
  operation: CliOperation,
  response: CliResponse,
): { readonly control: CliResponse; readonly bytes: readonly Buffer[] } {
  if (!response.ok || !isFileOperation(operation)) return { control: response, bytes: [] };
  const result = parseFileResult(response.result);
  const stdout = decodeCanonicalBase64(result.stdoutBase64, "stdout");
  const stderr = decodeCanonicalBase64(result.stderrBase64, "stderr");
  const control = {
    requestId: response.requestId,
    ok: true,
    result: { ...result, stdoutBase64: "", stderrBase64: "" },
    byteStreams: { stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength },
  } as CliResponse;
  return { control, bytes: [stdout, stderr] };
}

async function hydrateCliResponse(
  reader: CliStreamReader,
  operation: CliOperation,
  response: CliResponse,
): Promise<CliResponse> {
  if (!response.ok || response.byteStreams === undefined) return response;
  if (!isFileOperation(operation)) throw new Error("CLI response attached bytes to a non-file operation");
  const result = parseFileResult(response.result);
  const stdout = await reader.readExact(response.byteStreams.stdoutBytes);
  const stderr = await reader.readExact(response.byteStreams.stderrBytes);
  return {
    requestId: response.requestId,
    ok: true,
    result: { ...result, stdoutBase64: stdout.toString("base64"), stderrBase64: stderr.toString("base64") },
  } as CliResponse;
}

function parseFileResult(value: unknown): FileCommandResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CLI file result is invalid");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "exitCode,stderrBase64,stdoutBase64,success"
    || typeof raw.success !== "boolean"
    || !Number.isInteger(raw.exitCode)
    || Number(raw.exitCode) < 0
    || Number(raw.exitCode) > 255
    || typeof raw.stdoutBase64 !== "string"
    || typeof raw.stderrBase64 !== "string") throw new Error("CLI file result is invalid");
  return raw as unknown as FileCommandResult;
}

function decodeCanonicalBase64(value: string, channel: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`CLI ${channel} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > CLI_MAX_INLINE_BYTES || bytes.toString("base64") !== value) {
    throw new Error(`CLI ${channel} is outside the V1 bound`);
  }
  return bytes;
}

function isFileOperation(operation: CliOperation): boolean {
  return operation === "file.command" || operation === "file.import" || operation === "file.export";
}
