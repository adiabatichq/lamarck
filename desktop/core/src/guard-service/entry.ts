import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { GuardServiceError } from "./engine";
import { GuardProcessExecutor } from "./executor";
import { runGuardExecutorWorker } from "./executor-worker";
import { D0_SCHEMA_VERSION } from "../schema";
import {
  GUARD_RPC_DESCRIPTOR,
  type GuardReadyMessage,
  type GuardPingMessage,
  type GuardPongMessage,
  type GuardRpcFailure,
  type GuardRpcMethod,
  type GuardRpcRequest,
  type GuardShutdownMessage,
} from "./protocol";

export { GuardEngine, GuardServiceError } from "./engine";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const MAX_CANCEL_REQUEST_BYTES = 4 * 1024;
const ABSOLUTE_HARD_EXECUTION_LIMIT_MS = 60_000;

interface ElectronParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data?: unknown } | unknown) => void): void;
}

interface StartedGuardService {
  server: Server;
  executor: GuardProcessExecutor;
  port: number;
  close(): Promise<void>;
}

export async function startGuardService(opts: {
  workspacePath: string;
  token: string;
  port?: number;
  hardExecutionLimitMs?: number;
}): Promise<StartedGuardService> {
  if (typeof opts.token !== "string" || opts.token.length < 16) {
    throw new GuardServiceError(
      "GUARD_TOKEN",
      "LAMARCK_GUARD_TOKEN must contain at least 16 characters",
    );
  }
  const requestedPort = opts.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new GuardServiceError("GUARD_PORT", "PORT must be an integer between 0 and 65535");
  }

  const executor = new GuardProcessExecutor({
    entryPath: __filename,
    workspacePath: opts.workspacePath,
    hardExecutionLimitMs: Math.min(
      opts.hardExecutionLimitMs ?? ABSOLUTE_HARD_EXECUTION_LIMIT_MS,
      ABSOLUTE_HARD_EXECUTION_LIMIT_MS,
    ),
  });
  await executor.start();
  let closing = false;
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(executor, opts.token, request, response);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 500, {
          id: null,
          error: rpcError(error),
        } satisfies GuardRpcFailure);
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(requestedPort, LOOPBACK_HOST);
    });
  } catch (error) {
    await executor.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    await executor.close();
    throw new GuardServiceError("GUARD_LISTEN", "Guard failed to obtain a loopback port");
  }

  return {
    server,
    executor,
    port: address.port,
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      server.closeAllConnections();
      await executor.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function handleRequest(
  executor: GuardProcessExecutor,
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
  if (request.method === "GET" && url.pathname === GUARD_RPC_DESCRIPTOR.healthPath) {
    if (!executor.ready) {
      try {
        await executor.start();
      } catch (error) {
        sendJson(response, 503, {
          error: { code: "GUARD_EXECUTOR_UNAVAILABLE", message: errorMessage(error) },
        });
        return;
      }
    }
    sendJson(response, 200, {
      ok: true,
      schemaVersion: D0_SCHEMA_VERSION,
      database: "data.db",
    });
    return;
  }
  const isRpc = request.method === "POST" && url.pathname === GUARD_RPC_DESCRIPTOR.rpcPath;
  const isCancel = request.method === "POST" && url.pathname === GUARD_RPC_DESCRIPTOR.cancelPath;
  if (!isRpc && !isCancel) {
    sendJson(response, 404, {
      id: null,
      error: { code: "GUARD_NOT_FOUND", message: "Not found" },
    } satisfies GuardRpcFailure);
    return;
  }
  if (!hasBearerToken(request, token)) {
    response.setHeader("WWW-Authenticate", "Bearer");
    sendJson(response, 401, {
      id: null,
      error: { code: "GUARD_UNAUTHORIZED", message: "Unauthorized" },
    } satisfies GuardRpcFailure);
    return;
  }
  if (!isJsonContentType(request.headers["content-type"])) {
    sendJson(response, 415, {
      id: null,
      error: { code: "GUARD_CONTENT_TYPE", message: "Content-Type must be application/json" },
    } satisfies GuardRpcFailure);
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(
      request,
      isCancel ? MAX_CANCEL_REQUEST_BYTES : MAX_REQUEST_BYTES,
    ));
  } catch (error) {
    const failure = rpcError(error);
    sendJson(response, failure.code === "GUARD_REQUEST_LIMIT" ? 413 : 400, {
      id: null,
      error: failure,
    } satisfies GuardRpcFailure);
    return;
  }

  if (isCancel) {
    const id = requireRpcId(raw);
    sendJson(response, 200, { id, cancelled: executor.cancel(id) });
    return;
  }

  const id = rpcId(raw);
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  const onResponseClose = () => {
    if (!response.writableEnded && !response.writableFinished) abort.abort();
  };
  request.once("aborted", onRequestAbort);
  request.once("error", onRequestAbort);
  response.once("close", onResponseClose);
  // IncomingMessage.destroyed may be true after an entirely normal, fully
  // consumed request body. Only `aborted` means the caller went away here.
  if (request.aborted) abort.abort();
  try {
    const rpc = validateRpcRequest(raw);
    const result = await executor.dispatch(rpc.id, rpc.method, rpc.params, {
      timeoutMs: rpc.deadlineMs,
      signal: abort.signal,
    });
    sendJson(response, 200, { id: rpc.id, result });
  } catch (error) {
    if (!response.destroyed) {
      sendJson(response, 200, { id, error: rpcError(error) } satisfies GuardRpcFailure);
    }
  } finally {
    request.off("aborted", onRequestAbort);
    request.off("error", onRequestAbort);
    response.off("close", onResponseClose);
  }
}

function validateRpcRequest(value: unknown): GuardRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GuardServiceError("GUARD_INVALID_REQUEST", "RPC request must be an object");
  }
  const request = value as Record<string, unknown>;
  if (typeof request.id !== "string" && typeof request.id !== "number") {
    throw new GuardServiceError("GUARD_INVALID_REQUEST", "RPC id must be a string or number");
  }
  if (
    typeof request.method !== "string" ||
    !GUARD_RPC_DESCRIPTOR.methods.includes(request.method as GuardRpcMethod)
  ) {
    throw new GuardServiceError(
      "GUARD_METHOD_NOT_FOUND",
      `Unknown Guard RPC method: ${String(request.method)}`,
    );
  }
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    throw new GuardServiceError("GUARD_INVALID_REQUEST", "RPC params must be an object");
  }
  if (
    request.deadlineMs !== undefined
    && (!Number.isSafeInteger(request.deadlineMs) || (request.deadlineMs as number) <= 0)
  ) {
    throw new GuardServiceError(
      "GUARD_INVALID_REQUEST",
      "RPC deadlineMs must be a positive safe integer",
    );
  }
  return request as unknown as GuardRpcRequest;
}

function requireRpcId(value: unknown): string | number {
  const id = rpcId(value);
  if (id === null) {
    throw new GuardServiceError("GUARD_INVALID_REQUEST", "Cancellation requires an RPC id");
  }
  return id;
}

function rpcId(value: unknown): string | number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function rpcError(error: unknown): GuardRpcFailure["error"] {
  if (error instanceof GuardServiceError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof SyntaxError) {
    return { code: "GUARD_INVALID_JSON", message: error.message };
  }
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      errcode?: unknown;
      errstr?: unknown;
      message?: unknown;
    };
    const code = typeof candidate.code === "string"
      ? candidate.code
      : typeof candidate.errcode === "number"
        ? `SQLITE_${candidate.errcode}`
        : "GUARD_INTERNAL";
    const sqliteDetail = typeof candidate.errstr === "string" ? ` (${candidate.errstr})` : "";
    const message = typeof candidate.message === "string"
      ? `${candidate.message}${sqliteDetail}`
      : `Guard operation failed${sqliteDetail}`;
    return { code, message };
  }
  return { code: "GUARD_INTERNAL", message: String(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasBearerToken(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  const header = Array.isArray(value) ? value[0] : value;
  return typeof header === "string" && /^application\/json(?:\s*;|$)/i.test(header);
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      throw new GuardServiceError(
        "GUARD_REQUEST_LIMIT",
        `Guard request exceeds ${maxBytes} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

async function main(): Promise<void> {
  const workspacePath = process.argv[2];
  const token = process.env.LAMARCK_GUARD_TOKEN;
  const port = Number(process.env.PORT ?? "0");
  if (!workspacePath) {
    throw new GuardServiceError("GUARD_WORKSPACE", "Guard utility requires workspace path in argv[2]");
  }
  if (!token) {
    throw new GuardServiceError("GUARD_TOKEN", "LAMARCK_GUARD_TOKEN is required");
  }

  const service = await startGuardService({ workspacePath, token, port });
  const parentPort = (process as NodeJS.Process & { parentPort?: ElectronParentPort | null }).parentPort;
  const executorPid = service.executor.pid;
  if (!executorPid) {
    throw new GuardServiceError("GUARD_EXECUTOR_UNAVAILABLE", "Guard executor is unavailable");
  }
  const ready: GuardReadyMessage = { type: "ready", port: service.port, executorPid };
  if (parentPort) parentPort.postMessage(ready);
  else console.log(JSON.stringify(ready));

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await service.close();
  };
  parentPort?.on("message", (event) => {
    const message = event && typeof event === "object" && "data" in event
      ? (event as { data?: unknown }).data
      : event;
    if ((message as Partial<GuardPingMessage> | null)?.type === "ping") {
      const nonce = (message as Partial<GuardPingMessage>).nonce;
      if (typeof nonce === "number" && Number.isSafeInteger(nonce)) {
        parentPort.postMessage({ type: "pong", nonce } satisfies GuardPongMessage);
      }
      return;
    }
    if ((message as Partial<GuardShutdownMessage> | null)?.type === "shutdown") {
      void shutdown().then(() => process.exit(0));
    }
  });
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
}

if (require.main === module) {
  if (process.env.LAMARCK_GUARD_EXECUTOR_WORKER === "1") {
    const workspacePath = process.argv[2];
    try {
      if (!workspacePath) {
        throw new GuardServiceError(
          "GUARD_WORKSPACE",
          "Guard executor requires workspace path in argv[2]",
        );
      }
      runGuardExecutorWorker(workspacePath);
    } catch (error) {
      const failure = rpcError(error);
      console.error(`[guard-executor] ${failure.code}: ${failure.message}`);
      process.exit(1);
    }
  } else {
    void main().catch((error) => {
      const failure = rpcError(error);
      console.error(`[guard-service] ${failure.code}: ${failure.message}`);
      process.exitCode = 1;
    });
  }
}
