import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rm, stat } from "fs/promises";
import { randomBytes } from "crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { openSystemDatabase } from "./db";
import { ContentBlobStore } from "./blob-store";
import {
  APP_GUARD_DEADLINE_MS,
  HOST_GUARD_DEADLINE_MS,
  RemoteGuard,
  type GuardStatement,
  type SchemaSnapshot,
} from "./remote-guard";
import { D1ObserverState } from "./d1-observer-state";
import { D1Observer } from "./d1-observer";
import { D1Sequencer } from "./d1-sequencer";
import { VfsService, type VfsCaller } from "./vfs";
import {
  archiveApp,
  loadApps,
  sourceForAppWorkload,
  type AppRegistry,
  type AppWorkloadIdentity,
} from "./app-loader";
import {
  ConnectorScheduler,
  ConnectorLifecycleConflictError,
  ConnectorSupervisor,
  hashConnectorPackage,
  installConnectorFromSource,
  isDirectOAuthAuthType,
  registerWorkspaceConnectors,
  removeConnectorFromWorkspace,
  resolveWorkspaceConnectorDir,
  updateConnectorFromSource,
  type InstalledConnectorPackageView,
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
import {
  SCHEMA_CHANGE_AUTHOR_MAX_CHARS,
  SCHEMA_CHANGE_CONTEXT_MAX_CHARS,
  type GuardSqlParams,
} from "./guard-service/protocol";
import { serve, type NodeWebSocket } from "./node-server";
import { HttpStatusError, readJsonBody } from "./http-body";
import {
  isAppSystemRoute,
  parseRequestedWorkload,
} from "./app-runtime-policy";
import { instantiateBlankApp } from "./app-scaffold";
import { PACKAGE_ID_PATTERN, SCOPED_PACKAGE_ID_PATTERN } from "./package-id";
import { resolveDeviceIdentity } from "./device-identity";
import { AppRepositoryService } from "./apps/repository";
import { AppActivationCoordinator } from "./apps/activation";
import { AppEditMaterializationCoordinator } from "./apps/edit-materialization";
import { ArchiveHttpError, readAppPackageArchive } from "./apps/package-archive";
import { AppLifecycleService } from "./apps/lifecycle";
import { AppLifecycleError } from "./apps/errors";
import {
  ProducerDescriptorStore,
  createAppProducerDescriptor,
  createProducerBinding,
  createSystemProducerDescriptor,
} from "./producer-descriptor";
import { systemIdentityFromBuild } from "./system-identity";
import { instantiateMarketplaceApp } from "./marketplace/app-instantiation";
import { loadMarketplaceTrustRootsFile } from "./marketplace/client";
import { ConnectorMarketplaceError, MarketplaceService } from "./marketplace/service";
import {
  MANAGED_APP_EDIT_ROOT,
  parseCliRequest,
  type CliErrorCode,
  type CliRequest,
  type CliResponse,
  type FileCommandResult,
} from "@lamarck/cli";
import {
  projectAppShape,
  projectAppSummary,
  projectConnectorInspect,
  projectConnectorSummary,
  projectSourceShape,
  projectSourceSummary,
  type SourceProjectionInput,
} from "./cli-projectors";

// Lamarck — HTTP server entry point
// All routes go through here. Guard is the only write path.

const workspacePath = resolve(process.argv[2] || process.cwd());
const appsDir = join(workspacePath, "apps");
const lamarckDir = join(workspacePath, ".lamarck");
const appScaffoldDir = fileURLToPath(new URL("./scaffolds/app-v1/", import.meta.url));
const marketplaceTrustRootsPath = fileURLToPath(
  new URL("./marketplace-trust-roots.json", import.meta.url),
);
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
const systemIdentity = systemIdentityFromBuild();
const producerDescriptorStore = new ProducerDescriptorStore(workspacePath);
const systemProducer = createProducerBinding(
  producerDescriptorStore,
  createSystemProducerDescriptor(systemIdentity),
);
const guard = RemoteGuard.fromEnvironment(
  "system:server",
  systemProducer.producerRef,
  systemProducer.prepareProducer,
);
await guard.health();
const appVersionGuard = guard.withSource("system:apps", {
  producerRef: systemProducer.producerRef,
  prepareProducer: systemProducer.prepareProducer,
  writeTables: [],
  schemaGrant: false,
  deadlineMs: HOST_GUARD_DEADLINE_MS,
});
const appRepository = new AppRepositoryService({
  eventWriter: appVersionGuard,
  eventWriterForAuthority(authority) {
    return guard.withSource(authority.source, {
      producerRef: authority.producerRef,
      prepareProducer: () => { producerDescriptorStore.resolve(authority.producerRef); },
      writeTables: [],
      schemaGrant: false,
      deadlineMs: HOST_GUARD_DEADLINE_MS,
    });
  },
});
const appActivationCoordinator = new AppActivationCoordinator(
  appRepository,
  join(lamarckDir, "cache", "app-versions"),
);
const appEditMaterializations = new AppEditMaterializationCoordinator(
  appRepository,
  join(lamarckDir, "cache", "app-edit-bases"),
);
const appLifecycle = new AppLifecycleService(
  appsDir,
  join(lamarckDir, "archived-apps"),
  appRepository,
  appActivationCoordinator,
  appEditMaterializations,
);
const contentBlobStore = new ContentBlobStore(workspacePath);
const settings = new SettingsStore(lamarckDir);
const coreSettings = await settings.get();
const deviceIdentity = await resolveDeviceIdentity(coreSettings.vaultId ?? "");
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
  workspacePath,
  systemIdentity,
  producerDescriptorStore,
  authManager,
  oauthRedirectUri,
  managedProviderAppOrigin,
  deviceIdentity,
});
const connectorManifests = await registerWorkspaceConnectors(connectorSupervisor, workspacePath, {
  skipInvalid: true,
  onError(connectorDir, err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[lamarck] Skipping connector ${connectorDir}: ${message}`);
  },
});
await connectorSupervisor.recoverSourceIdentities();
const connectorScheduler = new ConnectorScheduler({
  supervisor: connectorSupervisor,
  onError(err, sourceRecord) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[lamarck] Connector ${sourceRecord.connectorId} scheduler error: ${message}`);
  },
});
let registry = await loadApps(appsDir);
let appRegistryTail: Promise<void> = Promise.resolve();
const marketplaceService = await MarketplaceService.initialize({
  workspacePath,
  apiOrigin: lamarckApiOrigin,
  trustRoots: await loadMarketplaceTrustRootsFile(marketplaceTrustRootsPath),
  lifecycle: {
    async appExists(localId) {
      try {
        return (await stat(join(appsDir, localId))).isDirectory();
      } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
      }
    },
    instantiateApp: instantiateVerifiedMarketplaceApp,
    async connectorHash(packageId) {
      if (!connectorSupervisor.isRegistered(packageId)) return undefined;
      return hashConnectorPackage(resolveWorkspaceConnectorDir(workspacePath, packageId));
    },
    async connectorState(packageId) {
      const installed = await connectorSupervisor.currentInstalledConnectorPackage(packageId);
      if (
        !installed?.packageHash
        || !["official", "custom", "modified", "untrusted"].includes(installed.packageTrust)
      ) return undefined;
      const installation = connectorSupervisor.marketplaceInstallation(packageId);
      return {
        hash: installed.packageHash,
        trust: installed.packageTrust as "official" | "custom" | "modified" | "untrusted",
        marketplaceManaged: installed.packageTrust === "official"
          && installation?.packageHash === installed.packageHash,
      };
    },
    recordOfficialConnectorRelease(packageId, contentHash) {
      connectorSupervisor.recordOfficialMarketplaceRelease(packageId, contentHash);
    },
    recordConnectorInstallation(packageId, contentHash, releaseId) {
      connectorSupervisor.recordMarketplaceInstallation(packageId, contentHash, releaseId);
    },
    async installConnector(verifiedSourceDir, packageId, eventGuard = guard) {
      await connectorSupervisor.clearInactiveConnectorRemnants(packageId);
      await installConnectorFromSource({
        sourceDir: verifiedSourceDir,
        workspacePath,
        connectorId: packageId,
        supervisor: connectorSupervisor,
        guard: eventGuard,
      });
    },
    async updateConnector(verifiedSourceDir, packageId, eventGuard = guard) {
      const updated = await updateConnectorFromSource({
        sourceDir: verifiedSourceDir,
        workspacePath,
        connectorId: packageId,
        supervisor: connectorSupervisor,
        guard: eventGuard,
      });
      return { updated: updated.updated };
    },
  },
});
const connectorUpdateCheckIntervalMs = 24 * 60 * 60 * 1_000;
const latestOfficialConnectorReleases = new Map<string, {
  contentHash: string;
}>();
let connectorUpdateCheck: Promise<void> | null = null;

function refreshOfficialConnectorReleases(): Promise<void> {
  if (connectorUpdateCheck) return connectorUpdateCheck;
  const installed = connectorSupervisor.listInstalledConnectors()
    .filter((connector) => connector.packageTrust === "official");
  connectorUpdateCheck = Promise.allSettled(installed.map(async (connector) => {
    const release = await marketplaceService.resolveConnectorRelease(connector.connectorId);
    latestOfficialConnectorReleases.set(connector.connectorId, {
      contentHash: release.contentHash,
    });
  })).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[lamarck] Connector update check failed:", result.reason);
      }
    }
  }).finally(() => {
    connectorUpdateCheck = null;
  });
  return connectorUpdateCheck;
}

void refreshOfficialConnectorReleases();
const connectorUpdateTimer = setInterval(() => {
  void refreshOfficialConnectorReleases();
}, connectorUpdateCheckIntervalMs);
connectorUpdateTimer.unref();
const d1ObserverState = new D1ObserverState(systemDb);
const d1Sequencer = new D1Sequencer();
const vfs = new VfsService(workspacePath, d1ObserverState, contentBlobStore, d1Sequencer);
appCapabilities.onChannelDeleted((channelId) => {
  vfs.closeWorkload(channelId);
});
await vfs.initialize();
const observerGuard = guard.withSource("system:vfs:observer", {
  producerRef: systemProducer.producerRef,
  prepareProducer: systemProducer.prepareProducer,
  writeTables: [],
  schemaGrant: false,
});
const d1Observer = new D1Observer(
  vfs.filesRoot,
  observerGuard,
  d1ObserverState,
  contentBlobStore,
  d1Sequencer,
);
await d1Observer.start();

interface SchemaRequest {
  id: string;
  ddl: string[];
  author?: string;
  context?: string;
  createdAt: number;
  beforeSchema: SchemaSnapshot;
  afterSchema: SchemaSnapshot;
  status: "pending" | "applied" | "rejected" | "stale" | "failed";
  error?: string;
}

interface SchemaEventAuthority {
  readonly source: string;
  readonly producerRef: string;
}

const schemaRequests = new Map<string, SchemaRequest>();
const schemaApprovals = new Map<string, Promise<SchemaRequest>>();
const schemaRequestAuthorities = new Map<string, SchemaEventAuthority>();

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

  const appProducer = createProducerBinding(
    producerDescriptorStore,
    createAppProducerDescriptor(
      auth.appId,
      auth.authorization.appCommit,
      systemIdentity,
    ),
  );
  return guard.withSource(sourceForAppWorkload(auth.appId, parseAppWorkload(auth.workload)), {
    producerRef: appProducer.producerRef,
    prepareProducer: appProducer.prepareProducer,
    // Authority is the immutable activation snapshot bound when the Host
    // issued this channel. Later draft edits cannot change a running workload.
    writeTables: [...auth.authorization.writeTables],
    schemaGrant: false,
    signal: opts?.signal,
    deadlineMs: APP_GUARD_DEADLINE_MS,
  });
}

function vfsCallerForRequest(auth: AuthContext, req: Request, signal: AbortSignal): VfsCaller {
  if (auth.kind === "app") {
    return {
      guard: guardForRequest(auth, { signal }),
      fileGrants: [...auth.authorization.fileGrants],
      trustedHost: false,
      workloadId: auth.channelId,
    };
  }
  const client = req.headers.get("x-lamarck-vfs-client") === "cli" ? "cli" : "ui";
  return {
    guard: guard.withSource(`system:vfs:${client}`, {
      producerRef: systemProducer.producerRef,
      prepareProducer: systemProducer.prepareProducer,
      writeTables: [],
      schemaGrant: false,
      signal,
      deadlineMs: HOST_GUARD_DEADLINE_MS,
    }),
    fileGrants: null,
    trustedHost: true,
  };
}

async function reloadAppRegistry(): Promise<void> {
  return enqueueAppRegistryUpdate(async () => {
    const candidate = await loadApps(appsDir);
    registry = candidate;
  });
}

async function refreshAppRegistryIfChanged(): Promise<void> {
  return enqueueAppRegistryUpdate(async () => {
    const candidate = await loadApps(appsDir);
    if (sameAppManifests(registry, candidate)) return;

    // Running workloads retain the activation manifest and grants captured by
    // their own capability. Draft authoring changes only refresh inventory.
    registry = candidate;
  });
}

function enqueueAppRegistryUpdate(update: () => Promise<void>): Promise<void> {
  const operation = appRegistryTail.then(update);
  // Keep the serialization tail usable after an individual scan fails while
  // returning the real failure to the request that initiated that scan.
  appRegistryTail = operation.catch(() => {});
  return operation;
}

function sameAppManifests(left: AppRegistry, right: AppRegistry): boolean {
  if (left.apps.size !== right.apps.size) return false;
  for (const [appId, app] of left.apps) {
    const candidate = right.apps.get(appId);
    if (!candidate || app.manifestDigest !== candidate.manifestDigest) {
      return false;
    }
  }
  return true;
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
  ddl: string | string[],
  metadata: { author?: string; context?: string },
  eventAuthority?: SchemaEventAuthority,
): Promise<{ status: "pending"; request: SchemaRequest }> {
  const author = normalizeSchemaChangeMetadata(
    metadata.author,
    SCHEMA_CHANGE_AUTHOR_MAX_CHARS,
    "author",
  );
  const context = normalizeSchemaChangeMetadata(
    metadata.context,
    SCHEMA_CHANGE_CONTEXT_MAX_CHARS,
    "context",
  );
  const plan = await guard.schemaPlan(ddl);
  const request: SchemaRequest = {
    id: ulid(),
    ddl: plan.ddl,
    ...(author === undefined ? {} : { author }),
    ...(context === undefined ? {} : { context }),
    createdAt: Date.now(),
    beforeSchema: plan.beforeSchema,
    afterSchema: plan.afterSchema,
    status: "pending",
  };
  schemaRequests.set(request.id, request);
  if (eventAuthority) schemaRequestAuthorities.set(request.id, eventAuthority);
  return { status: "pending", request };
}

async function approveSchemaRequest(
  id: string,
): Promise<SchemaRequest> {
  const request = schemaRequests.get(id);
  if (!request) throw new Error(`Schema request not found: ${id}`);
  const inFlight = schemaApprovals.get(id);
  if (inFlight) return inFlight;
  if (request.status !== "pending") return request;

  const operation = (async () => {
    try {
      await guard.applySchemaPlan({
        ddl: request.ddl,
        beforeSchema: request.beforeSchema,
        afterSchema: request.afterSchema,
      }, {
        approved: true,
        author: request.author,
        context: request.context,
        eventPrincipal: schemaRequestAuthorities.get(id),
      });
      request.status = "applied";
    } catch (err) {
      request.status = errorCode(err) === "GUARD_SCHEMA_STALE" ? "stale" : "failed";
      request.error = err instanceof Error ? err.message : String(err);
    }
    schemaRequestAuthorities.delete(id);
    return request;
  })();
  schemaApprovals.set(id, operation);
  try {
    return await operation;
  } finally {
    schemaApprovals.delete(id);
  }
}

function normalizeSchemaChangeMetadata(
  value: unknown,
  maxChars: number,
  label: "author" | "context",
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxChars || /[\x00-\x1f\x7f]/.test(value)) {
    throw new HttpStatusError(
      400,
      `Schema ${label} must be at most ${maxChars} characters and contain no control characters`,
    );
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function rejectSchemaRequest(id: string): SchemaRequest {
  const request = schemaRequests.get(id);
  if (!request) throw new Error(`Schema request not found: ${id}`);
  if (schemaApprovals.has(id)) throw new Error(`Schema request is currently being applied: ${id}`);
  if (request.status === "pending") request.status = "rejected";
  schemaRequestAuthorities.delete(id);
  return request;
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

async function instantiateVerifiedMarketplaceApp(input: {
  verifiedSourceDir: string;
  packageId: string;
  releaseId: string;
  localId?: string;
}): Promise<{ id: string }> {
  const created = await instantiateMarketplaceApp({
    verifiedSourceDir: input.verifiedSourceDir,
    appsDir,
    packageId: input.packageId,
    releaseId: input.releaseId,
    ...(input.localId === undefined ? {} : { localId: input.localId }),
    initializeRepository: (dir) => appRepository.initializeRepository(input.localId ?? input.packageId, dir),
  });
  try {
    await reloadAppRegistry();
    await guard.writeLifecycleEvent({
      type: "app.created",
      startedAt: Date.now(),
      payload: { appId: created.id },
    });
    return { id: created.id };
  } catch (error) {
    const failures: unknown[] = [error];
    await rm(created.dir, { recursive: true, force: true }).catch((rollbackError) => {
      failures.push(rollbackError);
    });
    await reloadAppRegistry().catch((rollbackError) => {
      failures.push(rollbackError);
    });
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `Marketplace App ${created.id} creation failed and rollback was incomplete`,
        { cause: error },
      );
    }
    throw error;
  }
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

function appLifecycleErrorResponse(
  error: unknown,
  json: (data: unknown, status?: number) => Response,
): Response {
  if (error instanceof AppLifecycleError) {
    const status = error.code === "APP_NOT_FOUND"
      ? 404
      : error.code === "APP_PACKAGE_INVALID"
        ? 400
        : error.code === "APP_VERSION_HISTORY_UNAVAILABLE"
          ? 503
          : 409;
    return json({ error: { code: error.code, message: error.message } }, status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: { code: "APP_INTERNAL_ERROR", message } }, 500);
}

type CliCorePrincipal =
  | { readonly kind: "system" }
  | {
      readonly kind: "app";
      readonly appId: string;
      readonly workload: AppWorkload;
      readonly appCommit: string;
      readonly writeTables: readonly string[];
      readonly fileGrants: readonly string[];
      readonly workloadHandle: string;
    };

function parseCliCorePrincipal(value: unknown): CliCorePrincipal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CLI principal is invalid");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "system" && Object.keys(raw).length === 1) return { kind: "system" };
  const keys = Object.keys(raw).sort().join(",");
  if (
    raw.kind !== "app"
    || keys !== "appCommit,appId,fileGrants,kind,workload,workloadHandle,writeTables"
    || typeof raw.appId !== "string"
    || !PACKAGE_ID_PATTERN.test(raw.appId)
    || typeof raw.workload !== "string"
    || !parseRequestedWorkload(raw.workload)
    || typeof raw.appCommit !== "string"
    || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(raw.appCommit)
    || typeof raw.workloadHandle !== "string"
    || !raw.workloadHandle
    || !Array.isArray(raw.writeTables)
    || raw.writeTables.some((item) => typeof item !== "string")
    || !Array.isArray(raw.fileGrants)
    || raw.fileGrants.some((item) => typeof item !== "string")
  ) throw new Error("CLI App principal is invalid");
  return Object.freeze({
    kind: "app",
    appId: raw.appId,
    workload: raw.workload as AppWorkload,
    appCommit: raw.appCommit,
    workloadHandle: raw.workloadHandle,
    writeTables: Object.freeze([...(raw.writeTables as string[])]),
    fileGrants: Object.freeze([...(raw.fileGrants as string[])]),
  });
}

function cliGuardForPrincipal(principal: CliCorePrincipal, signal: AbortSignal): RemoteGuard {
  if (principal.kind === "system") {
    return guard.withSource("system:cli", {
      producerRef: systemProducer.producerRef,
      prepareProducer: systemProducer.prepareProducer,
      writeTables: null,
      schemaGrant: false,
      signal,
      deadlineMs: HOST_GUARD_DEADLINE_MS,
    });
  }
  const producer = createProducerBinding(
    producerDescriptorStore,
    createAppProducerDescriptor(principal.appId, principal.appCommit, systemIdentity),
  );
  return guard.withSource(sourceForAppWorkload(principal.appId, parseAppWorkload(principal.workload)), {
    producerRef: producer.producerRef,
    prepareProducer: producer.prepareProducer,
    writeTables: [...principal.writeTables],
    schemaGrant: false,
    signal,
    deadlineMs: APP_GUARD_DEADLINE_MS,
  });
}

async function cliVersionEventContext(principal: CliCorePrincipal, eventWriter: RemoteGuard) {
  const source = principal.kind === "system"
    ? "system:cli"
    : sourceForAppWorkload(principal.appId, parseAppWorkload(principal.workload));
  const binding = principal.kind === "system"
    ? systemProducer
    : createProducerBinding(
        producerDescriptorStore,
        createAppProducerDescriptor(principal.appId, principal.appCommit, systemIdentity),
      );
  await binding.prepareProducer();
  return {
    eventWriter,
    eventAuthority: { source, producerRef: binding.producerRef },
  };
}

async function materializeCliPrincipal(principal: CliCorePrincipal): Promise<SchemaEventAuthority> {
  const binding = principal.kind === "system"
    ? systemProducer
    : createProducerBinding(
        producerDescriptorStore,
        createAppProducerDescriptor(principal.appId, principal.appCommit, systemIdentity),
      );
  await binding.prepareProducer();
  return {
    source: principal.kind === "system"
      ? "system:cli"
      : sourceForAppWorkload(principal.appId, parseAppWorkload(principal.workload)),
    producerRef: binding.producerRef,
  };
}

function cliVfsCaller(
  principal: CliCorePrincipal,
  requestGuard: RemoteGuard,
): VfsCaller {
  return principal.kind === "system"
    ? { guard: requestGuard, fileGrants: null, trustedHost: true }
    : {
        guard: requestGuard,
        fileGrants: [...principal.fileGrants],
        trustedHost: false,
        workloadId: principal.workloadHandle,
      };
}

async function cliSourceViews(): Promise<SourceProjectionInput[]> {
  connectorSupervisor.resumeExpiredPauses();
  const { packages: packageValues, sources } = await connectorSupervisor.currentCliShape();
  const packages = new Map(
    packageValues.map((value) => [value.connectorId, value] as const),
  );
  return sources.flatMap((source) => {
    const pkg = packages.get(source.connectorId);
    return pkg === undefined ? [] : [{
      ...source,
      packageHash: pkg.packageHash,
      packageTrust: pkg.packageTrust,
    } as SourceProjectionInput];
  });
}

interface CliConnectorSnapshot {
  readonly packages: ReadonlyMap<string, InstalledConnectorPackageView>;
  readonly sources: readonly SourceProjectionInput[];
  readonly sourceCounts: ReadonlyMap<string, number>;
}

async function cliConnectorSnapshot(): Promise<CliConnectorSnapshot> {
  connectorSupervisor.resumeExpiredPauses();
  const shape = await connectorSupervisor.currentCliShape();
  const packages = new Map(shape.packages.map((value) => [value.connectorId, value] as const));
  const sourceCounts = new Map<string, number>();
  const sources = shape.sources.flatMap((source) => {
    const pkg = packages.get(source.connectorId);
    if (!pkg) return [];
    sourceCounts.set(source.connectorId, (sourceCounts.get(source.connectorId) ?? 0) + 1);
    return [{
      ...source,
      packageHash: pkg.packageHash,
      packageTrust: pkg.packageTrust,
    } as SourceProjectionInput];
  });
  return Object.freeze({ packages, sources: Object.freeze(sources), sourceCounts });
}

async function cliObservedOutputs(source: string | null) {
  if (!source) return [];
  return await guard.query(
    `SELECT type,
            MIN(started_at) AS firstObservedAt,
            MAX(COALESCE(ended_at, started_at)) AS lastObservedAt
       FROM events
      WHERE source = ?
      GROUP BY type
      ORDER BY type`,
    [source],
  ) as Array<{ type: string; firstObservedAt: number; lastObservedAt: number }>;
}

function cliConnectorSummary(snapshot: CliConnectorSnapshot, connectorId: string) {
  const connector = snapshot.packages.get(connectorId);
  if (!connector) throw cliCoded("CONNECTOR_NOT_FOUND", `Connector ${connectorId} is not installed.`);
  const installation = connectorSupervisor.marketplaceInstallation(connectorId);
  const releaseId = connector.packageTrust === "official"
    && installation !== undefined
    && installation.packageHash === connector.packageHash
    ? installation.releaseId
    : null;
  const latest = latestOfficialConnectorReleases.get(connectorId);
  return projectConnectorSummary(connector, {
    releaseId,
    updateAvailable: connector.packageTrust === "official"
      && latest !== undefined
      && connector.packageHash !== latest.contentHash,
    sourceCount: snapshot.sourceCounts.get(connectorId) ?? 0,
  });
}

async function cliAppShapes(principal: CliCorePrincipal) {
  await refreshAppRegistryIfChanged();
  const inventory = await appLifecycle.inventory();
  return inventory.map((item) => projectAppShape(
    item,
    false,
    principal.kind === "system" ? item.path : `${MANAGED_APP_EDIT_ROOT}/${item.id}`,
  ));
}

async function executeCoreCliOperation(
  request: CliRequest,
  principal: CliCorePrincipal,
  signal: AbortSignal,
): Promise<unknown> {
  const input = request.input as Record<string, unknown>;
  const requestGuard = cliGuardForPrincipal(principal, signal);
  switch (request.operation) {
    case "query":
      return requestGuard.query(input.sql as string);
    case "schema.change": {
      try {
        const eventAuthority = await materializeCliPrincipal(principal);
        const pending = await createSchemaRequest(input.ddl as string, {
          ...(input.author === undefined ? {} : { author: input.author as string }),
          ...(input.context === undefined ? {} : { context: input.context as string }),
        }, eventAuthority);
        return { id: pending.request.id, status: "pending" };
      } catch (error) {
        throw cliCoded(
          "SCHEMA_REQUEST_REJECTED",
          `Schema request was rejected: ${coreErrorMessage(error)} Fix the DDL and rerun lamarck schema.`,
        );
      }
    }
    case "file.command":
    case "file.import":
    case "file.export": {
      const argv = input.argv as string[];
      const expected = request.operation === "file.import"
        ? "import"
        : request.operation === "file.export"
          ? "export"
          : null;
      if ((expected && argv[0] !== expected) || (!expected && (argv[0] === "import" || argv[0] === "export"))) {
        throw cliCoded("CLI_UNSUPPORTED_COMMAND", "The file operation does not match its typed command.");
      }
      const result = await vfs.command(
        cliVfsCaller(principal, requestGuard),
        argv.map(quoteCliWord).join(" "),
        {
          ...(input.author === undefined ? {} : { author: input.author as string }),
          ...(input.stdinBase64 === undefined ? {} : {
            stdin: { encoding: "base64" as const, data: input.stdinBase64 as string },
          }),
        },
      );
      return result satisfies FileCommandResult;
    }
    case "source.list":
      return (await cliSourceViews()).map(projectSourceSummary);
    case "source.inspect": {
      const source = (await cliSourceViews()).find((item) => item.id === input.sourceId);
      if (!source) throw cliCoded("SOURCE_NOT_FOUND", `Source ${String(input.sourceId)} was not found.`);
      const connector = await connectorSupervisor.currentInstalledConnectorPackage(source.connectorId);
      if (!connector) throw cliCoded("CONNECTOR_NOT_FOUND", `Connector ${source.connectorId} is not installed.`);
      return projectSourceShape(source, connector.eventCatalog, await cliObservedOutputs(source.source));
    }
    case "source.run": {
      requireCliSource(input.sourceId as string);
      try {
        const handle = connectorSupervisor.start(input.sourceId as string, { trigger: "manual" });
        return { sourceId: input.sourceId, runId: handle.runId, status: "accepted" };
      } catch (error) {
        throw cliCoded(
          "SOURCE_RUN_REJECTED",
          `Source run was rejected: ${coreErrorMessage(error)} Inspect the Source and complete its setup before rerunning source run.`,
        );
      }
    }
    case "source.run.status": {
      const run = connectorSupervisor.sourceRun(input.sourceId as string, input.runId as string);
      if (!run) throw cliCoded("SOURCE_NOT_FOUND", `Source run ${String(input.runId)} was not found.`);
      return run.status === "running"
        ? { sourceId: run.sourceId, runId: run.id, status: "running", startedAt: run.startedAt }
        : {
            sourceId: run.sourceId,
            runId: run.id,
            status: run.status,
            outcome: run.status,
            startedAt: run.startedAt,
            endedAt: run.endedAt!,
          };
    }
    case "source.pause": {
      requireCliSource(input.sourceId as string);
      await connectorSupervisor.pauseSource(input.sourceId as string);
      return { sourceId: input.sourceId, lifecycle: "paused" };
    }
    case "source.resume": {
      requireCliSource(input.sourceId as string);
      connectorSupervisor.resumeSource(input.sourceId as string);
      void connectorScheduler.tick().catch(() => {});
      return { sourceId: input.sourceId, lifecycle: "active" };
    }
    case "connector.list": {
      const snapshot = await cliConnectorSnapshot();
      return [...snapshot.packages.keys()].map((connectorId) => cliConnectorSummary(snapshot, connectorId));
    }
    case "connector.inspect": {
      const connectorId = input.connectorId as string;
      const snapshot = await cliConnectorSnapshot();
      const connector = snapshot.packages.get(connectorId);
      if (!connector) throw cliCoded("CONNECTOR_NOT_FOUND", `Connector ${connectorId} is not installed.`);
      const summary = cliConnectorSummary(snapshot, connectorId);
      const sources = snapshot.sources
        .filter((source) => source.connectorId === connectorId)
        .map(projectSourceSummary);
      return projectConnectorInspect(summary, connector.manifest, connector.eventCatalog, sources);
    }
    case "connector.install":
    case "connector.update": {
      const expectedAction = request.operation === "connector.install" ? "install" : "update";
      const id = request.operation === "connector.install" ? input.packageId as string : input.connectorId as string;
      try {
        const prepared = await marketplaceService.prepare("connector", id, expectedAction);
        const applied = await marketplaceService.apply(prepared.stageId, undefined, requestGuard);
        return {
          id: applied.id,
          releaseId: prepared.releaseId,
          packageHash: prepared.contentHash,
          changed: applied.disposition !== "already-installed",
        };
      } catch (error) {
        if (error instanceof ConnectorMarketplaceError) {
          throw cliCoded(error.code, error.message);
        }
        if (error instanceof ConnectorLifecycleConflictError) {
          throw cliCoded(
            error.code,
            `${error.message}; resolve the conflicting Sources before rerunning connector update.`,
          );
        }
        throw cliCoded(
          "CONNECTOR_VERIFICATION_FAILED",
          `Connector ${id} could not be admitted; inspect the package and retry the Marketplace command.`,
        );
      }
    }
    case "connector.remove": {
      const id = input.connectorId as string;
      const removed = await removeConnectorFromWorkspace({
        workspacePath,
        connectorId: id,
        supervisor: connectorSupervisor,
        guard: requestGuard,
      });
      if (!removed) throw cliCoded("CONNECTOR_NOT_FOUND", `Connector ${id} is not installed.`);
      return { id, removed: true };
    }
    case "app.list":
      return (await cliAppShapes(principal)).map(projectAppSummary);
    case "app.inspect": {
      const app = (await cliAppShapes(principal)).find((item) => item.id === input.appId);
      if (!app) throw cliCoded("APP_NOT_FOUND", `App not found: ${String(input.appId)}`);
      return app;
    }
    case "app.create": {
      const id = input.appId as string;
      const name = input.name as string;
      const description = input.description as string;
      if (!PACKAGE_ID_PATTERN.test(id) || !name || name.trim() !== name
        || !description || description.trim() !== description) {
        throw cliCoded("APP_INVALID", "The App id, name, or description is invalid.");
      }
      if (registry.apps.has(id)) throw cliCoded("APP_INVALID", `App ${id} already exists.`);
      await instantiateBlankApp({
        appsDir,
        scaffoldDir: appScaffoldDir,
        id,
        name,
        description,
        initializeRepository: (dir) => appRepository.initializeRepository(id, dir),
      });
      await reloadAppRegistry();
      await requestGuard.writeLifecycleEvent({ type: "app.created", startedAt: Date.now(), payload: { appId: id } });
      return { id, created: true };
    }
    case "app.save": {
      const result = await appLifecycle.save(input.appId as string, {
        ...(input.message === undefined ? {} : { message: input.message as string }),
        ...(input.author === undefined ? {} : { author: input.author as string }),
        ...await cliVersionEventContext(principal, requestGuard),
      });
      await refreshAppRegistryIfChanged();
      return { version: result.version, created: result.created };
    }
    case "app.versions": {
      const page = await appLifecycle.versions(input.appId as string, { limit: 100 });
      return page.versions.map(({ schemaVersion: _schemaVersion, ...record }) => record);
    }
    case "app.restore": {
      const result = await appLifecycle.restore(input.appId as string, input.version as string, {
        ...(input.message === undefined ? {} : { message: input.message as string }),
        ...(input.author === undefined ? {} : { author: input.author as string }),
        ...await cliVersionEventContext(principal, requestGuard),
      });
      await refreshAppRegistryIfChanged();
      return { version: result.version, created: result.created };
    }
    case "app.refresh":
      if (principal.kind !== "app") throw cliCoded("CLI_UNSUPPORTED_COMMAND", "app refresh is managed-only.");
      if (!registry.apps.has(input.appId as string)) {
        throw cliCoded("APP_NOT_FOUND", `App not found: ${String(input.appId)}`);
      }
      return { id: input.appId as string, refreshed: true };
    case "app.archive": {
      const appId = input.appId as string;
      const app = registry.apps.get(appId);
      if (!app) throw cliCoded("APP_NOT_FOUND", `App not found: ${appId}`);
      await appCapabilities.revokeApp(appId);
      await appRepository.verifyRetainedVersions(appId, app.dir);
      await archiveApp(appsDir, join(lamarckDir, "archived-apps"), appId);
      await reloadAppRegistry();
      await requestGuard.writeLifecycleEvent({ type: "app.archived", startedAt: Date.now(), payload: { appId } });
      return { id: appId, archived: true };
    }
  }
}

function quoteCliWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class CoreCliError extends Error {
  constructor(readonly code: CliErrorCode, message: string) { super(message); }
}

function cliCoded(code: CliErrorCode, message: string): CoreCliError {
  return new CoreCliError(code, message);
}

function requireCliSource(sourceId: string): void {
  const source = connectorSupervisor.getSource(sourceId);
  if (!source || !connectorSupervisor.isRegistered(source.connectorId)) {
    throw cliCoded("SOURCE_NOT_FOUND", `Source ${sourceId} was not found.`);
  }
}

function cliFailure(requestId: string, error: unknown): CliResponse {
  if (error instanceof CoreCliError) {
    return { requestId, ok: false, error: { code: error.code, message: error.message } } as CliResponse;
  }
  if (error instanceof AppLifecycleError) {
    const code = error.code === "APP_PACKAGE_INVALID"
      ? "APP_INVALID"
      : error.code === "APP_COMMAND_UNSUPPORTED"
        ? "CLI_UNSUPPORTED_COMMAND"
        : error.code;
    return { requestId, ok: false, error: { code, message: error.message } } as CliResponse;
  }
  return {
    requestId,
    ok: false,
    error: { code: "CLI_INTERNAL", message: "Lamarck could not complete the command." },
  } as CliResponse;
}

function coreErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

    const openVfsMatch = path.match(/^\/api\/vfs\/open\/([A-Za-z0-9_-]{43})$/);
    if (openVfsMatch && (method === "GET" || method === "HEAD")) {
      const content = await vfs.resolveOpen(
        openVfsMatch[1],
        (channelId) => appCapabilities.isOpen(channelId),
        method === "GET",
      );
      if (!content) return new Response("Not found", { status: 404, headers });
      try {
        return new Response(content.body, {
          status: 200,
          headers: {
            "Content-Type": content.mediaType,
            "Content-Length": String(content.byteLength),
            "Cache-Control": "no-store",
            ...headers,
          },
        });
      } catch (error) {
        await content.dispose();
        throw error;
      }
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

    try {
      // Host lifecycle probes must not depend on App registry scans, Connector
      // state, or any other feature domain. A healthy Core can report those
      // domains independently without being torn down as a startup failure.
      if (path === "/api/health" && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        return json({ ok: true });
      }

      if (path === "/api/cli/execute" && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readJsonBody<Record<string, unknown>>(req, 28 * 1024 * 1024);
        assertAllowedRequestFields(body, ["principal", "request"]);
        let request: CliRequest;
        try {
          request = parseCliRequest(body.request, { allowInlineFileBytes: true });
        } catch {
          return json({ error: "invalid typed CLI request" }, 400);
        }
        try {
          const principal = parseCliCorePrincipal(body.principal);
          const result = await executeCoreCliOperation(request, principal, requestGuardSignal);
          return json({ requestId: request.requestId, ok: true, result } as CliResponse);
        } catch (error) {
          return json(cliFailure(request.requestId, error));
        }
      }

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

      // -- D1 filesystem --
      if (path === "/api/vfs/upload/begin" && method === "POST") {
        if (auth!.kind !== "app") return json({ error: "app workload required" }, 403);
        return json({
          token: await vfs.beginUpload(vfsCallerForRequest(auth!, req, requestGuardSignal)),
        });
      }

      if (path === "/api/vfs/upload/chunk" && method === "POST") {
        if (auth!.kind !== "app") return json({ error: "app workload required" }, 403);
        const body = await readBody<{ token: string; index: number; dataBase64: string }>(req);
        await vfs.appendUpload(
          vfsCallerForRequest(auth!, req, requestGuardSignal),
          body.token,
          body.index,
          body.dataBase64,
        );
        return json({ ok: true });
      }

      if (path === "/api/vfs/upload/complete" && method === "POST") {
        if (auth!.kind !== "app") return json({ error: "app workload required" }, 403);
        const body = await readBody<{ token: string }>(req);
        vfs.completeUpload(vfsCallerForRequest(auth!, req, requestGuardSignal), body.token);
        return json({ ok: true });
      }

      if (path === "/api/vfs/upload/abort" && method === "POST") {
        if (auth!.kind !== "app") return json({ error: "app workload required" }, 403);
        const body = await readBody<{ token: string }>(req);
        vfs.abortUpload(vfsCallerForRequest(auth!, req, requestGuardSignal), body.token);
        return json({ ok: true });
      }

      if (path === "/api/vfs/command" && method === "POST") {
        const body = await readBody<{
          command: string;
          options?: import("@lamarck/system/protocol").VfsCommandWireOptions;
        }>(req);
        if (typeof body.command !== "string") throw new HttpStatusError(400, "VFS command is required");
        return json(await vfs.command(
          vfsCallerForRequest(auth!, req, requestGuardSignal),
          body.command,
          body.options,
        ));
      }

      if (path === "/api/vfs/open" && method === "POST") {
        if (auth!.kind !== "app") return json({ error: "app workload required" }, 403);
        const body = await readBody<{ path: string }>(req);
        if (typeof body.path !== "string") throw new HttpStatusError(400, "VFS path is required");
        return json({
          url: await vfs.open(
            vfsCallerForRequest(auth!, req, requestGuardSignal),
            body.path,
            url.origin,
            (channelId) => appCapabilities.isOpen(channelId),
          ),
        });
      }

      if (path === "/api/vfs/history-exclusions" && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        return json({ exclusions: d1ObserverState.listExclusions() });
      }

      if (path === "/api/vfs/history-exclusions" && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ path: string }>(req);
        if (typeof body.path !== "string") throw new HttpStatusError(400, "exclusion path is required");
        const exclusion = d1ObserverState.addExclusion(body.path);
        d1Observer.schedule();
        return json({ ok: true, exclusion });
      }

      if (path === "/api/vfs/history-exclusions" && method === "DELETE") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ path: string }>(req);
        if (typeof body.path !== "string") throw new HttpStatusError(400, "exclusion path is required");
        const removed = d1ObserverState.removeExclusion(body.path);
        d1Observer.schedule();
        return json({ ok: true, removed });
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

      if (path === "/api/schema/change/request" && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readJsonBody<Record<string, unknown>>(req, 300 * 1024);
        assertAllowedRequestFields(body, ["ddl", "author", "context"]);
        if (
          typeof body.ddl !== "string"
          && !(Array.isArray(body.ddl) && body.ddl.every((statement) => typeof statement === "string"))
        ) {
          throw new HttpStatusError(400, "schema change ddl must be a string or string array");
        }
        const result = await createSchemaRequest(
          body.ddl,
          {
            author: normalizeSchemaChangeMetadata(
              body.author,
              SCHEMA_CHANGE_AUTHOR_MAX_CHARS,
              "author",
            ),
            context: normalizeSchemaChangeMetadata(
              body.context,
              SCHEMA_CHANGE_CONTEXT_MAX_CHARS,
              "context",
            ),
          },
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
        const body = await readJsonBody<Record<string, unknown>>(req, 1024);
        assertAllowedRequestFields(body, []);
        const request = await approveSchemaRequest(
          decodeURIComponent(approveMatch[1]),
        );
        return json({ request });
      }

      const rejectMatch = path.match(/^\/api\/schema\/requests\/([^/]+)\/reject$/);
      if (rejectMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const request = rejectSchemaRequest(decodeURIComponent(rejectMatch[1]));
        return json({ request });
      }

      // -- Marketplace verified staging --
      if (path === "/api/marketplace/prepare" && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readJsonBody<Record<string, unknown>>(req, 4 * 1024);
        assertAllowedRequestFields(body, ["kind", "packageId"]);
        if (
          (body.kind !== "app" && body.kind !== "connector")
          || typeof body.packageId !== "string"
          || !SCOPED_PACKAGE_ID_PATTERN.test(body.packageId)
        ) {
          return json({ error: "kind and scoped packageId are required" }, 400);
        }
        return json(await marketplaceService.prepare(body.kind, body.packageId));
      }

      const marketplaceStageMatch = path.match(/^\/api\/marketplace\/stages\/([^/]+)$/);
      if (marketplaceStageMatch && method === "DELETE") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        await marketplaceService.cancel(decodeURIComponent(marketplaceStageMatch[1]));
        return json({ ok: true });
      }

      const marketplaceApplyMatch = path.match(/^\/api\/marketplace\/stages\/([^/]+)\/apply$/);
      if (marketplaceApplyMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readJsonBody<Record<string, unknown>>(req, 4 * 1024);
        assertAllowedRequestFields(body, ["localId"]);
        if (
          body.localId !== undefined
          && (typeof body.localId !== "string" || !PACKAGE_ID_PATTERN.test(body.localId))
        ) {
          return json({ error: "localId is invalid" }, 400);
        }
        return json(await marketplaceService.apply(
          decodeURIComponent(marketplaceApplyMatch[1]),
          body.localId as string | undefined,
        ));
      }

      // -- Connectors --
      if (path === "/api/connectors" && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const sources = (await connectorSupervisor.list()).map((sourceRecord) => ({
          ...sourceRecord,
          oauthRedirectUri: isDirectOAuthAuthType(sourceRecord.authType) ? oauthRedirectUri : undefined,
        }));
        const packages = connectorSupervisor.listInstalledConnectors().map((connector) => {
          const latest = latestOfficialConnectorReleases.get(connector.connectorId);
          return {
            ...connector,
            updateAvailable: connector.packageTrust === "official"
              && connector.packageHash !== undefined
              && latest !== undefined
              && connector.packageHash !== latest.contentHash,
          };
        });
        return json({
          sources,
          packages,
        });
      }

      const approveConnectorMatch = path.match(/^\/api\/connectors\/([^/]+)\/approve$/);
      if (approveConnectorMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const manifest = await connectorSupervisor.approveCurrentPackage(decodeURIComponent(approveConnectorMatch[1]));
        return json({ ok: true, manifest });
      }

      const requirementsCheckMatch = path.match(/^\/api\/connectors\/sources\/([^/]+)\/requirements\/check$/);
      if (requirementsCheckMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const requirements = await connectorSupervisor.checkSourceRequirements(
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

      const createSourceMatch = path.match(/^\/api\/connectors\/([^/]+)\/sources$/);
      if (createSourceMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ displayName?: unknown }>(req);
        assertAllowedRequestFields(body, ["displayName"]);
        assertDisplayNameField(body, { nullable: false });
        const sourceRecord = await connectorSupervisor.addSource({
          connectorId: decodeURIComponent(createSourceMatch[1]),
          displayName: body.displayName as string | undefined,
        });
        return json({ sourceRecord });
      }

      const sourceRouteMatch = path.match(/^\/api\/connectors\/sources\/([^/]+)$/);
      if (sourceRouteMatch && method === "PATCH") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{
          scheduleCron?: string | null;
          displayName?: unknown;
          config?: unknown;
        }>(req);
        assertAllowedRequestFields(body, ["displayName", "scheduleCron", "config"]);
        assertDisplayNameField(body, { nullable: true });
        const instanceId = decodeURIComponent(sourceRouteMatch[1]);
        let sourceRecord = connectorSupervisor.getSource(instanceId);
        if (!sourceRecord) return json({ error: "not found" }, 404);
        if ("scheduleCron" in body || "config" in body) {
          sourceRecord = await connectorSupervisor.configureSource(instanceId, {
            scheduleCron: body.scheduleCron,
            config: body.config,
          });
        }
        const renamed = body.displayName === undefined
          ? sourceRecord
          : connectorSupervisor.renameSource(instanceId, body.displayName as string | null);
        return json({ sourceRecord: renamed });
      }
	      if (sourceRouteMatch && method === "DELETE") {
	        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
	        await connectorSupervisor.removeSource(decodeURIComponent(sourceRouteMatch[1]));
	        return json({ ok: true });
	      }

      const pauseSourceMatch = path.match(/^\/api\/connectors\/sources\/([^/]+)\/pause$/);
      if (pauseSourceMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ durationMs?: number }>(req).catch(() => ({} as { durationMs?: number }));
        const sourceRecord = await connectorSupervisor.pauseSource(
          decodeURIComponent(pauseSourceMatch[1]),
          body.durationMs,
        );
        return json({ sourceRecord });
      }

      const resumeSourceMatch = path.match(/^\/api\/connectors\/sources\/([^/]+)\/resume$/);
      if (resumeSourceMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const sourceRecord = connectorSupervisor.resumeSource(
          decodeURIComponent(resumeSourceMatch[1]),
        );
        connectorScheduler.tick().catch((err) => {
          console.warn(`[lamarck] Connector scheduler tick after resume failed: ${err}`);
        });
        return json({ sourceRecord });
      }

      const disconnectSourceMatch = path.match(
        /^\/api\/connectors\/sources\/([^/]+)\/disconnect$/,
      );
      if (disconnectSourceMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const sourceRecord = await connectorSupervisor.disconnectSource(
          decodeURIComponent(disconnectSourceMatch[1]),
        );
        return json({ sourceRecord });
      }

	      const configPanelStartMatch = path.match(
	        /^\/api\/connectors\/sources\/([^/]+)\/config-panels\/([^/]+)\/start$/,
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

	      const connectSourceMatch = path.match(/^\/api\/connectors\/sources\/([^/]+)\/connect$/);
      if (connectSourceMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ token?: string }>(req);
        const sourceRecord = await connectorSupervisor.connectSourceWithToken(
          decodeURIComponent(connectSourceMatch[1]),
          body.token ?? "",
        );
        return json({ sourceRecord });
      }

      const authStartMatch = path.match(/^\/api\/connectors\/sources\/([^/]+)\/auth\/start$/)
        ?? path.match(/^\/api\/connectors\/sources\/([^/]+)\/oauth\/start$/);
      if (authStartMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<Record<string, unknown>>(req);
        assertAllowedRequestFields(body, ["replacePending"]);
        if (body.replacePending !== undefined && typeof body.replacePending !== "boolean") {
          return json({ error: "replacePending must be a boolean" }, 400);
        }
        const result = await connectorSupervisor.startAuthSource(
          decodeURIComponent(authStartMatch[1]),
          {
            redirectUri: oauthRedirectUri,
            replacePending: body.replacePending === true,
          },
        );
        return json(result);
      }

      const authAttemptMatch = path.match(
        /^\/api\/connectors\/sources\/([^/]+)\/auth\/attempts\/([^/]+)$/,
      ) ?? path.match(
        /^\/api\/connectors\/sources\/([^/]+)\/oauth\/attempts\/([^/]+)$/,
      );
      if (authAttemptMatch && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const result = await connectorSupervisor.getOAuthAttempt(
          decodeURIComponent(authAttemptMatch[1]),
          decodeURIComponent(authAttemptMatch[2]),
        );
        return json(result);
      }
      if (authAttemptMatch && method === "DELETE") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const cancelled = connectorSupervisor.cancelAuthAttempt(
          decodeURIComponent(authAttemptMatch[1]),
          decodeURIComponent(authAttemptMatch[2]),
        );
        return json({ ok: true, cancelled });
      }

      const retryIdentityMatch = path.match(
        /^\/api\/connectors\/sources\/([^/]+)\/identity\/retry$/,
      );
      if (retryIdentityMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<Record<string, unknown>>(req);
        assertAllowedRequestFields(body, []);
        const sourceRecord = await connectorSupervisor.retrySourceIdentity(
          decodeURIComponent(retryIdentityMatch[1]),
        );
        return json({ sourceRecord });
      }

      const restartSourceMatch = path.match(/^\/api\/connectors\/sources\/([^/]+)\/restart$/);
      if (restartSourceMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const sourceRecord = connectorSupervisor.restartSource(
          decodeURIComponent(restartSourceMatch[1]),
        );
        // Kick the scheduler so the restart takes effect immediately instead of
        // waiting for the next tick; don't block the response on it.
        connectorScheduler.tick().catch((err) => {
          console.warn(`[lamarck] Connector scheduler tick after restart failed: ${err}`);
        });
        return json({ sourceRecord });
      }

      // Trigger an explicit run on demand: the only execution path for a manual
      // connector, and how any connector runs outside its normal schedule.
      // Non-blocking — the run proceeds in the background; status shows on the
      // Source. Runtime config always comes from the latest stored Source.
      const runSourceMatch = path.match(/^\/api\/connectors\/sources\/([^/]+)\/run$/);
      if (runSourceMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<unknown>(req).catch(() => ({}));
        if (
          body === null
          || typeof body !== "object"
          || Array.isArray(body)
          || Object.keys(body).length > 0
        ) {
          return json(
            { error: "Run does not accept parameters; update the Source config before running" },
            400,
          );
        }
        const instanceId = decodeURIComponent(runSourceMatch[1]);
        connectorSupervisor.start(instanceId, { trigger: "manual" });
        return json({ ok: true });
      }

      const requirementRequestMatch = path.match(
        /^\/api\/connectors\/sources\/([^/]+)\/requirements\/([^/]+)\/request$/,
      );
      if (requirementRequestMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const requirement = await connectorSupervisor.requestSourceRequirement(
          decodeURIComponent(requirementRequestMatch[1]),
          decodeURIComponent(requirementRequestMatch[2]),
        );
        return json({ requirement });
      }

      // -- Apps --
      if (path === "/api/apps/edit-bases" && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        try {
          return json({ editBases: await appLifecycle.prepareEditBases() });
        } catch (error) {
          return appLifecycleErrorResponse(error, json);
        }
      }

      const editBaseMatch = path.match(/^\/api\/apps\/([^/]+)\/edit-base$/);
      if (editBaseMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        try {
          return json({
            editBase: await appLifecycle.prepareEditBase(
              decodeURIComponent(editBaseMatch[1]),
            ),
          });
        } catch (error) {
          return appLifecycleErrorResponse(error, json);
        }
      }

      const editSaveMatch = path.match(/^\/api\/apps\/([^/]+)\/edit-package$/);
      if (editSaveMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const appId = decodeURIComponent(editSaveMatch[1]);
        try {
          const upload = await readAppPackageArchive(
            req,
            join(lamarckDir, "staging", "app-edits"),
          );
          const encodedPrincipal = req.headers.get("x-lamarck-cli-principal");
          const managedPrincipal = encodedPrincipal === null
            ? undefined
            : parseCliCorePrincipal(JSON.parse(Buffer.from(encodedPrincipal, "base64url").toString("utf8")));
          if (managedPrincipal?.kind !== "app") {
            if (encodedPrincipal !== null) throw new Error("Managed App CLI principal is required");
          }
          const result = await appLifecycle.savePackage(appId, upload.entries, {
            baseVersion: upload.metadata.baseVersion,
            basePackageDigest: upload.metadata.basePackageDigest,
            ...(upload.metadata.message === undefined ? {} : { message: upload.metadata.message }),
            ...(upload.metadata.author === undefined ? {} : { author: upload.metadata.author }),
            ...(managedPrincipal?.kind === "app"
              ? await cliVersionEventContext(
                  managedPrincipal,
                  cliGuardForPrincipal(managedPrincipal, requestGuardSignal),
                )
              : {}),
          });
          await refreshAppRegistryIfChanged();
          return json({ result, editBase: await appLifecycle.prepareEditBase(appId) });
        } catch (error) {
          if (error instanceof ArchiveHttpError) {
            return json({ error: { code: "APP_PACKAGE_INVALID", message: error.message } }, error.status);
          }
          return appLifecycleErrorResponse(error, json);
        }
      }

      const activationPrepareMatch = path.match(/^\/api\/apps\/([^/]+)\/activation\/prepare$/);
      if (activationPrepareMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const appId = decodeURIComponent(activationPrepareMatch[1]);
        const body = await readBody<{ workload?: unknown }>(req);
        const workload = parseRequestedWorkload(body.workload);
        if (!workload) return json({ error: "valid workload is required" }, 400);
        try {
          const activation = await appLifecycle.prepareActivation(appId, workload);
          return json({ activation });
        } catch (error) {
          return appLifecycleErrorResponse(error, json);
        }
      }

      const activationReleaseMatch = path.match(/^\/api\/apps\/activation\/([^/]+)$/);
      if (activationReleaseMatch && method === "DELETE") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const activationId = decodeURIComponent(activationReleaseMatch[1]);
        return json({ ok: await appActivationCoordinator.release(activationId) });
      }

      if (path === "/api/app-runtime/channels" && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{
          appId?: unknown;
          workload?: unknown;
          activationId?: unknown;
        }>(req);
        const workload = parseRequestedWorkload(body.workload);
        if (
          typeof body.appId !== "string"
          || !workload
          || typeof body.activationId !== "string"
        ) {
          return json({ error: "appId, workload, and activationId are required" }, 400);
        }
        try {
          const activation = appActivationCoordinator.require(
            body.activationId,
            body.appId,
            workload,
          );
          await appRepository.verifyRetainedVersions(body.appId, join(appsDir, body.appId));
          const descriptor = producerDescriptorStore.publish(createAppProducerDescriptor(
            body.appId,
            activation.version,
            systemIdentity,
          ));
          producerDescriptorStore.resolve(descriptor.ref);
          return json(appCapabilities.issue(body.appId, workload, {
            activationId: activation.activationId,
            manifestDigest: activation.manifestDigest,
            packageDigest: activation.packageDigest,
            appCommit: activation.version,
            writeTables: activation.manifest.permissions.writes.tables,
            fileGrants: [
              `apps/${body.appId}/`,
              ...activation.manifest.permissions.writes.files,
            ],
          }));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 409);
        }
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
        // The Workspace is intentionally editable outside Lamarck. A coding
        // agent may create an App directory directly, so make this read an
        // authoritative semantic rescan without revoking unchanged Apps.
        await refreshAppRegistryIfChanged();
        return json({ apps: await appLifecycle.inventory() });
      }

      const versionsMatch = path.match(/^\/api\/apps\/([^/]+)\/versions$/);
      if (versionsMatch && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const appId = decodeURIComponent(versionsMatch[1]);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const limitValue = url.searchParams.get("limit");
        const limit = limitValue === null ? undefined : Number(limitValue);
        try {
          return json(await appLifecycle.versions(appId, { cursor, limit }));
        } catch (error) {
          return appLifecycleErrorResponse(error, json);
        }
      }

      const saveMatch = path.match(/^\/api\/apps\/([^/]+)\/save$/);
      if (saveMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const appId = decodeURIComponent(saveMatch[1]);
        const body = await readBody<{ message?: unknown; author?: unknown }>(req);
        if (
          (body.message !== undefined && typeof body.message !== "string")
          || (body.author !== undefined && typeof body.author !== "string")
        ) return json({ error: { code: "APP_PACKAGE_INVALID", message: "message and author must be strings" } }, 400);
        try {
          const result = await appLifecycle.save(appId, {
            ...(body.message === undefined ? {} : { message: body.message }),
            ...(body.author === undefined ? {} : { author: body.author }),
          });
          await refreshAppRegistryIfChanged();
          return json(result);
        } catch (error) {
          return appLifecycleErrorResponse(error, json);
        }
      }

      const restoreMatch = path.match(/^\/api\/apps\/([^/]+)\/restore$/);
      if (restoreMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const appId = decodeURIComponent(restoreMatch[1]);
        const body = await readBody<{ version?: unknown; message?: unknown; author?: unknown }>(req);
        if (
          typeof body.version !== "string"
          || (body.message !== undefined && typeof body.message !== "string")
          || (body.author !== undefined && typeof body.author !== "string")
        ) return json({ error: { code: "APP_PACKAGE_INVALID", message: "version and descriptive metadata are invalid" } }, 400);
        try {
          const result = await appLifecycle.restore(appId, body.version, {
            ...(body.message === undefined ? {} : { message: body.message }),
            ...(body.author === undefined ? {} : { author: body.author }),
          });
          await refreshAppRegistryIfChanged();
          return json(result);
        } catch (error) {
          return appLifecycleErrorResponse(error, json);
        }
      }

      const rebuildHistoryMatch = path.match(
        /^\/api\/apps\/([^/]+)\/version-history\/rebuild$/,
      );
      if (rebuildHistoryMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const appId = decodeURIComponent(rebuildHistoryMatch[1]);
        const body = await readBody<{ confirmed?: unknown }>(req);
        if (body.confirmed !== true) {
          return json({
            error: {
              code: "APP_PACKAGE_INVALID",
              message: "Version history rebuild requires explicit confirmation",
            },
          }, 400);
        }
        try {
          return json(await appLifecycle.rebuildVersionHistory(appId));
        } catch (error) {
          return appLifecycleErrorResponse(error, json);
        }
      }

      // -- Create App --
      if (path === "/api/apps" && method === "POST") {
        const body = await readBody<{ id?: unknown; name?: unknown; description?: unknown }>(req);
        const id = body.id;

        if (typeof id !== "string" || !PACKAGE_ID_PATTERN.test(id)) {
          return json({
            error: "Invalid app id. Use lowercase alphanumeric/hyphen segments separated by dots.",
          }, 400);
        }
        if (
          body.name !== undefined &&
          (typeof body.name !== "string" || body.name.length === 0 || body.name.trim() !== body.name)
        ) {
          return json({ error: "Invalid app name. Use a non-empty name without surrounding whitespace." }, 400);
        }
        const name = body.name ?? id;
        if (
          typeof body.description !== "string"
          || body.description.length === 0
          || body.description.trim() !== body.description
        ) {
          return json({
            error: "Invalid app description. Use a non-empty description without surrounding whitespace.",
          }, 400);
        }
        const description = body.description;

        await instantiateBlankApp({
          appsDir,
          scaffoldDir: appScaffoldDir,
          id,
          name,
          description,
          initializeRepository: (dir) => appRepository.initializeRepository(id, dir),
        });

        await reloadAppRegistry();
        await guard.withExecution({
          signal: requestGuardSignal,
          deadlineMs: HOST_GUARD_DEADLINE_MS,
        }).writeLifecycleEvent({
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
        await appRepository.verifyRetainedVersions(appId, app.dir);
        await archiveApp(appsDir, join(lamarckDir, "archived-apps"), appId);
        await reloadAppRegistry();

        // D0 composition: the capability was retired (recoverable, not deleted).
        // Only the id is recorded — the archive location is conventional
        // (.lamarck/archived-apps/<appId>) and the name is in the kept manifest.
        await guard.withExecution({
          signal: requestGuardSignal,
          deadlineMs: HOST_GUARD_DEADLINE_MS,
        }).writeLifecycleEvent({
          type: "app.archived",
          startedAt: Date.now(),
          payload: { appId },
        });
        return json({ ok: true, id: appId });
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

function assertAllowedRequestFields(
  value: unknown,
  allowedFields: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpStatusError(400, "request body must be a JSON object");
  }
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) {
    throw new HttpStatusError(400, `request body has unknown field: ${unknown}`);
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertDisplayNameField(
  value: Record<string, unknown>,
  opts: { nullable: boolean },
): void {
  if (!("displayName" in value) || value.displayName === undefined) return;
  if (typeof value.displayName === "string") return;
  if (opts.nullable && value.displayName === null) return;
  throw new HttpStatusError(
    400,
    opts.nullable
      ? "displayName must be a string or null"
      : "displayName must be a string",
  );
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[lamarck] Shutting down...");
  clearInterval(connectorUpdateTimer);
  const vfsClosed = vfs.close();
  const serverStopped = server.stop().catch(() => {});
  await connectorScheduler.stop();
  for (const proc of terminalProcs) {
    try { proc.kill(); } catch {}
  }
  terminalProcs.clear();
  await Promise.all([serverStopped, vfsClosed]);
  await d1Observer.stop();
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
