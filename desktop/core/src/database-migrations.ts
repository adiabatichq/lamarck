import { DatabaseSync } from "node:sqlite";
import { foldSqliteIdentifier } from "./sqlite-identifiers";

export interface DatabaseMigration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
  validate(db: DatabaseSync): void;
}

export interface DatabaseMigrationPlan {
  database: string;
  migrations: readonly DatabaseMigration[];
  adoptVersionZero?(db: DatabaseSync): void;
  validate(db: DatabaseSync): void;
}

export class DatabaseMigrationError extends Error {
  constructor(
    public readonly code:
      | "DB_MIGRATION_PLAN"
      | "DB_VERSION_INVALID"
      | "DB_VERSION_TOO_NEW"
      | "DB_MIGRATION_FAILED"
      | "DB_SCHEMA_MISMATCH",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DatabaseMigrationError";
  }
}

/**
 * Applies one ordered migration per SQLite transaction. `user_version` is
 * advanced inside the same transaction as its schema/data changes, so a crash
 * or exception leaves that database at its previous complete version.
 */
export function runDatabaseMigrations(
  db: DatabaseSync,
  plan: DatabaseMigrationPlan,
): number {
  assertMigrationPlan(plan);
  if (db.isTransaction) {
    throw new DatabaseMigrationError(
      "DB_MIGRATION_PLAN",
      `${plan.database} migrations require an owner-controlled connection outside a transaction`,
    );
  }
  const latestVersion = plan.migrations.at(-1)?.version ?? 0;
  let currentVersion = readDatabaseVersion(db, plan.database);
  assertVersionSupported(plan.database, currentVersion, latestVersion);

  for (const migration of plan.migrations) {
    if (migration.version <= currentVersion) continue;

    let transactionStarted = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const lockedVersion = readDatabaseVersion(db, plan.database);
      assertVersionSupported(plan.database, lockedVersion, latestVersion);
      if (lockedVersion >= migration.version) {
        validateDeclaredVersion(db, plan, lockedVersion);
        db.exec("COMMIT");
        transactionStarted = false;
        currentVersion = lockedVersion;
        continue;
      }
      if (lockedVersion !== migration.version - 1) {
        throw new DatabaseMigrationError(
          "DB_SCHEMA_MISMATCH",
          `${plan.database} cannot apply migration ${migration.version} from version ${lockedVersion}`,
        );
      }
      if (lockedVersion === 0 && hasApplicationSchemaObjects(db)) {
        if (!plan.adoptVersionZero || migration.version !== 1) {
          throw new DatabaseMigrationError(
            "DB_SCHEMA_MISMATCH",
            `${plan.database} has an unversioned schema that this Lamarck build cannot adopt`,
          );
        }
        plan.adoptVersionZero(db);
        migration.validate(db);
      } else {
        if (lockedVersion > 0) validateDeclaredVersion(db, plan, lockedVersion);
        migration.up(db);
        migration.validate(db);
      }
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      transactionStarted = false;
      currentVersion = migration.version;
    } catch (error) {
      if (transactionStarted && db.isTransaction) {
        try { db.exec("ROLLBACK"); } catch {}
      }
      if (error instanceof DatabaseMigrationError) throw error;
      throw new DatabaseMigrationError(
        "DB_MIGRATION_FAILED",
        `${plan.database} migration ${currentVersion} -> ${migration.version} (${migration.name}) failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  try {
    plan.validate(db);
  } catch (error) {
    if (error instanceof DatabaseMigrationError) throw error;
    throw new DatabaseMigrationError(
      "DB_SCHEMA_MISMATCH",
      `${plan.database} schema does not match version ${currentVersion}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return currentVersion;
}

function assertVersionSupported(database: string, version: number, latestVersion: number): void {
  if (version > latestVersion) {
    throw new DatabaseMigrationError(
      "DB_VERSION_TOO_NEW",
      `${database} schema version ${version} is newer than this Lamarck build supports (${latestVersion})`,
    );
  }
}

function validateDeclaredVersion(
  db: DatabaseSync,
  plan: DatabaseMigrationPlan,
  version: number,
): void {
  const migration = plan.migrations[version - 1];
  if (!migration || migration.version !== version) {
    throw new DatabaseMigrationError(
      "DB_MIGRATION_PLAN",
      `${plan.database} has no validator for declared schema version ${version}`,
    );
  }
  try {
    migration.validate(db);
  } catch (error) {
    if (error instanceof DatabaseMigrationError) throw error;
    throw new DatabaseMigrationError(
      "DB_SCHEMA_MISMATCH",
      `${plan.database} schema does not match declared version ${version}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function readDatabaseVersion(db: DatabaseSync, database = "database"): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  const version = row?.user_version;
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    throw new DatabaseMigrationError(
      "DB_VERSION_INVALID",
      `${database} has an invalid PRAGMA user_version`,
    );
  }
  return version as number;
}

/**
 * Validates only the schema objects owned by the supplied baseline. Unknown
 * objects are preserved, which is required for user-owned D2 tables in
 * data.db. Tables are compared structurally and by canonical DDL; named
 * indexes and triggers are compared as concrete objects so integrity
 * constraints cannot drift.
 */
export function assertSchemaCompatible(
  db: DatabaseSync,
  expectedSchema: string,
  database: string,
  options?: {
    allowUnknownObjects?: boolean;
    rejectUnknownObjectName?: (name: string) => boolean;
  },
): void {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec("PRAGMA foreign_keys = ON");
    expected.exec(expectedSchema);
    const expectedObjects = expected.prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY type, name`,
    ).all() as unknown as SchemaObject[];

    const actualObjects = db.prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY type, name`,
    ).all() as unknown as SchemaObject[];
    const expectedIdentities = new Set(
      expectedObjects.map((object) => `${object.type}\u0000${object.name}`),
    );

    if (options?.allowUnknownObjects === false) {
      const expectedNames = expectedObjects.map((object) => `${object.type}:${object.name}`);
      const actualNames = actualObjects.map((object) => `${object.type}:${object.name}`);
      if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
        schemaMismatch(database, "contains unknown or missing schema objects");
      }
    }
    if (options?.rejectUnknownObjectName) {
      const rejected = actualObjects.find((object) =>
        !expectedIdentities.has(`${object.type}\u0000${object.name}`)
        && options.rejectUnknownObjectName!(object.name)
      );
      if (rejected) {
        schemaMismatch(database, `contains reserved ${rejected.type} ${rejected.name}`);
      }
    }

    for (const object of expectedObjects) {
      const actual = db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type = ? AND name = ?",
      ).get(object.type, object.name) as SchemaObject | undefined;
      if (!actual) schemaMismatch(database, `missing ${object.type} ${object.name}`);
      if (actual.tbl_name !== object.tbl_name) {
        schemaMismatch(database, `${object.name} has the wrong owner`);
      }

      if (object.type === "table") {
        assertRowsEqual(
          database,
          `${object.name} columns`,
          tableColumns(expected, object.name),
          tableColumns(db, object.name),
        );
        assertRowsEqual(
          database,
          `${object.name} foreign keys`,
          foreignKeys(expected, object.name),
          foreignKeys(db, object.name),
        );
        assertRowsEqual(
          database,
          `${object.name} implicit indexes`,
          implicitIndexes(expected, object.name),
          implicitIndexes(db, object.name),
        );
        if (canonicalSql(actual.sql) !== canonicalSql(object.sql)) {
          schemaMismatch(database, `table ${object.name} definition differs`);
        }
      } else if (object.type === "index") {
        assertRowsEqual(
          database,
          `${object.name} index definition`,
          indexDefinition(expected, object),
          indexDefinition(db, actual),
        );
      } else if (canonicalSql(actual.sql) !== canonicalSql(object.sql)) {
        schemaMismatch(database, `${object.type} ${object.name} definition differs`);
      }
    }
  } finally {
    expected.close();
  }
}

interface SchemaObject {
  type: "table" | "index" | "trigger" | "view";
  name: string;
  tbl_name: string;
  sql: string;
}

function assertMigrationPlan(plan: DatabaseMigrationPlan): void {
  if (!plan.database.trim()) {
    throw new DatabaseMigrationError("DB_MIGRATION_PLAN", "Database migration plan requires a name");
  }
  for (let index = 0; index < plan.migrations.length; index += 1) {
    const migration = plan.migrations[index]!;
    const expectedVersion = index + 1;
    if (
      migration.version !== expectedVersion
      || !migration.name.trim()
      || typeof migration.up !== "function"
      || typeof migration.validate !== "function"
    ) {
      throw new DatabaseMigrationError(
        "DB_MIGRATION_PLAN",
        `${plan.database} migrations must be named and contiguous from version 1 (expected ${expectedVersion})`,
      );
    }
  }
}

function hasApplicationSchemaObjects(db: DatabaseSync): boolean {
  const row = db.prepare(
    `SELECT EXISTS(
       SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
     ) AS present`,
  ).get() as { present: number };
  return row.present === 1;
}

function tableColumns(db: DatabaseSync, table: string): unknown[] {
  return db.prepare(
    `SELECT cid, name, upper(type) AS type, "notnull" AS is_not_null,
            dflt_value, pk, hidden
     FROM pragma_table_xinfo(?)
     ORDER BY cid`,
  ).all(table);
}

function foreignKeys(db: DatabaseSync, table: string): unknown[] {
  return db.prepare(
    `SELECT id, seq, "table", "from", "to", on_update, on_delete, match
     FROM pragma_foreign_key_list(?)
     ORDER BY id, seq`,
  ).all(table);
}

function implicitIndexes(db: DatabaseSync, table: string): unknown[] {
  const indexes = db.prepare(
    `SELECT name, "unique" AS is_unique, origin, partial
     FROM pragma_index_list(?)
     WHERE origin <> 'c'
     ORDER BY name`,
  ).all(table) as Array<{ name: string; is_unique: number; origin: string; partial: number }>;
  return indexes.map((index) => ({
    unique: index.is_unique,
    origin: index.origin,
    partial: index.partial,
    columns: indexColumns(db, index.name),
  }));
}

function indexDefinition(db: DatabaseSync, object: SchemaObject): unknown[] {
  const listed = db.prepare(
    `SELECT "unique" AS is_unique, origin, partial
     FROM pragma_index_list(?)
     WHERE name = ?`,
  ).get(object.tbl_name, object.name) as {
    is_unique: number;
    origin: string;
    partial: number;
  } | undefined;
  if (!listed) return [];
  return [{
    unique: listed.is_unique,
    origin: listed.origin,
    partial: listed.partial,
    columns: indexColumns(db, object.name),
    sql: canonicalSql(object.sql),
  }];
}

function indexColumns(db: DatabaseSync, index: string): unknown[] {
  return db.prepare(
    `SELECT seqno, cid, name, "desc" AS descending, coll, key
     FROM pragma_index_xinfo(?)
     ORDER BY seqno`,
  ).all(index);
}

function assertRowsEqual(
  database: string,
  label: string,
  expected: unknown[],
  actual: unknown[],
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    schemaMismatch(database, `${label} differ from the declared baseline`);
  }
}

function canonicalSql(sql: string): string {
  // sqlite_schema has already removed CREATE's IF NOT EXISTS clause. Keep the
  // remaining quoted text byte-for-byte while normalizing only SQL tokens and
  // whitespace outside quotes.
  const source = sql;
  let result = "";
  let quote: "'" | '"' | "`" | "]" | null = null;
  let pendingSpace = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      result += character;
      if (quote === "]") {
        if (character === "]") quote = null;
      } else if (character === quote) {
        if (source[index + 1] === quote) {
          result += source[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      if (pendingSpace && result && !result.endsWith("(") && !result.endsWith(",")) result += " ";
      pendingSpace = false;
      quote = character;
      result += character;
      continue;
    }
    if (character === "[") {
      if (pendingSpace && result && !result.endsWith("(") && !result.endsWith(",")) result += " ";
      pendingSpace = false;
      quote = "]";
      result += character;
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    if ("(),=".includes(character)) {
      result = result.trimEnd() + character;
      pendingSpace = false;
      continue;
    }
    if (pendingSpace && result && !result.endsWith("(") && !result.endsWith(",")) result += " ";
    pendingSpace = false;
    result += foldSqliteIdentifier(character);
  }

  return result.trim();
}

function schemaMismatch(database: string, detail: string): never {
  throw new DatabaseMigrationError(
    "DB_SCHEMA_MISMATCH",
    `${database} ${detail}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
