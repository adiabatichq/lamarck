import type { DatabaseSync } from "node:sqlite";
import { validateDocId } from "./doc-id";

const CONTENT_HASH = /^[0-9a-f]{64}$/;

export interface WorkingTreeMirrorRecord {
  docId: string;
  contentHash: string;
  baselineLocked: boolean;
  databaseUpdatedAt: number;
  verifiedAt: number;
}

export interface WorkingTreeConflictRecord {
  docId: string;
  baselineHash: string | null;
  baselineLocked: boolean | null;
  baselineDatabaseUpdatedAt: number | null;
  databaseHash: string | null;
  fileHash: string | null;
  detectedAt: number;
  updatedAt: number;
}

export interface WorkingTreeProtectedHashRecord {
  contentHash: string;
  protectedAt: number;
}

interface MirrorRow {
  doc_id: string;
  content_hash: string;
  baseline_locked: number;
  database_updated_at: number;
  verified_at: number;
}

interface ConflictRow {
  doc_id: string;
  baseline_hash: string | null;
  baseline_locked: number | null;
  baseline_database_updated_at: number | null;
  database_hash: string | null;
  file_hash: string | null;
  detected_at: number;
  updated_at: number;
}

interface ProtectedHashRow {
  content_hash: string;
  protected_at: number;
}

/**
 * Device-local reconciliation bookkeeping for the D1 working tree. The store
 * deliberately persists hashes, lock state, and the last-converged D1 revision
 * only; document content remains in data.db and the pages/ materialization.
 */
export class WorkingTreeStateStore {
  private savepointSequence = 0;

  constructor(private readonly db: DatabaseSync) {}

  listMirrors(): WorkingTreeMirrorRecord[] {
    const rows = this.db.prepare(
      `SELECT doc_id, content_hash, baseline_locked, database_updated_at, verified_at
       FROM d1_working_tree_mirrors
       ORDER BY doc_id`,
    ).all() as unknown as MirrorRow[];
    return rows.map(mirrorFromRow);
  }

  getMirror(docId: string): WorkingTreeMirrorRecord | undefined {
    validateDocId(docId);
    const row = this.db.prepare(
      `SELECT doc_id, content_hash, baseline_locked, database_updated_at, verified_at
       FROM d1_working_tree_mirrors
       WHERE doc_id = ?`,
    ).get(docId) as MirrorRow | undefined;
    return row ? mirrorFromRow(row) : undefined;
  }

  upsertMirror(record: WorkingTreeMirrorRecord): void {
    validateMirror(record);
    this.upsertMirrorUnchecked(record);
  }

  deleteMirror(docId: string): boolean {
    validateDocId(docId);
    const result = this.db.prepare(
      "DELETE FROM d1_working_tree_mirrors WHERE doc_id = ?",
    ).run(docId);
    return Number(result.changes) > 0;
  }

  listConflicts(): WorkingTreeConflictRecord[] {
    const rows = this.db.prepare(
      `SELECT doc_id, baseline_hash, baseline_locked, baseline_database_updated_at,
              database_hash, file_hash,
              detected_at, updated_at
       FROM d1_working_tree_conflicts
       ORDER BY doc_id`,
    ).all() as unknown as ConflictRow[];
    return rows.map(conflictFromRow);
  }

  getConflict(docId: string): WorkingTreeConflictRecord | undefined {
    validateDocId(docId);
    const row = this.db.prepare(
      `SELECT doc_id, baseline_hash, baseline_locked, baseline_database_updated_at,
              database_hash, file_hash,
              detected_at, updated_at
       FROM d1_working_tree_conflicts
       WHERE doc_id = ?`,
    ).get(docId) as ConflictRow | undefined;
    return row ? conflictFromRow(row) : undefined;
  }

  upsertConflict(record: WorkingTreeConflictRecord): void {
    validateConflict(record);
    if (record.baselineLocked) {
      this.transaction(() => {
        this.upsertConflictUnchecked(record);
        this.protectContentHashUnchecked(record.baselineHash!, record.updatedAt);
      });
      return;
    }
    this.upsertConflictUnchecked(record);
  }

  deleteConflict(docId: string): boolean {
    validateDocId(docId);
    const result = this.db.prepare(
      "DELETE FROM d1_working_tree_conflicts WHERE doc_id = ?",
    ).run(docId);
    return Number(result.changes) > 0;
  }

  markConverged(record: WorkingTreeMirrorRecord): void {
    validateMirror(record);
    this.transaction(() => {
      this.db.prepare(
        "DELETE FROM d1_working_tree_conflicts WHERE doc_id = ?",
      ).run(record.docId);
      this.upsertMirrorUnchecked(record);
      if (record.baselineLocked) {
        this.protectContentHashUnchecked(record.contentHash, record.verifiedAt);
      }
    });
  }

  protectContentHash(contentHash: string, timestamp = Date.now()): void {
    validateHash(contentHash, "protected content hash");
    validateTimestamp(timestamp, "protectedAt");
    this.protectContentHashUnchecked(contentHash, timestamp);
  }

  isContentHashProtected(contentHash: string): boolean {
    validateHash(contentHash, "protected content hash");
    return this.db.prepare(
      `SELECT 1
       FROM d1_working_tree_protected_hashes
       WHERE content_hash = ?`,
    ).get(contentHash) !== undefined;
  }

  listProtectedContentHashes(): WorkingTreeProtectedHashRecord[] {
    const rows = this.db.prepare(
      `SELECT content_hash, protected_at
       FROM d1_working_tree_protected_hashes
       ORDER BY content_hash`,
    ).all() as unknown as ProtectedHashRow[];
    return rows.map((row) => ({
      contentHash: row.content_hash,
      protectedAt: row.protected_at,
    }));
  }

  markAbsent(docId: string): void {
    validateDocId(docId);
    this.transaction(() => {
      this.db.prepare(
        "DELETE FROM d1_working_tree_conflicts WHERE doc_id = ?",
      ).run(docId);
      this.db.prepare(
        "DELETE FROM d1_working_tree_mirrors WHERE doc_id = ?",
      ).run(docId);
    });
  }

  private upsertMirrorUnchecked(record: WorkingTreeMirrorRecord): void {
    this.db.prepare(
      `INSERT INTO d1_working_tree_mirrors
         (doc_id, content_hash, baseline_locked, database_updated_at, verified_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         baseline_locked = excluded.baseline_locked,
         database_updated_at = excluded.database_updated_at,
         verified_at = excluded.verified_at`,
    ).run(
      record.docId,
      record.contentHash,
      record.baselineLocked ? 1 : 0,
      record.databaseUpdatedAt,
      record.verifiedAt,
    );
  }

  private upsertConflictUnchecked(record: WorkingTreeConflictRecord): void {
    this.db.prepare(
      `INSERT INTO d1_working_tree_conflicts
         (doc_id, baseline_hash, baseline_locked, baseline_database_updated_at,
          database_hash, file_hash, detected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET
         baseline_hash = excluded.baseline_hash,
         baseline_locked = excluded.baseline_locked,
         baseline_database_updated_at = excluded.baseline_database_updated_at,
         database_hash = excluded.database_hash,
         file_hash = excluded.file_hash,
         detected_at = excluded.detected_at,
         updated_at = excluded.updated_at`,
    ).run(
      record.docId,
      record.baselineHash,
      record.baselineLocked === null ? null : record.baselineLocked ? 1 : 0,
      record.baselineDatabaseUpdatedAt,
      record.databaseHash,
      record.fileHash,
      record.detectedAt,
      record.updatedAt,
    );
  }

  private protectContentHashUnchecked(contentHash: string, timestamp: number): void {
    this.db.prepare(
      `INSERT INTO d1_working_tree_protected_hashes (content_hash, protected_at)
       VALUES (?, ?)
       ON CONFLICT(content_hash) DO NOTHING`,
    ).run(contentHash, timestamp);
  }

  private transaction(operation: () => void): void {
    if (!this.db.isTransaction) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        operation();
        this.db.exec("COMMIT");
      } catch (error) {
        if (this.db.isTransaction) {
          try { this.db.exec("ROLLBACK"); } catch {}
        }
        throw error;
      }
      return;
    }

    const savepoint = `d1_working_tree_state_${this.savepointSequence++}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      operation();
      this.db.exec(`RELEASE ${savepoint}`);
    } catch (error) {
      try { this.db.exec(`ROLLBACK TO ${savepoint}`); } catch {}
      try { this.db.exec(`RELEASE ${savepoint}`); } catch {}
      throw error;
    }
  }
}

function mirrorFromRow(row: MirrorRow): WorkingTreeMirrorRecord {
  return {
    docId: row.doc_id,
    contentHash: row.content_hash,
    baselineLocked: row.baseline_locked === 1,
    databaseUpdatedAt: row.database_updated_at,
    verifiedAt: row.verified_at,
  };
}

function conflictFromRow(row: ConflictRow): WorkingTreeConflictRecord {
  return {
    docId: row.doc_id,
    baselineHash: row.baseline_hash,
    baselineLocked: row.baseline_locked === null ? null : row.baseline_locked === 1,
    baselineDatabaseUpdatedAt: row.baseline_database_updated_at,
    databaseHash: row.database_hash,
    fileHash: row.file_hash,
    detectedAt: row.detected_at,
    updatedAt: row.updated_at,
  };
}

function validateMirror(record: WorkingTreeMirrorRecord): void {
  validateDocId(record.docId);
  validateHash(record.contentHash, "mirror contentHash");
  if (typeof record.baselineLocked !== "boolean") {
    throw new TypeError("Working-tree mirror baselineLocked must be a boolean");
  }
  validateTimestamp(record.databaseUpdatedAt, "mirror databaseUpdatedAt");
  validateTimestamp(record.verifiedAt, "mirror verifiedAt");
}

function validateConflict(record: WorkingTreeConflictRecord): void {
  validateDocId(record.docId);
  validateNullableHash(record.baselineHash, "conflict baselineHash");
  validateNullableHash(record.databaseHash, "conflict databaseHash");
  validateNullableHash(record.fileHash, "conflict fileHash");
  if (
    record.baselineLocked !== null
    && typeof record.baselineLocked !== "boolean"
  ) {
    throw new TypeError("Working-tree conflict baselineLocked must be a boolean or null");
  }
  if (record.baselineDatabaseUpdatedAt !== null) {
    validateTimestamp(
      record.baselineDatabaseUpdatedAt,
      "conflict baselineDatabaseUpdatedAt",
    );
  }
  const baselineAbsent = record.baselineHash === null;
  if (
    baselineAbsent !== (record.baselineLocked === null)
    || baselineAbsent !== (record.baselineDatabaseUpdatedAt === null)
  ) {
    throw new TypeError(
      "Working-tree conflict baseline hash, lock state, and database revision must all be present or absent",
    );
  }
  validateTimestamp(record.detectedAt, "conflict detectedAt");
  validateTimestamp(record.updatedAt, "conflict updatedAt");
  if (record.updatedAt < record.detectedAt) {
    throw new TypeError("Working-tree conflict updatedAt must not precede detectedAt");
  }
}

function validateNullableHash(value: string | null, label: string): void {
  if (value !== null) validateHash(value, label);
}

function validateHash(value: string, label: string): void {
  if (!CONTENT_HASH.test(value)) {
    throw new TypeError(`Working-tree ${label} must be a lowercase SHA-256 hash`);
  }
}

function validateTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Working-tree ${label} must be a non-negative safe integer`);
  }
}
