import { createServer as createHttpServer, get as httpGet } from "node:http";
import { connect as netConnect } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import {
  attachViewerBridge,
  createViewerGateway,
  type ViewerGatewayBinding,
} from "./viewer-gateway";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

describe("App viewer gateway", () => {
  test("streams bound-origin HTTP responses and applies security headers", async () => {
    const upstream = createHttpServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "cache-control": "public, max-age=31536000",
        expires: "Wed, 01 Jan 2031 00:00:00 GMT",
      });
      response.write("one-");
      setTimeout(() => response.end("two"), 5);
    });
    const upstreamPort = await listen(upstream);
    closers.push(() => closeServer(upstream));

    const gateway = await createGateway(upstreamPort);
    const response = await proxyGet(gateway, "/stream");
    expect(response.status).toBe(200);
    expect(response.body).toBe("one-two");
    expect(response.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(response.headers["x-dns-prefetch-control"]).toBe("off");
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers.expires).toBe("0");
  });

  test("fails closed for another origin and CONNECT tunneling", async () => {
    const upstream = createHttpServer((_request, response) => response.end("secret"));
    const upstreamPort = await listen(upstream);
    closers.push(() => closeServer(upstream));
    const gateway = await createGateway(upstreamPort);

    const denied = await rawProxyRequest(gateway.proxyUrl,
      "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
    expect(denied).toContain("403 Forbidden");

    const tunneled = await rawProxyRequest(gateway.proxyUrl,
      "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    expect(tunneled).toContain("403 Forbidden");
  });

  test("carries a WebSocket-style upgrade as raw bidirectional bytes", async () => {
    const upstream = createHttpServer();
    const upstreamSockets = new Set<import("node:stream").Duplex>();
    upstream.on("upgrade", (_request, socket) => {
      upstreamSockets.add(socket);
      socket.once("close", () => upstreamSockets.delete(socket));
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
      socket.on("data", (chunk) => socket.write(chunk));
    });
    const upstreamPort = await listen(upstream);
    closers.push(async () => {
      for (const socket of upstreamSockets) socket.destroy();
      await closeServer(upstream);
    });
    const gateway = await createGateway(upstreamPort);

    const proxy = new URL(gateway.proxyUrl);
    const viewer = new URL(gateway.viewerUrl);
    const socket = netConnect(Number(proxy.port), proxy.hostname);
    closers.push(async () => { socket.destroy(); });
    await onceConnected(socket);
    socket.write(
      `GET ws://${viewer.host}/socket HTTP/1.1\r\n`
      + `Host: ${viewer.host}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`,
    );
    const handshake = await readUntil(socket, "\r\n\r\n");
    expect(handshake).toContain("101 Switching Protocols");
    socket.write("ping");
    const echoed = await readUntil(socket, "ping");
    expect(echoed).toContain("ping");
  });

  test("leaves a normal bilateral Guest close to directional FIN lifecycle", async () => {
    let guest: RecordingGuestStream | undefined;
    const gateway = await createViewerGateway({
      instanceId: "instance-1",
      originHost: "0123456789abcdef.localhost",
      transport: {
        openUiStream: async () => {
          guest = new RecordingGuestStream(true);
          return guest;
        },
      },
    });
    closers.push(() => gateway.close());

    const response = await proxyGet(gateway, "/normal-close");
    expect(response.status).toBe(200);
    expect(response.body).toBe("viewer response");
    await waitFor(() => guest?.readableEnded && guest.writableFinished);
    await new Promise((resolve) => setImmediate(resolve));
    expect(guest?.destroyErrors).toEqual([]);
  });

  test("destroys a premature Guest bridge close with an explicit error", async () => {
    const socket = new RecordingGuestStream(false);
    const guest = new RecordingGuestStream(false);
    attachViewerBridge(socket, guest);
    socket.emit("close", false);

    const error = await waitFor(() => guest.destroyErrors[0]);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("before both byte directions completed");
  });
});

class RecordingGuestStream extends Duplex {
  readonly destroyErrors: Array<Error | undefined> = [];
  #request = Buffer.alloc(0);
  #responded = false;

  constructor(private readonly respond: boolean) {
    super({ allowHalfOpen: true, autoDestroy: false });
  }

  _read(): void {}

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#request = Buffer.concat([this.#request, chunk]);
    callback();
    if (!this.respond || this.#responded || !this.#request.includes("\r\n\r\n")) return;
    this.#responded = true;
    this.push(Buffer.from(
      "HTTP/1.1 200 OK\r\n"
      + "Content-Type: text/plain\r\n"
      + "Content-Length: 15\r\n"
      + "Connection: close\r\n"
      + "\r\n"
      + "viewer response",
    ));
    this.push(null);
  }

  _final(callback: (error?: Error | null) => void): void {
    callback();
  }

  override destroy(error?: Error): this {
    this.destroyErrors.push(error);
    return super.destroy(error);
  }
}

async function createGateway(upstreamPort: number): Promise<ViewerGatewayBinding> {
  const gateway = await createViewerGateway({
    instanceId: "instance-1",
    originHost: "0123456789abcdef.localhost",
    transport: {
      openUiStream: async () => netConnect(upstreamPort, "127.0.0.1"),
    },
  });
  closers.push(() => gateway.close());
  return gateway;
}

function proxyGet(
  gateway: ViewerGatewayBinding,
  path: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const request = beginProxyGet(gateway, path);
  return new Promise((resolve, reject) => {
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
  });
}

function beginProxyGet(
  gateway: ViewerGatewayBinding,
  path: string,
): ReturnType<typeof httpGet> {
  const proxy = new URL(gateway.proxyUrl);
  const target = new URL(path, gateway.viewerUrl).toString();
  return httpGet({
    host: proxy.hostname,
    port: Number(proxy.port),
    path: target,
    headers: { host: new URL(gateway.viewerUrl).host },
  });
}

function rawProxyRequest(proxyUrl: string, request: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = netConnect(Number(proxy.port), proxy.hostname);
    const chunks: Buffer[] = [];
    socket.once("error", reject);
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("connect", () => socket.end(request));
  });
}

function readUntil(socket: import("node:net").Socket, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      value += chunk.toString("utf8");
      if (!value.includes(marker)) return;
      cleanup();
      resolve(value);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function onceConnected(socket: import("node:net").Socket): Promise<void> {
  if (!socket.connecting) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function listen(server: import("node:http").Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server address unavailable"));
      resolve(address.port);
    });
  });
}

function closeServer(server: import("node:http").Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor<T>(operation: () => T | undefined | false): Promise<Exclude<T, undefined | false>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = operation();
    if (value !== undefined && value !== false) return value as Exclude<T, undefined | false>;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition");
}
