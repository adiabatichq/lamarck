import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  HOST_CLI_OPERATIONS,
  CliError,
  runCli,
  type CliIo,
  type CliOperation,
  type CliRequest,
  type CliResponse,
  type CliTransport,
} from "../src/index";

describe("CLI rendering and exit behavior", () => {
  test("prints direct domain JSON to stdout and stable errors to stderr", async () => {
    const successIo = io();
    expect(await runCli({ environment: "host", argv: ["app", "list", "--json"], transport: transport([[]]), io: successIo.value })).toBe(0);
    expect(successIo.stdout()).toBe("[]\n");
    expect(successIo.stderr()).toBe("");

    const failureIo = io();
    const unavailable: CliTransport = { hello: async () => { throw new CliError("LAMARCK_NOT_RUNNING", "Lamarck is not running."); }, execute: vi.fn() };
    expect(await runCli({ environment: "host", argv: ["app", "list", "--json"], transport: unavailable, io: failureIo.value })).toBe(1);
    expect(failureIo.stdout()).toBe("");
    expect(JSON.parse(failureIo.stderr())).toEqual({ error: { code: "LAMARCK_NOT_RUNNING", message: "Lamarck is not running." } });
  });

  test("writes file bytes natively to their respective streams", async () => {
    const output = io();
    const result = { success: false, exitCode: 7, stdoutBase64: Buffer.from("out").toString("base64"), stderrBase64: Buffer.from("err").toString("base64") };
    expect(await runCli({ environment: "host", argv: ["file", "cat", "missing"], transport: transport([result]), io: output.value })).toBe(7);
    expect(output.stdout()).toBe("out");
    expect(output.stderr()).toBe("err");
  });

  test("streams tee stdin as bounded native bytes instead of a control-frame field", async () => {
    const output = io();
    const bytes = Buffer.alloc(256 * 1024, 0xa5);
    (output.value.stdin as unknown as PassThrough).end(bytes);
    let seenRequest: CliRequest | undefined;
    let seenUpload: Buffer | undefined;
    const client: CliTransport = {
      hello: async () => ({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }),
      execute: async (request, upload) => {
        seenRequest = request;
        seenUpload = upload === undefined ? undefined : Buffer.from(upload);
        return {
          requestId: request.requestId,
          ok: true,
          result: { success: true, exitCode: 0, stdoutBase64: "", stderrBase64: "" },
        } as CliResponse<typeof request.operation>;
      },
    };
    expect(await runCli({ environment: "host", argv: ["file", "tee", "blob.bin"], transport: client, io: output.value })).toBe(0);
    expect(seenRequest?.input).toEqual({ argv: ["tee", "blob.bin"] });
    expect(seenRequest?.upload).toEqual({ kind: "file-stdin", bytes: bytes.byteLength });
    expect(seenUpload?.equals(bytes)).toBe(true);
  });

  test("reads large schema files locally into the bounded typed request", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-cli-schema-"));
    try {
      const path = join(root, "change.sql");
      const bytes = Buffer.from(`CREATE TABLE notes(id TEXT PRIMARY KEY);\n${"-- context\n".repeat(8_000)}`, "utf8");
      await writeFile(path, bytes);
      let seenRequest: CliRequest | undefined;
      const client: CliTransport = {
        hello: async () => ({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }),
        execute: async <T extends CliOperation>(request: CliRequest<T>, upload?: Uint8Array) => {
          seenRequest = request;
          expect(upload).toBeUndefined();
          return { requestId: request.requestId, ok: true, result: { id: "schema-1", status: "pending" } } as CliResponse<T>;
        },
      };
      expect(await runCli({
        environment: "host",
        argv: ["schema", "change", "--file", path, "--json"],
        transport: client,
        io: io().value,
      })).toBe(0);
      expect(seenRequest?.input).toEqual({ ddl: bytes.toString("utf8") });
      expect(seenRequest?.upload).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("waits only on the accepted persisted run id and preserves terminal errors", async () => {
    const output = io();
    const calls: CliRequest[] = [];
    const client = transport([
      { sourceId: "source-a", runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", status: "accepted" },
      { sourceId: "source-a", runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", status: "running", startedAt: 1 },
      { sourceId: "source-a", runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", status: "error", outcome: "error", startedAt: 1, endedAt: 2 },
    ], calls);
    expect(await runCli({ environment: "host", argv: ["source", "run", "source-a", "--wait", "--json"], transport: client, io: output.value })).toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", outcome: "error" });
    expect(calls.map((call) => [call.operation, call.input])).toEqual([
      ["source.run", { sourceId: "source-a" }],
      ["source.run.status", { sourceId: "source-a", runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
      ["source.run.status", { sourceId: "source-a", runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
    ]);
  });

  test("SIGINT detaches a wait without sending Source cancellation", async () => {
    const output = io();
    const calls: CliRequest[] = [];
    let count = 0;
    const client: CliTransport = {
      hello: async () => ({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }),
      execute: async <T extends CliOperation>(request: CliRequest<T>) => {
        calls.push(request);
        if (count++ === 0) {
          return { requestId: request.requestId, ok: true, result: { sourceId: "source-a", runId: "run-a", status: "accepted" } } as CliResponse<T>;
        }
        queueMicrotask(() => process.emit("SIGINT"));
        return { requestId: request.requestId, ok: true, result: { sourceId: "source-a", runId: "run-a", status: "running", startedAt: 1 } } as CliResponse<T>;
      },
    };
    expect(await runCli({ environment: "host", argv: ["source", "run", "source-a", "--wait", "--json"], transport: client, io: output.value })).toBe(1);
    expect(JSON.parse(output.stderr()).error).toMatchObject({ code: "SOURCE_RUN_ABORTED" });
    expect(calls.map((call) => call.operation)).toEqual(["source.run", "source.run.status"]);
  });

  test("requires --yes for non-interactive destructive commands before mutation", async () => {
    const output = io();
    const calls: CliRequest[] = [];
    expect(await runCli({ environment: "host", argv: ["connector", "remove", "oura", "--json"], transport: transport([], calls), io: output.value })).toBe(1);
    expect(JSON.parse(output.stderr()).error.code).toBe("CONFIRMATION_REQUIRED");
    expect(calls).toEqual([]);

    const appOutput = io();
    expect(await runCli({ environment: "host", argv: ["app", "archive", "example", "--json"], transport: transport([], calls), io: appOutput.value })).toBe(1);
    expect(JSON.parse(appOutput.stderr()).error.code).toBe("CONFIRMATION_REQUIRED");
    expect(calls).toEqual([]);
  });

  test("warns about immediate Capsule termination and never archives before TTY confirmation", async () => {
    const output = io(true, "no\n");
    const calls: CliRequest[] = [];
    expect(await runCli({
      environment: "host",
      argv: ["app", "archive", "example", "--json"],
      transport: transport([{ id: "example", name: "Example" }], calls),
      io: output.value,
    })).toBe(1);
    expect(calls.map(({ operation }) => operation)).toEqual(["app.inspect"]);
    expect(output.stdout()).toContain("running Capsules will terminate immediately");
    expect(JSON.parse(output.stderr()).error.code).toBe("CONFIRMATION_REQUIRED");
  });
});

function transport(results: unknown[], calls: CliRequest[] = []): CliTransport {
  return {
    hello: async () => ({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }),
    execute: async (request) => {
      calls.push(request as CliRequest);
      return { requestId: request.requestId, ok: true, result: results.shift() } as CliResponse<typeof request.operation>;
    },
  };
}

function io(tty = false, input = "") {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdin, { isTTY: tty });
  Object.assign(stdout, { isTTY: tty });
  if (input) stdin.end(input);
  let out = ""; let err = "";
  stdout.on("data", (chunk) => { out += chunk.toString(); });
  stderr.on("data", (chunk) => { err += chunk.toString(); });
  return { value: { stdin, stdout, stderr } as CliIo, stdout: () => out, stderr: () => err };
}
