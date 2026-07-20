import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { APP_VIEWER_CSP } from "./web-policy";
import { CAPSULE_MAX_VIEWER_CONNECTIONS_PER_INSTANCE } from "./backend";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_HEADER_COUNT = 128;

export interface CapsuleUiStreamTransport {
  openUiStream(instanceId: string): Promise<Duplex>;
}

export interface ViewerGatewayBinding {
  readonly viewerUrl: string;
  readonly proxyUrl: string;
  close(): Promise<void>;
}

/**
 * A per-viewer forward proxy with an internal one-shot raw bridge to the Guest.
 * Chromium receives only `proxyUrl`; the Guest instance binding and bridge
 * port never cross into renderer code. Standard HTTP origins preserve native
 * streaming, WebSocket, and HMR behavior that a custom protocol cannot offer.
 */
export async function createViewerGateway(options: {
  transport: CapsuleUiStreamTransport;
  instanceId: string;
  originHost?: string;
}): Promise<ViewerGatewayBinding> {
  const originHost = options.originHost ?? `${randomBytes(18).toString("hex")}.localhost`;
  assertOriginHost(originHost);
  const viewerUrl = `http://${originHost}/`;
  const sockets = new Set<Duplex>();

  const bridge = createNetServer({ pauseOnConnect: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void options.transport.openUiStream(options.instanceId).then(
      (guest) => {
        sockets.add(guest);
        guest.once("close", () => sockets.delete(guest));
        if (socket.destroyed) {
          guest.destroy();
          return;
        }
        socket.once("error", () => guest.destroy());
        socket.once("close", () => guest.destroy());
        guest.once("error", () => socket.destroy());
        guest.once("close", () => socket.destroy());
        socket.pipe(guest).pipe(socket);
        socket.resume();
      },
      () => socket.destroy(),
    );
  });
  bridge.maxConnections = CAPSULE_MAX_VIEWER_CONNECTIONS_PER_INSTANCE;
  await listen(bridge);
  const bridgeAddress = bridge.address();
  if (!bridgeAddress || typeof bridgeAddress === "string") {
    bridge.close();
    throw new Error("Viewer Guest bridge did not bind a TCP address");
  }

  const proxy = createHttpServer({ maxHeaderSize: 64 * 1024 }, (incoming, outgoing) => {
    const target = parseProxyTarget(incoming.url, incoming.headers.host);
    if (!target || !isBoundTarget(target, originHost)) {
      sendDenied(outgoing);
      incoming.resume();
      return;
    }

    const headers = sanitizeRequestHeaders(incoming.headers, originHost);
    const upstream = httpRequest({
      host: LOOPBACK_HOST,
      port: bridgeAddress.port,
      method: incoming.method,
      path: `${target.pathname}${target.search}`,
      headers,
      agent: false,
    }, (response) => {
      outgoing.writeHead(
        response.statusCode ?? 502,
        response.statusMessage,
        hardenViewerResponseHeaders(response.headers),
      );
      response.pipe(outgoing);
    });
    upstream.once("error", (error) => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, hardenViewerResponseHeaders({ "content-type": "text/plain; charset=utf-8" }));
      }
      outgoing.end(`App viewer upstream failed: ${error.message}`);
    });
    incoming.once("aborted", () => upstream.destroy());
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) upstream.destroy();
    });
    incoming.pipe(upstream);
  });
  proxy.maxHeadersCount = MAX_HEADER_COUNT;
  proxy.maxConnections = CAPSULE_MAX_VIEWER_CONNECTIONS_PER_INSTANCE;
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  proxy.on("upgrade", (request, browserSocket, head) => {
    const target = parseProxyTarget(request.url, request.headers.host);
    if (!target || !isBoundTarget(target, originHost)) {
      browserSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    const upstream = netConnect({ host: LOOPBACK_HOST, port: bridgeAddress.port });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("error", () => browserSocket.destroy());
    browserSocket.once("error", () => upstream.destroy());
    upstream.once("connect", () => {
      const path = `${target.pathname}${target.search}`;
      const headers = sanitizeRequestHeaders(request.headers, originHost, true);
      const lines = [`${request.method ?? "GET"} ${path} HTTP/${request.httpVersion}`];
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) lines.push(`${name}: ${entry}`);
        } else if (value !== undefined) {
          lines.push(`${name}: ${value}`);
        }
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      browserSocket.pipe(upstream).pipe(browserSocket);
    });
  });

  try {
    await listen(proxy);
  } catch (error) {
    await closeServer(bridge, sockets);
    throw error;
  }
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") {
    await Promise.all([closeServer(proxy, sockets), closeServer(bridge, sockets)]);
    throw new Error("Viewer proxy did not bind a TCP address");
  }

  let closed = false;
  return Object.freeze({
    viewerUrl,
    proxyUrl: `http://${LOOPBACK_HOST}:${proxyAddress.port}`,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([
        closeServer(proxy, sockets),
        closeServer(bridge, sockets),
      ]);
    },
  });
}

function parseProxyTarget(rawUrl: string | undefined, host: string | undefined): URL | null {
  if (!rawUrl) return null;
  try {
    if (/^https?:\/\//i.test(rawUrl) || /^wss?:\/\//i.test(rawUrl)) return new URL(rawUrl);
    if (!host || !rawUrl.startsWith("/")) return null;
    return new URL(rawUrl, `http://${host}`);
  } catch {
    return null;
  }
}

function isBoundTarget(target: URL, originHost: string): boolean {
  return (target.protocol === "http:" || target.protocol === "ws:") && target.host === originHost;
}

function sanitizeRequestHeaders(
  raw: Readonly<Record<string, string | string[] | undefined>>,
  originHost: string,
  preserveUpgrade = false,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  const connectionTokens = new Set(
    String(raw.connection ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase();
    if (value === undefined || connectionTokens.has(lower)) continue;
    if (["proxy-authorization", "proxy-connection", "forwarded", "via"].includes(lower)) continue;
    headers[lower] = value;
  }
  headers.host = originHost;
  headers["x-forwarded-host"] = originHost;
  headers["x-forwarded-proto"] = "http";
  if (preserveUpgrade) {
    headers.connection = "Upgrade";
    const upgrade = raw.upgrade;
    if (typeof upgrade === "string" && upgrade.length > 0) headers.upgrade = upgrade;
  }
  return headers;
}

export function hardenViewerResponseHeaders(
  raw: Readonly<Record<string, string | string[] | number | undefined>>,
): Record<string, string | string[] | number> {
  const headers: Record<string, string | string[] | number> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"].includes(lower)) continue;
    headers[lower] = value;
  }
  headers["content-security-policy"] = APP_VIEWER_CSP;
  headers["cross-origin-resource-policy"] = "same-origin";
  headers["referrer-policy"] = "no-referrer";
  headers["x-content-type-options"] = "nosniff";
  headers["x-dns-prefetch-control"] = "off";
  // App responses are runtime output, not authoritative browser state. Never
  // let an upstream framework opt the Host-owned viewer session into a durable
  // Chromium HTTP cache entry.
  headers["cache-control"] = "no-store, max-age=0";
  headers.pragma = "no-cache";
  headers.expires = "0";
  return headers;
}

function sendDenied(response: import("node:http").ServerResponse): void {
  response.writeHead(403, hardenViewerResponseHeaders({ "content-type": "text/plain; charset=utf-8" }));
  response.end("Viewer target is not bound to this App instance");
}

function assertOriginHost(value: string): void {
  if (!/^[a-f0-9]{16,64}\.localhost$/.test(value)) {
    throw new Error("Viewer origin host must be a Host-generated localhost subdomain");
  }
}

function listen(server: import("node:net").Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(
  server: import("node:net").Server,
  sockets: ReadonlySet<Duplex>,
): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
