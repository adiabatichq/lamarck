import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrateDataDatabase } from "../../src/data-migrations";
import { DATA_DB_FILENAME } from "../../src/data-schema";
import { openSystemDatabase } from "../../src/db";

export function openTestDatabases(workspacePath: string) {
  const lamarckDir = join(workspacePath, ".lamarck");
  mkdirSync(lamarckDir, { recursive: true });
  const dataDb = new DatabaseSync(join(lamarckDir, DATA_DB_FILENAME));
  const systemDb = openSystemDatabase(workspacePath);
  dataDb.exec("PRAGMA synchronous = NORMAL");
  dataDb.exec("PRAGMA foreign_keys = ON");
  migrateDataDatabase(dataDb);
  dataDb.exec("PRAGMA journal_mode = WAL");
  dataDb.exec("PRAGMA synchronous = NORMAL");
  return {
    dataDb,
    systemDb,
    close() {
      dataDb.close();
      systemDb.close();
    },
  };
}
