import type {
  ContentBlobRef,
  MutationResult,
  ResolveContentRefResult,
  SqlParams,
  SqlStatement,
  SystemInvoke,
  TransactionStatementResult,
  WriteEventInput,
} from "./protocol.js";

export interface System {
  query(sql: string, params?: SqlParams): Promise<{ rows: unknown[] }>;
  resolveContentRef(ref: ContentBlobRef): Promise<ResolveContentRefResult>;
  mutate(sql: string, params?: SqlParams): Promise<MutationResult>;
  transaction(statements: SqlStatement[]): Promise<TransactionStatementResult[]>;
  writeDoc(
    id: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ ok: true; id: string }>;
  deleteDoc(id: string): Promise<{ ok: true }>;
  writeEvent(event: WriteEventInput): Promise<{ ok: true; id: string }>;
}

export function createSystem(invoke: SystemInvoke): System {
  return Object.freeze({
    query: (sql: string, params?: SqlParams) => invoke(
      "query",
      params === undefined ? { sql } : { sql, params },
    ),
    resolveContentRef: (ref: ContentBlobRef) => invoke("resolveContentRef", { ref }),
    mutate: (sql: string, params?: SqlParams) => invoke(
      "mutate",
      params === undefined ? { sql } : { sql, params },
    ),
    transaction: (statements: SqlStatement[]) => invoke("transaction", { statements }),
    writeDoc: (id: string, content: string, metadata?: Record<string, unknown>) => invoke(
      "writeDoc",
      metadata === undefined ? { id, content } : { id, content, metadata },
    ),
    deleteDoc: (id: string) => invoke("deleteDoc", { id }),
    writeEvent: (event: WriteEventInput) => invoke("writeEvent", event),
  });
}
