import { describe, expect, test } from "vitest";
import { cliCoded, cliFailure } from "../src/cli-errors";
import { AppLifecycleError } from "../src/apps/errors";

describe("Core CLI error boundary", () => {
  test.each([
    ["GUARD_QUERY_REJECTED", "QUERY_REJECTED", "Query not authorized: only read-only relational queries are allowed."],
    ["GUARD_QUERY_INVALID", "QUERY_INVALID", "no such table: missing_table"],
  ])("preserves %s across the CLI response", (guardCode, cliCode, message) => {
    const error = Object.assign(new Error(message), { code: guardCode });
    expect(cliFailure("request-1", error)).toEqual({
      requestId: "request-1", ok: false, error: { code: cliCode, message },
    });
  });

  test.each(["ERR_SQLITE_ERROR", "GUARD_INTERNAL", "GUARD_RPC_TIMEOUT", "ECONNREFUSED", undefined])(
    "keeps unclassified %s failures internal without exposing diagnostics",
    (code) => {
      const error = Object.assign(new Error("private workspace path and storage details"), { code, errcode: 10 });
      expect(cliFailure("request-2", error)).toEqual({
        requestId: "request-2", ok: false,
        error: { code: "CLI_INTERNAL", message: "Lamarck could not complete the command." },
      });
    },
  );

  test("retains existing domain error mappings", () => {
    expect(cliFailure("request-3", cliCoded("APP_NOT_FOUND", "App not found"))).toMatchObject({
      error: { code: "APP_NOT_FOUND", message: "App not found" },
    });
    expect(cliFailure("request-4", new AppLifecycleError("APP_PACKAGE_INVALID", "Invalid manifest"))).toMatchObject({
      error: { code: "APP_INVALID", message: "Invalid manifest" },
    });
  });
});
