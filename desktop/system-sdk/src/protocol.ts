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
  variant: "redacted-text";
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
      variant: string;
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

export interface SystemOperationMap {
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
  writeDoc: {
    input: { id: string; content: string; metadata?: Record<string, unknown> };
    output: { ok: true; id: string };
  };
  deleteDoc: {
    input: { id: string };
    output: { ok: true };
  };
  writeEvent: {
    input: WriteEventInput;
    output: { ok: true; id: string };
  };
}

export const SYSTEM_OPERATIONS = Object.freeze([
  "query",
  "resolveContentRef",
  "mutate",
  "transaction",
  "writeDoc",
  "deleteDoc",
  "writeEvent",
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
