import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  assertSchemaCompatible,
  runDatabaseMigrations,
  type DatabaseMigration,
} from "./database-migrations";

export {
  DATA_DB_FILENAME,
  DATA_SCHEMA,
} from "./data-schema";
export const SYSTEM_DB_FILENAME = "system.db";

// Released schema constants are immutable migration inputs. This greenfield V1
// includes both the control plane and D1 working-tree reconciliation state.
export const SYSTEM_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS connector_integrations (
  id            TEXT PRIMARY KEY,
  connector_id  TEXT NOT NULL,
  source_key    TEXT,
  identity_status TEXT NOT NULL DEFAULT 'unresolved'
                  CHECK (identity_status IN ('unresolved', 'resolved', 'conflict', 'changed', 'error')),
  last_resolved_key TEXT,
  display_name  TEXT,
  suggested_label TEXT,
  status        TEXT NOT NULL DEFAULT 'idle',
  setup_status  TEXT NOT NULL DEFAULT 'ready',
  trust_status  TEXT NOT NULL DEFAULT 'missing',
  schedule_cron TEXT,
  next_run_at   INTEGER,
  paused_at     INTEGER,
  resume_at     INTEGER,
  package_hash  TEXT,
  config        JSON,
  sync_state    JSON,
  requirements_status JSON,
  auth_ref      TEXT,
  last_error    TEXT,
  warnings      JSON,
  last_run_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connector_integrations_connector
  ON connector_integrations(connector_id);
CREATE INDEX IF NOT EXISTS idx_connector_integrations_status
  ON connector_integrations(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_integrations_identity
  ON connector_integrations(connector_id, source_key)
  WHERE source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS connector_runs (
  id              TEXT PRIMARY KEY,
  integration_id  TEXT NOT NULL REFERENCES connector_integrations(id) ON DELETE CASCADE,
  connector_id    TEXT NOT NULL,
  source_key      TEXT,
  trigger         TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_connector_runs_integration
  ON connector_runs(integration_id, started_at DESC);

CREATE TABLE IF NOT EXISTS connector_custom_approvals (
  connector_id   TEXT NOT NULL,
  approved_hash  TEXT NOT NULL,
  approved_at    INTEGER NOT NULL,
  PRIMARY KEY (connector_id, approved_hash)
);

CREATE TABLE IF NOT EXISTS auth_accounts (
  id          TEXT PRIMARY KEY,
  label       TEXT,
  subject     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_secret_items (
  id          TEXT PRIMARY KEY,
  ciphertext  TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  algorithm   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_credentials (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  account_id        TEXT REFERENCES auth_accounts(id),
  owner_type        TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  scopes_json       JSON,
  status            TEXT NOT NULL,
  secret_item_id    TEXT NOT NULL REFERENCES auth_secret_items(id) ON DELETE CASCADE,
  expires_at        INTEGER,
  metadata          JSON,
  status_changed_at INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_credentials_owner
  ON auth_credentials(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_auth_credentials_status
  ON auth_credentials(status);

CREATE TABLE IF NOT EXISTS d1_working_tree_mirrors (
  doc_id              TEXT PRIMARY KEY,
  content_hash        TEXT NOT NULL
                      CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  baseline_locked     INTEGER NOT NULL CHECK (baseline_locked IN (0, 1)),
  database_updated_at INTEGER NOT NULL CHECK (database_updated_at >= 0),
  verified_at         INTEGER NOT NULL CHECK (verified_at >= 0)
);

CREATE TABLE IF NOT EXISTS d1_working_tree_conflicts (
  doc_id                       TEXT PRIMARY KEY,
  baseline_hash                TEXT
                               CHECK (baseline_hash IS NULL OR
                                 (length(baseline_hash) = 64 AND baseline_hash NOT GLOB '*[^0-9a-f]*')),
  baseline_locked              INTEGER CHECK (baseline_locked IS NULL OR baseline_locked IN (0, 1)),
  baseline_database_updated_at INTEGER
                               CHECK (baseline_database_updated_at IS NULL OR baseline_database_updated_at >= 0),
  database_hash                TEXT
                               CHECK (database_hash IS NULL OR
                                 (length(database_hash) = 64 AND database_hash NOT GLOB '*[^0-9a-f]*')),
  file_hash                    TEXT
                               CHECK (file_hash IS NULL OR
                                 (length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*')),
  detected_at                  INTEGER NOT NULL CHECK (detected_at >= 0),
  updated_at                   INTEGER NOT NULL CHECK (updated_at >= detected_at),
  CHECK (
    (baseline_hash IS NULL) = (baseline_locked IS NULL)
    AND (baseline_hash IS NULL) = (baseline_database_updated_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS d1_working_tree_protected_hashes (
  content_hash TEXT PRIMARY KEY NOT NULL
               CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  protected_at INTEGER NOT NULL CHECK (protected_at >= 0)
);
`;

export const SYSTEM_SCHEMA = SYSTEM_SCHEMA_V1;
export const SYSTEM_DATABASE_VERSION = 1;

const SYSTEM_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: "baseline control-plane and D1 reconciliation schema",
    up(db) {
      db.exec(SYSTEM_SCHEMA_V1);
    },
    validate(db) {
      assertSchemaCompatible(db, SYSTEM_SCHEMA_V1, SYSTEM_DB_FILENAME, {
        allowUnknownObjects: false,
      });
    },
  },
];

export function migrateSystemDatabase(db: DatabaseSync): number {
  return runDatabaseMigrations(db, {
    database: SYSTEM_DB_FILENAME,
    migrations: SYSTEM_MIGRATIONS,
    adoptVersionZero(unversionedDb) {
      assertSchemaCompatible(unversionedDb, SYSTEM_SCHEMA_V1, SYSTEM_DB_FILENAME, {
        allowUnknownObjects: false,
      });
    },
    validate(currentDb) {
      assertSchemaCompatible(currentDb, SYSTEM_SCHEMA, SYSTEM_DB_FILENAME, {
        allowUnknownObjects: false,
      });
    },
  });
}

export function openSystemDatabase(workspacePath: string): DatabaseSync {
  const lamarckDir = join(workspacePath, ".lamarck");
  const systemDb = new DatabaseSync(join(lamarckDir, SYSTEM_DB_FILENAME), {
    timeout: 5_000,
  });
  try {
    applyConnectionPragmas(systemDb);
    migrateSystemDatabase(systemDb);
    applyPersistentPragmas(systemDb);
    return systemDb;
  } catch (error) {
    try { systemDb.close(); } catch {}
    throw error;
  }
}

function applyConnectionPragmas(db: DatabaseSync): void {
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
}

function applyPersistentPragmas(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
}
