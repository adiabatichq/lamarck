import { D0_SCHEMA_VERSION_V1 } from "./schema";

export const DATA_DB_FILENAME = "data.db";

// D0 schema. D1 is filesystem-authoritative under <Workspace>/files and has no
// catalog or content copy in data.db. The Node Guard is the sole production
// initializer/owner, while tests may initialize a temporary database from this
// same runtime-neutral definition.
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

`;

// Greenfield V1 is rewritten directly until the first released schema exists.
export const DATA_SCHEMA = DATA_SCHEMA_V1;
