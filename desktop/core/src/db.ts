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

// Greenfield V1 includes the control plane and rebuildable D1 observer state.
export const SYSTEM_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS connector_sources (
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

CREATE INDEX IF NOT EXISTS idx_connector_sources_connector
  ON connector_sources(connector_id);
CREATE INDEX IF NOT EXISTS idx_connector_sources_status
  ON connector_sources(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_sources_identity
  ON connector_sources(connector_id, source_key)
  WHERE source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS connector_runs (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES connector_sources(id) ON DELETE CASCADE,
  connector_id    TEXT NOT NULL,
  source_key      TEXT,
  trigger         TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_connector_runs_source
  ON connector_runs(source_id, started_at DESC);

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

CREATE TABLE IF NOT EXISTS d1_observer_files (
  path              TEXT PRIMARY KEY,
  digest            TEXT NOT NULL
                    CHECK (substr(digest, 1, 7) = 'sha256:'
                      AND length(digest) = 71
                      AND substr(digest, 8) NOT GLOB '*[^0-9a-f]*'),
  byte_length       INTEGER NOT NULL CHECK (byte_length >= 0),
  markdown_baseline BLOB
);

CREATE TABLE IF NOT EXISTS d1_observer_cursor (
  singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_event_id TEXT
);

CREATE TABLE IF NOT EXISTS d1_history_exclusions (
  path      TEXT PRIMARY KEY,
  is_prefix INTEGER NOT NULL CHECK (is_prefix IN (0, 1))
);

CREATE TABLE IF NOT EXISTS connector_official_release_hashes (
  connector_id   TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  verified_at    INTEGER NOT NULL,
  PRIMARY KEY (connector_id, content_hash)
);
`;

export const SYSTEM_SCHEMA = SYSTEM_SCHEMA_V1;
export const SYSTEM_DATABASE_VERSION = 1;

const SYSTEM_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: "baseline control-plane and D1 observer schema",
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
