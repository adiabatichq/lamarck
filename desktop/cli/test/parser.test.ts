import { describe, expect, test } from "vitest";
import { CLI_OPERATIONS, helpText, parseCliArgs } from "../src/index";

describe("shared CLI parser", () => {
  const vectors: ReadonlyArray<[readonly string[], string, unknown]> = [
    [["query", "SELECT", "1", "--json"], "query", { sql: "SELECT 1" }],
    [["schema", "change", "--author", "Ada", "CREATE TABLE x(id TEXT PRIMARY KEY)"], "schema.change", { ddl: "CREATE TABLE x(id TEXT PRIMARY KEY)", author: "Ada" }],
    [["file", "ls", "-R", "notes"], "file.command", { argv: ["ls", "-R", "notes"] }],
    [["file", "import", "host", "inbox"], "file.import", { argv: ["import", "host", "inbox"] }],
    [["file", "export", "notes", "host"], "file.export", { argv: ["export", "notes", "host"] }],
    [["source", "list"], "source.list", {}],
    [["source", "inspect", "source-1"], "source.inspect", { sourceId: "source-1" }],
    [["source", "run", "source-1", "--wait"], "source.run", { sourceId: "source-1" }],
    [["source", "pause", "source-1"], "source.pause", { sourceId: "source-1" }],
    [["source", "resume", "source-1"], "source.resume", { sourceId: "source-1" }],
    [["connector", "list"], "connector.list", {}],
    [["connector", "inspect", "lamarck.oura"], "connector.inspect", { connectorId: "lamarck.oura" }],
    [["connector", "install", "lamarck.oura"], "connector.install", { packageId: "lamarck.oura" }],
    [["connector", "update", "lamarck.oura"], "connector.update", { connectorId: "lamarck.oura" }],
    [["connector", "remove", "lamarck.oura", "--yes"], "connector.remove", { connectorId: "lamarck.oura" }],
    [["app", "list"], "app.list", {}],
    [["app", "inspect", "focus"], "app.inspect", { appId: "focus" }],
    [["app", "create", "focus", "--description", "Focus", "--name", "Focus App"], "app.create", { appId: "focus", name: "Focus App", description: "Focus" }],
    [["app", "save", "focus", "--author", "Ada", "-m", "First"], "app.save", { appId: "focus", message: "First", author: "Ada" }],
    [["app", "versions", "focus"], "app.versions", { appId: "focus" }],
    [["app", "restore", "focus", "abc123", "--message", "Restore"], "app.restore", { appId: "focus", version: "abc123", message: "Restore" }],
    [["app", "refresh", "focus", "--yes"], "app.refresh", { appId: "focus" }],
    [["app", "archive", "focus", "--yes"], "app.archive", { appId: "focus" }],
  ];

  test.each(vectors)("parses %j", (argv, operation, input) => {
    const environment = operation === "app.refresh" ? "managed" : "host";
    const parsed = parseCliArgs(argv, environment);
    expect(parsed).toMatchObject({ kind: "execute", operation, input });
  });

  test("covers every public operation exactly once apart from the internal run-status read", () => {
    expect(new Set(vectors.map(([, operation]) => operation)))
      .toEqual(new Set(CLI_OPERATIONS.filter((operation) => operation !== "source.run.status")));
  });

  test("removes global flags before parsing regardless of order", () => {
    expect(parseCliArgs(["--json", "app", "save", "focus", "-m", "One"], "host"))
      .toMatchObject({ operation: "app.save", input: { appId: "focus", message: "One" }, json: true });
    expect(parseCliArgs(["schema", "change", "--json", "--file", "schema.sql"], "managed"))
      .toMatchObject({ operation: "schema.change", schemaFile: "schema.sql", json: true });
  });

  test("accepts every documented option independently of option order", () => {
    expect(parseCliArgs(["schema", "change", "CREATE TABLE x(id TEXT PRIMARY KEY)", "--context", "why", "--author", "Ada"], "host"))
      .toMatchObject({ input: { ddl: "CREATE TABLE x(id TEXT PRIMARY KEY)", author: "Ada", context: "why" } });
    expect(parseCliArgs(["file", "tee", "notes", "--author", "Ada"], "managed"))
      .toMatchObject({ input: { argv: ["tee", "notes"], author: "Ada" }, readsStdin: true });
    expect(parseCliArgs(["connector", "remove", "--yes", "lamarck.oura"], "host"))
      .toMatchObject({ input: { connectorId: "lamarck.oura" }, confirmed: true });
    expect(parseCliArgs(["app", "archive", "--yes", "focus"], "managed"))
      .toMatchObject({ input: { appId: "focus" }, confirmed: true });
    expect(() => parseCliArgs(["file", "--author", "Ada", "export", "notes", "host"], "host"))
      .toThrowError(expect.objectContaining({ code: "CLI_USAGE" }));
  });

  test("pins environment help and hard-cut denials", () => {
    expect(helpText("host")).toContain("file import");
    expect(helpText("host")).toContain("--file <schema.sql>");
    expect(helpText("host")).not.toContain("app refresh");
    expect(helpText("managed")).toContain("app refresh");
    expect(helpText("managed")).not.toContain("file import");
    expect(() => parseCliArgs(["app", "refresh", "focus", "--yes"], "host"))
      .toThrowError(expect.objectContaining({ code: "CLI_UNSUPPORTED_COMMAND" }));
    expect(() => parseCliArgs(["file", "export", "a", "b"], "managed"))
      .toThrowError(expect.objectContaining({ code: "CLI_UNSUPPORTED_COMMAND" }));
    expect(() => parseCliArgs(["vfs", "ls"], "host"))
      .toThrowError(expect.objectContaining({ code: "CLI_USAGE" }));
  });
});
