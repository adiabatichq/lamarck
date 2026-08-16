import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { APP_VIEWER_CSP } from "./web-policy";
import { CAPSULE_MAX_VIEWER_CONNECTIONS_PER_INSTANCE } from "./backend";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_HEADER_COUNT = 128;
const VIEWER_VFS_PATH_PREFIX = "/.lamarck/vfs/";
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface CapsuleUiStreamTransport {
  openUiStream(instanceId: string): Promise<Duplex>;
}

export interface ViewerGatewayBinding {
  readonly viewerUrl: string;
  readonly proxyUrl: string;
  registerVfsResource(coreUrl: string): string;
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
  coreOrigin: string;
  originHost?: string;
}): Promise<ViewerGatewayBinding> {
  const originHost = options.originHost ?? `${randomBytes(18).toString("hex")}.localhost`;
  assertOriginHost(originHost);
  const coreOrigin = normalizeCoreOrigin(options.coreOrigin);
  const viewerUrl = `http://${originHost}/`;
  const vfsResources = new Map<string, string>();
  const sockets = new Set<Duplex>();

  const bridge = createNetServer({ pauseOnConnect: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void options.transport.openUiStream(options.instanceId).then(
      (guest) => {
        sockets.add(guest);
        guest.once("close", () => sockets.delete(guest));
        if (socket.destroyed) {
          guest.destroy(new Error("Viewer bridge closed before the Guest transport attached"));
          return;
        }
        attachViewerBridge(socket, guest);
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
    if (isReservedVfsPath(target.pathname)) {
      serveViewerVfsResource(incoming, outgoing, target, vfsResources);
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
    if (isReservedVfsPath(target.pathname)) {
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
    registerVfsResource(coreUrl: string) {
      if (closed) throw new Error("Viewer gateway is closed");
      const validatedCoreUrl = validateCoreVfsResourceUrl(coreUrl, coreOrigin);
      let token: string;
      do token = randomBytes(32).toString("base64url");
      while (vfsResources.has(token));
      vfsResources.set(token, validatedCoreUrl);
      return new URL(`${VIEWER_VFS_PATH_PREFIX}${token}`, viewerUrl).toString();
    },
    async close() {
      if (closed) return;
      closed = true;
      vfsResources.clear();
      await Promise.all([
        closeServer(proxy, sockets),
        closeServer(bridge, sockets),
      ]);
    },
  });
}

/** Owns one Host bridge socket until both byte directions finish or either side aborts. */
export function attachViewerBridge(socket: Duplex, guest: Duplex): void {
  const abortGuest = (error: Error) => {
    if (!guest.destroyed) guest.destroy(error);
  };
  socket.once("error", abortGuest);
  socket.once("close", (hadError: boolean) => {
    if (hadError) return;
    if (socket.readableEnded && socket.writableFinished) return;
    abortGuest(new Error("Viewer bridge closed before both byte directions completed"));
  });
  guest.once("error", (error) => {
    if (!socket.destroyed) socket.destroy(error);
  });
  guest.once("close", () => {
    if (!socket.destroyed) socket.destroy();
  });
  socket.pipe(guest).pipe(socket);
  socket.resume();
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

function isReservedVfsPath(pathname: string): boolean {
  return pathname === VIEWER_VFS_PATH_PREFIX.slice(0, -1)
    || pathname.startsWith(VIEWER_VFS_PATH_PREFIX);
}

function serveViewerVfsResource(
  incoming: import("node:http").IncomingMessage,
  outgoing: import("node:http").ServerResponse,
  target: URL,
  resources: Map<string, string>,
): void {
  const method = incoming.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    incoming.resume();
    sendVfsFailure(outgoing, 405, "VFS resource method is not allowed", method === "HEAD", {
      allow: "GET, HEAD",
    });
    return;
  }
  const token = target.pathname.slice(VIEWER_VFS_PATH_PREFIX.length);
  if (target.search || !OPAQUE_TOKEN_PATTERN.test(token)) {
    incoming.resume();
    sendVfsFailure(outgoing, 404, "VFS resource not found", method === "HEAD");
    return;
  }
  const coreUrl = resources.get(token);
  if (!coreUrl) {
    incoming.resume();
    sendVfsFailure(outgoing, 404, "VFS resource not found", method === "HEAD");
    return;
  }

  incoming.resume();
  let viewerResponseTerminated = false;
  const terminateViewerResponse = () => {
    if (viewerResponseTerminated) return;
    viewerResponseTerminated = true;
    if (!outgoing.writableEnded && !outgoing.destroyed) outgoing.destroy();
  };
  outgoing.once("finish", () => { viewerResponseTerminated = true; });
  const upstream = httpRequest(coreUrl, {
    method,
    headers: { accept: incoming.headers.accept ?? "*/*" },
    agent: false,
  }, (response) => {
    response.once("aborted", terminateViewerResponse);
    response.once("error", terminateViewerResponse);
    const status = response.statusCode ?? 502;
    if (status < 200 || status > 299) {
      if (status === 404) resources.delete(token);
      response.resume();
      sendVfsFailure(
        outgoing,
        status === 404 ? 404 : 502,
        "VFS resource unavailable",
        method === "HEAD",
      );
      return;
    }
    outgoing.writeHead(
      status,
      response.statusMessage,
      hardenViewerResponseHeaders(viewerVfsResponseHeaders(response.headers)),
    );
    if (method === "HEAD") {
      response.resume();
      outgoing.end();
    } else {
      response.pipe(outgoing);
    }
  });
  upstream.once("error", () => {
    if (!outgoing.headersSent) {
      sendVfsFailure(outgoing, 502, "VFS resource unavailable", method === "HEAD");
    } else {
      terminateViewerResponse();
    }
  });
  outgoing.once("close", () => {
    if (!outgoing.writableEnded) {
      viewerResponseTerminated = true;
      upstream.destroy();
    }
  });
  upstream.end();
}

function viewerVfsResponseHeaders(
  headers: import("node:http").IncomingHttpHeaders,
): Record<string, string | string[] | undefined> {
  return {
    "accept-ranges": headers["accept-ranges"],
    "content-disposition": headers["content-disposition"],
    "content-length": headers["content-length"],
    "content-range": headers["content-range"],
    "content-type": headers["content-type"] ?? "application/octet-stream",
  };
}

function sendVfsFailure(
  response: import("node:http").ServerResponse,
  status: number,
  message: string,
  head: boolean,
  headers: Record<string, string> = {},
): void {
  const body = Buffer.from(message);
  response.writeHead(status, hardenViewerResponseHeaders({
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.byteLength),
    ...headers,
  }));
  response.end(head ? undefined : body);
}

function normalizeCoreOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Viewer Core origin is invalid");
  }
  if (
    url.protocol !== "http:"
    || !new Set(["localhost", "127.0.0.1"]).has(url.hostname)
    || !url.port
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("Viewer Core origin is invalid");
  }
  return url.origin;
}

function validateCoreVfsResourceUrl(raw: string, coreOrigin: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Core VFS resource URL is invalid");
  }
  const token = url.pathname.slice("/api/vfs/open/".length);
  if (
    url.origin !== coreOrigin
    || !url.pathname.startsWith("/api/vfs/open/")
    || !OPAQUE_TOKEN_PATTERN.test(token)
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error("Core VFS resource URL is invalid");
  }
  return url.toString();
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
