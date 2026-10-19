import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { migrateSystemDatabase, SYSTEM_DATABASE_VERSION } from "../src/db";
import { AppServiceStore } from "../src/apps/services";

test("the greenfield v1 baseline holds explicit Service policy and fences stale observations", () => {
  const db = new DatabaseSync(":memory:");
  try {
    expect(migrateSystemDatabase(db)).toBe(1);
    expect(SYSTEM_DATABASE_VERSION).toBe(1);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    const store = new AppServiceStore(db);
    db.exec("INSERT INTO app_runtime_settings VALUES ('notes', 1, 1), ('other', 1, 1)");
    expect(store.get("notes", "indexer")).toBeNull();
    const enabled = store.setEnabled("notes", "indexer", true);
    expect(enabled).toMatchObject({ enabled: true, revision: 1, restartBaseMs: 1000, restartMaxMs: 60000 });
    const observation = { crashCount: 3, restartAt: 42000, lastError: "exit 7", cleanupFailed: true };
    expect(store.observe("notes", "indexer", enabled.revision, observation)).toBe(true);
    expect(new AppServiceStore(db).get("notes", "indexer")).toMatchObject(observation);
    const disabled = store.setEnabled("notes", "indexer", false);
    expect(disabled.revision).toBe(2);
    expect(store.observe("notes", "indexer", 1, { ...observation, cleanupFailed: false })).toBe(false);
    expect(store.get("notes", "indexer")).toMatchObject({ enabled: false, cleanupFailed: true });
    store.setEnabled("other", "indexer", true);
    store.retire("notes");
    expect(store.get("notes", "indexer")).toBeNull();
    expect(store.get("other", "indexer")?.enabled).toBe(true);
  } finally { db.close(); }
});

test("only admitted Apps receive enabled defaults, and rescans preserve explicit choices", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateSystemDatabase(db); const store = new AppServiceStore(db);
    const app = { manifest: { runtime: { services: { indexer: { command: ["node", "indexer.js"] } } } } };
    const registry = { apps: new Map([["notes", app]]) } as unknown as import("../src/app-loader").AppRegistry;
    expect(store.get("notes", "indexer")).toBeNull();
    store.admitInstalled(registry);
    expect(store.appEnabled("notes")).toBe(true);
    expect(store.get("notes", "indexer")?.enabled).toBe(true);
    const revision = store.requireAdmission("notes");
    store.setEnabled("notes", "indexer", false); store.setAppEnabled("notes", false);
    expect(() => store.requireAdmission("notes")).toThrow("disabled");
    store.setAppEnabled("notes", true);
    expect(() => store.requireAdmission("notes", revision)).toThrow("changed");
    expect(store.get("notes", "indexer")?.enabled).toBe(false);
    store.setAppEnabled("notes", false);
    store.admitInstalled(registry);
    expect(store.appEnabled("notes")).toBe(false);
    expect(store.get("notes", "indexer")?.enabled).toBe(false);
    store.retire("notes"); store.admitInstalled(registry);
    expect(store.appEnabled("notes")).toBe(true);
    expect(store.get("notes", "indexer")?.enabled).toBe(true);
  } finally { db.close(); }
});
