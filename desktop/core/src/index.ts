import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { randomBytes } from "crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { openSystemDatabase } from "./db";
import { ContentBlobStore } from "./blob-store";
import { validateDocId } from "./doc-id";
import type { SchemaOp } from "./guard-types";
import {
  APP_GUARD_DEADLINE_MS,
  HOST_GUARD_DEADLINE_MS,
  RemoteGuard,
  appDocGrants,
  type GuardStatement,
} from "./remote-guard";
import {
  WorkingTree,
  WorkingTreeConflictNotFoundError,
  WorkingTreeConflictStaleError,
  WorkingTreeResolutionError,
  type WorkingTreeConflictResolution,
} from "./working-tree";
import { WorkingTreeStateStore } from "./working-tree-state";
import { archiveApp, loadApps, sourceForAppWorkload, type AppWorkloadIdentity } from "./app-loader";
import {
  ConnectorScheduler,
  ConnectorLifecycleConflictError,
  ConnectorSupervisor,
  currentConnectorPlatform,
  hashConnectorPackage,
  installConnectorFromSource,
  isDirectOAuthAuthType,
  isPlatformSupported,
  listAvailableBuiltIns,
  registerWorkspaceConnectors,
  removeConnectorFromWorkspace,
  resolveWorkspaceConnectorDir,
  updateConnectorFromSource,
} from "./connectors";
import {
  ConnectorAuthManager,
} from "./connectors/auth";
import {
  CredentialStore,
  LamarckSessionManager,
  SqliteEncryptedSecretStore,
  encodeVaultKey,
} from "./credentials";
import { ulid } from "./utils/ulid";
import { SettingsStore } from "./settings";
import {
  AppCapabilityRegistry,
  admitRequest,
  requireSecret,
  type AppWorkload,
  type AuthContext,
  type AuthSecrets,
} from "./auth";
import type { JsonValue } from "./json";
import type { GuardSqlParams } from "./guard-service/protocol";
import { serve, type NodeWebSocket } from "./node-server";
import { HttpStatusError, readJsonBody } from "./http-body";
import {
  isAppSystemRoute,
  isDeclaredWorkload,
  parseRequestedWorkload,
} from "./app-runtime-policy";
import { createAppPackageJson, createAppPackageLock } from "./app-scaffold";

// Lamarck — HTTP server entry point
// All routes go through here. Guard is the only write path.

const workspacePath = resolve(process.argv[2] || process.cwd());
const pagesDir = join(workspacePath, "pages");
const appsDir = join(workspacePath, "apps");
const lamarckDir = join(workspacePath, ".lamarck");
const authSecrets: AuthSecrets = {
  coreToken: requireSecret("LAMARCK_CORE_TOKEN"),
};
const appCapabilities = new AppCapabilityRegistry();
const corePort = Number(process.env.PORT) || 3000;
const coreHost = process.env.HOST || "127.0.0.1";
const oauthRedirectUri = `http://localhost:${corePort}/oauth/callback`;
const identityRedirectUri = `http://localhost:${corePort}/auth/callback`;
const managedProviderAppOrigin = process.env.LAMARCK_APP_ORIGIN ?? "https://app.lamarck.ai";
const lamarckApiOrigin = process.env.LAMARCK_API_ORIGIN ?? "https://api.lamarck.ai";

// Ensure .lamarck/ exists
await mkdir(lamarckDir, { recursive: true });

// Boot
const systemDb = openSystemDatabase(workspacePath);
const guard = RemoteGuard.fromEnvironment("system:server");
await guard.health();
const contentBlobStore = new ContentBlobStore(workspacePath);
const settings = new SettingsStore(lamarckDir);
await settings.update({ workspacePath });
const vaultKey = process.env.LAMARCK_VAULT_KEY ?? encodeVaultKey(randomBytes(32));
const secretStore = new SqliteEncryptedSecretStore(systemDb, vaultKey);
const credentialStore = new CredentialStore(systemDb);
const lamarckSessionManager = new LamarckSessionManager(secretStore, {
  credentialStore,
  apiOrigin: lamarckApiOrigin,
  appOrigin: managedProviderAppOrigin,
  redirectUri: identityRedirectUri,
});
const authManager = new ConnectorAuthManager(
  secretStore,
  {
    credentialStore,
    managedProviderApiOrigin: lamarckApiOrigin,
    lamarckSession: lamarckSessionManager,
  },
);
const connectorSupervisor = new ConnectorSupervisor({
  systemDb,
  guard,
  host: { workspacePath, lamarckApiOrigin },
  authManager,
  oauthRedirectUri,
  managedProviderAppOrigin,
});
// Built-ins are bundled catalog entries; installing one is an explicit user
// action through the same install flow as any other connector package.
const builtinConnectorsDir = fileURLToPath(new URL("../../template/connectors", import.meta.url));
const connectorManifests = await registerWorkspaceConnectors(connectorSupervisor, workspacePath, {
  skipInvalid: true,
  onError(connectorDir, err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[lamarck] Skipping connector ${connectorDir}: ${message}`);
  },
});
const connectorScheduler = new ConnectorScheduler({
  supervisor: connectorSupervisor,
  onError(err, integration) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[lamarck] Connector ${integration.connectorId} scheduler error: ${message}`);
  },
});
let registry = await loadApps(appsDir);
let appManifestGeneration = 1;
let appRegistryReload: Promise<void> | null = null;
const workingTree = new WorkingTree({
  guard,
  pagesDir,
  stateStore: new WorkingTreeStateStore(systemDb),
});
await workingTree.start();

interface SchemaRequest {
  id: string;
  kind: SchemaOp;
  ddl: string[];
  requestedBy: string;
  createdAt: number;
  beforeSchema: unknown;
  status: "pending" | "applied" | "rejected" | "failed";
  error?: string;
}

const schemaRequests = new Map<string, SchemaRequest>();
const schemaApprovals = new Map<string, Promise<SchemaRequest>>();

// SSE: push doc change notifications to connected shell clients
const sseClients = new Set<ReadableStreamDefaultController>();
guard.docChangeSubscribers.push((id) => {
  const msg = `data: ${JSON.stringify({ id })}\n\n`;
  for (const c of sseClients) {
    try { c.enqueue(new TextEncoder().encode(msg)); } catch { sseClients.delete(c); }
  }
});

console.log(`[lamarck] Workspace: ${workspacePath}`);
console.log(`[lamarck] Apps loaded: ${[...registry.apps.keys()].join(", ") || "(none)"}`);
console.log(`[lamarck] Connectors loaded: ${connectorManifests.map((manifest) => manifest.id).join(", ") || "(none)"}`);

// The trusted Shell may call Core over localhost. App viewers never receive a
// Core URL or a CORS-capable bearer; their System SDK is mediated by the Host.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "null",
]);

function corsHeaders(req: Request, extra?: Record<string, string>): Record<string, string> {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": [
      "Authorization",
      "Content-Type",
    ].join(", "),
    Vary: "Origin",
    ...extra,
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function isAllowedHost(req: Request): boolean {
  const rawHost = req.headers.get("host");
  if (!rawHost) return false;
  const host = rawHost.toLowerCase().replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

async function readBody<T>(req: Request): Promise<T> {
  return readJsonBody<T>(req);
}

function guardForRequest(auth: AuthContext, opts?: {
  requireAppIdentity?: boolean;
  signal?: AbortSignal;
}): RemoteGuard {
  if (auth.kind === "host") {
    if (opts?.requireAppIdentity) {
      throw new Error("Guard: app identity is required for this write path");
    }
    return guard.withExecution({
      signal: opts?.signal,
      deadlineMs: HOST_GUARD_DEADLINE_MS,
    });
  }

  return guard.withSource(sourceForAppWorkload(auth.appId, parseAppWorkload(auth.workload)), {
    // Authority is the immutable manifest snapshot bound when the Host issued
    // this channel. A later manifest edit can neither expand an in-flight
    // request nor revive this channel after its generation is invalidated.
    writeTables: [...auth.authorization.writeTables],
    docGrants: [...auth.authorization.docGrants],
    schemaGrant: false,
    signal: opts?.signal,
    deadlineMs: APP_GUARD_DEADLINE_MS,
  });
}

async function reloadAppRegistry(): Promise<void> {
  if (appRegistryReload) return appRegistryReload;

  const retiredGeneration = appManifestGeneration;
  const reload = (async () => {
    // invalidateManifestGeneration closes admissions synchronously before its
    // first await, then drains requests already admitted under that snapshot.
    await appCapabilities.invalidateManifestGeneration(retiredGeneration);
    const nextRegistry = await loadApps(appsDir);
    registry = nextRegistry;
    appManifestGeneration = retiredGeneration + 1;
  })();
  appRegistryReload = reload;
  try {
    await reload;
  } finally {
    if (appRegistryReload === reload) appRegistryReload = null;
  }
}

async function waitForAppRegistryReload(): Promise<void> {
  if (appRegistryReload) await appRegistryReload;
}

function parseAppWorkload(workload: AppWorkload): AppWorkloadIdentity {
  if (workload === "ui") return { kind: "ui" };
  const separator = workload.indexOf(":");
  const kind = workload.slice(0, separator);
  const entryId = workload.slice(separator + 1);
  if (kind === "service") return { kind: "service", entryId };
  if (kind === "job") return { kind: "job", entryId };
  throw new Error(`Guard: invalid app workload: ${workload}`);
}

async function createSchemaRequest(
  kind: SchemaOp,
  ddl: string | string[],
  requestedBy: string,
  requestGuard: RemoteGuard = guard,
): Promise<{ status: "pending" | "applied"; request?: SchemaRequest }> {
  if ((await settings.get()).allowCodingAgentSchemaDecisions) {
    if (kind === "promote") {
      await requestGuard.promote(ddl, { approved: true, requestedBy });
    } else {
      await requestGuard.demote(ddl, { approved: true, requestedBy });
    }
    return { status: "applied" };
  }

  const plan = await requestGuard.schemaPlan(kind, ddl);
  const request: SchemaRequest = {
    id: ulid(),
    kind,
    ddl: plan.ddl,
    requestedBy,
    createdAt: Date.now(),
    beforeSchema: plan.beforeSchema,
    status: "pending",
  };
  schemaRequests.set(request.id, request);
  return { status: "pending", request };
}

async function approveSchemaRequest(
  id: string,
  remember: boolean,
  requestGuard: RemoteGuard = guard,
): Promise<SchemaRequest> {
  const request = schemaRequests.get(id);
  if (!request) throw new Error(`Schema request not found: ${id}`);
  const inFlight = schemaApprovals.get(id);
  if (inFlight) return inFlight;
  if (request.status !== "pending") return request;

  const operation = (async () => {
    try {
      if (request.kind === "promote") {
        await requestGuard.promote(request.ddl, { approved: true, requestedBy: request.requestedBy });
      } else {
        await requestGuard.demote(request.ddl, { approved: true, requestedBy: request.requestedBy });
      }
      request.status = "applied";
      if (remember) {
        try {
          await settings.update({ allowCodingAgentSchemaDecisions: true });
        } catch (err) {
          request.error = `Schema applied, but the approval preference was not saved: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
    } catch (err) {
      request.status = "failed";
      request.error = err instanceof Error ? err.message : String(err);
    }
    return request;
  })();
  schemaApprovals.set(id, operation);
  try {
    return await operation;
  } finally {
    schemaApprovals.delete(id);
  }
}

function rejectSchemaRequest(id: string): SchemaRequest {
  const request = schemaRequests.get(id);
  if (!request) throw new Error(`Schema request not found: ${id}`);
  if (schemaApprovals.has(id)) throw new Error(`Schema request is currently being applied: ${id}`);
  if (request.status === "pending") request.status = "rejected";
  return request;
}

async function readAppFiles(appDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(dir: string, prefix = ""): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        files[relPath] = await readFile(fullPath, "utf8");
      }
    }
  }
  await walk(appDir);
  return files;
}

function resolveAppFile(appDir: string, filename: string): string {
  const target = join(appDir, filename);
  const rel = relative(appDir, target);
  if (!rel || rel.startsWith("..") || rel.includes("../") || rel === ".git" || rel.startsWith(".git/")) {
    throw new Error("Invalid filename");
  }
  return target;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const PRIVATE_RUNTIME_ENV = [
  "LAMARCK_GUARD_ORIGIN",
  "LAMARCK_GUARD_TOKEN",
  "LAMARCK_CORE_TOKEN",
  "LAMARCK_VAULT_KEY",
] as const;

function unprivilegedSubprocessEnv(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const name of PRIVATE_RUNTIME_ENV) delete env[name];
  return env;
}

function runProcess(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: unprivilegedSubprocessEnv(),
      stdio: "ignore",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        `${command} exited ${code === null ? `from signal ${signal ?? "unknown"}` : `with code ${code}`}`,
      ));
    });
  });
}

async function fileResponse(
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  const contentType = staticContentType(path);
  return new Response(new Uint8Array(await readFile(path)), {
    headers: contentType ? { "Content-Type": contentType, ...headers } : headers,
  });
}

function staticContentType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return undefined;
  }
}

// Track active terminal subprocesses for cleanup
const terminalProcs = new Set<ChildProcessWithoutNullStreams>();
const ptyHelperPath = fileURLToPath(new URL("./pty-helper.cjs", import.meta.url));
let shuttingDown = false;

// Routes
const server = await serve<{ cwd: string }>({
  hostname: coreHost,
  port: corePort,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const headers = corsHeaders(req);
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      });

    if (shuttingDown) return json({ error: "Core is shutting down" }, 503);

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if ((path.startsWith("/api/") || path === "/oauth/callback" || path === "/auth/callback") && !isAllowedHost(req)) {
      return json({ error: "invalid host" }, 403);
    }

    if (path === "/auth/callback" && method === "GET") {
      try {
        const result = await lamarckSessionManager.completeCallback(url.searchParams);
        const nextScript = result.nextUrl
          ? `<script>window.location.replace(${JSON.stringify(result.nextUrl)});</script>`
          : "";
        const nextText = result.nextUrl
          ? "Continuing to provider connection..."
          : "You can return to Lamarck desktop.";
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Lamarck Desktop</title>${nextScript}<body style="font-family: system-ui; padding: 24px;"><h1>Signed in</h1><p>${escapeHtml(nextText)}</p><p style="color: #555;">Session ${escapeHtml(result.sessionId ?? "")}</p></body>`,
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Lamarck Desktop</title><body style="font-family: system-ui; padding: 24px;"><h1>Sign in failed</h1><p>${escapeHtml(message)}</p></body>`,
          {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
          },
        );
      }
    }

    if (path === "/oauth/callback" && method === "GET") {
      const result = await connectorSupervisor.completeOAuthCallback(url.searchParams);
      const ok = result.status === "connected";
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Lamarck OAuth</title><body style="font-family: system-ui; padding: 24px;"><h1>${ok ? "Connected" : "OAuth failed"}</h1><p>${ok ? "You can return to Lamarck." : escapeHtml(result.error ?? result.status)}</p></body>`,
        {
          status: ok ? 200 : 400,
          headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
        },
      );
    }

    const admission = path.startsWith("/api/")
      ? admitRequest(req, authSecrets, appCapabilities)
      : null;
    if (path.startsWith("/api/") && !admission) {
      return json({ error: "unauthorized" }, 401);
    }
    const auth = admission?.context ?? null;
    const requestGuardSignal = admission
      ? AbortSignal.any([req.signal, admission.signal])
      : req.signal;
    if (auth?.kind === "app" && !isAppSystemRoute(path, method)) {
      admission!.release();
      return json({ error: "host auth required" }, 403);
    }

    // -- Terminal WebSocket upgrade --
    if (path === "/api/terminal") {
      const upgraded = server.upgrade(req, { data: { cwd: workspacePath } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400, headers });
      }
      return undefined as unknown as Response;
    }

    // -- SSE: doc change stream --
    if (path === "/api/docs/events" && method === "GET") {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(controller) {
          ctrl = controller;
          sseClients.add(controller);
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        },
        cancel() {
          sseClients.delete(ctrl);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...headers,
        },
      });
    }

    try {
      // -- Workspace --
      if (path === "/api/workspace" && method === "GET") {
        return json({ path: workspacePath });
      }

      // -- Lamarck identity --
      if (path === "/api/identity/session" && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        return json(await lamarckSessionManager.session());
      }

      if (path === "/api/identity/login/start" && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        return json(lamarckSessionManager.startLogin());
      }

      if (path === "/api/identity/logout" && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        await lamarckSessionManager.logout();
        return json({ ok: true });
      }

      // -- D1 Working Tree reconciliation --
      if (path === "/api/working-tree/conflicts" && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        return json({ conflicts: await workingTree.listConflicts() });
      }

      const workingTreeResolveMatch = path.match(
        /^\/api\/working-tree\/conflicts\/(.+)\/resolve$/,
      );
      if (workingTreeResolveMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        let docId: string;
        try {
          docId = decodeURIComponent(workingTreeResolveMatch[1]);
          validateDocId(docId);
        } catch {
          throw new HttpStatusError(400, "invalid Working Tree document id");
        }
        const body = await readBody<{
          resolution?: unknown;
          expectedVersion?: unknown;
          newId?: unknown;
        }>(req);
        if (
          body.resolution !== "use-database"
          && body.resolution !== "use-file"
          && body.resolution !== "keep-both"
        ) {
          throw new HttpStatusError(400, "invalid Working Tree conflict resolution");
        }
        if (typeof body.expectedVersion !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedVersion)) {
          throw new HttpStatusError(400, "invalid Working Tree conflict version");
        }
        if (body.newId !== undefined && typeof body.newId !== "string") {
          throw new HttpStatusError(400, "invalid Working Tree Keep Both document id");
        }
        return json(await workingTree.resolveConflict(docId, {
          resolution: body.resolution as WorkingTreeConflictResolution,
          expectedVersion: body.expectedVersion,
          newId: body.newId as string | undefined,
        }));
      }

      const workingTreeConflictMatch = path.match(
        /^\/api\/working-tree\/conflicts\/(.+)$/,
      );
      if (workingTreeConflictMatch && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        let docId: string;
        try {
          docId = decodeURIComponent(workingTreeConflictMatch[1]);
          validateDocId(docId);
        } catch {
          throw new HttpStatusError(400, "invalid Working Tree document id");
        }
        const conflict = await workingTree.getConflict(docId);
        if (!conflict) return json({ error: "Working Tree conflict not found" }, 404);
        return json({ conflict });
      }

      // -- Docs --
      if (path === "/api/docs" && method === "POST") {
        const body = await readBody<{ id: string; content: string; metadata?: Record<string, unknown> }>(req);
        await guardForRequest(auth!, { signal: requestGuardSignal }).writeDoc(
          body.id,
          body.content,
          body.metadata,
        );
        return json({ ok: true, id: body.id });
      }

      if (path.startsWith("/api/docs/") && method === "GET") {
        const docId = decodeURIComponent(path.slice("/api/docs/".length));
        const doc = await guardForRequest(auth!, { signal: requestGuardSignal }).queryOne(
          "SELECT * FROM docs WHERE id = ?",
          [docId],
        );
        if (!doc) return json({ error: "not found" }, 404);
        return json(doc);
      }

      if (path.startsWith("/api/docs/") && method === "DELETE") {
        const docId = decodeURIComponent(path.slice("/api/docs/".length));
        const deleted = await guardForRequest(auth!, { signal: requestGuardSignal }).deleteDoc(docId);
        if (!deleted) return json({ error: "not found" }, 404);
        return json({ ok: true });
      }

      // -- Events --
      if (path === "/api/events" && method === "POST") {
        const body = await readBody<{
          type: string; startedAt: number;
          endedAt?: number; externalId?: string; payload: JsonValue;
        }>(req);
        const id = await guardForRequest(auth!, { signal: requestGuardSignal }).writeEvent(body);
        return json({ ok: true, id });
      }

      // -- Query (read-only SQL) --
      if (path === "/api/query" && method === "POST") {
        const body = await readBody<{ sql: string; params?: GuardSqlParams }>(req);
        const rows = await guardForRequest(auth!, { signal: requestGuardSignal }).query(
          body.sql,
          body.params,
        );
        return json({ rows });
      }

      if (path === "/api/content-ref/resolve" && method === "POST") {
        const body = await readBody<{ ref: JsonValue }>(req);
        return json(contentBlobStore.resolve(body.ref));
      }

      // -- Mutate / transaction (D2 DML + transactional D0 audit) --
      if (path === "/api/mutate" && method === "POST") {
        const body = await readBody<{ sql: string; params?: GuardSqlParams }>(req);
        const result = await guardForRequest(auth!, {
          requireAppIdentity: true,
          signal: requestGuardSignal,
        }).mutate(
          body.sql,
          body.params,
        );
        return json(result);
      }

      if (path === "/api/transaction" && method === "POST") {
        const body = await readBody<{ statements: GuardStatement[] }>(req);
        const results = await guardForRequest(auth!, {
          requireAppIdentity: true,
          signal: requestGuardSignal,
        }).transaction(
          body.statements,
        );
        return json(results);
      }

      // -- Schema lifecycle request/approval --
      if (path === "/api/schema/inspect" && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        return json(await guardForRequest(auth!, { signal: requestGuardSignal }).schemaInspect());
      }

      const schemaRequestMatch = path.match(/^\/api\/schema\/(promote|demote)\/request$/);
      if (schemaRequestMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const kind = schemaRequestMatch[1] as SchemaOp;
        const body = await readBody<{ ddl: string | string[]; requestedBy?: string }>(req);
        const requestedBy = body.requestedBy ?? "coding-agent";
        const result = await createSchemaRequest(
          kind,
          body.ddl,
          requestedBy,
          guardForRequest(auth!, { signal: requestGuardSignal }),
        );
        return json(result);
      }

      if (path === "/api/schema/requests" && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        return json({ requests: [...schemaRequests.values()] });
      }

      const schemaRequestById = path.match(/^\/api\/schema\/requests\/([^/]+)$/);
      if (schemaRequestById && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const request = schemaRequests.get(decodeURIComponent(schemaRequestById[1]));
        if (!request) return json({ error: "not found" }, 404);
        return json({ request });
      }

      const approveMatch = path.match(/^\/api\/schema\/requests\/([^/]+)\/approve$/);
      if (approveMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ remember?: boolean }>(req);
        const request = await approveSchemaRequest(
          decodeURIComponent(approveMatch[1]),
          body.remember === true,
          guardForRequest(auth!, { signal: requestGuardSignal }),
        );
        return json({ request });
      }

      const rejectMatch = path.match(/^\/api\/schema\/requests\/([^/]+)\/reject$/);
      if (rejectMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const request = rejectSchemaRequest(decodeURIComponent(rejectMatch[1]));
        return json({ request });
      }

      // -- Connectors --
      if (path === "/api/connectors" && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const sources = (await connectorSupervisor.list()).map((source) => ({
          ...source,
          oauthRedirectUri: isDirectOAuthAuthType(source.authType) ? oauthRedirectUri : undefined,
        }));
        return json({
          sources,
          // Compatibility alias while callers migrate to the ownership model.
          connectors: sources,
          packages: connectorSupervisor.listInstalledConnectors(),
        });
      }

      // Bundled catalog entries; installed reflects whether the package is
      // currently registered in the workspace.
      if (path === "/api/connectors/available" && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const platform = currentConnectorPlatform();
        const entries = await listAvailableBuiltIns(builtinConnectorsDir, (dir, err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[lamarck] Skipping bundled connector ${dir}: ${message}`);
        });
        const installedById = new Map(
          connectorSupervisor.listInstalledConnectors()
            .map((connector) => [connector.connectorId, connector] as const),
        );
        const available = await Promise.all(entries.map(async (entry) => {
          const installed = installedById.get(entry.manifest.id);
          const catalogHash = await hashConnectorPackage(entry.dir);
          const installedHash = installed
            ? await hashConnectorPackage(
                resolveWorkspaceConnectorDir(workspacePath, entry.manifest.id),
              ).catch(() => installed.packageHash)
            : undefined;
          return {
            connectorId: entry.manifest.id,
            name: entry.manifest.name,
            mode: entry.manifest.runtime.mode,
            integrationsMode: entry.manifest.integrations.mode,
            authType: entry.manifest.auth?.type ?? "none",
            supported: isPlatformSupported(entry.manifest, platform),
            installed: installed !== undefined,
            catalogHash,
            installedHash,
            updateAvailable: installedHash !== undefined && installedHash !== catalogHash,
          };
        }));
        return json({ available });
      }

      const installConnectorMatch = path.match(/^\/api\/connectors\/([^/]+)\/install$/);
      if (installConnectorMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const connectorId = decodeURIComponent(installConnectorMatch[1]);
        const installed = await installConnectorFromSource({
          sourceDir: join(builtinConnectorsDir, connectorId),
          workspacePath,
          connectorId,
          guard,
        });
        const manifest = await connectorSupervisor.registerDirectory(installed.dir);
        return json({ ok: true, manifest });
      }

      const updateConnectorMatch = path.match(/^\/api\/connectors\/([^/]+)\/update$/);
      if (updateConnectorMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const connectorId = decodeURIComponent(updateConnectorMatch[1]);
        const result = await updateConnectorFromSource({
          sourceDir: join(builtinConnectorsDir, connectorId),
          workspacePath,
          connectorId,
          supervisor: connectorSupervisor,
          guard,
        });
        if (result.updated) {
          connectorScheduler.tick().catch((err) => {
            console.warn(`[lamarck] Connector scheduler tick after update failed: ${err}`);
          });
        }
        return json({
          ok: true,
          updated: result.updated,
          manifest: result.manifest,
          fromHash: result.fromHash,
          toHash: result.toHash,
        });
      }

      const approveConnectorMatch = path.match(/^\/api\/connectors\/([^/]+)\/approve$/);
      if (approveConnectorMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const manifest = await connectorSupervisor.approveCurrentPackage(decodeURIComponent(approveConnectorMatch[1]));
        return json({ ok: true, manifest });
      }

      const requirementsCheckMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)\/requirements\/check$/);
      if (requirementsCheckMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const requirements = await connectorSupervisor.checkIntegrationRequirements(
          decodeURIComponent(requirementsCheckMatch[1]),
        );
        return json({ requirements });
      }

      const removeConnectorMatch = path.match(/^\/api\/connectors\/([^/]+)$/);
      if (removeConnectorMatch && method === "DELETE") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const connectorId = decodeURIComponent(removeConnectorMatch[1]);
        const removed = await removeConnectorFromWorkspace({
          workspacePath,
          connectorId,
          supervisor: connectorSupervisor,
        });
        return json({ ok: true, removed });
      }

      const createIntegrationMatch = path.match(/^\/api\/connectors\/([^/]+)\/integrations$/);
      if (createIntegrationMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ integrationKey?: string; scheduleCron?: string | null; config?: unknown }>(req);
        const integration = connectorSupervisor.addIntegration({
          connectorId: decodeURIComponent(createIntegrationMatch[1]),
          integrationKey: body.integrationKey,
          scheduleCron: body.scheduleCron,
          config: body.config,
        });
        return json({ integration });
      }

      const integrationMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)$/);
      if (integrationMatch && method === "PATCH") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{
          scheduleCron?: string | null;
          integrationKey?: string;
          config?: unknown;
        }>(req);
        const instanceId = decodeURIComponent(integrationMatch[1]);
        connectorSupervisor.updateIntegration(instanceId, {
          scheduleCron: body.scheduleCron,
          integrationKey: body.integrationKey,
          config: body.config,
        });
        const integration = await connectorSupervisor.refreshIntegrationSetup(instanceId);
        return json({ integration });
      }
	      if (integrationMatch && method === "DELETE") {
	        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
	        await connectorSupervisor.removeIntegration(decodeURIComponent(integrationMatch[1]));
	        return json({ ok: true });
	      }

      const pauseIntegrationMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)\/pause$/);
      if (pauseIntegrationMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ durationMs?: number }>(req).catch(() => ({} as { durationMs?: number }));
        const integration = await connectorSupervisor.pauseIntegration(
          decodeURIComponent(pauseIntegrationMatch[1]),
          body.durationMs,
        );
        return json({ integration });
      }

      const resumeIntegrationMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)\/resume$/);
      if (resumeIntegrationMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const integration = connectorSupervisor.resumeIntegration(
          decodeURIComponent(resumeIntegrationMatch[1]),
        );
        connectorScheduler.tick().catch((err) => {
          console.warn(`[lamarck] Connector scheduler tick after resume failed: ${err}`);
        });
        return json({ integration });
      }

      const disconnectIntegrationMatch = path.match(
        /^\/api\/connectors\/integrations\/([^/]+)\/disconnect$/,
      );
      if (disconnectIntegrationMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const integration = await connectorSupervisor.disconnectIntegration(
          decodeURIComponent(disconnectIntegrationMatch[1]),
        );
        return json({ integration });
      }

	      const configPanelStartMatch = path.match(
	        /^\/api\/connectors\/integrations\/([^/]+)\/config-panels\/([^/]+)\/start$/,
	      );
	      if (configPanelStartMatch && method === "POST") {
	        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
	        const result = await connectorSupervisor.startConfigUi(
	          decodeURIComponent(configPanelStartMatch[1]),
	          decodeURIComponent(configPanelStartMatch[2]),
	        );
	        return json(result);
	      }

	      const configUiSessionMatch = path.match(/^\/api\/connectors\/config-ui-sessions\/([^/]+)$/);
	      if (configUiSessionMatch && method === "DELETE") {
	        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
	        const stopped = await connectorSupervisor.stopConfigUiSession(
	          decodeURIComponent(configUiSessionMatch[1]),
	        );
	        return json({ ok: true, stopped });
	      }

	      const connectIntegrationMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)\/connect$/);
      if (connectIntegrationMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ token?: string }>(req);
        const integration = await connectorSupervisor.connectIntegrationWithToken(
          decodeURIComponent(connectIntegrationMatch[1]),
          body.token ?? "",
        );
        return json({ integration });
      }

      const authStartMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)\/auth\/start$/)
        ?? path.match(/^\/api\/connectors\/integrations\/([^/]+)\/oauth\/start$/);
      if (authStartMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const result = await connectorSupervisor.startAuthIntegration(
          decodeURIComponent(authStartMatch[1]),
          {
            redirectUri: oauthRedirectUri,
          },
        );
        return json(result);
      }

      const authAttemptMatch = path.match(
        /^\/api\/connectors\/integrations\/([^/]+)\/auth\/attempts\/([^/]+)$/,
      ) ?? path.match(
        /^\/api\/connectors\/integrations\/([^/]+)\/oauth\/attempts\/([^/]+)$/,
      );
      if (authAttemptMatch && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const result = await connectorSupervisor.getOAuthAttempt(
          decodeURIComponent(authAttemptMatch[1]),
          decodeURIComponent(authAttemptMatch[2]),
        );
        return json(result);
      }

      const restartIntegrationMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)\/restart$/);
      if (restartIntegrationMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const integration = connectorSupervisor.restartIntegration(
          decodeURIComponent(restartIntegrationMatch[1]),
        );
        // Kick the scheduler so the restart takes effect immediately instead of
        // waiting for the next tick; don't block the response on it.
        connectorScheduler.tick().catch((err) => {
          console.warn(`[lamarck] Connector scheduler tick after restart failed: ${err}`);
        });
        return json({ integration });
      }

      // Trigger a one-off run on demand: the only execution path for a manual
      // connector, and how any connector takes an explicit run (e.g. backfill).
      // Non-blocking — the run proceeds in the background; status shows on the
      // integration. The optional config body rides as a one-off run override.
      const runIntegrationMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)\/run$/);
      if (runIntegrationMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ config?: unknown }>(req).catch(() => ({} as { config?: unknown }));
        const instanceId = decodeURIComponent(runIntegrationMatch[1]);
        connectorSupervisor.start(instanceId, { config: body.config, trigger: "manual" });
        return json({ ok: true });
      }

      const requirementRequestMatch = path.match(
        /^\/api\/connectors\/integrations\/([^/]+)\/requirements\/([^/]+)\/request$/,
      );
      if (requirementRequestMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const requirement = await connectorSupervisor.requestIntegrationRequirement(
          decodeURIComponent(requirementRequestMatch[1]),
          decodeURIComponent(requirementRequestMatch[2]),
        );
        return json({ requirement });
      }

      // -- Apps --
      if (path === "/api/app-runtime/channels" && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ appId?: unknown; workload?: unknown }>(req);
        const workload = parseRequestedWorkload(body.workload);
        if (typeof body.appId !== "string" || !workload) {
          return json({ error: "appId and a valid workload are required" }, 400);
        }
        await waitForAppRegistryReload();
        const app = registry.apps.get(body.appId);
        if (!app || !isDeclaredWorkload(app.manifest, workload)) {
          return json({ error: "unknown App or undeclared workload" }, 404);
        }
        return json(appCapabilities.issue(body.appId, workload, {
          manifestGeneration: appManifestGeneration,
          writeTables: registry.getTableGrants(body.appId),
          docGrants: appDocGrants(body.appId, app.manifest.permissions.docs),
        }));
      }

      const runtimeChannelMatch = path.match(/^\/api\/app-runtime\/channels\/([^/]+)$/);
      if (runtimeChannelMatch && method === "DELETE") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const channelId = decodeURIComponent(runtimeChannelMatch[1]);
        if (!await appCapabilities.revoke(channelId)) return json({ error: "not found" }, 404);
        return json({ ok: true });
      }

      const runtimeAppChannelsMatch = path.match(/^\/api\/app-runtime\/apps\/([^/]+)\/channels$/);
      if (runtimeAppChannelsMatch && method === "DELETE") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const appId = decodeURIComponent(runtimeAppChannelsMatch[1]);
        return json({ ok: true, revoked: await appCapabilities.revokeApp(appId) });
      }

      if (path === "/api/apps" && method === "GET") {
        const apps = [...registry.apps.values()].map((a) => ({
          manifestVersion: a.manifest.manifestVersion,
          id: a.manifest.id,
          name: a.manifest.name,
          runtime: a.manifest.runtime,
          permissions: a.manifest.permissions,
        }));
        return json({ apps });
      }

      // -- App Source (Host editing/build snapshot input; never a runtime mount) --
      const sourceMatch = path.match(/^\/api\/apps\/([^/]+)\/source$/);
      if (sourceMatch && method === "GET") {
        const appId = decodeURIComponent(sourceMatch[1]);
        const app = registry.apps.get(appId);
        if (!app) return json({ error: "app not found" }, 404);
        try {
          return json(await readAppFiles(app.dir));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json({ error: message }, 500);
        }
      }

      // -- Create App --
      if (path === "/api/apps" && method === "POST") {
        const body = await readBody<{ id: string; name?: string }>(req);
        const id = body.id;

        // Validate id: lowercase, alphanumeric + hyphens
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
          return json({ error: "Invalid app id. Use lowercase alphanumeric + hyphens." }, 400);
        }
        if (
          body.name !== undefined &&
          (typeof body.name !== "string" || body.name.length === 0 || body.name.trim() !== body.name)
        ) {
          return json({ error: "Invalid app name. Use a non-empty name without surrounding whitespace." }, 400);
        }
        const name = body.name ?? id;

        const appDir = join(appsDir, id);
        await mkdir(appDir, { recursive: true });

        const manifest = {
          manifestVersion: 1,
          id,
          name,
          runtime: {
            ui: {
              command: ["npm", "run", "start"],
              port: 3000,
            },
          },
          permissions: {
            docs: [],
            tables: [],
          },
        };
        await writeFile(join(appDir, "manifest.json"), JSON.stringify(manifest, null, 2));
        await writeFile(
          join(appDir, "package.json"),
          createAppPackageJson(id),
        );
        await writeFile(join(appDir, "package-lock.json"), createAppPackageLock(id));
        await writeFile(
          join(appDir, "vite.config.ts"),
          `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n`,
        );
        await writeFile(
          join(appDir, "index.tsx"),
          `import React from "react";\n\nconst appName = ${JSON.stringify(name)};\n\nexport default function App() {\n  return <div>{appName}</div>;\n}\n`,
        );
        await writeFile(
          join(appDir, "main.tsx"),
          `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./index";\n\nconst root = document.getElementById("root");\nif (!root) throw new Error("Missing #root element");\ncreateRoot(root).render(<StrictMode><App /></StrictMode>);\n`,
        );
        await writeFile(
          join(appDir, "index.html"),
          `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${escapeHtml(name)}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/main.tsx"></script>\n  </body>\n</html>\n`,
        );
        try {
          await runProcess("git", ["init"], appDir);
        } catch (err) {
          console.warn(`[lamarck] Could not initialize git for ${id}:`, err);
        }

        // Reloading invalidates every channel issued from the prior manifest
        // generation before the new App becomes visible.
        await reloadAppRegistry();

        // D0 composition: a new capability unit was registered into the system.
        // Only the id is recorded — at creation name mirrors the id and the
        // write scope is always empty; both evolve later through app.commit.
        await guardForRequest(auth!, { signal: requestGuardSignal }).writeEvent({
          type: "app.created",
          startedAt: Date.now(),
          payload: { appId: id },
        });
        return json({ ok: true, id });
      }

      // -- Archive App (non-destructive removal) --
      const archiveMatch = path.match(/^\/api\/apps\/([^/]+)\/archive$/);
      if (archiveMatch && method === "POST") {
        const appId = decodeURIComponent(archiveMatch[1]);
        const app = registry.apps.get(appId);
        if (!app) return json({ error: "app not found" }, 404);

        // Stop admission and drain active App requests before moving its code.
        await appCapabilities.revokeApp(appId);
        await archiveApp(appsDir, join(lamarckDir, "archived-apps"), appId);
        await reloadAppRegistry();

        // D0 composition: the capability was retired (recoverable, not deleted).
        // Only the id is recorded — the archive location is conventional
        // (.lamarck/archived-apps/<appId>) and the name is in the kept manifest.
        await guardForRequest(auth!, { signal: requestGuardSignal }).writeEvent({
          type: "app.archived",
          startedAt: Date.now(),
          payload: { appId },
        });
        return json({ ok: true, id: appId });
      }

      // -- Save App File --
      const fileMatch = path.match(/^\/api\/apps\/([^/]+)\/files\/(.+)$/);
      if (fileMatch && method === "PUT") {
        const appId = decodeURIComponent(fileMatch[1]);
        const filename = decodeURIComponent(fileMatch[2]);

        const app = registry.apps.get(appId);
        if (!app) return json({ error: "app not found" }, 404);

        const body = await readBody<{ content: string }>(req);
        const filePath = resolveAppFile(app.dir, filename);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, body.content);

        // Reload registry if manifest was modified
        if (filename === "manifest.json" || filename === "package.json") {
          await reloadAppRegistry();
        }

        return json({ ok: true });
      }

      // -- Shell (static SPA) --
      const shellDir = process.env.SHELL_DIST;
      if (shellDir) {
        // Try exact file first, then fall back to index.html (SPA routing)
        const filePath = join(shellDir, path === "/" ? "index.html" : path);
        try {
          const info = await stat(filePath);
          if (info.isFile()) return fileResponse(filePath, headers);
        } catch {}
        // SPA fallback: serve index.html for non-file routes
        try {
          const indexPath = join(shellDir, "index.html");
          await stat(indexPath);
          return fileResponse(indexPath, headers);
        } catch {}
      }

      return json({ error: "not found" }, 404);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[lamarck] Error: ${message}`);
      const status = err instanceof HttpStatusError
        ? err.status
        : err instanceof WorkingTreeConflictNotFoundError
          ? 404
          : err instanceof WorkingTreeConflictStaleError
            ? 409
            : err instanceof WorkingTreeResolutionError
              ? 400
        : err instanceof ConnectorLifecycleConflictError
          ? 409
          : 500;
      return json({ error: message }, status);
    } finally {
      // App revocation closes admission immediately, then waits on this lease.
      // Every successful admission is released exactly once on all route exits.
      admission?.release();
    }
  },
  websocket: {
    open(ws) {
      const { cwd } = ws.data as { cwd: string };

      // Keep the native PTY isolated from the HTTP process. Electron-as-Node
      // and standalone Node 24 both execute the same helper artifact.
      const proc = spawn(process.execPath, [ptyHelperPath, cwd], {
        stdio: ["pipe", "pipe", "pipe"],
        env: unprivilegedSubprocessEnv({
          ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? "1",
          TERM: "xterm-256color",
          LANG: "en_US.UTF-8",
        }),
      }) as ChildProcessWithoutNullStreams;

      terminalProcs.add(proc);
      (ws as any)._proc = proc;

      let terminalFinished = false;
      const finishTerminal = (error?: Error) => {
        if (terminalFinished) return;
        terminalFinished = true;
        terminalProcs.delete(proc);
        if (error) {
          try {
            ws.send(`\r\n[lamarck] Terminal failed: ${error.message}\r\n`);
          } catch {}
        }
        try { ws.close(error ? 1011 : 1000, error ? "Terminal process failed" : ""); } catch {}
      };

      // PTY stdout → WebSocket
      proc.stdout.on("data", (value: Buffer) => {
        try { ws.send(value); } catch {}
      });
      proc.once("error", finishTerminal);
      proc.once("exit", () => finishTerminal());
      // A failed or closed child stdin can emit independently of ChildProcess.
      proc.stdin.on("error", () => {});

      // PTY stderr → WebSocket
      proc.stderr.on("data", (value: Buffer) => {
        try { ws.send(value); } catch {}
      });
    },
    message(ws, message) {
      const proc = (ws as NodeWebSocket<{ cwd: string }> & { _proc?: ChildProcessWithoutNullStreams })._proc;
      if (!proc?.stdin) return;

      // Forward data (including \x01 resize messages) to the Node helper
      const data = typeof message === "string" ? message : new TextDecoder().decode(message);
      proc.stdin.write(data);
    },
    close(ws) {
      const proc = (ws as NodeWebSocket<{ cwd: string }> & { _proc?: ChildProcessWithoutNullStreams })._proc;
      if (proc) {
        terminalProcs.delete(proc);
        try { proc.kill(); } catch {}
      }
    },
  },
});

connectorScheduler.start().catch((err) => {
  console.error("[lamarck] Connector scheduler failed:", err);
});

console.log(`[lamarck] Server running on http://localhost:${server.port}`);

// Graceful shutdown
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[lamarck] Shutting down...");
  const serverStopped = server.stop().catch(() => {});
  await connectorScheduler.stop();
  for (const proc of terminalProcs) {
    try { proc.kill(); } catch {}
  }
  terminalProcs.clear();
  await serverStopped;
  await workingTree.stop();
  systemDb.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown().catch((err) => {
    console.error("[lamarck] Shutdown failed:", err);
    process.exit(1);
  });
});
process.on("SIGTERM", () => {
  shutdown().catch((err) => {
    console.error("[lamarck] Shutdown failed:", err);
    process.exit(1);
  });
});
