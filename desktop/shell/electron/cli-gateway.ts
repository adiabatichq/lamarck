import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import {
  CLI_RUNTIME_FILENAME,
  CliStreamReader,
  defaultCliRuntimeDirectory,
  encodeCliHttpResponse,
  parseCliFrame,
  parseCliRequest,
  type CliRequest,
} from "@lamarck/cli";
import type { CliOperationDispatcher } from "./cli-dispatcher";

export class DesktopCliGateway {
  readonly #directory: string;
  readonly #descriptorPath: string;
  #server: Server | null = null;
  #token: string | null = null;

  constructor(private readonly options: {
    readonly dispatcher: CliOperationDispatcher;
    readonly runtimeDirectory?: string;
  }) {
    this.#directory = options.runtimeDirectory ?? defaultCliRuntimeDirectory();
    this.#descriptorPath = join(this.#directory, CLI_RUNTIME_FILENAME);
  }

  async start(): Promise<void> {
    if (this.#server) throw new Error("Desktop CLI gateway is already running");
    const server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      const authorized = this.#token !== null
        && req.headers.authorization === `Bearer ${this.#token}`;
      if (!authorized) return write(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && req.url === "/cli/v1/hello") {
        res.setHeader("Content-Type", "application/json");
        return write(res, 200, this.options.dispatcher.capabilities("host"));
      }
      if (req.method !== "POST" || req.url !== "/cli/v1/execute") {
        return write(res, 404, { error: "not found" });
      }
      let request: CliRequest;
      try {
        request = await readRequest(req);
      } catch {
        res.setHeader("Content-Type", "application/json");
        return write(res, 400, { error: "invalid request" });
      }
      try {
        const dispatched = await this.options.dispatcher.dispatch(request, {
          environment: "host",
          principal: { kind: "system" },
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(encodeCliHttpResponse(request.operation, dispatched.response));
      } catch {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(encodeCliHttpResponse(request.operation, {
          requestId: request.requestId,
          ok: false,
          error: { code: "CLI_INTERNAL", message: "Lamarck could not complete the command." },
        }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Desktop CLI gateway did not bind TCP");
    this.#server = server;
    const token = randomBytes(32).toString("base64url");
    this.#token = token;
    try {
      await this.#publishDescriptor(address.port, token);
    } catch (error) {
      this.#server = null;
      this.#token = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#token = null;
    await rm(this.#descriptorPath, { force: true }).catch(() => {});
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async #publishDescriptor(port: number, token: string): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const runtimeDirectory = await lstat(this.#directory);
    if (!runtimeDirectory.isDirectory() || runtimeDirectory.isSymbolicLink()) {
      throw new Error("Desktop CLI runtime directory is unsafe");
    }
    await chmod(this.#directory, 0o700);
    const temporary = join(this.#directory, `.runtime-${randomBytes(12).toString("hex")}.json`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({
        port,
        token,
      }));
      await file.sync();
    } finally { await file.close(); }
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, this.#descriptorPath);
      try {
        const directory = await open(dirname(this.#descriptorPath), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        // The atomic descriptor publish already succeeded. Keep the matching
        // descriptor valid even if the best-effort directory durability sync fails.
        console.error("[cli] descriptor directory sync failed:", error);
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

async function readRequest(requestStream: import("node:http").IncomingMessage): Promise<CliRequest> {
  if (requestStream.headers["content-type"] !== "application/octet-stream") {
    throw new Error("CLI request content type is invalid");
  }
  const reader = new CliStreamReader(requestStream);
  const request = parseCliRequest(parseCliFrame(await reader.readFrame()), true);
  if (request.upload !== undefined && request.upload.kind !== "file-stdin") {
    throw new Error("Host CLI does not accept App package uploads");
  }
  const bytes = request.upload?.kind === "file-stdin"
    ? await reader.readExact(request.upload.bytes)
    : undefined;
  if ((await reader.readToEnd(1)).byteLength !== 0) throw new Error("CLI request has trailing bytes");
  if (bytes === undefined) return request;
  return {
    requestId: request.requestId,
    operation: request.operation,
    input: { ...request.input, stdinBase64: bytes.toString("base64") },
  } as CliRequest;
}

function write(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
  finished?: () => void,
): void {
  response.statusCode = status;
  response.end(JSON.stringify(value), finished);
}
