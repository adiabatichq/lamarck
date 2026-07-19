import type {
  JsonValue,
  MutationResult,
  SqlBlob,
  SqlParam,
  SqlParams,
  SqlScalar,
  SqlStatement,
  TransactionStatementResult,
} from "@lamarck/system/protocol";

/**
 * Private Core -> Guard capability descriptor.
 *
 * The Core resolves manifests/authentication into concrete grants. The Guard
 * never receives a callback (callbacks are not serializable across the process
 * boundary) and never infers app permissions from an app-controlled source.
 */
export interface GuardPrincipal {
  /** Injected into D0. Examples: system:server, app:focus, connector:oura. */
  source: string;
  /** D2 table names this request may mutate. `*` is reserved for host code. */
  tableGrants: "*" | string[];
  /** D1 exact ids or slash-terminated prefixes this request may write/delete. */
  docGrants: "*" | string[];
  /** Privileged schema lifecycle capability; ordinary apps must leave false. */
  schemaGrant?: boolean;
}

export type GuardSqlScalar = SqlScalar;

/** JSON-safe representation of a SQLite BLOB parameter or result value. */
export type GuardBlob = SqlBlob;

/** Lossless JSON representation of a SQLite INTEGER outside JS's safe range. */
export type GuardInteger = Exclude<MutationResult["lastInsertRowid"], number>;

export type GuardSqlParam = SqlParam;
export type GuardSqlParams = SqlParams;
export type GuardStatement = SqlStatement;

export interface GuardEventInput {
  schemaVersion?: string;
  type: string;
  externalId?: string;
  startedAt: number;
  endedAt?: number;
  payload: JsonValue;
}

export type GuardMutationResult = MutationResult;
export type GuardTransactionStatementResult = TransactionStatementResult;

export type GuardSchemaKind = "promote" | "demote";

export interface GuardSchemaSnapshot {
  tables: Array<{
    name: string;
    sql: string;
    columns: Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;
  }>;
  indexes: Array<{ name: string; table: string; sql: string | null }>;
}

export interface GuardSchemaPlan {
  kind: GuardSchemaKind;
  ddl: string[];
  beforeSchema: GuardSchemaSnapshot;
}

export interface GuardWorkingTreeDoc {
  id: string;
  content: string;
  metadata: string | null;
  updatedAt: number;
}

export interface GuardWorkingTreeLockedDocHash {
  id: string;
  contentHash: string;
}

export interface GuardRpcMethods {
  query: {
    params: GuardStatement & { principal: GuardPrincipal };
    result: Array<Record<string, unknown>>;
  };
  mutate: {
    params: GuardStatement & { principal: GuardPrincipal };
    result: GuardMutationResult;
  };
  transaction: {
    params: { principal: GuardPrincipal; statements: GuardStatement[] };
    result: GuardTransactionStatementResult[];
  };
  writeEvent: {
    params: { principal: GuardPrincipal; event: GuardEventInput };
    result: string;
  };
  writeDoc: {
    params: {
      principal: GuardPrincipal;
      id: string;
      content: string;
      metadata?: Record<string, unknown>;
    };
    result: { ok: true };
  };
  readDocForWorkingTree: {
    params: { principal: GuardPrincipal; id: string };
    result: GuardWorkingTreeDoc | null;
  };
  listLockedDocHashesForWorkingTree: {
    params: { principal: GuardPrincipal; afterId: string; limit: number };
    result: GuardWorkingTreeLockedDocHash[];
  };
  compareAndWriteDoc: {
    params: {
      principal: GuardPrincipal;
      id: string;
      expectedHash: string | null;
      expectedUpdatedAt: number | null;
      content: string;
      metadata?: Record<string, unknown>;
    };
    result: boolean;
  };
  deleteDoc: {
    params: { principal: GuardPrincipal; id: string };
    result: boolean;
  };
  compareAndDeleteDoc: {
    params: {
      principal: GuardPrincipal;
      id: string;
      expectedHash: string;
      expectedUpdatedAt: number;
    };
    result: boolean;
  };
  "schema.inspect": {
    params: { principal: GuardPrincipal };
    result: GuardSchemaSnapshot;
  };
  "schema.plan": {
    params: { principal: GuardPrincipal; kind: GuardSchemaKind; ddl: string | string[] };
    result: GuardSchemaPlan;
  };
  "schema.apply": {
    params: {
      principal: GuardPrincipal;
      kind: GuardSchemaKind;
      ddl: string | string[];
      approved: true;
      requestedBy?: string;
    };
    result: { ok: true };
  };
}

export type GuardRpcMethod = keyof GuardRpcMethods;

export type GuardRpcRequest<M extends GuardRpcMethod = GuardRpcMethod> = M extends GuardRpcMethod
  ? {
      id: string | number;
      method: M;
      params: GuardRpcMethods[M]["params"];
      /** Core-selected execution budget; Guard clamps it to its hard ceiling. */
      deadlineMs?: number;
    }
  : never;

export type GuardRpcSuccess<M extends GuardRpcMethod = GuardRpcMethod> = M extends GuardRpcMethod
  ? { id: string | number; result: GuardRpcMethods[M]["result"] }
  : never;

export interface GuardRpcFailure {
  id: string | number | null;
  error: {
    code: string;
    message: string;
  };
}

export type GuardRpcResponse<M extends GuardRpcMethod = GuardRpcMethod> =
  | GuardRpcSuccess<M>
  | GuardRpcFailure;

export interface GuardReadyMessage {
  type: "ready";
  port: number;
  executorPid: number;
}

export interface GuardShutdownMessage {
  type: "shutdown";
}

export interface GuardPingMessage {
  type: "ping";
  nonce: number;
}

export interface GuardPongMessage {
  type: "pong";
  nonce: number;
}

/** Runtime descriptor useful to the Core client and compatibility checks. */
export const GUARD_RPC_DESCRIPTOR = Object.freeze({
  version: 1,
  transport: "http-json-rpc" as const,
  host: "127.0.0.1" as const,
  healthPath: "/health" as const,
  rpcPath: "/rpc" as const,
  cancelPath: "/cancel" as const,
  methods: [
    "query",
    "mutate",
    "transaction",
    "writeEvent",
    "writeDoc",
    "readDocForWorkingTree",
    "listLockedDocHashesForWorkingTree",
    "compareAndWriteDoc",
    "deleteDoc",
    "compareAndDeleteDoc",
    "schema.inspect",
    "schema.plan",
    "schema.apply",
  ] as const,
  minimumNode: "24.10.0" as const,
});
