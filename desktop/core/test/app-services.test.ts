import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    db.exec("INSERT INTO app_runtime_settings (app_id, enabled, revision) VALUES ('notes', 1, 1), ('other', 1, 1)");
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


test("Experiment mode is persistent Host policy independent of versions and enablement", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateSystemDatabase(db);
    const store = new AppServiceStore(db);
    const registry = { apps: new Map([["notes", { manifest: { runtime: { jobs: { inbox: { command: ["node", "job.js"] } } } } }]]) } as unknown as import("../src/app-loader").AppRegistry;
    store.admitInstalled(registry);
    expect(store.mode("notes")).toBe("normal");
    store.setAppEnabled("notes", false);
    store.setMode("notes", "exp");
    store.admitInstalled(registry);
    const reopened = new AppServiceStore(db);
    expect(reopened.appSetting("notes")).toMatchObject({ enabled: false, mode: "exp" });
    expect(() => reopened.mode("missing")).toThrow("unavailable");
    const service = reopened.setEnabled("notes", "worker", false);
    reopened.observe("notes", "worker", service.revision, { crashCount: 0, restartAt: null, lastError: "cleanup failed", cleanupFailed: true });
    expect(() => reopened.setMode("notes", "normal")).toThrow("cleanup");
    expect(reopened.mode("notes")).toBe("exp");
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  } finally { db.close(); }
});


test("mode survives a closed system.db and reopened Host", () => {
  const root = mkdtempSync(join(tmpdir(), "app-mode-persistence-"));
  let db = new DatabaseSync(join(root, "system.db"));
  try {
    migrateSystemDatabase(db);
    db.prepare("INSERT INTO app_runtime_settings (app_id, enabled, revision) VALUES (?, 1, 1)").run("notes");
    new AppServiceStore(db).setMode("notes", "exp"); db.close();
    db = new DatabaseSync(join(root, "system.db")); expect(migrateSystemDatabase(db)).toBe(1);
    expect(new AppServiceStore(db).appSetting("notes")).toMatchObject({ enabled: true, mode: "exp" });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
