import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertSchemaCompatible,
  DatabaseMigrationError,
  readDatabaseVersion,
  runDatabaseMigrations,
  type DatabaseMigration,
} from "../src/database-migrations";

const openDatabases: DatabaseSync[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.isOpen) db.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database migration runner", () => {
  test("applies missing versions in order and reruns as a validated no-op", () => {
    const db = openMemoryDatabase();
    const applied: number[] = [];
    const migrations = syntheticMigrations(applied);

    expect(runDatabaseMigrations(db, syntheticPlan(migrations))).toBe(3);
    expect(applied).toEqual([1, 2, 3]);
    expect(readDatabaseVersion(db)).toBe(3);

    applied.length = 0;
    expect(runDatabaseMigrations(db, syntheticPlan(migrations))).toBe(3);
    expect(applied).toEqual([]);
  });

  test("rolls back only the failing step and can retry it", () => {
    const db = openMemoryDatabase();
    const firstTwo = syntheticMigrations([]).slice(0, 2);
    runDatabaseMigrations(db, syntheticPlan(firstTwo));

    const failingV3: DatabaseMigration = {
      version: 3,
      name: "failing third step",
      up(database) {
        database.exec("CREATE TABLE transient_v3 (id INTEGER PRIMARY KEY)");
        throw new Error("synthetic failure");
      },
      validate() {},
    };
    expect(() => runDatabaseMigrations(
      db,
      syntheticPlan([...firstTwo, failingV3]),
    )).toThrowError(expect.objectContaining({ code: "DB_MIGRATION_FAILED" }));
    expect(readDatabaseVersion(db)).toBe(2);
    expect(schemaObject(db, "transient_v3")).toBeUndefined();

    const successfulV3 = syntheticMigrations([])[2]!;
    expect(runDatabaseMigrations(
      db,
      syntheticPlan([...firstTwo, successfulV3]),
    )).toBe(3);
    expect(schemaObject(db, "migration_v3")).toBeTruthy();
  });

  test("validates the declared current version before running the next write", () => {
    const db = openMemoryDatabase();
    db.exec("PRAGMA user_version = 1");
    let wroteV2 = false;
    const migrations = syntheticMigrations([]);
    migrations[1] = {
      ...migrations[1]!,
      up(database) {
        wroteV2 = true;
        database.exec("CREATE TABLE migration_v2 (id INTEGER PRIMARY KEY)");
      },
    };

    expect(() => runDatabaseMigrations(db, syntheticPlan(migrations)))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
    expect(wroteV2).toBe(false);
    expect(readDatabaseVersion(db)).toBe(1);
    expect(schemaObject(db, "migration_v2")).toBeUndefined();
  });

  test("refuses future versions before any migration callback", () => {
    const db = openMemoryDatabase();
    db.exec("PRAGMA user_version = 99");
    let callbackRan = false;
    const migrations: readonly DatabaseMigration[] = [{
      version: 1,
      name: "must not run",
      up() { callbackRan = true; },
      validate() { callbackRan = true; },
    }];

    expect(() => runDatabaseMigrations(db, syntheticPlan(migrations)))
      .toThrowError(expect.objectContaining({ code: "DB_VERSION_TOO_NEW" }));
    expect(callbackRan).toBe(false);
    expect(readDatabaseVersion(db)).toBe(99);
  });

  test("rejects invalid plans and caller-owned transactions", () => {
    const db = openMemoryDatabase();
    const invalid = syntheticMigrations([])[1]!;
    expect(() => runDatabaseMigrations(db, syntheticPlan([invalid])))
      .toThrowError(expect.objectContaining({ code: "DB_MIGRATION_PLAN" }));

    db.exec("BEGIN");
    expect(() => runDatabaseMigrations(db, syntheticPlan(syntheticMigrations([]))))
      .toThrowError(expect.objectContaining({ code: "DB_MIGRATION_PLAN" }));
    db.exec("ROLLBACK");
  });

  test("SQLite crash recovery keeps schema and version at the prior commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lamarck-migration-crash-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "crash.db");
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE committed_v2 (id INTEGER PRIMARY KEY);
      PRAGMA user_version = 2;
    `);
    db.close();

    const childScript = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE; CREATE TABLE uncommitted_v3 (id INTEGER PRIMARY KEY); PRAGMA user_version = 3");
      process.stdout.write("ready\\n");
      setInterval(() => {}, 10_000);
    `;
    const child = spawn(process.execPath, ["-e", childScript, path], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await waitForLine(child.stdout!, "ready");
    child.kill("SIGKILL");
    await once(child, "exit");

    const recovered = new DatabaseSync(path);
    openDatabases.push(recovered);
    expect(readDatabaseVersion(recovered)).toBe(2);
    expect(schemaObject(recovered, "committed_v2")).toBeTruthy();
    expect(schemaObject(recovered, "uncommitted_v3")).toBeUndefined();
    expect((recovered.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
      .integrity_check).toBe("ok");
    expect((recovered.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
      .journal_mode).toBe("wal");
  });
});

describe("schema compatibility fingerprints", () => {
  test("detect table-level constraints and preserve quoted literal semantics", () => {
    const expected = `
      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        state TEXT COLLATE NOCASE CHECK (state = 'Ready')
      ) STRICT;
    `;
    const matching = openMemoryDatabase();
    matching.exec(expected);
    expect(() => assertSchemaCompatible(matching, expected, "matching.db")).not.toThrow();

    const wrongLiteral = openMemoryDatabase();
    wrongLiteral.exec(`
      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        state TEXT COLLATE NOCASE CHECK (state = 'ready')
      ) STRICT;
    `);
    expect(() => assertSchemaCompatible(wrongLiteral, expected, "wrong.db"))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
  });

  test("does not collapse Unicode identifiers that SQLite keeps distinct", () => {
    const expected = `
      CREATE TABLE records (
        "K" INTEGER,
        k INTEGER,
        CHECK (K > 0)
      );
    `;
    const wrongExpression = openMemoryDatabase();
    wrongExpression.exec(`
      CREATE TABLE records (
        "K" INTEGER,
        k INTEGER,
        CHECK (k > 0)
      );
    `);
    expect(() => assertSchemaCompatible(wrongExpression, expected, "unicode.db"))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
  });

  test("reserved expected objects are owned while reserved unknown objects are rejected", () => {
    const expected = "CREATE TABLE _lamarck_owned (id TEXT PRIMARY KEY)";
    const db = openMemoryDatabase();
    db.exec(expected);
    const options = {
      rejectUnknownObjectName: (name: string) => name.startsWith("_lamarck_"),
    };
    expect(() => assertSchemaCompatible(db, expected, "owned.db", options)).not.toThrow();

    db.exec("CREATE TABLE _lamarck_unknown (id TEXT PRIMARY KEY)");
    expect(() => assertSchemaCompatible(db, expected, "owned.db", options))
      .toThrowError(expect.objectContaining({ code: "DB_SCHEMA_MISMATCH" }));
  });
});

function openMemoryDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  openDatabases.push(db);
  return db;
}

function syntheticMigrations(applied: number[]): DatabaseMigration[] {
  return [1, 2, 3].map((version): DatabaseMigration => ({
    version,
    name: `synthetic v${version}`,
    up(db) {
      applied.push(version);
      db.exec(`CREATE TABLE migration_v${version} (id INTEGER PRIMARY KEY)`);
    },
    validate(db) {
      if (!schemaObject(db, `migration_v${version}`)) {
        throw new DatabaseMigrationError(
          "DB_SCHEMA_MISMATCH",
          `missing migration_v${version}`,
        );
      }
    },
  }));
}

function syntheticPlan(migrations: readonly DatabaseMigration[]) {
  return {
    database: "synthetic.db",
    migrations,
    validate(db: DatabaseSync) {
      const latest = migrations.at(-1);
      if (latest) latest.validate(db);
    },
  };
}

function schemaObject(db: DatabaseSync, name: string): unknown {
  return db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name = ?").get(name);
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
