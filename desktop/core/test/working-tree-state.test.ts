import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openSystemDatabase } from "../src/db";
import {
  WorkingTreeStateStore,
  type WorkingTreeConflictRecord,
  type WorkingTreeMirrorRecord,
} from "../src/working-tree-state";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

describe("WorkingTreeStateStore", () => {
  let workspace: string;
  let db: DatabaseSync;
  let store: WorkingTreeStateStore;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-working-tree-state-"));
    mkdirSync(join(workspace, ".lamarck"), { recursive: true });
    db = openSystemDatabase(workspace);
    store = new WorkingTreeStateStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("stores, updates, lists, and deletes mirror baselines", () => {
    const nested: WorkingTreeMirrorRecord = {
      docId: "筆記/mañana",
      contentHash: HASH_A,
      baselineLocked: false,
      databaseUpdatedAt: 95,
      verifiedAt: 100,
    };
    store.upsertMirror({
      docId: "z-last",
      contentHash: HASH_B,
      baselineLocked: true,
      databaseUpdatedAt: 85,
      verifiedAt: 90,
    });
    store.upsertMirror(nested);

    expect(store.getMirror(nested.docId)).toEqual(nested);
    expect(store.getMirror("missing")).toBeUndefined();
    expect(store.listMirrors().map((record) => record.docId))
      .toEqual(["z-last", "筆記/mañana"]);

    const updated = {
      ...nested,
      contentHash: HASH_C,
      baselineLocked: true,
      databaseUpdatedAt: 105,
      verifiedAt: 110,
    };
    store.upsertMirror(updated);
    expect(store.getMirror(nested.docId)).toEqual(updated);
    expect(store.deleteMirror(nested.docId)).toBe(true);
    expect(store.deleteMirror(nested.docId)).toBe(false);
  });

  test("stores durable exact-content protection fingerprints without content", () => {
    expect(store.isContentHashProtected(HASH_A)).toBe(false);

    store.protectContentHash(HASH_B, 200);
    store.protectContentHash(HASH_A, 100);
    store.protectContentHash(HASH_B, 300);

    expect(store.isContentHashProtected(HASH_A)).toBe(true);
    expect(store.listProtectedContentHashes()).toEqual([
      { contentHash: HASH_A, protectedAt: 100 },
      { contentHash: HASH_B, protectedAt: 200 },
    ]);

    const columns = db.prepare(
      "PRAGMA table_info(d1_working_tree_protected_hashes)",
    ).all() as unknown as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      "content_hash",
      "protected_at",
    ]);

    store.markAbsent("unrelated/document");
    expect(store.isContentHashProtected(HASH_A)).toBe(true);
  });

  test("stores absent sides without persisting document content", () => {
    const noBaseline: WorkingTreeConflictRecord = {
      docId: "new/conflict",
      baselineHash: null,
      baselineLocked: null,
      baselineDatabaseUpdatedAt: null,
      databaseHash: HASH_A,
      fileHash: null,
      detectedAt: 200,
      updatedAt: 200,
    };
    const withBaseline: WorkingTreeConflictRecord = {
      docId: "existing/conflict",
      baselineHash: HASH_A,
      baselineLocked: true,
      baselineDatabaseUpdatedAt: 90,
      databaseHash: HASH_B,
      fileHash: HASH_C,
      detectedAt: 100,
      updatedAt: 150,
    };
    const unavailableSides: WorkingTreeConflictRecord = {
      docId: "unsafe/path",
      baselineHash: null,
      baselineLocked: null,
      baselineDatabaseUpdatedAt: null,
      databaseHash: null,
      fileHash: null,
      detectedAt: 250,
      updatedAt: 250,
    };
    store.upsertConflict(noBaseline);
    store.upsertConflict(withBaseline);
    store.upsertConflict(unavailableSides);

    expect(store.getConflict(noBaseline.docId)).toEqual(noBaseline);
    expect(store.getConflict(withBaseline.docId)).toEqual(withBaseline);
    expect(store.getConflict(unavailableSides.docId)).toEqual(unavailableSides);
    expect(store.getConflict("missing")).toBeUndefined();
    expect(store.listConflicts().map((record) => record.docId))
      .toEqual(["existing/conflict", "new/conflict", "unsafe/path"]);

    const mirrorColumns = db.prepare(
      "PRAGMA table_info(d1_working_tree_mirrors)",
    ).all() as unknown as Array<{ name: string }>;
    const conflictColumns = db.prepare(
      "PRAGMA table_info(d1_working_tree_conflicts)",
    ).all() as unknown as Array<{ name: string }>;
    const protectedHashColumns = db.prepare(
      "PRAGMA table_info(d1_working_tree_protected_hashes)",
    ).all() as unknown as Array<{ name: string }>;
    expect(mirrorColumns.map((column) => column.name)).toEqual([
      "doc_id",
      "content_hash",
      "baseline_locked",
      "database_updated_at",
      "verified_at",
    ]);
    expect(conflictColumns.map((column) => column.name)).toEqual([
      "doc_id",
      "baseline_hash",
      "baseline_locked",
      "baseline_database_updated_at",
      "database_hash",
      "file_hash",
      "detected_at",
      "updated_at",
    ]);
    expect(protectedHashColumns.map((column) => column.name)).toEqual([
      "content_hash",
      "protected_at",
    ]);

    const updated = {
      ...withBaseline,
      baselineDatabaseUpdatedAt: 95,
      databaseHash: HASH_C,
      fileHash: null,
      updatedAt: 175,
    };
    store.upsertConflict(updated);
    expect(store.getConflict(withBaseline.docId)).toEqual(updated);
    expect(store.deleteConflict(withBaseline.docId)).toBe(true);
    expect(store.deleteConflict(withBaseline.docId)).toBe(false);
    expect(store.listProtectedContentHashes()).toEqual([
      { contentHash: HASH_A, protectedAt: 150 },
    ]);
  });

  test("persists mirror and conflict state across Core database reopen", () => {
    const mirror: WorkingTreeMirrorRecord = {
      docId: "persisted/mirror",
      contentHash: HASH_A,
      baselineLocked: true,
      databaseUpdatedAt: 95,
      verifiedAt: 100,
    };
    const conflict = conflictRecord("persisted/conflict");
    store.upsertMirror(mirror);
    store.upsertConflict(conflict);
    store.protectContentHash(HASH_C, 80);
    db.close();

    db = openSystemDatabase(workspace);
    store = new WorkingTreeStateStore(db);
    expect(store.getMirror(mirror.docId)).toEqual(mirror);
    expect(store.getConflict(conflict.docId)).toEqual(conflict);
    expect(store.listProtectedContentHashes()).toEqual([
      { contentHash: HASH_C, protectedAt: 80 },
    ]);
  });

  test("validates hashes, baseline pairing, timestamps, and doc ids before persistence", () => {
    expect(() => store.upsertMirror({
      docId: "invalid-hash",
      contentHash: "A".repeat(64),
      baselineLocked: false,
      databaseUpdatedAt: 1,
      verifiedAt: 1,
    })).toThrow("lowercase SHA-256");
    expect(() => store.upsertMirror({
      docId: "../outside",
      contentHash: HASH_A,
      baselineLocked: false,
      databaseUpdatedAt: 1,
      verifiedAt: 1,
    })).toThrow("Invalid doc id");
    expect(() => store.upsertMirror({
      docId: "invalid-database-revision",
      contentHash: HASH_A,
      baselineLocked: false,
      databaseUpdatedAt: -1,
      verifiedAt: 1,
    })).toThrow("non-negative safe integer");
    expect(() => store.upsertConflict({
      docId: "bad-baseline",
      baselineHash: HASH_A,
      baselineLocked: null,
      baselineDatabaseUpdatedAt: 1,
      databaseHash: HASH_B,
      fileHash: HASH_C,
      detectedAt: 1,
      updatedAt: 1,
    })).toThrow("all be present or absent");
    expect(() => store.upsertConflict({
      docId: "missing-baseline-revision",
      baselineHash: HASH_A,
      baselineLocked: false,
      baselineDatabaseUpdatedAt: null,
      databaseHash: HASH_B,
      fileHash: HASH_C,
      detectedAt: 1,
      updatedAt: 1,
    })).toThrow("all be present or absent");
    expect(() => store.upsertConflict({
      docId: "invalid-baseline-revision",
      baselineHash: HASH_A,
      baselineLocked: false,
      baselineDatabaseUpdatedAt: -1,
      databaseHash: HASH_B,
      fileHash: HASH_C,
      detectedAt: 1,
      updatedAt: 1,
    })).toThrow("non-negative safe integer");
    expect(() => store.upsertConflict({
      docId: "time-travel",
      baselineHash: HASH_A,
      baselineLocked: false,
      baselineDatabaseUpdatedAt: 1,
      databaseHash: HASH_B,
      fileHash: HASH_C,
      detectedAt: 2,
      updatedAt: 1,
    })).toThrow("must not precede");
    expect(() => store.protectContentHash("A".repeat(64), 1))
      .toThrow("lowercase SHA-256");
    expect(() => store.protectContentHash(HASH_A, -1))
      .toThrow("non-negative safe integer");
    expect(store.listMirrors()).toEqual([]);
    expect(store.listConflicts()).toEqual([]);
    expect(store.listProtectedContentHashes()).toEqual([]);
  });

  test("database checks independently reject malformed direct writes", () => {
    expect(() => db.prepare(
      `INSERT INTO d1_working_tree_mirrors
         (doc_id, content_hash, baseline_locked, database_updated_at, verified_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("uppercase", "F".repeat(64), 0, 1, 1)).toThrow();
    expect(() => db.prepare(
      `INSERT INTO d1_working_tree_mirrors
         (doc_id, content_hash, baseline_locked, database_updated_at, verified_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("negative-revision", HASH_A, 0, -1, 1)).toThrow();
    expect(() => db.prepare(
      `INSERT INTO d1_working_tree_conflicts
         (doc_id, baseline_hash, baseline_locked, baseline_database_updated_at,
          database_hash, file_hash, detected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("unpaired", HASH_A, 0, null, HASH_B, HASH_C, 1, 1)).toThrow();
    expect(() => db.prepare(
      `INSERT INTO d1_working_tree_conflicts
         (doc_id, baseline_hash, baseline_locked, baseline_database_updated_at,
          database_hash, file_hash, detected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("negative-baseline-revision", HASH_A, 0, -1, HASH_B, HASH_C, 1, 1))
      .toThrow();
    expect(() => db.prepare(
      `INSERT INTO d1_working_tree_protected_hashes
         (content_hash, protected_at)
       VALUES (?, ?)`,
    ).run("F".repeat(64), 1)).toThrow();
    expect(() => db.prepare(
      `INSERT INTO d1_working_tree_protected_hashes
         (content_hash, protected_at)
       VALUES (?, ?)`,
    ).run(HASH_A, -1)).toThrow();
    expect(() => db.prepare(
      `INSERT INTO d1_working_tree_protected_hashes
         (content_hash, protected_at)
       VALUES (?, ?)`,
    ).run(null, 1)).toThrow();
  });

  test("markConverged atomically clears a conflict and records the verified baseline", () => {
    const conflict = conflictRecord("notes/one");
    store.upsertConflict(conflict);
    const mirror: WorkingTreeMirrorRecord = {
      docId: conflict.docId,
      contentHash: HASH_C,
      baselineLocked: true,
      databaseUpdatedAt: 275,
      verifiedAt: 300,
    };

    store.markConverged(mirror);

    expect(store.getConflict(conflict.docId)).toBeUndefined();
    expect(store.getMirror(conflict.docId)).toEqual(mirror);
    expect(store.listProtectedContentHashes()).toEqual([
      { contentHash: HASH_C, protectedAt: 300 },
    ]);
  });

  test("markConverged rolls back all state when protected-hash persistence fails", () => {
    const conflict = conflictRecord("fault/protect-converged");
    store.upsertConflict(conflict);
    db.exec(`
      CREATE TEMP TRIGGER reject_working_tree_protected_hash_insert
      BEFORE INSERT ON d1_working_tree_protected_hashes
      WHEN NEW.content_hash = '${HASH_C}'
      BEGIN
        SELECT RAISE(ABORT, 'injected protected hash failure');
      END;
    `);

    expect(() => store.markConverged({
      docId: conflict.docId,
      contentHash: HASH_C,
      baselineLocked: true,
      databaseUpdatedAt: 275,
      verifiedAt: 300,
    })).toThrow("injected protected hash failure");
    expect(store.getConflict(conflict.docId)).toEqual(conflict);
    expect(store.getMirror(conflict.docId)).toBeUndefined();
    expect(store.isContentHashProtected(HASH_C)).toBe(false);
  });

  test("upsertConflict atomically protects a locked baseline", () => {
    const conflict: WorkingTreeConflictRecord = {
      ...conflictRecord("fault/protect-conflict"),
      baselineLocked: true,
    };
    db.exec(`
      CREATE TEMP TRIGGER reject_working_tree_protected_hash_insert
      BEFORE INSERT ON d1_working_tree_protected_hashes
      WHEN NEW.content_hash = '${HASH_A}'
      BEGIN
        SELECT RAISE(ABORT, 'injected protected hash failure');
      END;
    `);

    expect(() => store.upsertConflict(conflict))
      .toThrow("injected protected hash failure");
    expect(store.getConflict(conflict.docId)).toBeUndefined();
    expect(store.isContentHashProtected(HASH_A)).toBe(false);
  });

  test("markConverged rolls back conflict removal if mirror persistence fails", () => {
    const conflict = conflictRecord("fault/converge");
    store.upsertConflict(conflict);
    db.exec(`
      CREATE TEMP TRIGGER reject_working_tree_mirror_insert
      BEFORE INSERT ON d1_working_tree_mirrors
      WHEN NEW.doc_id = 'fault/converge'
      BEGIN
        SELECT RAISE(ABORT, 'injected mirror failure');
      END;
    `);

    expect(() => store.markConverged({
      docId: conflict.docId,
      contentHash: HASH_C,
      baselineLocked: false,
      databaseUpdatedAt: 275,
      verifiedAt: 300,
    })).toThrow("injected mirror failure");
    expect(store.getConflict(conflict.docId)).toEqual(conflict);
    expect(store.getMirror(conflict.docId)).toBeUndefined();
  });

  test("markAbsent atomically removes mirror and conflict state", () => {
    const docId = "notes/absent";
    store.upsertMirror({
      docId,
      contentHash: HASH_A,
      baselineLocked: false,
      databaseUpdatedAt: 95,
      verifiedAt: 100,
    });
    store.upsertConflict(conflictRecord(docId));

    store.markAbsent(docId);

    expect(store.getMirror(docId)).toBeUndefined();
    expect(store.getConflict(docId)).toBeUndefined();
  });

  test("markAbsent rolls back conflict removal if mirror removal fails", () => {
    const docId = "fault/absent";
    const mirror: WorkingTreeMirrorRecord = {
      docId,
      contentHash: HASH_A,
      baselineLocked: false,
      databaseUpdatedAt: 95,
      verifiedAt: 100,
    };
    const conflict = conflictRecord(docId);
    store.upsertMirror(mirror);
    store.upsertConflict(conflict);
    db.exec(`
      CREATE TEMP TRIGGER reject_working_tree_mirror_delete
      BEFORE DELETE ON d1_working_tree_mirrors
      WHEN OLD.doc_id = 'fault/absent'
      BEGIN
        SELECT RAISE(ABORT, 'injected mirror delete failure');
      END;
    `);

    expect(() => store.markAbsent(docId)).toThrow("injected mirror delete failure");
    expect(store.getConflict(docId)).toEqual(conflict);
    expect(store.getMirror(docId)).toEqual(mirror);
  });

  test("compound updates remain nested in a caller transaction", () => {
    const mirror: WorkingTreeMirrorRecord = {
      docId: "notes/nested",
      contentHash: HASH_A,
      baselineLocked: true,
      databaseUpdatedAt: 95,
      verifiedAt: 100,
    };
    db.exec("BEGIN IMMEDIATE");
    store.markConverged(mirror);
    expect(store.getMirror(mirror.docId)).toEqual(mirror);
    expect(store.isContentHashProtected(HASH_A)).toBe(true);
    db.exec("ROLLBACK");

    expect(store.getMirror(mirror.docId)).toBeUndefined();
    expect(store.isContentHashProtected(HASH_A)).toBe(false);
  });
});

function conflictRecord(docId: string): WorkingTreeConflictRecord {
  return {
    docId,
    baselineHash: HASH_A,
    baselineLocked: false,
    baselineDatabaseUpdatedAt: 150,
    databaseHash: HASH_B,
    fileHash: HASH_C,
    detectedAt: 200,
    updatedAt: 250,
  };
}
