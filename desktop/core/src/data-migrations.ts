import type { DatabaseSync } from "node:sqlite";
import {
  assertSchemaCompatible,
  runDatabaseMigrations,
  type DatabaseMigration,
} from "./database-migrations";
import { DATA_DB_FILENAME, DATA_SCHEMA, DATA_SCHEMA_V1 } from "./data-schema";
import { foldSqliteIdentifier } from "./sqlite-identifiers";

const DATA_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: "baseline D0 substrate",
    up(db) {
      db.exec(DATA_SCHEMA_V1);
    },
    validate(db) {
      validateDataSchema(db, DATA_SCHEMA_V1);
    },
  },
];

export const DATA_DATABASE_VERSION = DATA_MIGRATIONS.at(-1)?.version ?? 0;

export function migrateDataDatabase(db: DatabaseSync): number {
  return runDatabaseMigrations(db, {
    database: DATA_DB_FILENAME,
    migrations: DATA_MIGRATIONS,
    validate(currentDb) {
      validateDataSchema(currentDb, DATA_SCHEMA);
    },
  });
}

const RESERVED_DATA_OBJECT_PREFIXES = [
  "connector_",
  "auth_",
  "_lamarck_",
  "pragma_",
] as const;

function validateDataSchema(db: DatabaseSync, expectedSchema: string): void {
  // Unknown ordinary objects belong to D2 and must survive Lamarck substrate
  // migrations. Control-plane and Guard-private namespaces are never D2.
  assertSchemaCompatible(db, expectedSchema, DATA_DB_FILENAME, {
    rejectUnknownObjectName(name) {
      const normalizedName = foldSqliteIdentifier(name);
      return RESERVED_DATA_OBJECT_PREFIXES.some((prefix) => normalizedName.startsWith(prefix));
    },
  });
}
