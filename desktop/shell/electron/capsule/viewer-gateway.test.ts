import {
  createServer as createHttpServer,
  get as httpGet,
  request as httpRequest,
} from "node:http";
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

  test("streams Host-owned VFS resources without forwarding the reserved path to Guest", async () => {
    let guestRequests = 0;
    const guest = createHttpServer((_request, response) => {
      guestRequests += 1;
      response.end("Guest must not serve this path");
    });
    const guestPort = await listen(guest);
    closers.push(() => closeServer(guest));

    const coreToken = "c".repeat(43);
    const coreRequests: string[] = [];
    const core = createHttpServer((request, response) => {
      coreRequests.push(`${request.method} ${request.url}`);
      if (request.url !== `/api/vfs/open/${coreToken}`) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": "11",
        "cache-control": "public, max-age=31536000",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      response.write("image-");
      setTimeout(() => response.end("bytes"), 5);
    });
    const corePort = await listen(core);
    closers.push(() => closeServer(core));

    const gateway = await createViewerGateway({
      instanceId: "instance-vfs",
      originHost: "0123456789abcdef.localhost",
      coreOrigin: `http://127.0.0.1:${corePort}`,
      transport: {
        openUiStream: async () => netConnect(guestPort, "127.0.0.1"),
      },
    });
    closers.push(() => gateway.close());
    const viewerResource = gateway.registerVfsResource(
      `http://127.0.0.1:${corePort}/api/vfs/open/${coreToken}`,
    );

    expect(new URL(viewerResource).origin).toBe(new URL(gateway.viewerUrl).origin);
    expect(viewerResource).not.toContain(coreToken);
    expect(viewerResource).not.toContain(`127.0.0.1:${corePort}`);
    const streamed = await proxyRequest(gateway, new URL(viewerResource).pathname, "GET");
    expect(streamed).toMatchObject({
      status: 200,
      body: "image-bytes",
      headers: expect.objectContaining({
        "content-type": "image/png",
        "cache-control": "no-store, max-age=0",
      }),
    });
    const head = await proxyRequest(gateway, new URL(viewerResource).pathname, "HEAD");
    expect(head).toMatchObject({ status: 200, body: "" });
    expect(head.headers["content-type"]).toBe("image/png");
    expect(coreRequests).toEqual([
      `GET /api/vfs/open/${coreToken}`,
      `HEAD /api/vfs/open/${coreToken}`,
    ]);
    expect(guestRequests).toBe(0);
  });

  test("terminates the Viewer response when Core aborts after sending headers", async () => {
    let guestRequests = 0;
    const guest = createHttpServer((_request, response) => {
      guestRequests += 1;
      response.end("Guest must not serve this path");
    });
    const guestPort = await listen(guest);
    closers.push(() => closeServer(guest));
    const coreToken = "a".repeat(43);
    const core = createHttpServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": "1024",
      });
      response.write("partial");
      setImmediate(() => response.socket?.destroy());
    });
    const corePort = await listen(core);
    closers.push(() => closeServer(core));
    const gateway = await createViewerGateway({
      instanceId: "instance-aborted-vfs",
      originHost: "0123456789abcdef.localhost",
      coreOrigin: `http://127.0.0.1:${corePort}`,
      transport: { openUiStream: async () => netConnect(guestPort, "127.0.0.1") },
    });
    closers.push(() => gateway.close());
    const viewerResource = gateway.registerVfsResource(
      `http://127.0.0.1:${corePort}/api/vfs/open/${coreToken}`,
    );

    const terminated = await withTimeout(
      observeProxyTermination(gateway, new URL(viewerResource).pathname),
      1_000,
    );
    expect(terminated.status).toBe(200);
    expect(["aborted", "error"]).toContain(terminated.outcome);
    expect(guestRequests).toBe(0);
  });

  test("fails malformed, expired, and cross-Viewer VFS handles closed and bounded", async () => {
    let guestRequests = 0;
    const guest = createHttpServer((_request, response) => {
      guestRequests += 1;
      response.end("Guest must not serve this path");
    });
    const guestPort = await listen(guest);
    closers.push(() => closeServer(guest));
    const core = createHttpServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("expired Core handle");
    });
    const corePort = await listen(core);
    closers.push(() => closeServer(core));
    const coreOrigin = `http://127.0.0.1:${corePort}`;
    const first = await createViewerGateway({
      instanceId: "instance-first",
      originHost: "0123456789abcdef.localhost",
      coreOrigin,
      transport: { openUiStream: async () => netConnect(guestPort, "127.0.0.1") },
    });
    const second = await createViewerGateway({
      instanceId: "instance-second",
      originHost: "fedcba9876543210.localhost",
      coreOrigin,
      transport: { openUiStream: async () => netConnect(guestPort, "127.0.0.1") },
    });
    closers.push(() => first.close(), () => second.close());
    const viewerResource = first.registerVfsResource(
      `${coreOrigin}/api/vfs/open/${"e".repeat(43)}`,
    );
    const viewerPath = new URL(viewerResource).pathname;

    const malformed = await proxyGet(first, "/.lamarck/vfs/not-a-token");
    const unsupportedMethod = await proxyRequest(first, viewerPath, "POST");
    const expired = await proxyGet(first, viewerPath);
    const crossViewer = await proxyGet(second, viewerPath);
    for (const failure of [malformed, expired, crossViewer]) {
      expect(failure.status).toBe(404);
      expect(Buffer.byteLength(failure.body)).toBeLessThan(128);
    }
    expect(unsupportedMethod.status).toBe(405);
    expect(unsupportedMethod.headers.allow).toBe("GET, HEAD");
    expect(guestRequests).toBe(0);
    expect(() => first.registerVfsResource(`${coreOrigin}/api/query`)).toThrow(
      "Core VFS resource URL is invalid",
    );
    expect(() => first.registerVfsResource(
      `http://127.0.0.1:${corePort + 1}/api/vfs/open/${"x".repeat(43)}`,
    )).toThrow("Core VFS resource URL is invalid");

    const directCore = await rawProxyRequest(first.proxyUrl,
      `GET ${coreOrigin}/api/vfs/open/${"x".repeat(43)} HTTP/1.1\r\n`
      + `Host: 127.0.0.1:${corePort}\r\nConnection: close\r\n\r\n`);
    expect(directCore).toContain("403 Forbidden");
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
      coreOrigin: "http://127.0.0.1:32100",
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
    coreOrigin: `http://127.0.0.1:${upstreamPort}`,
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

function proxyRequest(
  gateway: ViewerGatewayBinding,
  path: string,
  method: "GET" | "HEAD" | "POST",
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const proxy = new URL(gateway.proxyUrl);
  const target = new URL(path, gateway.viewerUrl).toString();
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port),
      path: target,
      method,
      headers: { host: new URL(gateway.viewerUrl).host },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

function observeProxyTermination(
  gateway: ViewerGatewayBinding,
  path: string,
): Promise<{ status: number; outcome: "ended" | "aborted" | "error" }> {
  const request = beginProxyGet(gateway, path);
  return new Promise((resolve) => {
    request.once("error", () => resolve({ status: 0, outcome: "error" }));
    request.once("response", (response) => {
      let settled = false;
      const finish = (outcome: "ended" | "aborted" | "error") => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode ?? 0, outcome });
      };
      response.once("end", () => finish("ended"));
      response.once("aborted", () => finish("aborted"));
      response.once("error", () => finish("error"));
      response.resume();
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for Viewer response termination")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
