import { constants, createReadStream } from "node:fs";
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import {
  MANAGED_APP_EDIT_ROOT,
  encodeCliFrame,
  parseCliCapabilities,
  parseCliFrame,
  parseCliRequest,
  parseCliResponse,
  type CliHostCapabilities,
  type CliRequest,
  type CliResponse,
  CliStreamReader,
  writeCliResponse,
  writeCliBytes,
} from "@lamarck/cli";
import { createAppEditSnapshot, hashAppEditPackage } from "./snapshot";

interface AppEditBaseDescriptorV1 {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly version: string | null;
  readonly packageDigest: `sha256:${string}`;
  readonly lowerPath: string;
}

interface AppWorkspaceSyncV1 {
  readonly type: "app-workspaces.sync";
  readonly schemaVersion: 1;
  readonly complete: boolean;
  readonly editBases: readonly AppEditBaseDescriptorV1[];
}

class SupersededEditBaseError extends Error {
  constructor(readonly appId: string, options?: ErrorOptions) {
    super(`App editing lower was superseded before it could be copied: ${appId}`, options);
    this.name = "SupersededEditBaseError";
  }
}

export interface WorkloadAppCliBridge { close(): Promise<void> }

export async function openWorkloadAppCliBridge(options: {
  readonly socketPath: string;
  readonly upstream: Duplex;
  readonly editRoot: string;
  readonly lowerRoot: string;
  readonly uid: number;
  readonly gid: number;
}): Promise<WorkloadAppCliBridge> {
  if (options.socketPath !== `${dirname(options.socketPath)}/cli.sock`) {
    throw new Error("CLI socket must use its fixed name");
  }
  const upstreamReader = new CliStreamReader(options.upstream);
  const hello = parseCliCapabilities(parseCliFrame(await upstreamReader.readFrame()), "managed");
  const server = createServer();
  const clients = new Set<Socket>();
  const bases = new Map<string, AppEditBaseDescriptorV1>();
  const savingApps = new Set<string>();
  const deferredBases = new Map<string, AppEditBaseDescriptorV1 | null>();
  let tail: Promise<void> = Promise.resolve();
  let workspaceTail: Promise<void> = Promise.resolve();
  let closed = false;
  let upstreamFailure: Error | undefined;
  let pending: {
    readonly requestId: string;
    readonly operation: CliRequest["operation"];
    readonly resolve: (response: CliResponse) => void;
    readonly reject: (error: Error) => void;
  } | undefined;

  const withWorkspace = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = workspaceTail.then(operation);
    workspaceTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const exchange = async (
    request: CliRequest,
    upload?: string | Uint8Array,
  ): Promise<CliResponse> => {
    if (pending) throw new Error("Managed CLI attempted concurrent Host exchanges");
    if (upstreamFailure) throw upstreamFailure;
    return new Promise<CliResponse>((resolveExchange, rejectExchange) => {
      pending = {
        requestId: request.requestId,
        operation: request.operation,
        resolve: resolveExchange,
        reject: rejectExchange,
      };
      void (async () => {
        await writeCliBytes(options.upstream, encodeCliFrame(request));
        if (typeof upload === "string") {
          for await (const chunk of createReadStream(upload)) await writeCliBytes(options.upstream, chunk);
        } else if (upload && upload.byteLength > 0) {
          await writeCliBytes(options.upstream, upload);
        }
      })().catch((error) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (pending?.requestId === request.requestId) pending = undefined;
        rejectExchange(failure);
      });
    });
  };

  const materialize = async (base: AppEditBaseDescriptorV1) => {
    const lower = resolve(options.lowerRoot, ...base.lowerPath.split("/"));
    if (!lower.startsWith(`${resolve(options.lowerRoot)}/`)) throw new Error("Host editing lower escaped its share");
    const destination = join(options.editRoot, base.appId);
    const stage = await mkdtemp(join(options.editRoot, `.materialize-${base.appId}-`));
    try {
      try {
        await copyTree(lower, stage, options.uid, options.gid);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) {
          throw new SupersededEditBaseError(base.appId, { cause: error });
        }
        throw error;
      }
      await rm(destination, { recursive: true, force: true });
      await rename(stage, destination);
      bases.set(base.appId, base);
    } finally { await rm(stage, { recursive: true, force: true }); }
  };

  const assertWorkspace = async (appId: string): Promise<void> => {
    const workspace = await lstat(join(options.editRoot, appId));
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) {
      throw new Error(`Initialized App workspace is unavailable: ${appId}`);
    }
  };

  const reconcileBase = async (base: AppEditBaseDescriptorV1): Promise<void> => {
    const current = bases.get(base.appId);
    if (!current) {
      await materialize(base);
      return;
    }
    await assertWorkspace(base.appId);
    if (sameBase(current, base)) return;
    let clean = false;
    try {
      clean = await hashAppEditPackage(join(options.editRoot, base.appId)) === current.packageDigest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      // An invalid or concurrently edited tree is dirty and must be preserved.
    }
    if (clean) await materialize(base);
  };

  const applyWorkspaceSync = async (sync: AppWorkspaceSyncV1): Promise<void> => {
    await withWorkspace(async () => {
      const nextIds = new Set(sync.editBases.map((base) => base.appId));
      for (const base of sync.editBases) {
        if (savingApps.has(base.appId)) {
          deferredBases.set(base.appId, base);
        } else {
          try {
            await reconcileBase(base);
          } catch (error) {
            if (!sync.complete && error instanceof SupersededEditBaseError) continue;
            throw error;
          }
        }
      }
      if (sync.complete) {
        for (const appId of [...bases.keys()]) {
          if (nextIds.has(appId)) continue;
          if (savingApps.has(appId)) {
            deferredBases.set(appId, null);
            continue;
          }
          await rm(join(options.editRoot, appId), { recursive: true, force: true });
          bases.delete(appId);
        }
      }
    });
  };

  const unwrapResult = async (request: CliRequest, response: CliResponse): Promise<CliResponse> => {
    if (!response.ok) return response;
    if (request.operation === "app.list") {
      if (!Array.isArray(response.result)) throw new Error("Host returned invalid App inventory");
      const publicItems = [];
      for (const raw of response.result) {
        if (!raw || typeof raw !== "object") throw new Error("Host returned invalid App inventory");
        const item = raw as Record<string, unknown>;
        const appId = requireAppId(item.id);
        await withWorkspace(() => assertWorkspace(appId));
        publicItems.push(item);
      }
      return success(request, publicItems);
    }
    if (request.operation === "app.inspect") {
      if (!response.result || typeof response.result !== "object") throw new Error("Host returned invalid App inspection");
      const item = response.result as Record<string, unknown>;
      const appId = requireAppId(item.id);
      await withWorkspace(() => assertWorkspace(appId));
      return response;
    }
    if (request.operation === "app.refresh") {
      if (!response.result || typeof response.result !== "object") throw new Error("Host omitted the App editing base");
      const wrapped = response.result as { result?: unknown; editBase?: unknown };
      const appId = requireAppId((request as CliRequest<"app.refresh">).input.appId);
      const base = parseBase(wrapped.editBase);
      if (base.appId !== appId) throw new Error("Host returned an editing base for another App");
      await withWorkspace(() => materialize(base));
      return success(request, wrapped.result);
    }
    return response;
  };

  const handle = async (request: CliRequest, uploadBytes?: Uint8Array): Promise<CliResponse> => {
    if (request.operation === "app.save") {
      if (request.upload !== undefined) throw new Error("Local App save cannot submit package authority");
      const saveRequest = request as CliRequest<"app.save">;
      const appId = requireAppId(saveRequest.input.appId);
      try {
        const base = bases.get(appId);
        if (!base) throw new Error(`App workspace was not initialized: ${appId}`);
        await withWorkspace(() => assertWorkspace(appId));
        savingApps.add(appId);
        let snapshot: Awaited<ReturnType<typeof createAppEditSnapshot>> | undefined;
        try {
          snapshot = await withWorkspace(() => createAppEditSnapshot(
            join(options.editRoot, appId),
            `${options.editRoot}-transfers`,
          ));
          const hostRequest: CliRequest<"app.save"> = {
            ...saveRequest,
            upload: {
              kind: "app-package",
              archiveDigest: snapshot.archiveDigest,
              archiveBytes: snapshot.archiveBytes,
              baseVersion: base.version,
              basePackageDigest: base.packageDigest,
            },
          };
          const response = await exchange(hostRequest, snapshot.path);
          if (!response.ok) return response;
          if (!response.result || typeof response.result !== "object") {
            throw new Error("Host omitted the saved App base");
          }
          const wrapped = response.result as { result?: unknown; editBase?: unknown };
          const savedBase = parseBase(wrapped.editBase);
          if (savedBase.appId !== appId) throw new Error("Host returned an editing base for another App");
          await withWorkspace(async () => { bases.set(appId, savedBase); });
          return success(request, wrapped.result);
        } finally {
          savingApps.delete(appId);
          const deferred = deferredBases.get(appId);
          deferredBases.delete(appId);
          if (deferred !== undefined) {
            await withWorkspace(async () => {
              if (deferred === null) {
                await rm(join(options.editRoot, appId), { recursive: true, force: true });
                bases.delete(appId);
              } else if (!sameBase(bases.get(appId), deferred)) {
                try {
                  await reconcileBase(deferred);
                } catch (error) {
                  if (!(error instanceof SupersededEditBaseError)) throw error;
                }
              }
            });
          }
          await snapshot?.cleanup();
        }
      } catch (error) {
        return failure(request, "CLI_INTERNAL", error instanceof Error
          ? error.message
          : "Lamarck could not access the initialized App workspace.");
      }
    }
    return unwrapResult(request, await exchange(request, uploadBytes));
  };

  server.on("connection", (client) => {
    if (closed) return client.destroy();
    clients.add(client);
    client.once("close", () => clients.delete(client));
    const operation = tail.then(async () => {
      await writeCliBytes(client, encodeCliFrame(hello));
      const reader = new CliStreamReader(client);
      let request: CliRequest;
      try {
        request = parseCliRequest(parseCliFrame(await reader.readFrame()), true);
      } catch (error) {
        if (client.readableEnded || client.destroyed) return;
        throw error;
      }
      if (request.upload !== undefined
        && request.upload.kind !== "file-stdin") {
        throw new Error("Local CLI upload is not allowed");
      }
      const uploadBytes = request.upload?.kind === "file-stdin"
        ? await reader.readExact(request.upload.bytes)
        : undefined;
      await writeCliResponse(client, request.operation, await handle(request, uploadBytes));
      client.end();
    }).catch((error) => {
      if (!client.destroyed) client.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    tail = operation.then(() => undefined, () => undefined);
  });

  await mkdir(options.editRoot, { recursive: true, mode: 0o700 });
  await chown(options.editRoot, options.uid, options.gid);
  await applyWorkspaceSync(parseWorkspaceSync(parseCliFrame(await upstreamReader.readFrame()), true));
  void receiveUpstream().catch((error) => {
    upstreamFailure = error instanceof Error ? error : new Error(String(error));
    pending?.reject(upstreamFailure);
    pending = undefined;
    for (const client of clients) client.destroy(upstreamFailure);
    if (!closed) server.close();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => { server.off("error", reject); resolveListen(); });
  });
  await chmod(options.socketPath, 0o600);
  await chown(options.socketPath, options.uid, options.gid);

  return Object.freeze({
    close: async () => {
      if (closed) return;
      closed = true;
      for (const client of clients) client.destroy();
      options.upstream.destroy();
      await closeServer(server);
      await tail;
      await workspaceTail;
    },
  });

  async function receiveUpstream(): Promise<void> {
    while (!closed && !options.upstream.destroyed) {
      const value = parseCliFrame(await upstreamReader.readFrame());
      if (isWorkspaceSync(value)) {
        await applyWorkspaceSync(parseWorkspaceSync(value));
        continue;
      }
      const awaiting = pending;
      if (!awaiting) throw new Error("Host sent an unsolicited CLI response");
      pending = undefined;
      let response = parseCliResponse(value, awaiting.requestId);
      if (response.ok && response.byteStreams !== undefined) {
        const result = response.result as Record<string, unknown>;
        const stdout = await upstreamReader.readExact(response.byteStreams.stdoutBytes);
        const stderr = await upstreamReader.readExact(response.byteStreams.stderrBytes);
        response = {
          requestId: response.requestId,
          ok: true,
          result: {
            ...result,
            stdoutBase64: stdout.toString("base64"),
            stderrBase64: stderr.toString("base64"),
          },
        } as CliResponse;
      }
      awaiting.resolve(response);
    }
  }
}

async function copyTree(source: string, destination: string, uid: number, gid: number): Promise<void> {
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("App editing lower is invalid");
  await chmod(destination, 0o755);
  await chown(destination, uid, gid);
  for (const child of await readdir(source, { withFileTypes: true })) {
    const from = join(source, child.name);
    const to = join(destination, child.name);
    const childInfo = await lstat(from);
    if (childInfo.isDirectory() && !childInfo.isSymbolicLink()) {
      await mkdir(to, { mode: 0o755 });
      await copyTree(from, to, uid, gid);
    } else if (childInfo.isFile() && !childInfo.isSymbolicLink()) {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await chmod(to, 0o644);
      await chown(to, uid, gid);
    } else throw new Error("App editing lower contains an unsupported entry");
  }
}

function parseBase(value: unknown): AppEditBaseDescriptorV1 {
  if (!value || typeof value !== "object") throw new Error("Invalid App editing base");
  const base = value as Partial<AppEditBaseDescriptorV1>;
  if (
    base.schemaVersion !== 1
    || !isAppId(base.appId)
    || (base.version !== null && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(base.version ?? ""))
    || !/^sha256:[0-9a-f]{64}$/.test(base.packageDigest ?? "")
    || typeof base.lowerPath !== "string"
    || base.lowerPath !== `${base.appId}/${base.lowerPath.split("/")[1]}`
  ) throw new Error("Invalid App editing base");
  return base as AppEditBaseDescriptorV1;
}

function isWorkspaceSync(value: unknown): boolean {
  return Boolean(value && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "app-workspaces.sync");
}

function parseWorkspaceSync(value: unknown, requireComplete = false): AppWorkspaceSyncV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid App workspace synchronization frame");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "complete,editBases,schemaVersion,type"
    || raw.type !== "app-workspaces.sync"
    || raw.schemaVersion !== 1
    || typeof raw.complete !== "boolean"
    || requireComplete && raw.complete !== true
    || !Array.isArray(raw.editBases)) {
    throw new Error("Invalid App workspace synchronization frame");
  }
  const ids = new Set<string>();
  const editBases = raw.editBases.map((value) => {
    const base = parseBase(value);
    if (ids.has(base.appId)) throw new Error("Duplicate App workspace synchronization entry");
    ids.add(base.appId);
    return base;
  });
  return Object.freeze({
    type: "app-workspaces.sync",
    schemaVersion: 1,
    complete: raw.complete,
    editBases: Object.freeze(editBases),
  });
}

function sameBase(
  left: AppEditBaseDescriptorV1 | undefined,
  right: AppEditBaseDescriptorV1,
): boolean {
  return left !== undefined
    && left.appId === right.appId
    && left.version === right.version
    && left.packageDigest === right.packageDigest
    && left.lowerPath === right.lowerPath;
}

function success(request: CliRequest, result: unknown): CliResponse {
  return { requestId: request.requestId, ok: true, result } as CliResponse;
}

function failure(request: CliRequest, code: string, message: string): CliResponse {
  return { requestId: request.requestId, ok: false, error: { code, message } } as CliResponse;
}

function requireAppId(value: unknown): string {
  if (!isAppId(value)) throw new Error("CLI requires a valid App id");
  return value;
}

function isAppId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
