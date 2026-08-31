import { constants, createReadStream } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import {
  APP_EDIT_ROOT_PATH,
  encodeAppCliFrame,
  isCanonicalAppPackageId,
  parseAppCliRequest,
  parseAppCliResponse,
  type AppCliRequestV1,
  type AppCliResponseV1,
  type AppEditBaseDescriptorV1,
  type CapsuleAppInventoryItemV1,
} from "./protocol";
import { createAppEditSnapshot } from "./snapshot";
import { AppCliStreamReader, writeAppCliBytes } from "./stream";

export interface WorkloadAppCliBridge {
  close(): Promise<void>;
}

export async function openWorkloadAppCliBridge(options: {
  readonly socketPath: string;
  readonly upstream: Duplex;
  readonly editRoot: string;
  readonly lowerRoot: string;
  readonly uid: number;
  readonly gid: number;
}): Promise<WorkloadAppCliBridge> {
  if (options.socketPath !== `${dirname(options.socketPath)}/cli.sock`) {
    throw new Error("App CLI socket must use its fixed name");
  }
  const server = createServer();
  const clients = new Set<Socket>();
  const upstreamReader = new AppCliStreamReader(options.upstream);
  const bases = new Map<string, AppEditBaseDescriptorV1>();
  let tail: Promise<void> = Promise.resolve();
  let closed = false;

  server.on("connection", (client) => {
    if (closed) return client.destroy();
    clients.add(client);
    client.once("close", () => clients.delete(client));
    const operation = tail.then(async () => {
      const reader = new AppCliStreamReader(client);
      const request = parseAppCliRequest(await reader.readFrame(), false);
      const response = await handleLocalRequest(request);
      await writeAppCliBytes(client, encodeAppCliFrame(response));
      client.end();
    }).catch((error) => {
      if (!client.destroyed) client.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    tail = operation.then(() => undefined, () => undefined);
  });

  const handleLocalRequest = async (request: AppCliRequestV1): Promise<AppCliResponseV1> => {
    if (request.operation === "app.save") {
      const appId = requireAppId(request.input.appId);
      const base = bases.get(appId);
      if (!base) return failure(request, "APP_NOT_MATERIALIZED", `Run app list before saving ${appId}`);
      const snapshot = await createAppEditSnapshot(
        join(options.editRoot, appId),
        `${options.editRoot}-transfers`,
      );
      try {
        const hostRequest: AppCliRequestV1 = {
          ...request,
          upload: {
            archiveDigest: snapshot.archiveDigest,
            archiveBytes: snapshot.archiveBytes,
            baseVersion: base.version,
            basePackageDigest: base.packageDigest,
          },
        };
        await writeAppCliBytes(options.upstream, encodeAppCliFrame(hostRequest));
        const input = createReadStream(snapshot.path);
        for await (const chunk of input) await writeAppCliBytes(options.upstream, chunk);
        const response = parseAppCliResponse(await upstreamReader.readFrame());
        if (response.requestId !== request.requestId) throw new Error("App CLI response attribution mismatch");
        if (response.ok) await rematerializeFromResult(appId, response.result);
        return publicResponse(response);
      } finally {
        await snapshot.cleanup();
      }
    }

    await writeAppCliBytes(options.upstream, encodeAppCliFrame(request));
    const response = parseAppCliResponse(await upstreamReader.readFrame());
    if (response.requestId !== request.requestId) throw new Error("App CLI response attribution mismatch");
    if (!response.ok) return response;
    if (request.operation === "app.list") {
      if (!Array.isArray(response.result)) throw new Error("Host returned invalid App inventory");
      const publicItems = [];
      for (const raw of response.result) {
        const item = parseInventoryItem(raw);
        const existing = bases.get(item.id);
        if (!existing) await materialize(item.editBase);
        const localBase = bases.get(item.id);
        if (!localBase) throw new Error("App materialization did not record its base");
        publicItems.push({
          id: item.id,
          name: item.name,
          path: `${APP_EDIT_ROOT_PATH}/${item.id}`,
          version: localBase.version,
        });
      }
      return { ...response, result: publicItems };
    }
    const appId = requireAppId(request.input.appId);
    if (request.operation === "app.refresh" || request.operation === "app.restore") {
      await rematerializeFromResult(appId, response.result);
    }
    return publicResponse(response);
  };

  const rematerializeFromResult = async (appId: string, result: unknown) => {
    if (!result || typeof result !== "object") throw new Error("Host omitted the App editing base");
    const base = parseBase((result as { editBase?: unknown }).editBase);
    if (base.appId !== appId) throw new Error("Host returned an editing base for another App");
    await materialize(base);
  };

  const materialize = async (base: AppEditBaseDescriptorV1) => {
    const lower = resolve(options.lowerRoot, ...base.lowerPath.split("/"));
    const expectedPrefix = `${resolve(options.lowerRoot)}/`;
    if (!lower.startsWith(expectedPrefix)) throw new Error("Host editing lower escaped its share");
    const destination = join(options.editRoot, base.appId);
    const stage = await mkdtemp(join(options.editRoot, `.materialize-${base.appId}-`));
    try {
      await copyTree(lower, stage, options.uid, options.gid);
      await rm(destination, { recursive: true, force: true });
      await rename(stage, destination);
      bases.set(base.appId, base);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  };

  await mkdir(options.editRoot, { recursive: true, mode: 0o700 });
  await chown(options.editRoot, options.uid, options.gid);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolveListen();
    });
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
    },
  });
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

function parseInventoryItem(value: unknown): CapsuleAppInventoryItemV1 {
  if (!value || typeof value !== "object") throw new Error("Invalid Capsule App inventory item");
  const item = value as Partial<CapsuleAppInventoryItemV1>;
  const base = parseBase(item.editBase);
  if (
    item.schemaVersion !== 1
    || typeof item.id !== "string"
    || typeof item.name !== "string"
    || item.path !== `${APP_EDIT_ROOT_PATH}/${item.id}`
    || item.version !== base.version
    || base.appId !== item.id
  ) throw new Error("Invalid Capsule App inventory item");
  return item as CapsuleAppInventoryItemV1;
}

function parseBase(value: unknown): AppEditBaseDescriptorV1 {
  if (!value || typeof value !== "object") throw new Error("Invalid App editing base");
  const base = value as Partial<AppEditBaseDescriptorV1>;
  if (
    base.schemaVersion !== 1
    || !isCanonicalAppPackageId(base.appId)
    || (base.version !== null && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(base.version ?? ""))
    || !/^sha256:[0-9a-f]{64}$/.test(base.packageDigest ?? "")
    || typeof base.lowerPath !== "string"
    || base.lowerPath !== `${base.appId}/${base.lowerPath.split("/")[1]}`
  ) throw new Error("Invalid App editing base");
  return base as AppEditBaseDescriptorV1;
}

function requireAppId(value: unknown): string {
  if (!isCanonicalAppPackageId(value)) {
    throw new Error("App CLI requires a valid App id");
  }
  return value;
}

function publicResponse(response: AppCliResponseV1): AppCliResponseV1 {
  if (!response.ok || !response.result || typeof response.result !== "object") return response;
  const result = response.result as { editBase?: unknown; result?: unknown };
  return "editBase" in result ? { ...response, result: result.result } : response;
}

function failure(request: AppCliRequestV1, code: string, message: string): AppCliResponseV1 {
  return { version: 1, requestId: request.requestId, ok: false, error: { code, message } };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
