import { describe, expect, test } from "vitest";
import {
  decodeCliHttpResponse,
  encodeCliFrame,
  encodeCliHttpResponse,
  parseCliRequest,
  type CliResponse,
} from "../src/index";

describe("CLI bounded byte streams", () => {
  test("keeps binary stdout and stderr outside the bounded control frame", async () => {
    const stdout = Buffer.alloc(256 * 1024, 0xa5);
    const stderr = Buffer.from([0, 255, 1, 254]);
    const response = {
      requestId: "file-1",
      ok: true,
      result: {
        success: false,
        exitCode: 7,
        stdoutBase64: stdout.toString("base64"),
        stderrBase64: stderr.toString("base64"),
      },
    } as CliResponse<"file.command">;

    const wire = encodeCliHttpResponse("file.command", response);
    const controlBytes = wire.readUInt32BE(0);
    expect(controlBytes).toBeLessThan(1024);
    expect(wire.byteLength).toBeGreaterThan(stdout.byteLength);
    expect(await decodeCliHttpResponse(wire, "file.command", "file-1")).toEqual(response);
  });

  test("accepts only operation-matched declared caller byte streams", () => {
    const file = {
      requestId: "file-2",
      operation: "file.command",
      input: { argv: ["tee", "blob.bin"] },
      upload: { kind: "file-stdin", bytes: 10 },
    };
    expect(parseCliRequest(file, true)).toEqual(file);
    expect(() => parseCliRequest({ ...file, input: { argv: ["cat", "blob.bin"] } }, true)).toThrow("file upload is invalid");

    const prefix = "CREATE TABLE notes(id TEXT PRIMARY KEY);\n--";
    const ddl = `${prefix}${" ".repeat(300 * 1024 - Buffer.byteLength(prefix))}`;
    const schema = {
      requestId: "schema-1",
      operation: "schema.change",
      input: { ddl },
    };
    expect(parseCliRequest(schema, true)).toEqual(schema);
    expect(encodeCliFrame(schema).byteLength).toBeGreaterThan(64 * 1024);
    expect(encodeCliFrame(schema).byteLength).toBeLessThan(2 * 1024 * 1024);
    expect(() => parseCliRequest({ ...schema, input: { ddl: `${ddl}x` } }, true))
      .toThrow("ddl is outside the V1 bound");
  });
});
