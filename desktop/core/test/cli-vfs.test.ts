import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseVfsCommand } from "@lamarck/system/internal/vfs";

describe("VFS CLI", () => {
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
});
