import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { D0_SCHEMA_VERSION } from "../../src/schema";
import type { EventInput } from "../../src/guard-types";
import { docIdsHavePortableMaterializationConflict, validateDocId } from "../../src/doc-id";
import { assertJsonValue } from "../../src/json";
import { ulid } from "../../src/utils/ulid";
import type { GuardSqlParams } from "../../src/guard-service/protocol";

export const TEST_PRODUCER_REF = `producer:v1:sha256:${"1".repeat(64)}`;

const UNCONDITIONAL_DOC_MUTATION = Symbol("unconditional-doc-mutation");
type DocVersionExpectation = typeof UNCONDITIONAL_DOC_MUTATION | {
  hash: string | null;
  updatedAt: number | null;
};

/**
 * Minimal synchronous test double for modules whose production dependency is
 * the async Guard capability interface. Security policy is covered by the
 * Node 24 Guard suite; this helper intentionally does not parse arbitrary SQL.
 */
export class TestGuard {
  public onDocChange?: (id: string, content: string | null) => void | Promise<void>;
  public docChangeSubscribers: Array<(id: string) => void> = [];

  constructor(
    private readonly opts: { db: DatabaseSync; source: string; producerRef?: string },
  ) {}

  withSource(
    source: string,
    options?: {
      copyDocHook?: boolean;
      producerRef?: string;
      prepareProducer?: () => void | Promise<void>;
    },
  ): TestGuard {
    const guard = new TestGuard({
      db: this.opts.db,
      source,
      producerRef: options?.producerRef ?? this.opts.producerRef ?? TEST_PRODUCER_REF,
    });
    guard.docChangeSubscribers = this.docChangeSubscribers;
    if (options?.copyDocHook !== false) guard.onDocChange = this.onDocChange;
    return guard;
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

  writeDoc(id: string, content: string, metadata?: Record<string, unknown>): void {
    validateDocId(id);
    if (metadata !== undefined) assertJsonValue(metadata, "Test Guard doc metadata");
    this.writeDocTransaction(id, content, metadata, UNCONDITIONAL_DOC_MUTATION);
    this.notifyDocChange(id, content);
  }

  readDocForWorkingTree(id: string): {
    id: string;
    content: string;
    metadata: string | null;
    updatedAt: number;
  } | null {
    validateDocId(id);
    const row = this.opts.db.prepare(
      "SELECT id, content, metadata, updated_at FROM docs WHERE id = ?",
    ).get(id) as {
      id: string;
      content: string;
      metadata: string | null;
      updated_at: number;
    } | undefined;
    return row
      ? { id: row.id, content: row.content, metadata: row.metadata, updatedAt: row.updated_at }
      : null;
  }

  listLockedDocHashesForWorkingTree(
    afterId: string,
    limit: number,
  ): Array<{ id: string; contentHash: string }> {
    if (!this.opts.source.startsWith("system:")) {
      const error = new Error(
        "Guard: Working Tree locked document hashes require a system principal",
      );
      Object.assign(error, { code: "GUARD_DOC_PERMISSION" });
      throw error;
    }
    if (typeof afterId !== "string" || !Number.isSafeInteger(limit) || limit < 1 || limit > 512) {
      throw new Error("Guard: invalid Working Tree locked document hash page");
    }
    const rows = this.opts.db.prepare(
      `SELECT id, content
       FROM docs
       WHERE id > ?
         AND metadata IS NOT NULL
         AND json_valid(metadata)
         AND json_type(metadata, '$.locked') = 'true'
       ORDER BY id
       LIMIT ?`,
    ).all(afterId, limit) as unknown as Array<{ id: string; content: string }>;
    return rows.map((row) => ({ id: row.id, contentHash: hashDocContent(row.content) }));
  }

  async compareAndWriteDoc(
    id: string,
    expectedHash: string | null,
    expectedUpdatedAt: number | null,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    validateDocId(id);
    if (metadata !== undefined) assertJsonValue(metadata, "Test Guard doc metadata");
    validateExpectedDocVersion(expectedHash, expectedUpdatedAt);
    const applied = this.writeDocTransaction(id, content, metadata, {
      hash: expectedHash,
      updatedAt: expectedUpdatedAt,
    });
    if (applied) this.notifyDocChange(id, content);
    return applied;
  }

  private writeDocTransaction(
    id: string,
    content: string,
    metadata: Record<string, unknown> | undefined,
    expectation: DocVersionExpectation,
  ): boolean {
    return this.transaction(() => {
      const existing = this.opts.db.prepare(
        "SELECT content, metadata, updated_at FROM docs WHERE id = ?",
      ).get(id) as { content: string; metadata: string | null; updated_at: number } | undefined;
      if (!docMatchesExpectation(existing, expectation)) {
        return false;
      }
      if (!existing) {
        const collision = (this.opts.db.prepare("SELECT id FROM docs").all() as unknown as Array<{
          id: string;
        }>).find((row) => docIdsHavePortableMaterializationConflict(row.id, id));
        if (collision) {
          const error = new Error(
            `Guard: doc id ${JSON.stringify(id)} collides with portable Working Tree id ${JSON.stringify(collision.id)}`,
          );
          Object.assign(error, { code: "GUARD_DOC_PATH_COLLISION" });
          throw error;
        }
      }
      const storedMetadata = parseMetadata(existing?.metadata ?? null);
      let effectiveMetadata = resolveMetadata(storedMetadata, metadata);
      if (
        this.opts.source === "working-tree:pages"
        && this.hasLockedDocWithContentHash(hashDocContent(content))
      ) {
        effectiveMetadata = { ...(effectiveMetadata ?? {}), locked: true };
      }
      const suppressContentAudit = storedMetadata?.locked === true
        || effectiveMetadata?.locked === true;
      const now = Math.max(Date.now(), (existing?.updated_at ?? -1) + 1);
      this.opts.db.prepare(
        `INSERT INTO docs (id, content, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`,
      ).run(
        id,
        content,
        effectiveMetadata === null ? null : JSON.stringify(effectiveMetadata),
        now,
        now,
      );
      if (!suppressContentAudit) {
        this.writeEvent({
          type: "d1.write",
          startedAt: now,
          payload: { doc_id: id },
        });
      }
      return true;
    });
  }

  deleteDoc(id: string): boolean {
    validateDocId(id);
    const deleted = this.deleteDocTransaction(id, UNCONDITIONAL_DOC_MUTATION);
    if (deleted) this.notifyDocChange(id, null);
    return deleted;
  }

  async compareAndDeleteDoc(
    id: string,
    expectedHash: string,
    expectedUpdatedAt: number,
  ): Promise<boolean> {
    validateDocId(id);
    validateExpectedDocVersion(expectedHash, expectedUpdatedAt);
    const deleted = this.deleteDocTransaction(id, {
      hash: expectedHash,
      updatedAt: expectedUpdatedAt,
    });
    if (deleted) this.notifyDocChange(id, null);
    return deleted;
  }

  private deleteDocTransaction(
    id: string,
    expectation: DocVersionExpectation,
  ): boolean {
    return this.transaction(() => {
      const existing = this.opts.db.prepare(
        "SELECT content, metadata, updated_at FROM docs WHERE id = ?",
      ).get(id) as { content: string; metadata: string | null; updated_at: number } | undefined;
      if (!docMatchesExpectation(existing, expectation)) {
        return false;
      }
      if (!existing) return false;
      const storedMetadata = parseMetadata(existing.metadata);
      const now = Date.now();
      this.opts.db.prepare("DELETE FROM docs WHERE id = ?").run(id);
      if (storedMetadata?.locked !== true) {
        this.writeEvent({
          type: "d1.delete",
          startedAt: now,
          payload: { doc_id: id },
        });
      }
      return true;
    });
  }

  private hasLockedDocWithContentHash(contentHash: string): boolean {
    const rows = this.opts.db.prepare(
      `SELECT content
       FROM docs
       WHERE metadata IS NOT NULL
         AND json_valid(metadata)
         AND json_type(metadata, '$.locked') = 'true'`,
    ).iterate() as NodeJS.Iterator<{ content: string }>;
    for (const row of rows) {
      if (hashDocContent(row.content) === contentHash) return true;
    }
    return false;
  }

  private notifyDocChange(id: string, content: string | null): void {
    void this.onDocChange?.(id, content);
    for (const subscriber of this.docChangeSubscribers) subscriber(id);
  }

  private transaction<T>(operation: () => T): T {
    this.opts.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.opts.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.opts.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
}

function parseMetadata(serialized: string | null): Record<string, unknown> | null {
  if (serialized === null) return null;
  const metadata = JSON.parse(serialized) as unknown;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("Test Guard stored doc metadata must be an object");
  }
  return metadata as Record<string, unknown>;
}

function resolveMetadata(
  stored: Record<string, unknown> | null,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (incoming === undefined) return stored;
  const effective = { ...incoming };
  if (
    stored !== null
    && Object.hasOwn(stored, "locked")
    && !Object.hasOwn(incoming, "locked")
  ) {
    effective.locked = stored.locked;
  }
  return effective;
}

function hashDocContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function validateExpectedDocVersion(
  expectedHash: string | null,
  expectedUpdatedAt: number | null,
): void {
  if ((expectedHash === null) !== (expectedUpdatedAt === null)) {
    throw new Error("Guard: expected doc hash and updated_at must both be null or both exist");
  }
  if (
    expectedUpdatedAt !== null
    && (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0)
  ) {
    throw new Error("Guard: expected doc updated_at must be a nonnegative safe integer or null");
  }
}

function docMatchesExpectation(
  existing: { content: string; updated_at: number } | undefined,
  expectation: DocVersionExpectation,
): boolean {
  if (expectation === UNCONDITIONAL_DOC_MUTATION) return true;
  if (!existing) return expectation.hash === null && expectation.updatedAt === null;
  return expectation.hash !== null
    && hashDocContent(existing.content) === expectation.hash
    && existing.updated_at === expectation.updatedAt;
}
