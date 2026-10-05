import type { AiOptions, AiStart, AiEvent } from './ai/types.js';
import type { ComputerTool, ComputerResult } from './computer.js';
export type { ComputerTool, ComputerResult } from './computer.js';
export * from './ai/types.js';
export { encodeAi, decodeAi, AI_MAX_VALUE_BYTES } from './ai/codec.js';
export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SqlScalar = null | string | number;
export interface SqlBlob { $blobBase64: string; }
export type SqlParam = SqlScalar | SqlBlob;
export type SqlParams = SqlParam[] | Record<string, SqlParam>;

export interface SqlStatement {
  sql: string;
  params?: SqlParams;
}

export interface MutationResult {
  rows: Array<Record<string, unknown>>;
  changes: number;
  lastInsertRowid: number | { $integer: string };
  auditEventIds: string[];
}

export type TransactionStatementResult =
  | { kind: "query"; rows: Array<Record<string, unknown>> }
  | ({ kind: "mutate" } & MutationResult);

export type ContentBlobRef = {
  kind: "content-blob";
  version: 1;
  digest: string;
  mediaType: "text/plain; charset=utf-8" | "application/json";
  encoding: "gzip";
};

export type ResolveContentRefResult =
  | {
      status: "resolved";
      kind: "text";
      text: string;
      bytes: number;
      digest: string;
      mediaType: string;
    }
  | { status: "missing"; digest: string }
  | { status: "digest_mismatch"; expected: string; actual: string }
  | { status: "unsupported"; reason: string }
  | { status: "decode_error"; message: string };

export interface WriteEventInput {
  type: string;
  startedAt: number;
  endedAt?: number;
  externalId?: string;
  payload: JsonValue;
}

export interface VfsCommandWireOptions {
  stdin?: { encoding: "utf8" | "base64"; data: string } | { uploadToken: string };
  stdout?: "capture" | "ignore";
  author?: string;
}

export interface VfsCommandWireResult {
  success: boolean;
  exitCode: number;
  stdoutBase64: string;
  stderrBase64: string;
}

/** Original D0 envelope; payload is decoded JSON, never a query projection. */
export interface D0Event {
  id: string;
  schema_version: string;
  source: string;
  producer_ref: string;
  type: string;
  external_id: string | null;
  started_at: number;
  ended_at: number | null;
  payload: JsonValue;
  created_at: number;
}
export interface SubscriptionBatch { sequence: number; events: D0Event[]; }

/** Proposed job-input contract for review; no manifest or protocol version bump. */
export interface JobInvocation {
  version: 1; triggerId: string; runId: string; revision: number;
  input: { kind: 'event'; event: D0Event } | { kind: 'schedule'; scheduledAt: number };
}

export interface SystemOperationMap {
  "job.input": { input: Record<string, never>; output: JobInvocation };
  "subscription.start": { input: SqlStatement; output: { subscriptionId: string } };
  "subscription.next": { input: { subscriptionId: string; acknowledged: number }; output: SubscriptionBatch };
  "subscription.cancel": { input: { subscriptionId: string }; output: { ok: true } };
  'computer.open': { input: { sessionId: string }; output: { sessionId: string; tools: ComputerTool[]; instructions: string } };
  'computer.call': { input: { sessionId: string; name: string; arguments: Record<string, unknown> }; output: ComputerResult };
  'computer.close': { input: { sessionId: string }; output: { ok: true } };
  "ai.listOptions": { input: Record<string, never>; output: AiOptions };
  "ai.start": { input: AiStart; output: { invocationId: string } };
  "ai.next": { input: { invocationId: string; sequence: number }; output: { events: AiEvent[] } };
  "ai.cancel": { input: { invocationId: string }; output: { ok: true } };
  "ai.toolResult": { input: { invocationId: string; toolCallId: string; value: JsonValue; failed: boolean; modelOutput?: JsonValue }; output: { ok: true } };
  query: {
    input: { sql: string; params?: SqlParams };
    output: { rows: unknown[] };
  };
  resolveContentRef: {
    input: { ref: ContentBlobRef };
    output: ResolveContentRefResult;
  };
  mutate: {
    input: { sql: string; params?: SqlParams };
    output: MutationResult;
  };
  transaction: {
    input: { statements: SqlStatement[] };
    output: TransactionStatementResult[];
  };
  "vfs.command": {
    input: { command: string; options?: VfsCommandWireOptions };
    output: VfsCommandWireResult;
  };
  "vfs.upload.begin": {
    input: Record<string, never>;
    output: { token: string };
  };
  "vfs.upload.chunk": {
    input: { token: string; index: number; dataBase64: string };
    output: { ok: true };
  };
  "vfs.upload.complete": {
    input: { token: string };
    output: { ok: true };
  };
  "vfs.upload.abort": {
    input: { token: string };
    output: { ok: true };
  };
  "vfs.open": {
    input: { path: string };
    output: { url: string };
  };
  writeEvent: {
    input: WriteEventInput;
    output: { ok: true; id: string };
  };
}

export const SYSTEM_OPERATIONS = Object.freeze([
  "job.input",
  'computer.open', 'computer.call', 'computer.close',
  "ai.listOptions", "ai.start", "ai.next", "ai.cancel", "ai.toolResult",
  "subscription.start", "subscription.next", "subscription.cancel",
  "query",
  "resolveContentRef",
  "mutate",
  "transaction",
  "vfs.command",
  "vfs.open",
  "writeEvent",
  "vfs.upload.begin",
  "vfs.upload.chunk",
  "vfs.upload.complete",
  "vfs.upload.abort",
] as const satisfies readonly (keyof SystemOperationMap)[]);

export type SystemOperation = (typeof SYSTEM_OPERATIONS)[number];

type MissingSystemOperations = Exclude<keyof SystemOperationMap, SystemOperation>;
const ALL_SYSTEM_OPERATIONS_ARE_LISTED: MissingSystemOperations extends never ? true : never = true;
void ALL_SYSTEM_OPERATIONS_ARE_LISTED;

export type SystemInvoke = <Operation extends SystemOperation>(
  operation: Operation,
  input: SystemOperationMap[Operation]["input"],
) => Promise<SystemOperationMap[Operation]["output"]>;

export interface SystemRpcRequest<Operation extends SystemOperation = SystemOperation> {
  version: 1;
  requestId: number;
  operation: Operation;
  input: SystemOperationMap[Operation]["input"];
}

export type SystemRpcResponse =
  | {
      version: 1;
      requestId: number;
      ok: true;
      result: unknown;
    }
  | {
      version: 1;
      requestId: number;
      ok: false;
      error: { message: string; code?: string };
    };
