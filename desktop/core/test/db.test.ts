import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DATA_DB_FILENAME, SYSTEM_DB_FILENAME } from "../src/db";
import { openTestDatabases as openDatabases } from "./support/test-databases";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";
import { TEST_PRODUCER_REF } from "./support/test-guard";

describe("DB", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-test-"));
    mkdirSync(join(workspace, ".lamarck"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("opens and creates split schemas", () => {
    const { dataDb, systemDb, close } = openDatabases(workspace);

    expect(existsSync(join(workspace, ".lamarck", DATA_DB_FILENAME))).toBe(true);
    expect(existsSync(join(workspace, ".lamarck", SYSTEM_DB_FILENAME))).toBe(true);

    // Check events table exists
    const events = dataDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
    ).get();
    expect(events).toBeTruthy();

    // D1 has no database table; files/ is its only local authority.
    const docs = dataDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='docs'"
    ).get();
    expect(docs).toBeFalsy();

    for (const table of ["d1_observer_files", "d1_observer_cursor", "d1_history_exclusions"]) {
      expect(dataDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
      ).get(table)).toBeFalsy();
      expect(systemDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
      ).get(table)).toBeTruthy();
    }

    const dataConnectorSources = dataDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='connector_sources'"
    ).get();
    expect(dataConnectorSources).toBeFalsy();

    const connectorSources = systemDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='connector_sources'"
    ).get();
    expect(connectorSources).toBeTruthy();

    const connectorApprovals = systemDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='connector_custom_approvals'"
    ).get();
    expect(connectorApprovals).toBeTruthy();

    const dataConnectorRuns = dataDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='connector_runs'"
    ).get();
    expect(dataConnectorRuns).toBeFalsy();

    const connectorRuns = systemDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='connector_runs'"
    ).get();
    expect(connectorRuns).toBeTruthy();

    for (const table of ["auth_accounts", "auth_credentials", "auth_secret_items"]) {
      expect(dataDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
      ).get(table)).toBeFalsy();
      expect(systemDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
      ).get(table)).toBeTruthy();
    }

    close();
  });

  test("events table has correct columns", () => {
    const { dataDb, close } = openDatabases(workspace);
    const columns = dataDb.prepare("PRAGMA table_info(events)").all() as { name: string }[];
    const names = columns.map((c) => c.name);

    expect(names).toContain("id");
    expect(names).toContain("schema_version");
    expect(names).toContain("source");
    expect(names).toContain("producer_ref");
    expect(names).toContain("type");
    expect(names).toContain("external_id");
    expect(names).toContain("started_at");
    expect(names).toContain("ended_at");
    expect(names).toContain("payload");
    expect(names).toContain("created_at");

    close();
  });

  test("events require an explicit producer_ref", () => {
    const { dataDb, close } = openDatabases(workspace);
    expect(() => dataDb.prepare(
      "INSERT INTO events (id, source, type, started_at, payload) VALUES (?, ?, ?, ?, ?)",
    ).run("missing-producer", "system:test", "test.event", Date.now(), "{}"))
      .toThrow(/producer_ref/);
    close();
  });

  test("connector sources table has runtime state columns", () => {
    const { systemDb, close } = openDatabases(workspace);
    const columns = systemDb.prepare("PRAGMA table_info(connector_sources)").all() as { name: string }[];
    const names = columns.map((c) => c.name);

    expect(names).toContain("id");
    expect(names).toContain("connector_id");
    expect(names).toContain("source_key");
    expect(names).toContain("identity_status");
    expect(names).toContain("last_resolved_key");
    expect(names).toContain("display_name");
    expect(names).toContain("suggested_label");
    expect(names).not.toContain("integration_key");
    expect(names).toContain("status");
    expect(names).toContain("setup_status");
    expect(names).toContain("trust_status");
    expect(names).toContain("schedule_cron");
    expect(names).toContain("next_run_at");
    expect(names).toContain("paused_at");
    expect(names).toContain("resume_at");
    expect(names).toContain("package_hash");
    expect(names).toContain("config");
    expect(names).toContain("sync_state");
    expect(names).toContain("requirements_status");
    expect(names).toContain("auth_ref");
    expect(names).toContain("last_error");
    expect(names).toContain("warnings");
    expect(names).toContain("last_run_at");
    expect(names).toContain("created_at");
    expect(names).toContain("updated_at");

    close();
  });

  test("events default to current D0 schema version", () => {
    const { dataDb, close } = openDatabases(workspace);

    dataDb.prepare(
      "INSERT INTO events (id, source, producer_ref, type, started_at, payload) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("e1", "system:test", TEST_PRODUCER_REF, "test.event", Date.now(), "{}");

    const event = dataDb.prepare("SELECT schema_version FROM events WHERE id = ?").get("e1") as {
      schema_version: string;
    };
    expect(event.schema_version).toBe("0.1");

    close();
  });

  test("observer checkpoint stores exact Markdown baselines in system.db", () => {
    const { systemDb, close } = openDatabases(workspace);
    const columns = systemDb.prepare("PRAGMA table_info(d1_observer_files)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual([
      "path",
      "digest",
      "byte_length",
      "markdown_baseline",
    ]);
    close();
  });

  test("events dedup index works", () => {
    const { dataDb, close } = openDatabases(workspace);

    dataDb.prepare(
      "INSERT INTO events (id, source, producer_ref, type, external_id, started_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("e1", "connector:oura", TEST_PRODUCER_REF, "sleep.recorded", "oura-123", Date.now(), "{}");

    // Same source + external_id should fail
    expect(() =>
      dataDb.prepare(
        "INSERT INTO events (id, source, producer_ref, type, external_id, started_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("e2", "connector:oura", TEST_PRODUCER_REF, "sleep.recorded", "oura-123", Date.now(), "{}")
    ).toThrow();

    // Different source + same external_id should succeed
    dataDb.prepare(
      "INSERT INTO events (id, source, producer_ref, type, external_id, started_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("e3", "connector:github", TEST_PRODUCER_REF, "sleep.recorded", "oura-123", Date.now(), "{}");

    close();
  });

  test("events table is append-only at SQLite trigger level", () => {
    const { dataDb, close } = openDatabases(workspace);

    dataDb.prepare(
      "INSERT INTO events (id, source, producer_ref, type, started_at, payload) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("e1", "system:test", TEST_PRODUCER_REF, "test.event", Date.now(), "{}");

    expect(() =>
      dataDb.prepare("UPDATE events SET type = ? WHERE id = ?").run("test.changed", "e1")
    ).toThrow("events are append-only");
    expect(() =>
      dataDb.prepare("DELETE FROM events WHERE id = ?").run("e1")
    ).toThrow("events are append-only");

    close();
  });

  test("WAL mode is enabled on both databases", () => {
    const { dataDb, systemDb, close } = openDatabases(workspace);
    const dataResult = dataDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const systemResult = systemDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(dataResult.journal_mode).toBe("wal");
    expect(systemResult.journal_mode).toBe("wal");
    close();
  });
});
