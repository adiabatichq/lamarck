import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseVfsCommand } from "@lamarck/system/internal/vfs";

describe("Host CLI", () => {
  test("preserves argv, author, binary stdin, and process-like output through Core", async () => {
    const requests: Array<{ headers: IncomingMessage["headers"]; body: Record<string, unknown> }> = [];
    const stdout = Buffer.from([100, 111, 110, 101, 0]);
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        success: true,
        exitCode: 0,
        stdoutBase64: stdout.toString("base64"),
        stderrBase64: "",
      }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const child = spawn(process.execPath, [
        resolve("dist/cli.mjs"),
        "vfs",
        "--author",
        "codex",
        "tee",
        "--",
        "notes/a b.md",
        "notes/quote'file.md",
      ], {
        cwd: resolve("."),
        env: {
          ...process.env,
          LAMARCK_CORE_URL: `http://127.0.0.1:${address.port}`,
          LAMARCK_CORE_TOKEN: "test-core-token",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const input = Buffer.from([0, 255, 10]);
      child.stdin.end(input);
      const outputChunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => outputChunks.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => errorChunks.push(Buffer.from(chunk)));
      const [exitCode] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

      expect(exitCode).toBe(0);
      expect(Buffer.concat(outputChunks)).toEqual(stdout);
      expect(Buffer.concat(errorChunks)).toEqual(Buffer.alloc(0));
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.authorization).toBe("Bearer test-core-token");
      expect(requests[0]!.headers["x-lamarck-vfs-client"]).toBe("cli");
      expect(requests[0]!.body).toMatchObject({
        options: {
          author: "codex",
          stdin: { encoding: "base64", data: input.toString("base64") },
        },
      });
      const command = requests[0]!.body.command;
      expect(typeof command).toBe("string");
      expect(parseVfsCommand(command as string).argv).toEqual([
        "tee", "--", "notes/a b.md", "notes/quote'file.md",
      ]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("submits one schema change with exact DDL and descriptive metadata", async () => {
    const requests: Array<{ method?: string; url?: string; body?: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length === 0
        ? undefined
        : JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({ method: request.method, url: request.url, body });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(request.method === "POST"
        ? JSON.stringify({ status: "pending", request: { id: "schema-request", status: "pending" } })
        : JSON.stringify({ request: { id: "schema-request", status: "applied" } }));
    });
    const directory = await mkdtemp(join(tmpdir(), "lamarck-cli-schema-"));
    const file = join(directory, "schema.sql");
    const ddl = [
      "CREATE TABLE focus (id TEXT PRIMARY KEY NOT NULL)",
      "CREATE INDEX focus_by_id ON focus(id)",
    ].join(";\n");
    await writeFile(file, ddl, "utf8");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const child = spawn(process.execPath, [
        resolve("dist/cli.mjs"),
        "schema",
        "change",
        "--file",
        file,
        "--author",
        "codex",
        "--context",
        "Add focus storage.",
      ], {
        cwd: resolve("."),
        env: {
          ...process.env,
          LAMARCK_CORE_URL: `http://127.0.0.1:${address.port}`,
          LAMARCK_CORE_TOKEN: "test-core-token",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const outputChunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => outputChunks.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => errorChunks.push(Buffer.from(chunk)));
      const [exitCode] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

      expect(exitCode).toBe(0);
      expect(Buffer.concat(errorChunks)).toEqual(Buffer.alloc(0));
      expect(Buffer.concat(outputChunks).toString("utf8")).toContain("schema request applied: schema-request");
      expect(requests).toEqual([
        {
          method: "POST",
          url: "/api/schema/change/request",
          body: { ddl, author: "codex", context: "Add focus storage." },
        },
        {
          method: "GET",
          url: "/api/schema/requests/schema-request",
          body: undefined,
        },
      ]);
    } finally {
      server.close();
      await once(server, "close");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
