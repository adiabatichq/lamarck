import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { watch as watchFileSystem } from "node:fs";
import {
  MANAGED_APP_EDIT_ROOT,
  encodeCliFrame,
  parseCliFrame,
  parseCliRequest,
  type CliRequest,
  type CliResponse,
  CliStreamReader,
  writeCliResponse,
  writeCliBytes,
} from "@lamarck/cli";
import { PACKAGE_ID_PATTERN } from "../package-id";
import type {
  CliOperationDispatcher,
  ManagedAppEditBaseV1,
  ManagedCliIdentity,
} from "../cli-dispatcher";

const MAX_UPLOAD_BYTES = 1536 * 1024 * 1024;
const DEFAULT_WATCH_DEBOUNCE_MS = 175;
const DEFAULT_WATCH_RETRY_MS = 1_000;
const EXCLUDED_APP_ROOTS = new Set([".git", ".lamarck", "node_modules"]);

export type AppCliWorkloadIdentityV1 = ManagedCliIdentity;

interface AppCliSession {
  readonly stream: Duplex;
  readonly workspaceIds: Set<string>;
  writeTail: Promise<void>;
  readyForSync: boolean;
  closed: boolean;
}

interface AppWorkspaceSyncV1 {
  readonly type: "app-workspaces.sync";
  readonly schemaVersion: 1;
  readonly complete: boolean;
  readonly editBases: readonly ManagedAppEditBaseV1[];
}

interface PassiveAppWatcher {
  close(): void;
  on(event: "error", listener: (error: Error) => void): this;
  unref?(): this;
}

type AppWatchFactory = (
  path: string,
  options: { recursive: true },
  listener: (event: string, filename: string | Buffer | null) => void,
) => PassiveAppWatcher;

/** Terminates the workload-bound typed CLI stream in the trusted Host. */
export class AppCliStreamServer {
  readonly #sessions = new Set<AppCliSession>();
  #lastCompleteSnapshot: string | null = null;
  #watcher: PassiveAppWatcher | null = null;
  #watchRetryTimer: NodeJS.Timeout | null = null;
  #fullReconcileTimer: NodeJS.Timeout | null = null;
  readonly #appReconcileTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: {
    readonly dispatcher: () => CliOperationDispatcher;
    readonly appsRoot?: string | (() => string);
    readonly watch?: AppWatchFactory;
    readonly watchDebounceMs?: number;
    readonly watchRetryMs?: number;
  }) {}

  attach(identity: AppCliWorkloadIdentityV1, stream: Duplex): () => void {
    validateIdentity(identity);
    const reader = new CliStreamReader(stream);
    const session: AppCliSession = {
      stream,
      workspaceIds: new Set(),
      writeTail: Promise.resolve(),
      readyForSync: false,
      closed: false,
    };
    this.#sessions.add(session);
    this.#ensureWatcher();
    const closeSession = () => {
      if (session.closed) return;
      session.closed = true;
      this.#sessions.delete(session);
      if (this.#sessions.size === 0) this.#stopWatcher();
    };
    stream.once("close", closeSession);
    const run = async () => {
      const initialBases = await this.options.dispatcher().managedAppEditBases();
      await this.#write(session, () => writeCliBytes(
        stream,
        encodeCliFrame(this.options.dispatcher().capabilities("managed")),
      ));
      session.readyForSync = true;
      await this.#writeWorkspaceSync(session, initialBases, true);
      const initialKey = snapshotKey(initialBases);
      if (this.#lastCompleteSnapshot !== initialKey) {
        this.#lastCompleteSnapshot = initialKey;
        await Promise.all([...this.#sessions]
          .filter((candidate) => candidate !== session && candidate.readyForSync && !candidate.closed)
          .map((candidate) => this.#writeWorkspaceSync(candidate, initialBases, true)));
      }
      while (!session.closed && !stream.destroyed) {
        let request: CliRequest;
        try {
          request = parseCliRequest(parseCliFrame(await reader.readFrame()), true);
        } catch (error) {
          if (stream.readableEnded || stream.destroyed) return;
          throw error;
        }
        const handled = request.operation === "app.save" && request.upload
          ? { response: await this.#savePackage(request, reader, identity) }
          : request.upload?.kind === "file-stdin"
            ? await this.#callerContent(request, reader, identity)
            : await this.options.dispatcher().dispatch(request, {
              environment: "managed",
              principal: identity,
            });
        const response = await this.#mapManagedAppResult(request, handled.response, session);
        await this.#write(session, () => writeCliResponse(stream, request.operation, response));
        if (request.operation === "app.save" && response.ok) {
          const savedBase = savedEditBase(response.result);
          this.#lastCompleteSnapshot = null;
          await this.#broadcastWorkspaceSync([savedBase], false, session);
        }
      }
    };
    void run().catch((error) => {
      if (!stream.destroyed) stream.destroy(error instanceof Error ? error : new Error(String(error)));
    }).finally(closeSession);
    return () => {
      if (session.closed) return;
      closeSession();
      if (!stream.destroyed) stream.destroy();
    };
  }

  async reconcileAppWorkspaces(
    appId?: string,
    editBase?: ManagedAppEditBaseV1,
  ): Promise<void> {
    if (this.#sessions.size === 0) return;
    if (appId || editBase) {
      const resolved = editBase ?? await this.options.dispatcher().managedAppEditBase(appId!);
      this.#lastCompleteSnapshot = null;
      await this.#broadcastWorkspaceSync([resolved], false);
      return;
    }
    const editBases = await this.options.dispatcher().managedAppEditBases();
    const key = snapshotKey(editBases);
    if (key !== this.#lastCompleteSnapshot) {
      await this.#broadcastWorkspaceSync(editBases, true);
      this.#lastCompleteSnapshot = key;
    }
  }

  async #callerContent(
    request: CliRequest,
    reader: CliStreamReader,
    identity: AppCliWorkloadIdentityV1,
  ) {
    const upload = request.upload;
    if (!upload || upload.kind !== "file-stdin") {
      return { response: failure(request, "CLI_USAGE", "The caller content upload is invalid.") };
    }
    const bytes = await reader.readExact(upload.bytes);
    const hydrated = {
      requestId: request.requestId,
      operation: request.operation,
      input: { ...request.input, stdinBase64: bytes.toString("base64") },
    } as CliRequest;
    return this.options.dispatcher().dispatch(hydrated, {
      environment: "managed",
      principal: identity,
    });
  }

  async #savePackage(
    request: CliRequest,
    reader: CliStreamReader,
    identity: AppCliWorkloadIdentityV1,
  ): Promise<CliResponse> {
    const saveRequest = request as CliRequest<"app.save">;
    const upload = request.upload!;
    if (upload.kind !== "app-package" || upload.archiveBytes > MAX_UPLOAD_BYTES) {
      return failure(request, "APP_INVALID", "App package upload is outside the V1 bound");
    }
    try {
      const body = Readable.from(readUpload(reader, upload.archiveBytes));
      return (await this.options.dispatcher().dispatchManagedAppSave(saveRequest, identity, body)).response;
    } catch {
      return failure(request, "CLI_INTERNAL", "Lamarck could not save the App package.");
    }
  }

  async #mapManagedAppResult(
    request: CliRequest,
    response: CliResponse,
    session: AppCliSession,
  ): Promise<CliResponse> {
    if (!response.ok) return response;
    try {
      if (request.operation === "app.list") {
        if (!Array.isArray(response.result)) return failure(request, "CLI_INTERNAL", "Core returned an invalid App inventory");
        const result = response.result.flatMap((raw) => {
          const app = raw as { id?: unknown };
          const appId = requireAppId(app.id);
          return session.workspaceIds.has(appId)
            ? [{ ...app, path: `${MANAGED_APP_EDIT_ROOT}/${appId}` }]
            : [];
        });
        return success(request, result);
      }
      if (request.operation === "app.inspect") {
        const app = response.result as { id?: unknown };
        const appId = requireAppId(app.id);
        if (!session.workspaceIds.has(appId)) {
          return failure(request, "APP_NOT_FOUND", `App not found: ${appId}`);
        }
        return success(request, { ...app, path: `${MANAGED_APP_EDIT_ROOT}/${appId}` });
      }
      if (request.operation === "app.refresh") {
        const appId = requireAppId((request as CliRequest<"app.refresh">).input.appId);
        return success(request, { result: response.result, editBase: await this.#editBase(appId) });
      }
      return response;
    } catch {
      return failure(request, "CLI_INTERNAL", "Lamarck could not materialize the App editing base.");
    }
  }

  #editBase(appId: string): Promise<unknown> {
    return this.options.dispatcher().managedAppEditBase(appId);
  }

  async #broadcastWorkspaceSync(
    editBases: readonly ManagedAppEditBaseV1[],
    complete: boolean,
    excluded?: AppCliSession,
  ): Promise<void> {
    await Promise.all([...this.#sessions]
      .filter((session) => session !== excluded && session.readyForSync && !session.closed)
      .map((session) => this.#writeWorkspaceSync(session, editBases, complete)));
  }

  async #writeWorkspaceSync(
    session: AppCliSession,
    editBases: readonly ManagedAppEditBaseV1[],
    complete: boolean,
  ): Promise<void> {
    const frame: AppWorkspaceSyncV1 = Object.freeze({
      type: "app-workspaces.sync",
      schemaVersion: 1,
      complete,
      editBases: Object.freeze([...editBases]),
    });
    await this.#write(session, () => writeCliBytes(session.stream, encodeCliFrame(frame)));
    if (complete) {
      session.workspaceIds.clear();
      for (const base of editBases) session.workspaceIds.add(base.appId);
    } else {
      for (const base of editBases) session.workspaceIds.add(base.appId);
    }
  }

  #write(session: AppCliSession, operation: () => Promise<void>): Promise<void> {
    const write = session.writeTail.then(async () => {
      if (session.closed || session.stream.destroyed) return;
      await operation();
    });
    session.writeTail = write.catch(() => {});
    return write;
  }

  #ensureWatcher(): void {
    if (this.#sessions.size === 0 || this.#watcher || this.#watchRetryTimer || !this.options.appsRoot) {
      return;
    }
    const appsRoot = typeof this.options.appsRoot === "function"
      ? this.options.appsRoot()
      : this.options.appsRoot;
    try {
      const watch = this.options.watch
        ?? watchFileSystem as unknown as AppWatchFactory;
      const watcher = watch(appsRoot, { recursive: true }, (_event, filename) => {
        this.#handleWatchNotification(filename);
      });
      this.#watcher = watcher;
      watcher.unref?.();
      watcher.on("error", (error) => {
        if (this.#watcher !== watcher) return;
        console.warn("[cli] App workspace watcher failed; retrying:", error);
        watcher.close();
        this.#watcher = null;
        this.#scheduleWatcherRetry();
      });
    } catch (error) {
      console.warn("[cli] App workspace watcher could not start; retrying:", error);
      this.#scheduleWatcherRetry();
    }
  }

  #scheduleWatcherRetry(): void {
    if (this.#sessions.size === 0 || this.#watchRetryTimer) return;
    this.#watchRetryTimer = setTimeout(() => {
      this.#watchRetryTimer = null;
      this.#ensureWatcher();
    }, this.options.watchRetryMs ?? DEFAULT_WATCH_RETRY_MS);
    this.#watchRetryTimer.unref();
  }

  #handleWatchNotification(filename: string | Buffer | null): void {
    if (filename === null) {
      this.#queueFullReconcile();
      return;
    }
    const raw = (typeof filename === "string" ? filename : filename.toString())
      .replaceAll("\\", "/");
    if (!raw || raw.startsWith("/")) {
      this.#queueFullReconcile();
      return;
    }
    const segments = raw.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")
      || !PACKAGE_ID_PATTERN.test(segments[0]!)) {
      this.#queueFullReconcile();
      return;
    }
    if (segments.length === 1) {
      this.#queueFullReconcile();
      return;
    }
    if (EXCLUDED_APP_ROOTS.has(segments[1]!)) return;
    this.#queueAppReconcile(segments[0]!);
  }

  #queueAppReconcile(appId: string): void {
    if (this.#fullReconcileTimer) return;
    const pending = this.#appReconcileTimers.get(appId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.#appReconcileTimers.delete(appId);
      void this.reconcileAppWorkspaces(appId).catch((error) => {
        console.warn(`[cli] App workspace watcher could not reconcile ${appId}:`, error);
      });
    }, this.options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS);
    timer.unref();
    this.#appReconcileTimers.set(appId, timer);
  }

  #queueFullReconcile(): void {
    for (const timer of this.#appReconcileTimers.values()) clearTimeout(timer);
    this.#appReconcileTimers.clear();
    if (this.#fullReconcileTimer) clearTimeout(this.#fullReconcileTimer);
    this.#fullReconcileTimer = setTimeout(() => {
      this.#fullReconcileTimer = null;
      void this.reconcileAppWorkspaces().catch((error) => {
        console.warn("[cli] App workspace watcher could not reconcile inventory:", error);
      });
    }, this.options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS);
    this.#fullReconcileTimer.unref();
  }

  #stopWatcher(): void {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#watchRetryTimer) clearTimeout(this.#watchRetryTimer);
    this.#watchRetryTimer = null;
    if (this.#fullReconcileTimer) clearTimeout(this.#fullReconcileTimer);
    this.#fullReconcileTimer = null;
    for (const timer of this.#appReconcileTimers.values()) clearTimeout(timer);
    this.#appReconcileTimers.clear();
  }
}

async function* readUpload(reader: CliStreamReader, bytes: number): AsyncIterable<Buffer> {
  let remaining = bytes;
  while (remaining > 0) {
    const chunk = await reader.readExact(Math.min(64 * 1024, remaining));
    remaining -= chunk.byteLength;
    yield chunk;
  }
}

function success(request: CliRequest, result: unknown): CliResponse {
  return { requestId: request.requestId, ok: true, result } as CliResponse;
}

function failure(request: CliRequest, code: string, message: string): CliResponse {
  return { requestId: request.requestId, ok: false, error: { code, message } } as CliResponse;
}

function validateIdentity(value: AppCliWorkloadIdentityV1): void {
  if (
    value.kind !== "app"
    || !PACKAGE_ID_PATTERN.test(value.appId)
    || !value.workloadHandle
    || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value.appCommit)
    || !Array.isArray(value.writeTables)
    || value.writeTables.some((table) => typeof table !== "string" || table.length === 0)
    || !Array.isArray(value.fileGrants)
    || value.fileGrants.some((grant) => typeof grant !== "string" || grant.length === 0)
    || (value.workload !== "ui" && !/^(?:service|job):[a-z0-9][a-z0-9-]*$/.test(value.workload))
  ) throw new Error("Invalid workload-bound CLI identity");
}

function requireAppId(value: unknown): string {
  if (typeof value !== "string" || !PACKAGE_ID_PATTERN.test(value)) {
    throw new Error("A valid App id is required");
  }
  return value;
}

function snapshotKey(editBases: readonly ManagedAppEditBaseV1[]): string {
  return JSON.stringify([...editBases]
    .map((base) => [base.appId, base.version, base.packageDigest, base.lowerPath])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

function savedEditBase(value: unknown): ManagedAppEditBaseV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed App save omitted its resulting editing base");
  }
  const editBase = (value as { editBase?: unknown }).editBase;
  if (!editBase || typeof editBase !== "object" || Array.isArray(editBase)) {
    throw new Error("Managed App save omitted its resulting editing base");
  }
  return editBase as ManagedAppEditBaseV1;
}
