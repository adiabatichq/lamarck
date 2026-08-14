import type { DatabaseSync } from "node:sqlite";
import { D0_SCHEMA_VERSION } from "../../src/schema";
import type { EventInput } from "../../src/guard-types";
import { assertJsonValue } from "../../src/json";
import { ulid } from "../../src/utils/ulid";
import type { GuardSqlParams } from "../../src/guard-service/protocol";

export const TEST_PRODUCER_REF = `producer:v1:sha256:${"1".repeat(64)}`;

/** Minimal synchronous Guard double for connector unit tests. */
export class TestGuard {
  constructor(
    private readonly opts: { db: DatabaseSync; source: string; producerRef?: string },
  ) {}

  withSource(
    source: string,
    options?: {
      producerRef?: string;
      prepareProducer?: () => void | Promise<void>;
    },
  ): TestGuard {
    return new TestGuard({
      db: this.opts.db,
      source,
      producerRef: options?.producerRef ?? this.opts.producerRef ?? TEST_PRODUCER_REF,
    });
  }

  queryOne(sql: string, params?: GuardSqlParams): unknown | null {
    const statement = this.opts.db.prepare(sql);
    if (!params) return statement.get();
    return Array.isArray(params)
      ? statement.get(...params as any[])
      : statement.get(params as never);
  }

  query(sql: string, params?: GuardSqlParams): unknown[] {
    const statement = this.opts.db.prepare(sql);
    if (!params) return statement.all();
    return Array.isArray(params)
      ? statement.all(...params as any[])
      : statement.all(params as never);
  }

  writeEvent(event: EventInput): string {
    assertJsonValue(event.payload, "Test Guard event payload");
    const id = ulid();
    this.opts.db.prepare(
      `INSERT INTO events
        (id, schema_version, source, producer_ref, type, external_id, started_at, ended_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      event.schemaVersion ?? D0_SCHEMA_VERSION,
      this.opts.source,
      this.opts.producerRef ?? TEST_PRODUCER_REF,
      event.type,
      event.externalId ?? null,
      event.startedAt,
      event.endedAt ?? null,
      JSON.stringify(event.payload),
    );
    return id;
  }
}
