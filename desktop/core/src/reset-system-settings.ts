import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateSystemDatabase, SYSTEM_DB_FILENAME } from "./db";

/** Explicit Host recovery only, after the previous runtime has fully stopped. */
export function resetSystemSettings(workspacePath: string): void {
  const directory = join(realpathSync(workspacePath), ".lamarck");
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) {
    throw new Error("Workspace settings must be in a physical directory");
  }
  const databasePath = join(directory, SYSTEM_DB_FILENAME);
  const sidecars = [databasePath + "-wal", databasePath + "-shm", databasePath + "-journal"];
  for (const path of [databasePath, ...sidecars]) {
    try {
      if (lstatSync(path).isDirectory()) throw new Error("Workspace database path is not a file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // Prepare the replacement before discarding any settings. Directory names
  // cover installed packages even when their manifest currently needs repair.
  let appIds: string[];
  try {
    appIds = readdirSync(join(resolve(workspacePath), "apps"), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    appIds = [];
  }
  const replacement = join(directory, `.system-reset-${randomUUID()}.db`);
  try {
    const db = new DatabaseSync(replacement);
    try {
      migrateSystemDatabase(db);
      const disable = db.prepare("INSERT INTO app_runtime_settings (app_id, enabled, revision) VALUES (?, 0, 1)");
      db.exec("BEGIN");
      for (const appId of appIds) disable.run(appId);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    // Old journal pages must never be applied to the new database.
    for (const path of sidecars) rmSync(path, { force: true });
    renameSync(replacement, databasePath);
  } finally {
    rmSync(replacement, { force: true });
  }
}
