import type { JsonValue } from "./json";
import type { DocOp, EventInput, SchemaOp } from "./guard-types";
import type {
  GuardMutationResult,
  GuardPrincipal,
  GuardSchemaPlan,
  GuardSqlParams,
  GuardStatement as RpcGuardStatement,
  GuardTransactionStatementResult,
  GuardWorkingTreeDoc,
  GuardWorkingTreeLockedDocHash,
} from "./guard-service/protocol";

export interface GuardBinding {
  source: string;
  /** null means trusted host access; an array is an exact D2 table allowlist. */
  writeTables: string[] | null;
  /** null means trusted host access; grants are exact doc ids or prefixes ending in '/'. */
  docGrants: string[] | null;
  /** Only the authenticated host schema approval path receives this grant. */
  schemaGrant: boolean;
}

export interface GuardStatement {
  sql: string;
  params?: GuardSqlParams;
}

export type GuardStatementResult = GuardMutationResult;

export interface SchemaSnapshot {
  tables: Array<{ name: string; sql: string; columns: unknown[] }>;
  indexes: Array<{ name: string; table: string; sql: string | null }>;
}

export type SchemaPlan = GuardSchemaPlan;

interface RpcResponse<T> {
  id: string;
  result?: T;
  error?: { message: string; code?: string };
}

export interface GuardExecutionOptions {
  signal?: AbortSignal;
  deadlineMs: number;
}

export const APP_GUARD_DEADLINE_MS = 10_000;
export const HOST_GUARD_DEADLINE_MS = 25_000;
export const BACKGROUND_GUARD_DEADLINE_MS = 45_000;
const GUARD_TRANSPORT_GRACE_MS = 5_000;
const GUARD_CANCEL_TIMEOUT_MS = 2_000;

export class GuardRpcClient {
  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}

  async call<T>(
    method: string,
    params: Record<string, unknown>,
    opts: GuardExecutionOptions = { deadlineMs: BACKGROUND_GUARD_DEADLINE_MS },
  ): Promise<T> {
    const id = crypto.randomUUID();
    const deadlineMs = positiveDeadline(opts.deadlineMs);
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onParentAbort, { once: true });
    const timeout = setTimeout(() => {
      const error = new Error("Guard RPC transport exceeded its deadline");
      Object.assign(error, { code: "GUARD_RPC_TIMEOUT" });
      controller.abort(error);
    }, deadlineMs + GUARD_TRANSPORT_GRACE_MS);
    timeout.unref?.();
    const cancel = () => { void this.cancel(id); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    if (opts.signal?.aborted) onParentAbort();

    try {
      const response = await fetch(`${this.origin}/rpc`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id, method, params, deadlineMs }),
        signal: controller.signal,
      });
      const payload = await response.json() as RpcResponse<T>;
      if (!response.ok || payload.error) {
        const error = new Error(payload.error?.message ?? `Guard service returned ${response.status}`);
        if (payload.error?.code) Object.assign(error, { code: payload.error.code });
        throw error;
      }
      return payload.result as T;
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onParentAbort);
      controller.signal.removeEventListener("abort", cancel);
    }
  }

  async health(): Promise<void> {
    const response = await fetch(`${this.origin}/health`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`Guard service health check failed: ${response.status}`);
  }

  private async cancel(id: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GUARD_CANCEL_TIMEOUT_MS);
    timeout.unref?.();
    try {
      await fetch(`${this.origin}/cancel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
        signal: controller.signal,
      });
    } catch {
      // The original request's socket close is an independent cancellation
      // path. The Guard hard deadline remains the final fail-closed bound.
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Async capability client for the Node Guard utility. It intentionally owns no
 * SQLite handle: production data access can only cross this RPC boundary.
 */
export class RemoteGuard {
  public onDocChange?: (id: string, content: string | null) => void | Promise<void>;
  public docChangeSubscribers: Array<(id: string) => void> = [];

  constructor(
    private readonly rpc: GuardRpcClient,
    private readonly binding: GuardBinding,
    private readonly execution: GuardExecutionOptions = {
      deadlineMs: BACKGROUND_GUARD_DEADLINE_MS,
    },
  ) {}

  static fromEnvironment(source = "system:server"): RemoteGuard {
    const origin = process.env.LAMARCK_GUARD_ORIGIN;
    const token = process.env.LAMARCK_GUARD_TOKEN;
    if (!origin || !token) {
      throw new Error("Guard service configuration is missing");
    }
    return new RemoteGuard(
      new GuardRpcClient(origin, token),
      { source, writeTables: null, docGrants: null, schemaGrant: true },
    );
  }

  async health(): Promise<void> {
    await this.rpc.health();
  }

  withSource(source: string, opts?: {
    writeTables?: string[] | null;
    docGrants?: string[] | null;
    schemaGrant?: boolean;
    copyDocHook?: boolean;
    signal?: AbortSignal;
    deadlineMs?: number;
  }): RemoteGuard {
    const guard = new RemoteGuard(this.rpc, {
      source,
      writeTables: opts?.writeTables === undefined
        ? this.binding.writeTables === null && !source.startsWith("system:")
          ? []
          : this.binding.writeTables
        : opts.writeTables,
      docGrants: opts?.docGrants === undefined ? this.binding.docGrants : opts.docGrants,
      // Source rebinding is a privilege drop. Schema authority is never
      // inherited implicitly by app, connector, or working-tree facades.
      schemaGrant: opts?.schemaGrant ?? false,
    }, {
      signal: opts?.signal ?? this.execution.signal,
      deadlineMs: opts?.deadlineMs ?? this.execution.deadlineMs,
    });
    guard.docChangeSubscribers = this.docChangeSubscribers;
    if (opts?.copyDocHook !== false) guard.onDocChange = this.onDocChange;
    return guard;
  }

  withExecution(opts: GuardExecutionOptions): RemoteGuard {
    const guard = new RemoteGuard(this.rpc, this.binding, {
      signal: opts.signal,
      deadlineMs: positiveDeadline(opts.deadlineMs),
    });
    guard.docChangeSubscribers = this.docChangeSubscribers;
    guard.onDocChange = this.onDocChange;
    return guard;
  }

  async query(sql: string, params?: GuardSqlParams): Promise<unknown[]> {
    return this.call<unknown[]>("query", { principal: this.principal(), sql, params });
  }

  async queryOne(sql: string, params?: GuardSqlParams): Promise<unknown | null> {
    const rows = await this.query(sql, params);
    return rows[0] ?? null;
  }

  async mutate(sql: string, params?: GuardSqlParams): Promise<GuardStatementResult> {
    return this.call<GuardStatementResult>("mutate", {
      principal: this.principal(),
      sql,
      params,
    });
  }

  async transaction(statements: GuardStatement[]): Promise<GuardTransactionStatementResult[]> {
    return this.call<GuardTransactionStatementResult[]>("transaction", {
      principal: this.principal(),
      statements: statements as RpcGuardStatement[],
    });
  }

  async writeEvent(event: EventInput): Promise<string> {
    return this.call<string>("writeEvent", { principal: this.principal(), event });
  }

  async writeDoc(id: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.call("writeDoc", {
      principal: this.principal(),
      id,
      content,
      metadata,
    });
    this.notifyDocChange(id, content);
  }

  async readDocForWorkingTree(id: string): Promise<GuardWorkingTreeDoc | null> {
    return this.call<GuardWorkingTreeDoc | null>("readDocForWorkingTree", {
      principal: this.principal(),
      id,
    });
  }

  async listLockedDocHashesForWorkingTree(
    afterId: string,
    limit: number,
  ): Promise<GuardWorkingTreeLockedDocHash[]> {
    return this.call<GuardWorkingTreeLockedDocHash[]>("listLockedDocHashesForWorkingTree", {
      principal: this.principal(),
      afterId,
      limit,
    });
  }

  async compareAndWriteDoc(
    id: string,
    expectedHash: string | null,
    expectedUpdatedAt: number | null,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const applied = await this.call<boolean>("compareAndWriteDoc", {
      principal: this.principal(),
      id,
      expectedHash,
      expectedUpdatedAt,
      content,
      metadata,
    });
    if (applied) this.notifyDocChange(id, content);
    return applied;
  }

  async deleteDoc(id: string): Promise<boolean> {
    const deleted = await this.call<boolean>("deleteDoc", {
      principal: this.principal(),
      id,
    });
    if (deleted) this.notifyDocChange(id, null);
    return deleted;
  }

  async compareAndDeleteDoc(
    id: string,
    expectedHash: string,
    expectedUpdatedAt: number,
  ): Promise<boolean> {
    const deleted = await this.call<boolean>("compareAndDeleteDoc", {
      principal: this.principal(),
      id,
      expectedHash,
      expectedUpdatedAt,
    });
    if (deleted) this.notifyDocChange(id, null);
    return deleted;
  }

  async schemaPlan(kind: SchemaOp, ddl: string | string[]): Promise<SchemaPlan> {
    return this.call<SchemaPlan>("schema.plan", {
      principal: this.principal(),
      kind,
      ddl,
    });
  }

  async schemaInspect(): Promise<SchemaSnapshot> {
    return this.call<SchemaSnapshot>("schema.inspect", {
      principal: this.principal(),
    });
  }

  async promote(ddl: string | string[], opts?: { approved?: boolean; requestedBy?: string }): Promise<void> {
    await this.applySchema("promote", ddl, opts);
  }

  async demote(ddl: string | string[], opts?: { approved?: boolean; requestedBy?: string }): Promise<void> {
    await this.applySchema("demote", ddl, opts);
  }

  private async applySchema(
    kind: SchemaOp,
    ddl: string | string[],
    opts?: { approved?: boolean; requestedBy?: string },
  ): Promise<void> {
    await this.call("schema.apply", {
      principal: this.principal(),
      kind,
      ddl,
      approved: opts?.approved === true,
      requestedBy: opts?.requestedBy,
    });
  }

  private principal(): GuardPrincipal {
    return {
      source: this.binding.source,
      tableGrants: this.binding.writeTables ?? "*",
      docGrants: this.binding.docGrants ?? "*",
      schemaGrant: this.binding.schemaGrant,
    };
  }

  private call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.rpc.call<T>(method, params, this.execution);
  }

  private notifyDocChange(id: string, content: string | null): void {
    try {
      Promise.resolve(this.onDocChange?.(id, content)).catch((err) => {
        console.error(`[guard] Doc materialization failed for ${id}:`, err);
      });
    } catch (err) {
      console.error(`[guard] Doc materialization failed for ${id}:`, err);
    }
    for (const subscriber of this.docChangeSubscribers) {
      try { subscriber(id); } catch {}
    }
  }
}

function positiveDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Guard execution deadline must be a positive safe integer");
  }
  return value;
}

export function appDocGrants(appId: string, declared: string[]): string[] {
  return [`apps/${appId}/`, ...declared];
}

export function canWriteDocFromGrants(grants: string[], id: string, _op: DocOp): boolean {
  return grants.some((grant) => grant.endsWith("/") ? id.startsWith(grant) : id === grant);
}

export type { EventInput, SchemaOp, JsonValue };
