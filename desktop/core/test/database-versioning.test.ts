import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DATA_DATABASE_VERSION,
  migrateDataDatabase,
} from "../src/data-migrations";
import { DATA_DB_FILENAME, DATA_SCHEMA_V1 } from "../src/data-schema";
import {
  openSystemDatabase,
  SYSTEM_DATABASE_VERSION,
  SYSTEM_DB_FILENAME,
  SYSTEM_SCHEMA_V1,
} from "../src/db";
import { readDatabaseVersion } from "../src/database-migrations";
import { GuardEngine } from "../src/guard-service/engine";

describe("data.db and system.db schema versions", () => {
  let workspace: string;
  let lamarckDirectory: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-versioning-"));
    lamarckDirectory = join(workspace, ".lamarck");
    mkdirSync(lamarckDirectory, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("fresh owners establish independent current baselines", () => {
    const guard = new GuardEngine({ workspacePath: workspace });
    expect(guard.health()).toEqual({
      ok: true,
      schemaVersion: "0.1",
      database: DATA_DB_FILENAME,
    });
    guard.close();

    const systemDb = openSystemDatabase(workspace);
    expect(readDatabaseVersion(systemDb, SYSTEM_DB_FILENAME)).toBe(SYSTEM_DATABASE_VERSION);
    expect(schemaObject(systemDb, "d1_working_tree_mirrors")).toBeTruthy();
    expect(schemaObject(systemDb, "d1_working_tree_conflicts")).toBeTruthy();
    expect(schemaObject(systemDb, "d1_working_tree_protected_hashes")).toBeTruthy();
    systemDb.close();

    const dataDb = new DatabaseSync(dataPath());
    expect(readDatabaseVersion(dataDb, DATA_DB_FILENAME)).toBe(DATA_DATABASE_VERSION);
    dataDb.close();
  });

  test("pins the released migration inputs", () => {
    expect(SYSTEM_DATABASE_VERSION).toBe(1);
    expect(sha256(DATA_SCHEMA_V1))
      .toBe("ec3182151699d26bcb3e00118fa5e93e6c2d4f5407de935e8f0351bf1cf6c395");
    expect(sha256(SYSTEM_SCHEMA_V1))
      .toBe("d1c2d5b86fdfb29187ca55bd69b0f8d804405a9f010aecad1a7d2aa0641ad517");
  });

  test("D2 promotion and demotion do not change the data database version", () => {
    const guard = new GuardEngine({ workspacePath: workspace });
    const host = {
      source: "system:database-version-test",
      tableGrants: "*" as const,
      docGrants: "*" as const,
      schemaGrant: true,
    };
    guard.schemaApply(
      host,
      "promote",
      "CREATE TABLE version_invariant (id TEXT PRIMARY KEY)",
      true,
      "database-version-test",
    );
    const afterPromotion = new DatabaseSync(dataPath());
    expect(readDatabaseVersion(afterPromotion, DATA_DB_FILENAME)).toBe(DATA_DATABASE_VERSION);
    afterPromotion.close();
    guard.schemaApply(
      host,
      "demote",
      "DROP TABLE version_invariant",
      true,
      "database-version-test",
    );
    guard.close();

    const db = new DatabaseSync(dataPath());
    expect(readDatabaseVersion(db, DATA_DB_FILENAME)).toBe(DATA_DATABASE_VERSION);
    expect(schemaObject(db, "version_invariant")).toBeUndefined();
    db.close();
  });

  test("system migration waits for a concurrent writer and then converges", async () => {
    const childScript = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
      }, 200);
    `;
    const child = spawn(process.execPath, ["-e", childScript, systemPath()], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const childExit = once(child, "exit");
    await waitForLine(child.stdout!, "locked");

    const systemDb = openSystemDatabase(workspace);
    expect(readDatabaseVersion(systemDb, SYSTEM_DB_FILENAME)).toBe(SYSTEM_DATABASE_VERSION);
    systemDb.close();
    const [exitCode] = await childExit;
    expect(exitCode).toBe(0);
  });

  test("adopts a complete legacy data v0 without changing D2 objects or rows", () => {
    const db = new DatabaseSync(dataPath());
    db.exec(`
      ${DATA_SCHEMA_V1}
      CREATE TABLE project_items (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX project_items_value ON project_items(value);
      CREATE TABLE project_audit (id TEXT PRIMARY KEY);
      CREATE TRIGGER project_items_audit
      AFTER INSERT ON project_items
      BEGIN
        INSERT INTO project_audit (id) VALUES (NEW.id);
      END;
      CREATE VIEW project_item_values AS SELECT id, value FROM project_items;
      CREATE TABLE "_lamarcK_items" (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO docs (id, content, metadata, created_at, updated_at)
      VALUES ('notes/legacy.md', 'preserved', '{"locked":false}', 1, 2);
      INSERT INTO project_items (id, value) VALUES ('item-1', 'preserved');
      INSERT INTO "_lamarcK_items" (id, value) VALUES ('unicode-1', 'distinct');
    `);
    const names = [
      "project_items",
      "project_items_value",
      "project_audit",
      "project_items_audit",
      "project_item_values",
      "_lamarcK_items",
    ];
    const schemaBefore = schemaSnapshot(db, names);

    expect(migrateDataDatabase(db)).toBe(DATA_DATABASE_VERSION);
    expect(readDatabaseVersion(db, DATA_DB_FILENAME)).toBe(DATA_DATABASE_VERSION);
    expect(schemaSnapshot(db, names)).toEqual(schemaBefore);
    expect(db.prepare("SELECT content, metadata FROM docs WHERE id = ?")
      .get("notes/legacy.md")).toEqual({
        content: "preserved",
        metadata: '{"locked":false}',
      });
    expect(db.prepare("SELECT id, value FROM project_items").all())
      .toEqual([{ id: "item-1", value: "preserved" }]);
    expect(db.prepare("SELECT id FROM project_audit").all()).toEqual([{ id: "item-1" }]);
    expect(db.prepare('SELECT id, value FROM "_lamarcK_items"').all())
      .toEqual([{ id: "unicode-1", value: "distinct" }]);
    db.close();
  });

  test("adopts an exact unversioned system schema without changing control-plane rows", () => {
    const legacy = new DatabaseSync(systemPath());
    legacy.exec(SYSTEM_SCHEMA_V1);
    legacy.prepare(
      `INSERT INTO auth_accounts (id, label, subject, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run("account-1", "Legacy", "subject-1", 123);
    legacy.close();

    const systemDb = openSystemDatabase(workspace);
    expect(readDatabaseVersion(systemDb, SYSTEM_DB_FILENAME)).toBe(SYSTEM_DATABASE_VERSION);
    expect(systemDb.prepare("SELECT id, label, subject, created_at FROM auth_accounts").all())
      .toEqual([{
        id: "account-1",
        label: "Legacy",
        subject: "subject-1",
        created_at: 123,
      }]);
    expect(schemaObject(systemDb, "d1_working_tree_mirrors")).toBeTruthy();
    expect(schemaObject(systemDb, "d1_working_tree_conflicts")).toBeTruthy();
    expect(schemaObject(systemDb, "d1_working_tree_protected_hashes")).toBeTruthy();
    systemDb.close();
  });

  test("refuses an incomplete declared system v1 without repairing it", () => {
    const incomplete = new DatabaseSync(systemPath());
    incomplete.exec(`
      ${SYSTEM_SCHEMA_V1}
      DROP TABLE d1_working_tree_mirrors;
      DROP TABLE d1_working_tree_conflicts;
      DROP TABLE d1_working_tree_protected_hashes;
      PRAGMA user_version = 1;
    `);
    incomplete.close();

    expect(() => openSystemDatabase(workspace))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
    const reopened = new DatabaseSync(systemPath());
    expect(readDatabaseVersion(reopened, SYSTEM_DB_FILENAME)).toBe(1);
    expect(schemaObject(reopened, "d1_working_tree_mirrors")).toBeUndefined();
    expect(schemaObject(reopened, "d1_working_tree_conflicts")).toBeUndefined();
    expect(schemaObject(reopened, "d1_working_tree_protected_hashes")).toBeUndefined();
    expect(journalMode(reopened)).toBe("delete");
    reopened.close();
  });

  test("refuses partial data v0 instead of silently repairing it", () => {
    const partial = new DatabaseSync(dataPath());
    partial.exec("CREATE TABLE events (id TEXT PRIMARY KEY)");

    expect(() => migrateDataDatabase(partial))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
    expect(readDatabaseVersion(partial, DATA_DB_FILENAME)).toBe(0);
    expect(schemaObject(partial, "docs")).toBeUndefined();
    partial.close();
  });

  test("refuses a complete-looking data v0 whose integrity trigger drifted", () => {
    const incompatible = new DatabaseSync(dataPath());
    incompatible.exec(`
      ${DATA_SCHEMA_V1}
      DROP TRIGGER prevent_events_delete;
      CREATE TRIGGER prevent_events_delete
      BEFORE DELETE ON events
      BEGIN
        SELECT 1;
      END;
    `);

    expect(() => migrateDataDatabase(incompatible))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
    expect(readDatabaseVersion(incompatible, DATA_DB_FILENAME)).toBe(0);
    incompatible.close();
  });

  test("allows D2 extensions but rejects reserved control-plane objects in data v0", () => {
    const polluted = new DatabaseSync(dataPath());
    polluted.exec(`
      ${DATA_SCHEMA_V1}
      CREATE TABLE connector_legacy_state (id TEXT PRIMARY KEY);
    `);

    expect(() => migrateDataDatabase(polluted))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
    expect(readDatabaseVersion(polluted, DATA_DB_FILENAME)).toBe(0);
    expect(schemaObject(polluted, "connector_legacy_state")).toBeTruthy();
    polluted.close();
  });

  test("refuses unknown objects in legacy system v0", () => {
    const polluted = new DatabaseSync(systemPath());
    polluted.exec(`
      ${SYSTEM_SCHEMA_V1}
      CREATE TABLE legacy_extra (id TEXT PRIMARY KEY);
    `);
    polluted.close();

    expect(() => openSystemDatabase(workspace))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
    const reopened = new DatabaseSync(systemPath());
    expect(readDatabaseVersion(reopened, SYSTEM_DB_FILENAME)).toBe(0);
    expect(schemaObject(reopened, "legacy_extra")).toBeTruthy();
    expect(journalMode(reopened)).toBe("delete");
    reopened.close();
  });

  test("Guard refuses a future data version without enabling WAL or changing data", () => {
    const future = new DatabaseSync(dataPath());
    future.exec(`
      ${DATA_SCHEMA_V1}
      CREATE TABLE future_items (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO future_items (id, value) VALUES ('future-1', 'preserved');
      PRAGMA user_version = ${DATA_DATABASE_VERSION + 1};
    `);
    expect(journalMode(future)).toBe("delete");
    future.close();

    expect(() => new GuardEngine({ workspacePath: workspace }))
      .toThrowError(expect.objectContaining({ code: "DB_VERSION_TOO_NEW" }));

    const reopened = new DatabaseSync(dataPath());
    expect(readDatabaseVersion(reopened, DATA_DB_FILENAME)).toBe(DATA_DATABASE_VERSION + 1);
    expect(journalMode(reopened)).toBe("delete");
    expect(reopened.prepare("SELECT id, value FROM future_items").all())
      .toEqual([{ id: "future-1", value: "preserved" }]);
    reopened.close();
  });

  test("Core refuses a future system version without enabling WAL or changing data", () => {
    const future = new DatabaseSync(systemPath());
    future.exec(`
      ${SYSTEM_SCHEMA_V1}
      PRAGMA user_version = ${SYSTEM_DATABASE_VERSION + 1};
    `);
    future.prepare(
      `INSERT INTO auth_accounts (id, label, subject, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run("future-account", "Future", "subject", 456);
    expect(journalMode(future)).toBe("delete");
    future.close();

    expect(() => openSystemDatabase(workspace))
      .toThrowError(expect.objectContaining({ code: "DB_VERSION_TOO_NEW" }));

    const reopened = new DatabaseSync(systemPath());
    expect(readDatabaseVersion(reopened, SYSTEM_DB_FILENAME)).toBe(SYSTEM_DATABASE_VERSION + 1);
    expect(journalMode(reopened)).toBe("delete");
    expect(reopened.prepare("SELECT id FROM auth_accounts").all())
      .toEqual([{ id: "future-account" }]);
    reopened.close();
  });

  test("each owner migrates only its own database stream", () => {
    const futureData = new DatabaseSync(dataPath());
    futureData.exec(`
      ${DATA_SCHEMA_V1}
      PRAGMA user_version = ${DATA_DATABASE_VERSION + 1};
    `);
    futureData.close();

    const systemDb = openSystemDatabase(workspace);
    expect(readDatabaseVersion(systemDb, SYSTEM_DB_FILENAME)).toBe(SYSTEM_DATABASE_VERSION);
    systemDb.close();

    const untouchedData = new DatabaseSync(dataPath());
    expect(readDatabaseVersion(untouchedData, DATA_DB_FILENAME)).toBe(DATA_DATABASE_VERSION + 1);
    expect(journalMode(untouchedData)).toBe("delete");
    untouchedData.close();

    rmSync(dataPath(), { force: true });
    const futureSystem = new DatabaseSync(systemPath());
    futureSystem.exec(`
      ${SYSTEM_SCHEMA_V1}
      PRAGMA user_version = ${SYSTEM_DATABASE_VERSION + 1};
    `);
    futureSystem.close();

    const guard = new GuardEngine({ workspacePath: workspace });
    guard.close();
    const migratedData = new DatabaseSync(dataPath());
    expect(readDatabaseVersion(migratedData, DATA_DB_FILENAME)).toBe(DATA_DATABASE_VERSION);
    migratedData.close();
    const untouchedSystem = new DatabaseSync(systemPath());
    expect(readDatabaseVersion(untouchedSystem, SYSTEM_DB_FILENAME))
      .toBe(SYSTEM_DATABASE_VERSION + 1);
    untouchedSystem.close();
  });

  function dataPath(): string {
    return join(lamarckDirectory, DATA_DB_FILENAME);
  }

  function systemPath(): string {
    return join(lamarckDirectory, SYSTEM_DB_FILENAME);
  }
});

function schemaSnapshot(db: DatabaseSync, names: string[]): unknown[] {
  const placeholders = names.map(() => "?").join(", ");
  return db.prepare(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_schema
     WHERE name IN (${placeholders})
     ORDER BY type, name`,
  ).all(...names);
}

function schemaObject(db: DatabaseSync, name: string): unknown {
  return db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name = ?").get(name);
}

function journalMode(db: DatabaseSync): string {
  return (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForLine(
  stream: NodeJS.ReadableStream,
  expected: string,
): Promise<void> {
  let output = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    output += chunk;
    if (output.split(/\r?\n/).includes(expected)) return;
  }
  throw new Error(`Child exited before emitting ${expected}`);
}
