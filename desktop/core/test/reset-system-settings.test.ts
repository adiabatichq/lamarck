import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AppServiceStore } from "../src/apps/services";
import { DATA_SCHEMA_V1 } from "../src/data-schema";
import { openSystemDatabase, SYSTEM_SCHEMA_V1 } from "../src/db";
import { resetSystemSettings } from "../src/reset-system-settings";

describe("explicit system settings reset", () => {
  let workspace: string;
  let directory: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-system-reset-"));
    directory = join(workspace, ".lamarck");
    mkdirSync(directory);
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  test("replaces an incompatible v1 system DB while preserving live data WAL, files, identity and package history", () => {
    const old = new DatabaseSync(join(directory, "system.db"));
    old.exec(SYSTEM_SCHEMA_V1.replace(",\n  mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal', 'exp'))", ""));
    old.exec("PRAGMA user_version = 1; INSERT INTO app_runtime_settings VALUES ('notes', 1, 4)");
    old.exec("INSERT INTO auth_secret_items VALUES ('key', 'secret', 'nonce', 'algorithm', 1, 1)");
    old.close();
    expect(() => openSystemDatabase(workspace)).toThrow();
    writeFileSync(join(directory, "system.db-wal"), "discard old WAL");
    writeFileSync(join(directory, "system.db-shm"), "discard old SHM");
    writeFileSync(join(directory, "system.db-journal"), "discard old rollback journal");

    const retained = new Map<string, Buffer>();
    for (const path of ["files/note.md", "pages/index.md", "apps/notes/manifest.json", "apps/notes/.git/objects/version", "connectors/mail/index.mjs", ".lamarck/settings.json", ".lamarck/blobs/content", ".lamarck/archived-apps/old/manifest.json"]) {
      const fullPath = join(workspace, path);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      const bytes = Buffer.from(`keep ${path}`);
      writeFileSync(fullPath, bytes);
      retained.set(fullPath, bytes);
    }
    const data = new DatabaseSync(join(directory, "data.db"));
    try {
      data.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      data.exec(DATA_SCHEMA_V1);
      data.exec("PRAGMA user_version = 1; CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes VALUES (1, 'mine')");
      data.exec("INSERT INTO events (id, source, producer_ref, type, started_at, payload) VALUES ('event-1', 'source-1', 'producer-1', 'test', 1, '{}')");
      for (const file of ["data.db", "data.db-wal", "data.db-shm"]) {
        const path = join(directory, file);
        retained.set(path, readFileSync(path));
      }
      resetSystemSettings(workspace);
      for (const [path, bytes] of retained) expect(readFileSync(path), path).toEqual(bytes);
      expect(data.prepare("SELECT body FROM notes").get()?.body).toBe("mine");
      expect(data.prepare("SELECT id FROM events").get()?.id).toBe("event-1");
      expect(data.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    } finally { data.close(); }

    const current = openSystemDatabase(workspace);
    try {
      expect(current.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(current.prepare("SELECT count(*) AS n FROM auth_secret_items").get()?.n).toBe(0);
      expect(current.prepare("SELECT count(*) AS n FROM triggers").get()?.n).toBe(0);
      expect(new AppServiceStore(current).appSetting("notes")).toEqual({ enabled: false, revision: 1, mode: "normal" });
    } finally { current.close(); }
    expect(existsSync(join(directory, "system.db-wal"))).toBe(false);
    expect(existsSync(join(directory, "system.db-journal"))).toBe(false);
    expect(readdirSync(directory).some(name => name.startsWith(".system-reset-"))).toBe(false);
  });

  test("also resets an unreadable system DB without needing its old schema", () => {
    writeFileSync(join(directory, "system.db"), "not SQLite");
    resetSystemSettings(workspace);
    const db = openSystemDatabase(workspace);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    db.close();
  });

  test("refuses a redirected settings directory without changing its contents", () => {
    const external = join(workspace, "external");
    mkdirSync(external);
    writeFileSync(join(external, "system.db"), "keep");
    rmSync(directory, { recursive: true });
    symlinkSync(external, directory);
    expect(() => resetSystemSettings(workspace)).toThrow("physical directory");
    expect(readFileSync(join(external, "system.db"), "utf8")).toBe("keep");
    expect(readdirSync(external)).toEqual(["system.db"]);
  });

  test("refuses malformed database paths before removing any files", () => {
    writeFileSync(join(directory, "system.db"), "keep");
    mkdirSync(join(directory, "system.db-shm"));
    expect(() => resetSystemSettings(workspace)).toThrow("not a file");
    expect(readFileSync(join(directory, "system.db"), "utf8")).toBe("keep");
  });
});
