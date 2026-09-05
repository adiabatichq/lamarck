import type { JsonValue } from "./json";
import type { EventInput } from "./guard-types";
import type {
  GuardEventPrincipal,
  GuardMutationResult,
  GuardPrincipal,
  GuardSchemaPlan,
  GuardSchemaSnapshot,
  GuardSqlParams,
  GuardStatement as RpcGuardStatement,
  GuardTransactionStatementResult,
} from "./guard-service/protocol";

export interface GuardBinding {
  source: string;
  /** Host-established Producer Descriptor ref; callers cannot override it per event. */
  producerRef: string;
  /** Publishes/verifies the bound descriptor before an operation can produce D0. */
  prepareProducer?: () => void | Promise<void>;
  /** null means trusted host access; an array is an exact D2 table allowlist. */
  writeTables: string[] | null;
  /** Only the authenticated host schema approval path receives this grant. */
  schemaGrant: boolean;
}

export interface GuardStatement {
  sql: string;
  params?: GuardSqlParams;
}

export type GuardStatementResult = GuardMutationResult;

export type SchemaSnapshot = GuardSchemaSnapshot;
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
  constructor(
    private readonly rpc: GuardRpcClient,
    private readonly binding: GuardBinding,
    private readonly execution: GuardExecutionOptions = {
      deadlineMs: BACKGROUND_GUARD_DEADLINE_MS,
    },
  ) {}

  static fromEnvironment(
    source: string,
    producerRef: string,
    prepareProducer?: () => void | Promise<void>,
  ): RemoteGuard {
    const origin = process.env.LAMARCK_GUARD_ORIGIN;
    const token = process.env.LAMARCK_GUARD_TOKEN;
    if (!origin || !token) {
      throw new Error("Guard service configuration is missing");
    }
    return new RemoteGuard(
      new GuardRpcClient(origin, token),
      {
        source,
        producerRef,
        prepareProducer,
        writeTables: null,
        schemaGrant: true,
      },
    );
  }

  async health(): Promise<void> {
    await this.rpc.health();
  }

  withSource(source: string, opts: {
    producerRef: string;
    prepareProducer?: () => void | Promise<void>;
    writeTables?: string[] | null;
    schemaGrant?: boolean;
    signal?: AbortSignal;
    deadlineMs?: number;
  }): RemoteGuard {
    const guard = new RemoteGuard(this.rpc, {
      source,
      producerRef: opts.producerRef,
      // Publication belongs to the new producer context and is never inherited
      // merely because a caller changed Source.
      prepareProducer: opts.prepareProducer,
      writeTables: opts?.writeTables === undefined
        ? this.binding.writeTables === null && !source.startsWith("system:")
          ? []
          : this.binding.writeTables
        : opts.writeTables,
      // Source rebinding is a privilege drop. Schema authority is never
      // inherited implicitly by app or connector facades.
      schemaGrant: opts?.schemaGrant ?? false,
    }, {
      signal: opts?.signal ?? this.execution.signal,
      deadlineMs: opts?.deadlineMs ?? this.execution.deadlineMs,
    });
    return guard;
  }

  withExecution(opts: GuardExecutionOptions): RemoteGuard {
    const guard = new RemoteGuard(this.rpc, this.binding, {
      signal: opts.signal,
      deadlineMs: positiveDeadline(opts.deadlineMs),
    });
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
    await this.prepareProducer();
    return this.call<GuardStatementResult>("mutate", {
      principal: this.principal(),
      sql,
      params,
    });
  }

  async transaction(statements: GuardStatement[]): Promise<GuardTransactionStatementResult[]> {
    await this.prepareProducer();
    return this.call<GuardTransactionStatementResult[]>("transaction", {
      principal: this.principal(),
      statements: statements as RpcGuardStatement[],
    });
  }

  async writeEvent(event: EventInput): Promise<string> {
    await this.prepareProducer();
    return this.call<string>("writeEvent", { principal: this.principal(), event });
  }

  async writeLifecycleEvent(event: EventInput): Promise<string> {
    await this.prepareProducer();
    return this.call<string>("writeLifecycleEvent", { principal: this.principal(), event });
  }

  async writeWorkspaceEvent(event: EventInput): Promise<string> {
    await this.prepareProducer();
    return this.call<string>("writeWorkspaceEvent", { principal: this.principal(), event });
  }

  async schemaInspect(): Promise<SchemaSnapshot> {
    return this.call<SchemaSnapshot>("schema.inspect", {
      principal: this.principal(),
    });
  }

  async schemaPlan(ddl: string | string[]): Promise<SchemaPlan> {
    return this.call<SchemaPlan>("schema.plan", {
      principal: this.principal(),
      ddl,
    });
  }

  async applySchemaPlan(
    plan: SchemaPlan,
    opts?: { approved?: boolean; author?: string; context?: string; eventPrincipal?: GuardEventPrincipal },
  ): Promise<void> {
    await this.prepareProducer();
    await this.call("schema.apply", {
      principal: this.principal(),
      plan,
      approved: opts?.approved === true,
      author: opts?.author,
      context: opts?.context,
      eventPrincipal: opts?.eventPrincipal,
    });
  }

  private principal(): GuardPrincipal {
    return {
      source: this.binding.source,
      producerRef: this.binding.producerRef,
      tableGrants: this.binding.writeTables ?? "*",
      schemaGrant: this.binding.schemaGrant,
    };
  }

  private call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.rpc.call<T>(method, params, this.execution);
  }

  private async prepareProducer(): Promise<void> {
    await this.binding.prepareProducer?.();
  }

}

function positiveDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Guard execution deadline must be a positive safe integer");
  }
  return value;
}

export type { EventInput, JsonValue };
