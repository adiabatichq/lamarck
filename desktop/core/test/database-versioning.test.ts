import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DATA_DATABASE_VERSION, migrateDataDatabase } from "../src/data-migrations";
import { DATA_DB_FILENAME, DATA_SCHEMA_V1 } from "../src/data-schema";
import {
  openSystemDatabase,
  migrateSystemDatabase,
  SYSTEM_SCHEMA,
  SYSTEM_DATABASE_VERSION,
  SYSTEM_DB_FILENAME,
  SYSTEM_SCHEMA_V1,
} from "../src/db";
import { ConnectorInstallationStore } from "../src/connectors/installations";
import { readDatabaseVersion } from "../src/database-migrations";
import { GuardEngine } from "../src/guard-service/engine";
import { TEST_PRODUCER_REF } from "./support/test-guard";

describe("versioned data.db and system.db schemas", () => {
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
    expect(guard.health()).toEqual({ ok: true, schemaVersion: "0.1", database: DATA_DB_FILENAME });
    guard.close();

    const systemDb = openSystemDatabase(workspace);
    expect(readDatabaseVersion(systemDb, SYSTEM_DB_FILENAME)).toBe(SYSTEM_DATABASE_VERSION);
    expect(schemaObject(systemDb, "ai_models")).toBeUndefined();
    expect(schemaObject(systemDb, "ai_access_sources")).toBeTruthy();
    expect(schemaObject(systemDb, "d1_observer_files")).toBeTruthy();
    expect(schemaObject(systemDb, "d1_observer_cursor")).toBeTruthy();
    expect(schemaObject(systemDb, "d1_history_exclusions")).toBeTruthy();
    expect(schemaObject(systemDb, "connector_official_release_hashes")).toBeTruthy();
    expect(schemaObject(systemDb, "connector_installations")).toBeTruthy();
    expect(schemaObject(systemDb, "connector_marketplace_approvals")).toBeUndefined();
    systemDb.close();

    const dataDb = new DatabaseSync(dataPath());
    expect(readDatabaseVersion(dataDb, DATA_DB_FILENAME)).toBe(DATA_DATABASE_VERSION);
    expect(schemaObject(dataDb, "docs")).toBeUndefined();
    dataDb.close();
  });

  test("pins the rewritten greenfield V1 inputs", () => {
    expect(DATA_DATABASE_VERSION).toBe(1);
    expect(SYSTEM_DATABASE_VERSION).toBe(2);
    expect(sha256(DATA_SCHEMA_V1))
      .toBe("0dad836ef5969c2dc2eb71202881ca802281de079ec73866a62dfa19c5ed0979");
    expect(sha256(SYSTEM_SCHEMA_V1))
      .toBe("46622e4fb3b0700737c90ea17e4044798842bc0396bc1928cbec2dd4b3046079");
  });

  test.each(["pre-ai", "ai-catalog", "current-alpha"])("upgrades published V1 %s without losing control-plane data", (variant) => {
    const db = new DatabaseSync(systemPath());
    db.exec(variant === "pre-ai" ? SYSTEM_SCHEMA_V1 : SYSTEM_SCHEMA);
    db.exec("PRAGMA user_version = 1");
    db.exec("INSERT INTO auth_accounts (id, label, subject, created_at) VALUES ('account', 'Saved account', 'subject', 123)");
    db.exec("INSERT INTO d1_observer_cursor VALUES (1, 'event-123')");
    if (variant !== "pre-ai") {
      db.exec(`INSERT INTO ai_access_sources VALUES ('source', 'local', 'local', 'Saved source', '{"mode":"all"}', '{"endpoint":"http://localhost:11434"}', 3)`);
    }
    if (variant === "ai-catalog") {
      db.exec("CREATE TABLE ai_models (id TEXT PRIMARY KEY, metadata_json JSON NOT NULL)");
      db.exec(`INSERT INTO ai_models VALUES ('cached-model', '{}')`);
    }
    const account = db.prepare("SELECT * FROM auth_accounts").get();
    const sources = variant === "pre-ai" ? [] : db.prepare("SELECT * FROM ai_access_sources").all();
    db.close();

    const migrated = openSystemDatabase(workspace);
    expect(readDatabaseVersion(migrated)).toBe(2);
    expect(migrated.prepare("SELECT * FROM auth_accounts").get()).toEqual(account);
    expect(migrated.prepare("SELECT * FROM ai_access_sources").all()).toEqual(sources);
    expect(migrated.prepare("SELECT last_event_id FROM d1_observer_cursor").get()).toEqual({ last_event_id: "event-123" });
    expect(schemaObject(migrated, "ai_models")).toBeUndefined();
    expect(migrateSystemDatabase(migrated)).toBe(2);
    migrated.close();
  });

  test.each(["unknown-table", "altered-source", "altered-catalog"])("refuses unrecognized V1 %s without changing it", (variant) => {
    const db = new DatabaseSync(systemPath());
    db.exec(SYSTEM_SCHEMA);
    db.exec("PRAGMA user_version = 1");
    if (variant === "unknown-table") db.exec("CREATE TABLE user_content (id TEXT)");
    if (variant === "altered-source") db.exec("ALTER TABLE ai_access_sources ADD COLUMN extra TEXT");
    if (variant === "altered-catalog") db.exec("CREATE TABLE ai_models (id TEXT PRIMARY KEY, metadata_json JSON NOT NULL, extra TEXT)");
    const before = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    expect(() => migrateSystemDatabase(db)).toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
    expect(readDatabaseVersion(db)).toBe(1);
    expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
    db.close();
  });

  test("persists current Marketplace Connector release metadata across restart", () => {
    const packageHash = `sha256:${"a".repeat(64)}`;
    const first = openSystemDatabase(workspace);
    const firstStore = new ConnectorInstallationStore(first);
    expect(firstStore.record("lamarck.oura", packageHash, "release-7", 100)).toEqual({
      connectorId: "lamarck.oura",
      packageHash,
      releaseId: "release-7",
      installedAt: 100,
      updatedAt: 100,
    });
    first.close();

    const reopened = openSystemDatabase(workspace);
    expect(new ConnectorInstallationStore(reopened).get("lamarck.oura"))
      .toMatchObject({ packageHash, releaseId: "release-7" });
    reopened.close();
  });

  test("D2 schema changes do not change the greenfield V1 data database version", () => {
    const guard = new GuardEngine({ workspacePath: workspace });
    const host = {
      source: "system:database-version-test",
      producerRef: TEST_PRODUCER_REF,
      tableGrants: "*" as const,
      schemaGrant: true,
    };
    const createPlan = guard.schemaPlan(
      host,
      "CREATE TABLE version_invariant (id TEXT PRIMARY KEY NOT NULL)",
    );
    guard.schemaApply(host, createPlan, true, "database-version-test");
    const afterPromotion = new DatabaseSync(dataPath());
    expect(readDatabaseVersion(afterPromotion, DATA_DB_FILENAME)).toBe(DATA_DATABASE_VERSION);
    afterPromotion.close();
    const dropPlan = guard.schemaPlan(host, "DROP TABLE version_invariant");
    guard.schemaApply(host, dropPlan, true, "database-version-test");
    guard.close();

    const db = new DatabaseSync(dataPath());
    expect(readDatabaseVersion(db, DATA_DB_FILENAME)).toBe(DATA_DATABASE_VERSION);
    expect(schemaObject(db, "version_invariant")).toBeUndefined();
    db.close();
  });

  test("rejects unversioned schemas instead of adopting or rewriting them", () => {
    const data = new DatabaseSync(dataPath());
    data.exec(DATA_SCHEMA_V1);
    expect(() => migrateDataDatabase(data))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
    expect(readDatabaseVersion(data, DATA_DB_FILENAME)).toBe(0);
    data.close();

    const system = new DatabaseSync(systemPath());
    system.exec(SYSTEM_SCHEMA_V1);
    system.close();
    expect(() => openSystemDatabase(workspace))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
    const reopened = new DatabaseSync(systemPath());
    expect(readDatabaseVersion(reopened, SYSTEM_DB_FILENAME)).toBe(0);
    reopened.close();
  });

  test("refuses an incomplete declared V1 without repairing it", () => {
    const incomplete = new DatabaseSync(systemPath());
    incomplete.exec(`${SYSTEM_SCHEMA_V1}\nDROP TABLE d1_observer_files;\nPRAGMA user_version = 1;`);
    incomplete.close();

    expect(() => openSystemDatabase(workspace))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
    const reopened = new DatabaseSync(systemPath());
    expect(readDatabaseVersion(reopened, SYSTEM_DB_FILENAME)).toBe(1);
    expect(schemaObject(reopened, "d1_observer_files")).toBeUndefined();
    reopened.close();
  });

  test("refuses future versions before changing journal mode or data", () => {
    const futureData = new DatabaseSync(dataPath());
    futureData.exec(`${DATA_SCHEMA_V1}\nPRAGMA user_version = ${DATA_DATABASE_VERSION + 1};`);
    futureData.close();
    expect(() => new GuardEngine({ workspacePath: workspace }))
      .toThrowError(expect.objectContaining({ code: "DB_VERSION_TOO_NEW" }));
    const data = new DatabaseSync(dataPath());
    expect(readDatabaseVersion(data, DATA_DB_FILENAME)).toBe(DATA_DATABASE_VERSION + 1);
    expect(journalMode(data)).toBe("delete");
    data.close();

    const futureSystem = new DatabaseSync(systemPath());
    futureSystem.exec(`${SYSTEM_SCHEMA_V1}\nPRAGMA user_version = ${SYSTEM_DATABASE_VERSION + 1};`);
    futureSystem.close();
    expect(() => openSystemDatabase(workspace))
      .toThrowError(expect.objectContaining({ code: "DB_VERSION_TOO_NEW" }));
    const system = new DatabaseSync(systemPath());
    expect(readDatabaseVersion(system, SYSTEM_DB_FILENAME)).toBe(SYSTEM_DATABASE_VERSION + 1);
    expect(journalMode(system)).toBe("delete");
    system.close();
  });

  function dataPath(): string {
    return join(lamarckDirectory, DATA_DB_FILENAME);
  }

  function systemPath(): string {
    return join(lamarckDirectory, SYSTEM_DB_FILENAME);
  }
});

function schemaObject(db: DatabaseSync, name: string): unknown {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = ?").get(name);
}

function journalMode(db: DatabaseSync): string {
  return (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
