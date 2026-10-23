import { describe, expect, test } from "vitest";
import { startupFailure } from "../src/startup-failure";

describe("system settings reset diagnosis", () => {
  test.each(["DB_SCHEMA_MISMATCH", "DB_VERSION_INVALID"])("allows confirmed system.db %s only", code => {
    expect(startupFailure({ code }, "system.db").canResetSystemSettings).toBe(true);
    // Guard/data.db failures never authorize a system settings reset.
    expect(startupFailure({ code }).canResetSystemSettings).toBeUndefined();
  });

  test.each([11, 26, 267])("recognizes SQLite corruption code %s, including wrapped errors", errcode => {
    const corruption = { code: "ERR_SQLITE_ERROR", errcode };
    expect(startupFailure(corruption, "system.db").canResetSystemSettings).toBe(true);
    expect(startupFailure({ code: "DB_MIGRATION_FAILED", cause: corruption }, "system.db").canResetSystemSettings).toBe(true);
    expect(startupFailure(corruption).canResetSystemSettings).toBeUndefined();
  });

  test.each([
    { code: "EACCES" }, { code: "EPERM" }, { code: "EADDRINUSE" },
    { code: "DB_VERSION_TOO_NEW" }, { code: "DB_MIGRATION_FAILED" },
    { code: "ERR_SQLITE_ERROR", errcode: 5 }, // busy
    { code: "ERR_SQLITE_ERROR", errcode: 8 }, // readonly
    { code: "ERR_SQLITE_ERROR", errcode: 10 }, // I/O error
    { code: "ERR_SQLITE_ERROR", errcode: 13 }, // disk full
    { code: "ERR_SQLITE_ERROR", errcode: 14 }, // cannot open
    new Error("Core server did not start in time"),
  ])("rejects non-corruption startup failure %j", error => {
    expect(startupFailure(error, "system.db").canResetSystemSettings).toBeUndefined();
  });
});
