import { D0_SCHEMA_VERSION_V1 } from "./schema";

export const DATA_DB_FILENAME = "data.db";

// D0 events + D1 docs schema. Keep the event envelope stable: the Node Guard
// is the sole production initializer/owner, while unit tests may initialize a
// temporary database from the same runtime-neutral definition.
export const DATA_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT '${D0_SCHEMA_VERSION_V1}',
  source      TEXT NOT NULL,
  producer_ref TEXT NOT NULL,
  type        TEXT NOT NULL,
  external_id TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  payload     JSON NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
);

CREATE INDEX IF NOT EXISTS idx_events_source ON events(source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup ON events(source, external_id)
  WHERE external_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS prevent_events_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_events_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE IF NOT EXISTS docs (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL DEFAULT '',
  metadata    JSON,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs(updated_at DESC);
`;

// Latest schema for fresh fixtures and external compatibility harnesses. Once
// v2 exists, keep DATA_SCHEMA_V1 frozen and point this alias at the new latest.
export const DATA_SCHEMA = DATA_SCHEMA_V1;
