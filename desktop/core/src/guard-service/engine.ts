import {
  DatabaseSync,
  constants,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { D0_SCHEMA_VERSION } from "../schema";
import { migrateDataDatabase } from "../data-migrations";
import { DATA_DB_FILENAME } from "../data-schema";
import { assertJsonValue, type JsonValue } from "../json";
import { parseProducerRef } from "../producer-descriptor";
import { foldSqliteIdentifier as normalizeName } from "../sqlite-identifiers";
import { ulid } from "../utils/ulid";
import type {
  GuardEventInput,
  GuardInteger,
  GuardMutationResult,
  GuardPrincipal,
  GuardRpcMethod,
  GuardSchemaKind,
  GuardSchemaPlan,
  GuardSchemaSnapshot,
  GuardSqlParam,
  GuardSqlParams,
  GuardStatement,
  GuardTransactionStatementResult,
} from "./protocol";

export { DATA_DB_FILENAME };

const SYSTEM_TABLES = new Set(["events"]);
const SYSTEM_TABLE_PREFIXES = ["sqlite_", "pragma_", "_lamarck_", "connector_", "auth_"];
const SAFE_EPONYMOUS_READS = new Set(["json_each", "json_tree"]);
const RESERVED_EVENT_TYPE_PREFIXES = [
  "connector.",
  "workspace.",
  "ddl.",
  "app.created",
  "app.archived",
];

const CDC_TABLE = "_lamarck_cdc_rows";
const CDC_TRIGGER_PREFIX = "_lamarck_cdc_";
const CDC_SCALAR_ENCODER = "_lamarck_encode_cdc_scalar";
const DEFAULT_MAX_RESULT_ROWS = 10_000;
const DEFAULT_MAX_RESULT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_AUDIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SQL_BYTES = 256 * 1024;
// The synchronous SQLite owner is disposable, but one result value is fully
// materialized by node:sqlite before Guard can apply its JSON result limit.
// Bound SQLite's allocator inside that process so expressions such as
// randomblob(1e9) fail with SQLITE_NOMEM instead of exhausting the host.
const SQLITE_HARD_HEAP_LIMIT_BYTES = 256 * 1024 * 1024;
const MAX_TRANSACTION_STATEMENTS = 100;

type DmlOp = "insert" | "update" | "delete";

interface TableColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
  hidden?: number;
}

interface PlannedWrite {
  op: DmlOp;
  table: string;
  triggerOrView: string | null;
}

interface QueryPolicy {
  mode: "query";
}

interface D0Policy {
  mode: "d0";
}

interface MutatePolicy {
  mode: "mutate";
  principal: NormalizedPrincipal;
  writes: PlannedWrite[];
}

interface SchemaPolicy {
  mode: "schema";
  kind: GuardSchemaKind;
  objects: Set<string>;
  tableObjects: Set<string>;
  indexTables: Set<string>;
}

interface InternalPolicy {
  mode: "internal";
}

interface DenyPolicy {
  mode: "deny";
}

type AuthorizerPolicy = QueryPolicy | D0Policy | MutatePolicy | SchemaPolicy | InternalPolicy | DenyPolicy;

interface NormalizedPrincipal {
  source: string;
  producerRef: string;
  tableGrants: "*" | Set<string>;
  schemaGrant: boolean;
}

interface CdcRow {
  seq: number;
  table: string;
  op: DmlOp;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

interface MutationContext {
  transactionId?: string;
  statementIndex?: number;
  auditBudget?: { bytes: number };
}

interface SchemaTargets {
  objects: Set<string>;
  tableObjects: Set<string>;
  indexTables: Set<string>;
}

export interface GuardEngineOptions {
  workspacePath: string;
  maxResultRows?: number;
  maxResultBytes?: number;
  maxAuditBytes?: number;
  maxSqlBytes?: number;
}

export class GuardServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GuardServiceError";
  }
}

/**
 * The sole owner of a workspace's data.db connection.
 *
 * This class deliberately has no system.db path or handle. All untrusted SQL is
 * prepared and executed while a sqlite authorizer policy is installed. Internal
 * BEGIN/COMMIT, audit writes, and schema setup use short explicit internal
 * scopes; the connection otherwise defaults to deny-all.
 */
export class GuardEngine {
  readonly databasePath: string;

  private readonly db: DatabaseSync;
  private readonly maxResultRows: number;
  private readonly maxResultBytes: number;
  private readonly maxAuditBytes: number;
  private readonly maxSqlBytes: number;
  private policy: AuthorizerPolicy = { mode: "deny" };
  private closed = false;
  private readonly uncapturableTables = new Map<string, string>();
  private readonly primaryKeyColumnsByTable = new Map<string, Set<string>>();
  private deniedPrimaryKeyMutation: string | null = null;
  private readonly mainRelations = new Set<string>();

  constructor(opts: GuardEngineOptions) {
    const workspacePath = resolveRequiredWorkspacePath(opts.workspacePath);
    const lamarckDir = join(workspacePath, ".lamarck");
    mkdirSync(lamarckDir, { recursive: true });

    this.databasePath = join(lamarckDir, DATA_DB_FILENAME);
    this.maxResultRows = positiveLimit(opts.maxResultRows, DEFAULT_MAX_RESULT_ROWS, "maxResultRows");
    this.maxResultBytes = positiveLimit(opts.maxResultBytes, DEFAULT_MAX_RESULT_BYTES, "maxResultBytes");
    this.maxAuditBytes = positiveLimit(opts.maxAuditBytes, DEFAULT_MAX_AUDIT_BYTES, "maxAuditBytes");
    this.maxSqlBytes = positiveLimit(opts.maxSqlBytes, DEFAULT_MAX_SQL_BYTES, "maxSqlBytes");

    this.db = new DatabaseSync(this.databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });

    try {
      this.db.exec(`PRAGMA hard_heap_limit = ${SQLITE_HARD_HEAP_LIMIT_BYTES}`);
      this.db.enableDefensive(true);
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA recursive_triggers = ON");
      this.db.exec("PRAGMA trusted_schema = OFF");
      migrateDataDatabase(this.db);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.function(
        CDC_SCALAR_ENCODER,
        { deterministic: true, useBigIntArguments: true },
        encodeCdcScalar,
      );

      if (typeof this.db.setAuthorizer !== "function") {
        throw new GuardServiceError(
          "GUARD_NODE_VERSION",
          "Guard requires Node.js 24.10.0 or newer (node:sqlite setAuthorizer is unavailable)",
        );
      }
      this.db.setAuthorizer((action, arg1, arg2, dbName, triggerOrView) =>
        this.authorize(action, arg1, arg2, dbName, triggerOrView)
      );
      this.assertD2PrimaryKeys();
      this.refreshCdcCapture();
    } catch (error) {
      try { this.db.close(); } catch {}
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.policy = { mode: "deny" };
    this.db.setAuthorizer(null);
    this.db.close();
  }

  health(): { ok: true; schemaVersion: string; database: "data.db" } {
    this.assertOpen();
    this.withPolicy({ mode: "internal" }, () => this.db.prepare("SELECT 1").get());
    return { ok: true, schemaVersion: D0_SCHEMA_VERSION, database: "data.db" };
  }

  query(
    principalInput: GuardPrincipal,
    sql: string,
    params?: GuardSqlParams,
  ): Array<Record<string, unknown>> {
    this.assertOpen();
    normalizePrincipal(principalInput);
    const statementSql = this.validateSql(sql, "system.query");
    const bound = normalizeParams(params);

    return this.withPolicy({ mode: "query" }, () => {
      const statement = this.db.prepare(statementSql);
      if (statement.columns().length === 0) {
        throw new GuardServiceError("GUARD_QUERY_REQUIRED", "Guard: system.query requires a relational result");
      }
      return executeRows(statement, bound, {
        maxRows: this.maxResultRows,
        maxBytes: this.maxResultBytes,
        mustComplete: false,
      });
    });
  }

  mutate(
    principalInput: GuardPrincipal,
    sql: string,
    params?: GuardSqlParams,
  ): GuardMutationResult {
    this.assertOpen();
    const principal = normalizePrincipal(principalInput);
    const statementSql = this.validateSql(sql, "system.mutate");
    const bound = normalizeParams(params);

    this.beginImmediate();
    try {
      const result = this.executeMutation(principal, statementSql, bound, {});
      this.commit();
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  transaction(
    principalInput: GuardPrincipal,
    statements: GuardStatement[],
  ): GuardTransactionStatementResult[] {
    this.assertOpen();
    const principal = normalizePrincipal(principalInput);
    if (!Array.isArray(statements) || statements.length === 0) {
      throw new GuardServiceError(
        "GUARD_TRANSACTION_EMPTY",
        "Guard: system.transaction requires at least one statement",
      );
    }
    if (statements.length > MAX_TRANSACTION_STATEMENTS) {
      throw new GuardServiceError(
        "GUARD_TRANSACTION_LIMIT",
        `Guard: system.transaction accepts at most ${MAX_TRANSACTION_STATEMENTS} statements`,
      );
    }

    const normalized = statements.map((statement, index) => {
      if (!statement || typeof statement !== "object") {
        throw new GuardServiceError(
          "GUARD_INVALID_REQUEST",
          `Guard: transaction statement ${index} must be an object`,
        );
      }
      return {
        sql: this.validateSql(statement.sql, `system.transaction[${index}]`),
        params: normalizeParams(statement.params),
      };
    });

    const transactionId = ulid();
    const results: GuardTransactionStatementResult[] = [];
    const auditBudget = { bytes: 0 };
    let resultBytes = 0;
    const appendResult = (result: GuardTransactionStatementResult) => {
      resultBytes += jsonByteLength(result);
      if (resultBytes > this.maxResultBytes) {
        throw new GuardServiceError(
          "GUARD_RESULT_LIMIT",
          `Guard: transaction result exceeds ${this.maxResultBytes} bytes`,
        );
      }
      results.push(result);
    };
    this.beginImmediate();
    try {
      for (let index = 0; index < normalized.length; index += 1) {
        const item = normalized[index];
        this.clearCdcRows();
        const policy: MutatePolicy = { mode: "mutate", principal, writes: [] };

        this.deniedPrimaryKeyMutation = null;
        let prepared: { rows: Array<Record<string, unknown>>; hasWrites: boolean };
        try {
          prepared = this.withPolicy(policy, () => {
            const statement = this.db.prepare(item.sql);
            if (policy.writes.length > 0) {
              this.assertWritesCapturable(policy.writes);
            } else if (statement.columns().length === 0) {
              throw new GuardServiceError(
                "GUARD_QUERY_REQUIRED",
                `Guard: transaction statement ${index} must be relational SQL or DML`,
              );
            }
            const rows = executeRows(statement, item.params, {
              maxRows: this.maxResultRows,
              maxBytes: this.maxResultBytes,
              mustComplete: policy.writes.length > 0,
            });
            return { rows, hasWrites: policy.writes.length > 0 };
          });
        } catch (error) {
          this.rethrowPrimaryKeyMutation(error);
        }

        if (!prepared.hasWrites) {
          appendResult({ kind: "query", rows: prepared.rows });
          continue;
        }

        const summary = this.readChangeSummary();
        const cdc = this.readCdcRows();
        const auditEventIds = this.writeMutationAudit(
          principal,
          item.sql,
          item.params,
          cdc,
          { transactionId, statementIndex: index, auditBudget },
        );
        appendResult({
          kind: "mutate",
          rows: prepared.rows,
          changes: summary.changes,
          lastInsertRowid: summary.lastInsertRowid,
          auditEventIds,
        });
      }
      this.commit();
      return results;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  writeEvent(principalInput: GuardPrincipal, event: GuardEventInput): string {
    this.assertOpen();
    const principal = normalizePrincipal(principalInput);
    validateEventInput(event);
    assertEventTypeAllowed(principal.source, event.type);

    return this.appendEvent(principal, event);
  }

  writeWorkspaceEvent(principalInput: GuardPrincipal, event: GuardEventInput): string {
    this.assertOpen();
    const principal = normalizePrincipal(principalInput);
    validateEventInput(event);
    if (!event.type.startsWith("workspace.") || event.externalId !== undefined) {
      throw new GuardServiceError(
        "GUARD_EVENT_NAMESPACE",
        "Guard: Host workspace events require workspace.* and external_id = null",
      );
    }
    return this.appendEvent(principal, event);
  }

  private appendEvent(principal: NormalizedPrincipal, event: GuardEventInput): string {
    const id = ulid();
    let resolvedId = id;
    this.beginImmediate();
    try {
      this.withPolicy({ mode: "d0" }, () => {
        const result = this.db.prepare(
          `INSERT INTO events
            (id, schema_version, source, producer_ref, type, external_id, started_at, ended_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
        ).run(
          id,
          event.schemaVersion ?? D0_SCHEMA_VERSION,
          principal.source,
          principal.producerRef,
          event.type,
          event.externalId ?? null,
          event.startedAt,
          event.endedAt ?? null,
          JSON.stringify(event.payload),
        );
        if (result.changes === 0 && event.externalId !== undefined) {
          const existing = this.db.prepare(
            "SELECT id FROM events WHERE source = ? AND external_id = ?",
          ).get(principal.source, event.externalId) as { id: string } | undefined;
          if (existing) {
            resolvedId = existing.id;
            return;
          }
        }
        assertSingleRowChange(result.changes, "D0 event insert");
      });
      this.commit();
      return resolvedId;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  schemaInspect(principalInput: GuardPrincipal): GuardSchemaSnapshot {
    this.assertOpen();
    const principal = normalizePrincipal(principalInput);
    assertSchemaGrant(principal);
    return this.snapshotSchema(true);
  }

  schemaPlan(
    principalInput: GuardPrincipal,
    kind: GuardSchemaKind,
    ddl: string | string[],
  ): GuardSchemaPlan {
    this.assertOpen();
    const principal = normalizePrincipal(principalInput);
    assertSchemaGrant(principal);
    const statements = normalizeDdl(ddl, kind);
    const targets = this.collectSchemaTargets(kind, statements);
    this.dryRunSchema(kind, statements, targets);
    return {
      kind,
      ddl: statements,
      beforeSchema: this.snapshotSchema(),
    };
  }

  schemaApply(
    principalInput: GuardPrincipal,
    kind: GuardSchemaKind,
    ddl: string | string[],
    approved: boolean,
    requestedBy?: string,
  ): { ok: true } {
    this.assertOpen();
    const principal = normalizePrincipal(principalInput);
    assertSchemaGrant(principal);
    if (approved !== true) {
      throw new GuardServiceError("GUARD_SCHEMA_APPROVAL", `Guard: ${kind} requires approval`);
    }
    const statements = normalizeDdl(ddl, kind);
    const targets = this.collectSchemaTargets(kind, statements);
    this.dryRunSchema(kind, statements, targets);

    const before = this.snapshotSchema();
    this.beginImmediate();
    try {
      for (const statement of statements) {
        this.executeSchemaStatement(kind, statement, targets);
      }
      this.assertNoSystemForeignKeys(targets.tableObjects);
      const after = this.snapshotSchema();
      // Rebuild row capture while the schema transaction is still open. A new
      // or altered table that cannot be captured never becomes durable.
      this.refreshCdcCapture(new Set([...targets.tableObjects, ...targets.indexTables]));
      this.logD0(principal, kind === "promote" ? "ddl.promote" : "ddl.demote", {
        ddl: statements,
        before_schema: before,
        after_schema: after,
        requested_by: requestedBy ?? null,
        schema_version: D0_SCHEMA_VERSION,
      });
      this.commit();
    } catch (error) {
      this.rollback();
      // TEMP schema changes roll back with the main transaction, but restore
      // the in-memory capability map as well.
      try { this.refreshCdcCapture(); } catch {}
      throw error;
    }
    return { ok: true };
  }

  dispatch(method: GuardRpcMethod, rawParams: unknown): unknown {
    const params = requireObject(rawParams, "params");
    switch (method) {
      case "query":
        return this.query(
          params.principal as GuardPrincipal,
          requireString(params.sql, "params.sql"),
          params.params as GuardSqlParams | undefined,
        );
      case "mutate":
        return this.mutate(
          params.principal as GuardPrincipal,
          requireString(params.sql, "params.sql"),
          params.params as GuardSqlParams | undefined,
        );
      case "transaction":
        return this.transaction(
          params.principal as GuardPrincipal,
          params.statements as GuardStatement[],
        );
      case "writeEvent":
        return this.writeEvent(params.principal as GuardPrincipal, params.event as GuardEventInput);
      case "writeWorkspaceEvent":
        return this.writeWorkspaceEvent(
          params.principal as GuardPrincipal,
          params.event as GuardEventInput,
        );
      case "schema.inspect":
        return this.schemaInspect(params.principal as GuardPrincipal);
      case "schema.plan":
        return this.schemaPlan(
          params.principal as GuardPrincipal,
          requireSchemaKind(params.kind),
          requireDdl(params.ddl),
        );
      case "schema.apply":
        return this.schemaApply(
          params.principal as GuardPrincipal,
          requireSchemaKind(params.kind),
          requireDdl(params.ddl),
          params.approved === true,
          params.requestedBy === undefined
            ? undefined
            : requireString(params.requestedBy, "params.requestedBy"),
        );
      default:
        throw new GuardServiceError("GUARD_METHOD_NOT_FOUND", `Unknown Guard RPC method: ${method}`);
    }
  }

  private executeMutation(
    principal: NormalizedPrincipal,
    sql: string,
    params: NormalizedParams,
    context: MutationContext,
  ): GuardMutationResult {
    this.clearCdcRows();
    const policy: MutatePolicy = { mode: "mutate", principal, writes: [] };
    this.deniedPrimaryKeyMutation = null;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = this.withPolicy(policy, () => {
        const statement = this.db.prepare(sql);
        if (policy.writes.length === 0) {
          throw new GuardServiceError(
            "GUARD_MUTATION_REQUIRED",
            "Guard: system.mutate requires one complete DML statement",
          );
        }
        this.assertWritesCapturable(policy.writes);
        return executeRows(statement, params, {
          maxRows: this.maxResultRows,
          maxBytes: this.maxResultBytes,
          mustComplete: true,
        });
      });
    } catch (error) {
      this.rethrowPrimaryKeyMutation(error);
    }
    const summary = this.readChangeSummary();
    const cdc = this.readCdcRows();
    const auditEventIds = this.writeMutationAudit(
      principal,
      sql,
      params,
      cdc,
      context,
    );
    return { rows, ...summary, auditEventIds };
  }

  private writeMutationAudit(
    principal: NormalizedPrincipal,
    sql: string,
    params: NormalizedParams,
    cdcRows: CdcRow[],
    context: MutationContext,
  ): string[] {
    const groups = groupCdcRows(cdcRows);
    if (groups.length === 0) return [];

    const eventIds: string[] = [];
    let statementAuditBytes = 0;
    for (const group of groups) {
      const columns = this.getTableColumns(group.table);
      const pkColumns = columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
      if (pkColumns.length === 0) {
        throw new GuardServiceError(
          "GUARD_D2_PRIMARY_KEY",
          `Every App-owned D2 table needs an explicit non-null primary key: ${group.table}`,
        );
      }
      const beforeRows = group.rows.flatMap((row) => row.before ? [row.before] : []);
      const afterRows = group.rows.flatMap((row) => row.after ? [row.after] : []);
      const pkSource = group.op === "delete" ? beforeRows : afterRows;
      const primaryKey = pkSource.map((row) =>
        Object.fromEntries(pkColumns.map((column) => [column, row[column]]))
      );
      const payload: Record<string, unknown> = {
        op: group.op,
        table: group.table,
        primary_key: primaryKey,
        before: group.op === "insert" ? null : beforeRows,
        after: group.op === "delete" ? null : afterRows,
        affected_rows: group.rows.length,
        sql: sql.slice(0, 500),
        params: paramsForAudit(params),
        schema_version: D0_SCHEMA_VERSION,
      };
      if (context.transactionId !== undefined) {
        payload.transaction_id = context.transactionId;
        payload.statement_index = context.statementIndex;
      }
      const payloadBytes = assertJsonSize(
        payload,
        this.maxAuditBytes,
        "Guard mutation audit payload",
      );
      statementAuditBytes += payloadBytes;
      if (statementAuditBytes > this.maxAuditBytes) {
        throw new GuardServiceError(
          "GUARD_AUDIT_LIMIT",
          `Guard: mutation audit exceeds ${this.maxAuditBytes} bytes`,
        );
      }
      if (context.auditBudget) {
        context.auditBudget.bytes += payloadBytes;
        if (context.auditBudget.bytes > this.maxAuditBytes) {
          throw new GuardServiceError(
            "GUARD_AUDIT_LIMIT",
            `Guard: transaction audit exceeds ${this.maxAuditBytes} bytes`,
          );
        }
      }
      eventIds.push(this.logD0(
        principal,
        `workspace.table.rows.${group.op === "insert" ? "inserted" : group.op === "update" ? "updated" : "deleted"}`,
        payload,
      ));
    }
    return eventIds;
  }

  private readChangeSummary(): { changes: number; lastInsertRowid: number | GuardInteger } {
    const row = this.withPolicy({ mode: "internal" }, () => {
      const statement = this.db.prepare(
        "SELECT changes() AS changes, last_insert_rowid() AS last_insert_rowid",
      );
      statement.setReadBigInts(true);
      return statement.get();
    }) as { changes: number | bigint; last_insert_rowid: number | bigint };
    return {
      changes: integerToNumber(row.changes, "changes"),
      lastInsertRowid: integerForJson(row.last_insert_rowid, "last_insert_rowid"),
    };
  }

  private readCdcRows(): CdcRow[] {
    const raw = this.withPolicy({ mode: "internal" }, () =>
      this.db.prepare(
        `SELECT seq, table_name, op, before_json, after_json
         FROM temp.${quoteIdent(CDC_TABLE)} ORDER BY seq`,
      ).all()
    ) as Array<{
      seq: number;
      table_name: string;
      op: DmlOp;
      before_json: string | null;
      after_json: string | null;
    }>;
    let bytes = 0;
    return raw.map((row) => {
      bytes += Buffer.byteLength(row.before_json ?? "", "utf8");
      bytes += Buffer.byteLength(row.after_json ?? "", "utf8");
      if (bytes > this.maxAuditBytes) {
        throw new GuardServiceError(
          "GUARD_AUDIT_LIMIT",
          `Guard: mutation audit exceeds ${this.maxAuditBytes} bytes`,
        );
      }
      return {
        seq: row.seq,
        table: row.table_name,
        op: row.op,
        before: row.before_json ? JSON.parse(row.before_json) : null,
        after: row.after_json ? JSON.parse(row.after_json) : null,
      };
    });
  }

  private clearCdcRows(): void {
    this.withPolicy({ mode: "internal" }, () => {
      this.db.exec(`DELETE FROM temp.${quoteIdent(CDC_TABLE)}`);
    });
  }

  private assertWritesCapturable(writes: PlannedWrite[]): void {
    for (const write of writes) {
      const failure = this.uncapturableTables.get(normalizeName(write.table));
      if (failure) {
        throw new GuardServiceError(
          "GUARD_CDC_UNAVAILABLE",
          `Guard: cannot audit writes to table ${write.table}: ${failure}`,
        );
      }
    }
  }

  private rethrowPrimaryKeyMutation(error: unknown): never {
    const target = this.deniedPrimaryKeyMutation;
    this.deniedPrimaryKeyMutation = null;
    if (target) {
      throw new GuardServiceError(
        "GUARD_D2_PRIMARY_KEY_MUTATION",
        `Primary keys are immutable; delete and insert the row instead: ${target}`,
      );
    }
    throw error;
  }

  private refreshCdcCapture(requiredTables?: Set<string>): void {
    this.withPolicy({ mode: "internal" }, () => {
      const oldTriggers = this.db.prepare(
        `SELECT name FROM temp.sqlite_schema
         WHERE type = 'trigger' AND name LIKE ?`,
      ).all(`${CDC_TRIGGER_PREFIX}%`) as Array<{ name: string }>;
      for (const trigger of oldTriggers) {
        this.db.exec(`DROP TRIGGER IF EXISTS temp.${quoteIdent(trigger.name)}`);
      }
      this.db.exec(`DROP TABLE IF EXISTS temp.${quoteIdent(CDC_TABLE)}`);
      this.db.exec(
        `CREATE TEMP TABLE ${quoteIdent(CDC_TABLE)} (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          op TEXT NOT NULL,
          before_json TEXT,
          after_json TEXT
        )`,
      );

      this.uncapturableTables.clear();
      this.primaryKeyColumnsByTable.clear();
      const tables = this.db.prepare(
        `SELECT name, sql FROM main.sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      ).all() as Array<{ name: string; sql: string | null }>;
      const views = this.db.prepare(
        "SELECT name FROM main.sqlite_schema WHERE type = 'view'",
      ).all() as Array<{ name: string }>;
      this.mainRelations.clear();
      this.mainRelations.add("sqlite_master");
      this.mainRelations.add("sqlite_schema");
      for (const relation of [...tables, ...views]) {
        this.mainRelations.add(normalizeName(relation.name));
      }
      let index = 0;
      for (const table of tables) {
        if (isSystemTable(table.name)) continue;
        try {
          const columns = this.getTableColumnsInternal(table.name);
          if (columns.length === 0) {
            throw new Error("table exposes no auditable columns");
          }
          if (/^CREATE\s+VIRTUAL\s+TABLE\b/i.test(table.sql ?? "")) {
            throw new Error("virtual tables are not supported by row CDC");
          }
          this.primaryKeyColumnsByTable.set(
            normalizeName(table.name),
            new Set(columns.filter((column) => column.pk > 0).map((column) => normalizeName(column.name))),
          );
          const before = jsonObjectExpression("OLD", columns);
          const after = jsonObjectExpression("NEW", columns);
          const tableName = sqlString(table.name);
          const qTable = quoteIdent(table.name);
          const triggerBase = `${CDC_TRIGGER_PREFIX}${index++}`;
          this.db.exec(
            `CREATE TEMP TRIGGER ${quoteIdent(`${triggerBase}_insert`)}
             AFTER INSERT ON main.${qTable}
             BEGIN
               INSERT INTO ${quoteIdent(CDC_TABLE)}
                 (table_name, op, before_json, after_json)
               VALUES (${tableName}, 'insert', NULL, ${after});
             END`,
          );
          this.db.exec(
            `CREATE TEMP TRIGGER ${quoteIdent(`${triggerBase}_update`)}
             AFTER UPDATE ON main.${qTable}
             BEGIN
               INSERT INTO ${quoteIdent(CDC_TABLE)}
                 (table_name, op, before_json, after_json)
               VALUES (${tableName}, 'update', ${before}, ${after});
             END`,
          );
          this.db.exec(
            `CREATE TEMP TRIGGER ${quoteIdent(`${triggerBase}_delete`)}
             AFTER DELETE ON main.${qTable}
             BEGIN
               INSERT INTO ${quoteIdent(CDC_TABLE)}
                 (table_name, op, before_json, after_json)
               VALUES (${tableName}, 'delete', ${before}, NULL);
             END`,
          );
        } catch (error) {
          this.uncapturableTables.set(normalizeName(table.name), errorMessage(error));
        }
      }

      if (requiredTables) {
        for (const table of requiredTables) {
          const failure = this.uncapturableTables.get(normalizeName(table));
          if (failure) {
            throw new GuardServiceError(
              "GUARD_CDC_UNAVAILABLE",
              `Guard: schema would create an unauditable table ${table}: ${failure}`,
            );
          }
        }
      }
    });
  }

  private getTableColumns(table: string): TableColumn[] {
    return this.withPolicy({ mode: "internal" }, () => this.getTableColumnsInternal(table));
  }

  private getTableColumnsInternal(table: string): TableColumn[] {
    return this.db.prepare(`PRAGMA main.table_xinfo(${quoteIdent(table)})`).all() as unknown as TableColumn[];
  }

  private assertNoSystemForeignKeys(tables: Set<string>): void {
    this.withPolicy({ mode: "internal" }, () => {
      for (const table of tables) {
        const foreignKeys = this.db.prepare(
          `PRAGMA main.foreign_key_list(${quoteIdent(table)})`,
        ).all() as Array<{ table: string }>;
        const systemTarget = foreignKeys.find((foreignKey) => isSystemTable(foreignKey.table));
        if (systemTarget) {
          throw new GuardServiceError(
            "GUARD_SYSTEM_FOREIGN_KEY",
            `Guard: D2 table ${table} cannot reference system table ${systemTarget.table}`,
          );
        }
      }
    });
  }

  private assertD2PrimaryKeys(onlyTables?: Set<string>): void {
    this.withPolicy({ mode: "internal" }, () => {
      const tables = this.db.prepare(
        `SELECT name, sql FROM main.sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      ).all() as Array<{ name: string; sql: string | null }>;
      for (const table of tables) {
        const normalized = normalizeName(table.name);
        if (isSystemTable(table.name) || (onlyTables && !onlyTables.has(normalized))) continue;
        const columns = this.getTableColumnsInternal(table.name);
        const primaryKey = columns.filter((column) => column.pk > 0);
        if (primaryKey.length === 0) {
          throw new GuardServiceError(
            "GUARD_D2_PRIMARY_KEY",
            `Every App-owned D2 table needs an explicit non-null primary key: ${table.name}`,
          );
        }
        const sql = table.sql ?? "";
        const tableProvidesNonNullPrimaryKey = /\bWITHOUT\s+ROWID\b/i.test(sql)
          || /(?:\)|,)\s*STRICT(?:\s*,\s*WITHOUT\s+ROWID)?\s*$/i.test(sql);
        const hasSeparatePrimaryKeyIndex = (this.db.prepare(
          `PRAGMA main.index_list(${quoteIdent(table.name)})`,
        ).all() as Array<{ origin: string }>).some((index) => index.origin === "pk");
        const invalid = primaryKey.find((column) => {
          const integerPrimaryKey = primaryKey.length === 1
            && normalizeName(column.type.trim()) === "integer"
            && !hasSeparatePrimaryKeyIndex;
          return column.notnull !== 1 && !integerPrimaryKey && !tableProvidesNonNullPrimaryKey;
        });
        if (invalid) {
          throw new GuardServiceError(
            "GUARD_D2_PRIMARY_KEY",
            `Every primary-key column must be non-null: ${table.name}.${invalid.name}`,
          );
        }
      }
    });
  }

  private snapshotSchema(includeSystemTables = false): GuardSchemaSnapshot {
    return this.withPolicy({ mode: "internal" }, () => {
      const tables = this.db.prepare(
        `SELECT name, sql FROM main.sqlite_schema
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           ${includeSystemTables ? "" : "AND name <> 'events'"}
         ORDER BY name`,
      ).all() as Array<{ name: string; sql: string }>;
      const indexes = this.db.prepare(
        `SELECT name, tbl_name AS table_name, sql FROM main.sqlite_schema
         WHERE type = 'index'
           AND name NOT LIKE 'sqlite_%'
           ${includeSystemTables ? "" : "AND tbl_name <> 'events'"}
         ORDER BY name`,
      ).all() as Array<{ name: string; table_name: string; sql: string | null }>;
      return {
        tables: tables.map((table) => ({
          name: table.name,
          sql: table.sql,
          columns: this.getTableColumnsInternal(table.name).map(({ hidden: _hidden, ...column }) => column),
        })),
        indexes: indexes.map((index) => ({
          name: index.name,
          table: index.table_name,
          sql: index.sql,
        })),
      };
    });
  }

  private collectSchemaTargets(kind: GuardSchemaKind, statements: string[]): SchemaTargets {
    const objects = new Set<string>();
    const tableObjects = new Set<string>();
    const indexTables = new Set<string>();
    for (const statement of statements) {
      const parsed = parseDdl(kind, statement);
      objects.add(normalizeName(parsed.object));
      if (parsed.table) indexTables.add(normalizeName(parsed.table));
      if (parsed.type === "table") tableObjects.add(normalizeName(parsed.object));
      if (parsed.type === "index" && kind === "demote") {
        const row = this.withPolicy({ mode: "internal" }, () =>
          this.db.prepare(
            "SELECT tbl_name FROM main.sqlite_schema WHERE type = 'index' AND lower(name) = lower(?)",
          ).get(parsed.object)
        ) as { tbl_name: string } | undefined;
        if (row?.tbl_name) indexTables.add(normalizeName(row.tbl_name));
      }
    }
    for (const name of [...objects, ...tableObjects, ...indexTables]) {
      if (isSystemTable(name)) {
        throw new GuardServiceError(
          "GUARD_SYSTEM_SCHEMA",
          `Guard: schema lifecycle cannot modify system table or namespace: ${name}`,
        );
      }
    }
    return { objects, tableObjects, indexTables };
  }

  private dryRunSchema(
    kind: GuardSchemaKind,
    statements: string[],
    targets: SchemaTargets,
  ): void {
    this.beginImmediate();
    try {
      for (const statement of statements) {
        this.executeSchemaStatement(kind, statement, targets);
      }
      this.assertNoSystemForeignKeys(targets.tableObjects);
      if (kind === "promote") this.assertD2PrimaryKeys(targets.tableObjects);
      this.rollback();
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  private executeSchemaStatement(
    kind: GuardSchemaKind,
    statement: string,
    targets: SchemaTargets,
  ): void {
    this.withPolicy(
      {
        mode: "schema",
        kind,
        objects: targets.objects,
        tableObjects: targets.tableObjects,
        indexTables: targets.indexTables,
      },
      () => this.db.exec(statement),
    );
  }

  private logD0(
    principal: Pick<NormalizedPrincipal, "source" | "producerRef">,
    type: string,
    payload: Record<string, unknown>,
  ): string {
    assertJsonSize(payload, this.maxAuditBytes, `Guard ${type} payload`);
    const id = ulid();
    const now = Date.now();
    this.withPolicy({ mode: "d0" }, () => {
      const result = this.db.prepare(
        `INSERT INTO events
          (id, schema_version, source, producer_ref, type, external_id, started_at, ended_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        D0_SCHEMA_VERSION,
        principal.source,
        principal.producerRef,
        type,
        null,
        now,
        null,
        JSON.stringify(payload),
      );
      assertSingleRowChange(result.changes, "D0 audit insert");
    });
    return id;
  }

  private beginImmediate(): void {
    this.withPolicy({ mode: "internal" }, () => this.db.exec("BEGIN IMMEDIATE"));
  }

  private commit(): void {
    this.withPolicy({ mode: "internal" }, () => this.db.exec("COMMIT"));
  }

  private rollback(): void {
    if (!this.db.isTransaction) return;
    try {
      this.withPolicy({ mode: "internal" }, () => this.db.exec("ROLLBACK"));
    } catch {}
  }

  private validateSql(sql: string, method: string): string {
    if (typeof sql !== "string") {
      throw new GuardServiceError("GUARD_INVALID_SQL", `Guard: ${method} requires SQL`);
    }
    if (Buffer.byteLength(sql, "utf8") > this.maxSqlBytes) {
      throw new GuardServiceError(
        "GUARD_SQL_LIMIT",
        `Guard: SQL exceeds ${this.maxSqlBytes} bytes`,
      );
    }
    return singleStatement(sql, method);
  }

  private withPolicy<T>(policy: AuthorizerPolicy, fn: () => T): T {
    if (this.policy.mode !== "deny") {
      throw new GuardServiceError("GUARD_REENTRANT", "Guard: reentrant database operation denied");
    }
    this.policy = policy;
    try {
      return fn();
    } finally {
      this.policy = { mode: "deny" };
    }
  }

  private authorize(
    action: number,
    arg1: string | null,
    arg2: string | null,
    dbName: string | null,
    triggerOrView: string | null,
  ): number {
    const policy = this.policy;
    if (policy.mode === "internal") return constants.SQLITE_OK;
    if (policy.mode === "deny") return constants.SQLITE_DENY;

    if (action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH) {
      return constants.SQLITE_DENY;
    }
    if (
      action === constants.SQLITE_TRANSACTION ||
      action === constants.SQLITE_SAVEPOINT ||
      action === constants.SQLITE_PRAGMA
    ) {
      return constants.SQLITE_DENY;
    }
    if (action === constants.SQLITE_FUNCTION) {
      const functionName = normalizeName(arg2 ?? "");
      if (functionName === "load_extension") return constants.SQLITE_DENY;
      if (functionName === CDC_SCALAR_ENCODER) {
        return triggerOrView?.startsWith(CDC_TRIGGER_PREFIX)
          ? constants.SQLITE_OK
          : constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    }
    if (action === constants.SQLITE_READ) {
      // Relational reads are unrestricted inside data.db, but the private TEMP
      // CDC substrate (and any future attached DB) is not part of system.query.
      const table = normalizeName(arg1 ?? "");
      if (
        policy.mode === "schema" &&
        policy.kind === "demote" &&
        dbName === "temp" &&
        table === "sqlite_temp_master"
      ) {
        return constants.SQLITE_OK;
      }
      // SQLite reports dbName=null for count(*) because its synthetic READ has
      // an empty column name. Resolve that narrow case against the main schema
      // snapshot instead of accidentally admitting a TEMP relation.
      if (
        dbName !== "main" &&
        !(dbName === null && (this.mainRelations.has(table) || SAFE_EPONYMOUS_READS.has(table)))
      ) {
        return constants.SQLITE_DENY;
      }
      if (
        table.startsWith("pragma_") ||
        table === "sqlite_dbpage" ||
        table === "sqlite_dbdata" ||
        table === "sqlite_dbptr"
      ) {
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    }
    if (action === constants.SQLITE_SELECT || action === constants.SQLITE_RECURSIVE) {
      return constants.SQLITE_OK;
    }

    if (policy.mode === "query") return constants.SQLITE_DENY;

    if (policy.mode === "d0") {
      const op = dmlOpForAction(action);
      return op === "insert" &&
          dbName === "main" &&
          normalizeName(arg1 ?? "") === "events" &&
          triggerOrView === null
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    }

    if (policy.mode === "mutate") {
      const op = dmlOpForAction(action);
      if (!op || !arg1) return constants.SQLITE_DENY;
      if (
        dbName === "temp" &&
        normalizeName(arg1) === CDC_TABLE &&
        triggerOrView?.startsWith(CDC_TRIGGER_PREFIX)
      ) {
        return constants.SQLITE_OK;
      }
      if (dbName !== "main") return constants.SQLITE_DENY;
      if (isSystemTable(arg1)) return constants.SQLITE_DENY;
      if (!hasTableGrant(policy.principal, arg1)) return constants.SQLITE_DENY;
      if (
        op === "update"
        && arg2
        && this.primaryKeyColumnsByTable.get(normalizeName(arg1))?.has(normalizeName(arg2))
      ) {
        this.deniedPrimaryKeyMutation = `${arg1}.${arg2}`;
        return constants.SQLITE_DENY;
      }
      policy.writes.push({ op, table: arg1, triggerOrView });
      return constants.SQLITE_OK;
    }

    return authorizeSchema(policy, action, arg1, arg2, dbName);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new GuardServiceError("GUARD_CLOSED", "Guard service is closed");
    }
  }
}

type NormalizedParams = SQLInputValue[] | Record<string, SQLInputValue>;

function normalizeParams(params: GuardSqlParams | undefined): NormalizedParams {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map((value, index) => normalizeParam(value, `params[${index}]`));
  if (!isPlainObject(params)) {
    throw new GuardServiceError(
      "GUARD_INVALID_PARAMS",
      "Guard: SQL params must be an array or named-parameter object",
    );
  }
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, normalizeParam(value, `params.${key}`)]),
  );
}

function normalizeParam(value: GuardSqlParam, path: string): SQLInputValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GuardServiceError("GUARD_INVALID_PARAMS", `Guard: ${path} must be finite`);
    }
    return value;
  }
  if (isPlainObject(value) && Object.keys(value).length === 1 && typeof value.$blobBase64 === "string") {
    if (!isCanonicalBase64(value.$blobBase64)) {
      throw new GuardServiceError("GUARD_INVALID_PARAMS", `Guard: ${path} is not canonical base64`);
    }
    return Buffer.from(value.$blobBase64, "base64");
  }
  throw new GuardServiceError(
    "GUARD_INVALID_PARAMS",
    `Guard: ${path} must be null, string, finite number, or {$blobBase64}`,
  );
}

function executeRows(
  statement: StatementSync,
  params: NormalizedParams,
  limits: { maxRows: number; maxBytes: number; mustComplete: boolean },
): Array<Record<string, unknown>> {
  // Keep SQLite INTEGER values exact until the JSON boundary. Without this,
  // node:sqlite rejects 64-bit values outside JavaScript's safe integer range
  // before jsonSafeSqlValue() can encode them losslessly.
  statement.setReadBigInts(true);
  statement.setAllowBareNamedParameters(true);
  if (statement.columns().length === 0) {
    runStatement(statement, params);
    return [];
  }

  const rows: Array<Record<string, unknown>> = [];
  let bytes = 0;
  let overflow: GuardServiceError | null = null;
  const iterator = iterateStatement(statement, params);
  for (const raw of iterator) {
    if (!overflow) {
      const row = jsonSafeRow(raw);
      const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
      if (rows.length >= limits.maxRows) {
        overflow = new GuardServiceError(
          "GUARD_RESULT_LIMIT",
          `Guard: result exceeds ${limits.maxRows} rows`,
        );
      } else if (bytes + rowBytes > limits.maxBytes) {
        overflow = new GuardServiceError(
          "GUARD_RESULT_LIMIT",
          `Guard: result exceeds ${limits.maxBytes} bytes`,
        );
      } else {
        rows.push(row);
        bytes += rowBytes;
      }
    }
    if (overflow && !limits.mustComplete) break;
  }
  if (overflow) throw overflow;
  return rows;
}

function runStatement(statement: StatementSync, params: NormalizedParams): void {
  if (Array.isArray(params)) statement.run(...params);
  else statement.run(params);
}

function iterateStatement(
  statement: StatementSync,
  params: NormalizedParams,
): NodeJS.Iterator<Record<string, SQLOutputValue>> {
  return Array.isArray(params) ? statement.iterate(...params) : statement.iterate(params);
}

function jsonSafeRow(row: Record<string, SQLOutputValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonSafeSqlValue(value)]));
}

function jsonSafeSqlValue(value: SQLOutputValue): unknown {
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : { $integer: value.toString() };
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return {
      $real: Number.isNaN(value) ? "NaN" : value < 0 ? "-Infinity" : "Infinity",
    };
  }
  if (ArrayBuffer.isView(value)) {
    return { $blobBase64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  }
  return value;
}

function normalizePrincipal(input: GuardPrincipal): NormalizedPrincipal {
  if (!input || typeof input !== "object") {
    throw new GuardServiceError("GUARD_INVALID_PRINCIPAL", "Guard: principal is required");
  }
  const source = requireString(input.source, "principal.source");
  if (source.trim() !== source || source.length > 200) {
    throw new GuardServiceError("GUARD_INVALID_PRINCIPAL", "Guard: invalid principal source");
  }
  let producerRef: string;
  try {
    producerRef = parseProducerRef(input.producerRef);
  } catch {
    throw new GuardServiceError(
      "GUARD_INVALID_PRINCIPAL",
      "Guard: invalid principal producerRef",
    );
  }
  let tableGrants: "*" | Set<string>;
  if (input.tableGrants === "*") {
    if (!source.startsWith("system:")) {
      throw new GuardServiceError(
        "GUARD_INVALID_PRINCIPAL",
        "Guard: wildcard D2 grants require a system source",
      );
    }
    tableGrants = "*";
  } else if (Array.isArray(input.tableGrants)) {
    tableGrants = new Set(input.tableGrants.map((table) => {
      if (typeof table !== "string" || table.trim() !== table || !table || table === "*") {
        throw new GuardServiceError("GUARD_INVALID_PRINCIPAL", "Guard: invalid D2 table grant");
      }
      return normalizeName(table);
    }));
  } else {
    throw new GuardServiceError("GUARD_INVALID_PRINCIPAL", "Guard: tableGrants are required");
  }

  const schemaGrant = input.schemaGrant === true;
  if (schemaGrant && !source.startsWith("system:")) {
    throw new GuardServiceError(
      "GUARD_SCHEMA_DENIED",
      "Guard: schema capability requires a system source",
    );
  }
  return { source, producerRef, tableGrants, schemaGrant };
}

function assertSchemaGrant(principal: NormalizedPrincipal): void {
  if (!principal.schemaGrant) {
    throw new GuardServiceError(
      "GUARD_SCHEMA_DENIED",
      `Guard: source ${principal.source} has no schema lifecycle capability`,
    );
  }
}

function hasTableGrant(principal: NormalizedPrincipal, table: string): boolean {
  return principal.tableGrants === "*" || principal.tableGrants.has(normalizeName(table));
}

function authorizeSchema(
  policy: SchemaPolicy,
  action: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
): number {
  if (dbName === "temp") {
    if (
      policy.kind === "demote" &&
      action === constants.SQLITE_DROP_TEMP_TRIGGER &&
      arg1?.startsWith(CDC_TRIGGER_PREFIX) &&
      arg2 &&
      policy.tableObjects.has(normalizeName(arg2))
    ) {
      // DROP TABLE automatically removes this connection's TEMP CDC triggers.
      return constants.SQLITE_OK;
    }
    if (
      policy.kind === "demote" &&
      dmlOpForAction(action) !== null &&
      normalizeName(arg1 ?? "") === "sqlite_temp_master" &&
      policy.tableObjects.size > 0
    ) {
      return constants.SQLITE_OK;
    }
    return constants.SQLITE_DENY;
  }
  if (dbName !== null && dbName !== "main") return constants.SQLITE_DENY;
  if (action === constants.SQLITE_REINDEX && arg1) {
    return policy.kind === "promote" && policy.objects.has(normalizeName(arg1))
      ? constants.SQLITE_OK
      : constants.SQLITE_DENY;
  }
  if (
    action === constants.SQLITE_DROP_TRIGGER &&
    policy.kind === "demote" &&
    arg2 &&
    policy.tableObjects.has(normalizeName(arg2))
  ) {
    // DROP TABLE removes main-schema triggers owned by that exact table.
    return constants.SQLITE_OK;
  }
  const createActions = new Set([
    constants.SQLITE_CREATE_TABLE,
    constants.SQLITE_CREATE_INDEX,
    constants.SQLITE_ALTER_TABLE,
  ]);
  const dropActions = new Set([constants.SQLITE_DROP_TABLE, constants.SQLITE_DROP_INDEX]);
  if (createActions.has(action) || dropActions.has(action)) {
    if (
      action === constants.SQLITE_CREATE_INDEX &&
      arg1?.startsWith("sqlite_autoindex_") &&
      arg2 &&
      policy.tableObjects.has(normalizeName(arg2))
    ) {
      // PRIMARY KEY / UNIQUE constraints create an engine-owned implicit
      // index while compiling CREATE TABLE.
      return constants.SQLITE_OK;
    }
    const name = action === constants.SQLITE_ALTER_TABLE ? arg2 : arg1;
    if (!name) return constants.SQLITE_DENY;
    if (
      action === constants.SQLITE_CREATE_TABLE &&
      normalizeName(name) === "sqlite_sequence" &&
      policy.kind === "promote" &&
      policy.tableObjects.size > 0
    ) {
      // SQLite creates this engine-owned table for an approved AUTOINCREMENT
      // table. User SQL cannot create reserved sqlite_* objects directly.
      return constants.SQLITE_OK;
    }
    if (isSystemTable(name)) return constants.SQLITE_DENY;
    if (policy.kind === "promote" && !createActions.has(action)) return constants.SQLITE_DENY;
    if (policy.kind === "demote" && !dropActions.has(action)) return constants.SQLITE_DENY;
    const normalizedName = normalizeName(name);
    if (action === constants.SQLITE_CREATE_TABLE || action === constants.SQLITE_ALTER_TABLE || action === constants.SQLITE_DROP_TABLE) {
      return policy.tableObjects.has(normalizedName) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    }
    if (!policy.objects.has(normalizedName)) return constants.SQLITE_DENY;
    return !arg2 || policy.indexTables.has(normalizeName(arg2))
      ? constants.SQLITE_OK
      : constants.SQLITE_DENY;
  }

  const op = dmlOpForAction(action);
  if (op && arg1) {
    const table = normalizeName(arg1);
    if (table === "sqlite_master" || table === "sqlite_schema") return constants.SQLITE_OK;
    if (
      table === "sqlite_sequence" &&
      policy.kind === "demote" &&
      policy.tableObjects.size > 0
    ) {
      return constants.SQLITE_OK;
    }
    // CREATE TABLE AS SELECT would insert data without D2 row audit, so promote
    // never permits target-table DML. DROP TABLE's implicit delete is allowed,
    // but cascades into any non-target table still fail closed.
    return policy.kind === "demote" && policy.tableObjects.has(table)
      ? constants.SQLITE_OK
      : constants.SQLITE_DENY;
  }
  return constants.SQLITE_DENY;
}

function dmlOpForAction(action: number): DmlOp | null {
  if (action === constants.SQLITE_INSERT) return "insert";
  if (action === constants.SQLITE_UPDATE) return "update";
  if (action === constants.SQLITE_DELETE) return "delete";
  return null;
}

function groupCdcRows(rows: CdcRow[]): Array<{ table: string; op: DmlOp; rows: CdcRow[] }> {
  const groups = new Map<string, { table: string; op: DmlOp; rows: CdcRow[] }>();
  for (const row of rows) {
    const key = `${normalizeName(row.table)}\u0000${row.op}`;
    const group = groups.get(key) ?? { table: row.table, op: row.op, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function paramsForAudit(params: NormalizedParams): JsonValue {
  if (Array.isArray(params)) return params.map(sqlInputForAudit);
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, sqlInputForAudit(value)]));
}

function sqlInputForAudit(value: SQLInputValue): JsonValue {
  if (ArrayBuffer.isView(value)) {
    return {
      $blobBase64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    };
  }
  if (typeof value === "bigint") return { $integer: value.toString() };
  return value;
}

function jsonObjectExpression(prefix: "OLD" | "NEW", columns: TableColumn[]): string {
  const pairs = columns.flatMap((column) => {
    const value = `${prefix}.${quoteIdent(column.name)}`;
    return [
      sqlString(column.name),
      `json(${CDC_SCALAR_ENCODER}(
        typeof(${value}),
        CASE WHEN typeof(${value}) = 'text' THEN CAST(${value} AS BLOB) ELSE ${value} END
      ))`,
    ];
  });
  return `json_object(${pairs.join(", ")})`;
}

function encodeCdcScalar(sqliteType: SQLInputValue, value: SQLInputValue): string {
  if (typeof sqliteType !== "string") {
    throw new GuardServiceError("GUARD_CDC_VALUE", "Guard: invalid SQLite type in CDC");
  }
  let encoded: unknown = value;
  if (sqliteType === "text") {
    if (!ArrayBuffer.isView(value)) {
      throw new GuardServiceError("GUARD_CDC_VALUE", "Guard: invalid TEXT bytes in CDC");
    }
    try {
      // ignoreBOM=true means the decoder does not consume a leading UTF-8 BOM;
      // U+FEFF remains part of the SQLite TEXT value and therefore the audit.
      encoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
    } catch {
      throw new GuardServiceError(
        "GUARD_CDC_TEXT_ENCODING",
        "Guard: D2 TEXT values must contain valid UTF-8",
      );
    }
  } else if (sqliteType === "integer" && typeof value === "bigint") {
    encoded = Number.isSafeInteger(Number(value))
      ? Number(value)
      : { $integer: value.toString() };
  } else if (sqliteType === "real" && typeof value === "number" && !Number.isFinite(value)) {
    encoded = {
      $real: Number.isNaN(value) ? "NaN" : value < 0 ? "-Infinity" : "Infinity",
    };
  } else if (sqliteType === "blob" && ArrayBuffer.isView(value)) {
    encoded = {
      $blobHex: Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        .toString("hex")
        .toUpperCase(),
    };
  }
  const json = JSON.stringify(encoded);
  if (json === undefined) {
    throw new GuardServiceError("GUARD_CDC_VALUE", "Guard: unsupported SQLite value in CDC");
  }
  return json;
}

function assertSingleRowChange(value: number | bigint, operation: string): void {
  if (value !== 1 && value !== 1n) {
    throw new GuardServiceError(
      "GUARD_SYSTEM_WRITE_SUPPRESSED",
      `Guard: ${operation} changed ${String(value)} rows instead of 1`,
    );
  }
}

function integerToNumber(value: number | bigint, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number)) {
    throw new GuardServiceError("GUARD_INTEGER_RANGE", `Guard: ${label} exceeds JSON integer range`);
  }
  return number;
}

function integerForJson(value: number | bigint, label: string): number | GuardInteger {
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value))
      ? Number(value)
      : { $integer: value.toString() };
  }
  if (!Number.isSafeInteger(value)) {
    throw new GuardServiceError("GUARD_INTEGER_RANGE", `Guard: ${label} is not an integer`);
  }
  return value;
}

function isSystemTable(table: string): boolean {
  const normalized = normalizeName(table);
  return SYSTEM_TABLES.has(normalized) || SYSTEM_TABLE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validateEventInput(event: GuardEventInput): void {
  if (!event || typeof event !== "object") {
    throw new GuardServiceError("GUARD_INVALID_EVENT", "Guard: event is required");
  }
  if (typeof event.type !== "string" || !event.type || event.type.trim() !== event.type) {
    throw new GuardServiceError("GUARD_INVALID_EVENT", "Guard: event requires a type");
  }
  if (!Number.isFinite(event.startedAt)) {
    throw new GuardServiceError("GUARD_INVALID_EVENT", "Guard: event requires a finite startedAt timestamp");
  }
  if (event.endedAt !== undefined && !Number.isFinite(event.endedAt)) {
    throw new GuardServiceError("GUARD_INVALID_EVENT", "Guard: event endedAt must be finite when provided");
  }
  if (event.schemaVersion !== undefined && typeof event.schemaVersion !== "string") {
    throw new GuardServiceError("GUARD_INVALID_EVENT", "Guard: event schemaVersion must be a string");
  }
  if (event.externalId !== undefined && typeof event.externalId !== "string") {
    throw new GuardServiceError("GUARD_INVALID_EVENT", "Guard: event externalId must be a string");
  }
  assertJsonValue(event.payload, "Guard event payload");
}

function assertEventTypeAllowed(source: string, type: string): void {
  if (source.startsWith("system:")) return;
  if (RESERVED_EVENT_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))) {
    throw new GuardServiceError(
      "GUARD_EVENT_NAMESPACE",
      `Guard: event type "${type}" is in a system-reserved namespace`,
    );
  }
}

function normalizeDdl(ddl: string | string[], kind: GuardSchemaKind): string[] {
  if (kind !== "promote" && kind !== "demote") {
    throw new GuardServiceError("GUARD_SCHEMA_KIND", "Guard: invalid schema lifecycle kind");
  }
  const raw = Array.isArray(ddl) ? ddl : splitStatements(ddl);
  const statements = raw.map((statement, index) => singleStatement(statement, `${kind}[${index}]`));
  if (statements.length === 0) {
    throw new GuardServiceError("GUARD_SCHEMA_EMPTY", `Guard: ${kind} requires at least one DDL statement`);
  }
  for (const statement of statements) parseDdl(kind, statement);
  return statements;
}

const IDENTIFIER = `(?:"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_]*)`;

function parseDdl(
  kind: GuardSchemaKind,
  statement: string,
): { type: "table" | "index"; object: string; table?: string } {
  const patterns = kind === "promote"
    ? [
        {
          type: "table" as const,
          regex: new RegExp(
            `^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})(?=\\s*\\()`,
            "i",
          ),
        },
        {
          type: "index" as const,
          regex: new RegExp(
            `^\\s*CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})\\s+ON\\s+(${IDENTIFIER})(?=\\s*\\()`,
            "i",
          ),
        },
        {
          type: "table" as const,
          regex: new RegExp(`^\\s*ALTER\\s+TABLE\\s+(${IDENTIFIER})\\s+ADD\\s+COLUMN\\b`, "i"),
        },
      ]
    : [
        {
          type: "table" as const,
          regex: new RegExp(`^\\s*DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENTIFIER})\\s*$`, "i"),
        },
        {
          type: "index" as const,
          regex: new RegExp(`^\\s*DROP\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?(${IDENTIFIER})\\s*$`, "i"),
        },
      ];
  for (const pattern of patterns) {
    const match = statement.match(pattern.regex);
    if (!match) continue;
    return {
      type: pattern.type,
      object: unquoteIdentifier(match[1]),
      table: match[2] ? unquoteIdentifier(match[2]) : undefined,
    };
  }
  throw new GuardServiceError(
    "GUARD_SCHEMA_SQL",
    `Guard: ${kind} DDL is not allowed: ${statement.slice(0, 80)}`,
  );
}

function unquoteIdentifier(value: string): string {
  if (value.startsWith('"')) return value.slice(1, -1).replace(/""/g, '"');
  if (value.startsWith("`")) return value.slice(1, -1).replace(/``/g, "`");
  if (value.startsWith("[")) return value.slice(1, -1);
  return value;
}

function singleStatement(sql: string, method: string): string {
  if (typeof sql !== "string" || sql.includes("\0")) {
    throw new GuardServiceError("GUARD_INVALID_SQL", `Guard: ${method} requires SQL`);
  }
  const trimmed = sql.trim();
  if (!trimmed || onlyWhitespaceAndComments(trimmed)) {
    throw new GuardServiceError("GUARD_INVALID_SQL", `Guard: ${method} requires SQL`);
  }
  const semicolon = firstSqlSemicolon(trimmed);
  if (semicolon === -1) return trimmed;
  const tail = trimmed.slice(semicolon + 1);
  if (!onlyWhitespaceAndComments(tail)) {
    throw new GuardServiceError(
      "GUARD_MULTIPLE_STATEMENTS",
      `Guard: ${method} accepts exactly one SQL statement`,
    );
  }
  return trimmed.slice(0, semicolon).trimEnd();
}

function splitStatements(sql: string): string[] {
  if (typeof sql !== "string") {
    throw new GuardServiceError("GUARD_SCHEMA_SQL", "Guard: DDL must be a string or string array");
  }
  const statements: string[] = [];
  let rest = sql;
  while (!onlyWhitespaceAndComments(rest)) {
    const index = firstSqlSemicolon(rest);
    if (index === -1) {
      statements.push(rest);
      break;
    }
    statements.push(rest.slice(0, index));
    rest = rest.slice(index + 1);
  }
  return statements.map((statement) => statement.trim()).filter(Boolean);
}

function firstSqlSemicolon(sql: string): number {
  let quote: "'" | '"' | "`" | "]" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (quote !== "]" && next === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "[") {
      quote = "]";
    } else if (char === ";") {
      return index;
    }
  }
  return -1;
}

function onlyWhitespaceAndComments(sql: string): boolean {
  return sql.replace(/--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\//g, "").trim().length === 0;
}

function assertJsonSize(value: unknown, maxBytes: number, label: string): number {
  const bytes = jsonByteLength(value);
  if (bytes > maxBytes) {
    throw new GuardServiceError("GUARD_AUDIT_LIMIT", `${label} exceeds ${maxBytes} bytes`);
  }
  return bytes;
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GuardServiceError("GUARD_CONFIG", `Guard: ${name} must be a positive integer`);
  }
  return value;
}

function resolveRequiredWorkspacePath(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GuardServiceError("GUARD_WORKSPACE", "Guard: workspace path is required");
  }
  return resolve(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new GuardServiceError("GUARD_INVALID_REQUEST", `Guard: ${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new GuardServiceError("GUARD_INVALID_REQUEST", `Guard: ${label} must be a non-empty string`);
  }
  return value;
}

function requireSchemaKind(value: unknown): GuardSchemaKind {
  if (value === "promote" || value === "demote") return value;
  throw new GuardServiceError("GUARD_SCHEMA_KIND", "Guard: schema kind must be promote or demote");
}

function requireDdl(value: unknown): string | string[] {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new GuardServiceError("GUARD_SCHEMA_SQL", "Guard: ddl must be a string or string array");
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
