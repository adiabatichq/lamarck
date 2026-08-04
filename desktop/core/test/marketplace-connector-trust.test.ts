import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { migrateSystemDatabase } from "../src/db";
import { WorkspaceConnectorRegistry } from "../src/connectors/registry";

describe("Marketplace Connector exact-hash trust", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    migrateSystemDatabase(db);
  });

  afterEach(() => db.close());

  test("persists one Official runnable hash across Core registry restarts", () => {
    const contentHash = `sha256:${"a".repeat(64)}`;
    const first = new WorkspaceConnectorRegistry({ systemDb: db });
    first.recordOfficialRelease("lamarck.rss", contentHash);
    expect(first.classify("lamarck.rss", contentHash)).toMatchObject({
      status: "official",
      badge: "Official",
      runnable: true,
    });

    const restarted = new WorkspaceConnectorRegistry({ systemDb: db });
    expect(restarted.classify("lamarck.rss", contentHash)).toMatchObject({
      status: "official",
      runnable: true,
    });
    expect(restarted.classify("lamarck.rss", `sha256:${"b".repeat(64)}`)).toMatchObject({
      status: "modified",
      runnable: false,
    });
  });

  test("rejects a noncanonical hash before granting trust", () => {
    const registry = new WorkspaceConnectorRegistry({ systemDb: db });
    expect(() => registry.recordOfficialRelease("lamarck.rss", "a".repeat(64)))
      .toThrow("canonical sha256");
  });
});
