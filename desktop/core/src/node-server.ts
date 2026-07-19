import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable, type Duplex } from "node:stream";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WEBSOCKET_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_WEBSOCKET_OUTBOUND_BYTES = 4 * 1024 * 1024;

export interface NodeWebSocket<T = unknown> {
  data: T;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

interface WebSocketHandlers<T> {
  open?(socket: NodeWebSocket<T>): void;
  message?(socket: NodeWebSocket<T>, message: string | Uint8Array): void;
  close?(socket: NodeWebSocket<T>): void;
}

export interface NodeFetchServer {
  readonly port: number;
  upgrade<T>(request: Request, options: { data: T }): boolean;
  stop(): Promise<void>;
}

export interface ResponseCloseEmitter {
  readonly writableEnded: boolean;
  readonly writableFinished: boolean;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

interface ServeOptions<T> {
  hostname: string;
  port: number;
  fetch(request: Request, server: NodeFetchServer): Response | undefined | Promise<Response | undefined>;
  websocket?: WebSocketHandlers<T>;
}

interface UpgradeContext {
  incoming: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  upgraded: boolean;
}

/**
 * Small Node HTTP adapter for Core's Fetch-native router. It deliberately owns
 * only the server surface Core needs: Fetch requests/responses, streaming
 * SSE bodies, and authenticated WebSocket upgrades for the dev terminal.
 */
export async function serve<T = unknown>(options: ServeOptions<T>): Promise<NodeFetchServer> {
  const upgrades = new WeakMap<Request, UpgradeContext>();
  let boundPort = options.port;

  const httpServer = createServer((incoming, outgoing) => {
    void handleHttpRequest(incoming, outgoing).catch((error) => {
      outgoing.destroy(error instanceof Error ? error : undefined);
    });
  });

  const api: NodeFetchServer = {
    get port() {
      return boundPort;
    },
    upgrade<Data>(request: Request, upgradeOptions: { data: Data }): boolean {
      const context = upgrades.get(request);
      if (!context || context.upgraded || !options.websocket) return false;
      const accepted = acceptWebSocket(
        context,
        upgradeOptions.data,
        options.websocket as unknown as WebSocketHandlers<Data>,
      );
      context.upgraded = accepted;
      return accepted;
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
        httpServer.closeAllConnections();
      });
    },
  };

  httpServer.on("upgrade", (incoming, socket, head) => {
    void handleUpgrade(incoming, socket, head).catch(() => socket.destroy());
  });

  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 60_000;
  httpServer.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Core HTTP server did not expose a TCP address"));
        return;
      }
      boundPort = address.port;
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(options.port, options.hostname);
  });

  return api;

  async function handleHttpRequest(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ): Promise<void> {
    let request: Request | undefined;
    let cancelUnusedBody = false;
    const controller = new AbortController();
    const unbindOutgoingAbort = bindClientDisconnectAbort(outgoing, controller);
    try {
      request = toRequest(incoming, options.hostname, boundPort, controller);
      let response = await options.fetch(request, api) ?? new Response(null, { status: 204 });
      cancelUnusedBody = Boolean(request.body && !request.bodyUsed);
      if (cancelUnusedBody) response = responseWithConnectionClose(response);
      await writeResponse(outgoing, response);
    } catch (error) {
      cancelUnusedBody = Boolean(request?.body && !request.bodyUsed);
      if (outgoing.headersSent) throw error;
      await writeResponse(
        outgoing,
        new Response(JSON.stringify({ error: errorMessage(error) }), {
          status: 500,
          headers: { "Content-Type": "application/json", Connection: "close" },
        }),
      );
    } finally {
      unbindOutgoingAbort();
      // Deliver the response first. Cancelling Readable.toWeb(IncomingMessage)
      // can destroy the socket, so doing it before `finish` would turn a valid
      // 401/4xx response into ECONNRESET for clients still uploading a body.
      if (cancelUnusedBody && request?.body && !request.bodyUsed) {
        await request.body.cancel().catch(() => {});
      }
    }
  }

  async function handleUpgrade(
    incoming: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let request: Request;
    try {
      request = toRequest(incoming, options.hostname, boundPort);
    } catch {
      await writeUpgradeResponse(socket, new Response("Malformed WebSocket request", { status: 400 }));
      return;
    }

    const context: UpgradeContext = { incoming, socket, head, upgraded: false };
    upgrades.set(request, context);
    try {
      const response = await options.fetch(request, api);
      if (!context.upgraded) {
        await writeUpgradeResponse(socket, response ?? new Response("WebSocket upgrade rejected", { status: 400 }));
      }
    } catch (error) {
      if (!context.upgraded) {
        await writeUpgradeResponse(socket, new Response(errorMessage(error), { status: 500 }));
      }
    } finally {
      upgrades.delete(request);
    }
  }
}

/** Bind a premature client disconnect to the Fetch Request's AbortSignal. */
export function bindClientDisconnectAbort(
  response: ResponseCloseEmitter,
  controller: AbortController,
): () => void {
  const onClose = () => {
    if (!response.writableEnded && !response.writableFinished) controller.abort();
  };
  response.once("close", onClose);
  return () => response.off("close", onClose);
}

function responseWithConnectionClose(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Connection", "close");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function toRequest(
  incoming: IncomingMessage,
  hostname: string,
  port: number,
  controller = new AbortController(),
): Request {
  const host = incoming.headers.host ?? `${hostname}:${port}`;
  const url = new URL(incoming.url ?? "/", `http://${host}`);
  incoming.once("aborted", () => controller.abort());
  incoming.once("error", () => controller.abort());

  const init: RequestInit & { duplex?: "half" } = {
    method: incoming.method ?? "GET",
    headers: incoming.headers as HeadersInit,
    signal: controller.signal,
  };
  if (init.method !== "GET" && init.method !== "HEAD") {
    init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  if (!response.body) {
    outgoing.end();
    return;
  }

  await pipeResponseBody(response.body, outgoing);
}

export async function pipeResponseBody(
  responseBody: ReadableStream<Uint8Array>,
  outgoing: ServerResponse,
): Promise<void> {
  const body = Readable.fromWeb(responseBody as never);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      body.off("error", onBodyError);
      outgoing.off("error", onOutgoingError);
      outgoing.off("finish", onFinish);
      outgoing.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onBodyError = (error: Error) => {
      outgoing.destroy(error);
      finish(error);
    };
    const onOutgoingError = (error: Error) => {
      body.destroy();
      finish(error);
    };
    const onFinish = () => finish();
    const onClose = () => {
      // `pipe()` does not destroy its source when the destination disappears.
      // Destroying the Node wrapper cancels the original Web stream, which is
      // how Core's SSE source removes its controller from `sseClients`.
      if (!outgoing.writableFinished) body.destroy();
      finish();
    };
    body.once("error", onBodyError);
    outgoing.once("error", onOutgoingError);
    outgoing.once("finish", onFinish);
    outgoing.once("close", onClose);
    body.pipe(outgoing);
  });
}

async function writeUpgradeResponse(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const statusText = response.statusText || "Rejected";
  const headers = new Headers(response.headers);
  headers.set("Content-Length", String(body.length));
  headers.set("Connection", "close");
  let raw = `HTTP/1.1 ${response.status} ${statusText}\r\n`;
  headers.forEach((value, name) => { raw += `${name}: ${value}\r\n`; });
  socket.end(Buffer.concat([Buffer.from(`${raw}\r\n`, "utf8"), body]));
}

function acceptWebSocket<T>(
  context: UpgradeContext,
  data: T,
  handlers: WebSocketHandlers<T>,
): boolean {
  const key = context.incoming.headers["sec-websocket-key"];
  const version = context.incoming.headers["sec-websocket-version"];
  const upgrade = context.incoming.headers.upgrade;
  if (
    typeof key !== "string"
    || version !== "13"
    || typeof upgrade !== "string"
    || upgrade.toLowerCase() !== "websocket"
  ) {
    return false;
  }

  const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
  context.socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const connection = new WebSocketConnection(context.socket, data, handlers);
  handlers.open?.(connection.socket);
  if (context.head.length) connection.push(context.head);
  return true;
}

export class WebSocketConnection<T> {
  readonly socket: NodeWebSocket<T>;
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode: 1 | 2 | undefined;
  private closed = false;

  constructor(
    private transport: Duplex,
    data: T,
    private handlers: WebSocketHandlers<T>,
  ) {
    this.socket = {
      data,
      send: (value) => this.send(value),
      close: (code = 1000, reason = "") => this.close(code, reason),
    };
    transport.on("data", (chunk: Buffer) => this.push(chunk));
    transport.once("end", () => this.finish());
    transport.once("close", () => this.finish());
    transport.once("error", () => this.finish());
  }

  push(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    try {
      while (this.readFrame()) {}
    } catch {
      this.close(1002, "Invalid WebSocket frame");
    }
  }

  private readFrame(): boolean {
    if (this.buffered.length < 2) return false;
    const first = this.buffered[0];
    const second = this.buffered[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (!masked || (first & 0x70) !== 0) throw new Error("Invalid frame flags");

    let offset = 2;
    let length = second & 0x7f;
    if (length === 126) {
      if (this.buffered.length < offset + 2) return false;
      length = this.buffered.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffered.length < offset + 8) return false;
      const extended = this.buffered.readBigUInt64BE(offset);
      if (extended > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) throw new Error("Frame too large");
      length = Number(extended);
      offset += 8;
    }
    if (length > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error("Frame too large");
    if (this.buffered.length < offset + 4 + length) return false;

    const mask = this.buffered.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(this.buffered.subarray(offset, offset + length));
    this.buffered = this.buffered.subarray(offset + length);
    for (let index = 0; index < payload.length; index++) {
      payload[index] ^= mask[index & 3];
    }

    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) throw new Error("Invalid control frame");
      if (opcode === 0x8) {
        this.writeFrame(0x8, payload);
        this.transport.end();
        this.finish();
      } else if (opcode === 0x9) {
        this.writeFrame(0xA, payload);
      }
      return this.buffered.length > 0;
    }

    if (opcode === 0x1 || opcode === 0x2) {
      if (this.fragmentOpcode !== undefined) throw new Error("Nested fragmented message");
      if (fin) this.emitMessage(opcode, payload);
      else {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      }
    } else if (opcode === 0x0) {
      if (this.fragmentOpcode === undefined) throw new Error("Unexpected continuation");
      this.fragments.push(payload);
      const total = this.fragments.reduce((size, part) => size + part.length, 0);
      if (total > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error("Message too large");
      if (fin) {
        const messageOpcode = this.fragmentOpcode;
        const message = Buffer.concat(this.fragments, total);
        this.fragmentOpcode = undefined;
        this.fragments = [];
        this.emitMessage(messageOpcode, message);
      }
    } else {
      throw new Error("Unknown data opcode");
    }
    return this.buffered.length > 0;
  }

  private emitMessage(opcode: 1 | 2, payload: Buffer): void {
    this.handlers.message?.(
      this.socket,
      opcode === 1 ? payload.toString("utf8") : new Uint8Array(payload),
    );
  }

  private send(value: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) return;
    if (typeof value === "string") {
      this.writeFrame(0x1, Buffer.from(value));
      return;
    }
    const payload = value instanceof ArrayBuffer
      ? Buffer.from(value)
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    this.writeFrame(0x2, payload);
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    const reasonBytes = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.writeFrame(0x8, payload);
    this.transport.end();
    this.finish();
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const frame = Buffer.concat([header, payload]);
    if (this.transport.writableLength + frame.length > MAX_WEBSOCKET_OUTBOUND_BYTES) {
      this.transport.destroy(new Error("WebSocket outbound buffer exceeded"));
      this.finish();
      return;
    }
    this.transport.write(frame);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.close?.(this.socket);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
