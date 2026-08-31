import { chmod, chown, lstat, mkdir, rmdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import {
  openWorkloadAppCliBridge,
  type WorkloadAppCliBridge,
} from "../app-edit/guest-bridge";

export interface WorkloadSdkBridge {
  readonly socketPath: string;
  assertOpen(): void;
  close(): Promise<void>;
}

export interface WorkloadSdkBridgeOptions {
  readonly bridgeRoot: string;
  readonly socketPath: string;
  readonly uid: number;
  readonly gid: number;
  readonly upstream: Duplex;
  readonly appCli?: {
    readonly socketPath: string;
    readonly upstream: Duplex;
    readonly editRoot: string;
    readonly lowerRoot: string;
  };
}

/**
 * Own one workload-private Unix socket and relay its first client to the
 * already-authenticated Host DATA stream. The bridge itself remains outside
 * the App cgroup, so an App that never imports the SDK can still exit.
 */
export async function openWorkloadSdkBridge(
  options: WorkloadSdkBridgeOptions,
): Promise<WorkloadSdkBridge> {
  validateOptions(options);
  const server = createServer({ allowHalfOpen: false });
  let local: Socket | undefined;
  let rootCreated = false;
  let ready = false;
  let closing = false;
  let failure: Error | undefined;
  let closePromise: Promise<void> | undefined;
  let listenerClosePromise: Promise<void> | undefined;
  let appCliBridge: WorkloadAppCliBridge | undefined;

  const closeListener = (): Promise<void> => {
    listenerClosePromise ??= server.listening
      ? new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        })
      : Promise.resolve();
    return listenerClosePromise;
  };

  const terminatePeer = (peer: Duplex, error?: Error) => {
    if (peer.destroyed) return;
    peer.destroy(error);
  };

  const removeUpstreamListeners = () => {
    options.upstream.off("error", onUpstreamError);
    options.upstream.off("end", onUpstreamEnd);
    options.upstream.off("close", onUpstreamClose);
  };

  const closeBridge = async (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      ready = false;
      local?.destroy();
      options.upstream.destroy();
      options.appCli?.upstream.destroy();
      const failures: unknown[] = [];
      try {
        await appCliBridge?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await closeListener();
      } catch (error) {
        failures.push(error);
      }
      try {
        await chmod(options.bridgeRoot, 0o700);
      } catch (error) {
        failures.push(error);
      }
      try {
        await unlinkIfPresent(options.socketPath);
      } catch (error) {
        failures.push(error);
      }
      try {
        await rmdir(options.bridgeRoot);
      } catch (error) {
        failures.push(error);
      }
      removeUpstreamListeners();
      if (failures.length > 0) {
        throw new AggregateError(failures, "System SDK bridge cleanup failed");
      }
    })();
    await closePromise;
  };

  const failBridge = (error: Error) => {
    if (closing || failure) return;
    failure = error;
    terminatePeer(local ?? options.upstream, error);
    if (local) terminatePeer(options.upstream, error);
    // During setup the surrounding catch owns cleanup. Once published, revoke
    // the socket path immediately so a workload can never connect to a dead
    // authenticated Host stream.
    if (ready) void closeBridge().catch(() => undefined);
  };

  function onUpstreamError(error: Error): void {
    failBridge(error);
  }

  function onUpstreamEnd(): void {
    failBridge(new Error("Authenticated System SDK upstream ended"));
  }

  function onUpstreamClose(): void {
    failBridge(new Error("Authenticated System SDK upstream closed"));
  }

  options.upstream.once("error", onUpstreamError);
  options.upstream.once("end", onUpstreamEnd);
  options.upstream.once("close", onUpstreamClose);

  server.on("error", (error) => failBridge(error));

  server.on("connection", (socket) => {
    if (closing || local) {
      socket.destroy(new Error("System SDK bridge accepts exactly one workload client"));
      return;
    }
    local = socket;
    void closeListener().catch((error: unknown) => {
      terminatePeer(socket, asError(error));
      terminatePeer(options.upstream, asError(error));
    });

    socket.once("error", (error) => terminatePeer(options.upstream, error));
    options.upstream.once("error", (error) => terminatePeer(socket, error));
    socket.once("close", () => {
      if (!closing) terminatePeer(options.upstream);
    });
    options.upstream.once("close", () => {
      if (!closing) terminatePeer(socket);
    });
    socket.pipe(options.upstream);
    options.upstream.pipe(socket);
  });

  try {
    await mkdir(dirname(options.bridgeRoot), { recursive: true, mode: 0o700 });
    assertUpstreamOpen(options.upstream, failure);
    await ensureMissing(options.bridgeRoot, "SDK bridge root");
    assertUpstreamOpen(options.upstream, failure);
    await mkdir(options.bridgeRoot, { mode: 0o700 });
    rootCreated = true;
    assertUpstreamOpen(options.upstream, failure);
    await listen(server, options.socketPath);
    assertUpstreamOpen(options.upstream, failure);
    if (options.appCli) {
      appCliBridge = await openWorkloadAppCliBridge({
        ...options.appCli,
        uid: options.uid,
        gid: options.gid,
      });
    }
    await chmod(options.socketPath, 0o600);
    await chown(options.socketPath, options.uid, options.gid);
    // The App can traverse its private mounted directory and connect to the
    // socket, but the read-only OCI bind prevents replacement or unlinking.
    await chown(options.bridgeRoot, options.uid, options.gid);
    await chmod(options.bridgeRoot, 0o500);
    assertUpstreamOpen(options.upstream, failure);
    ready = true;
  } catch (error) {
    closing = true;
    ready = false;
    local?.destroy();
    options.upstream.destroy();
    options.appCli?.upstream.destroy();
    removeUpstreamListeners();
    const failures: unknown[] = failure && failure !== error
      ? [failure, error]
      : [error];
    await closeListener().catch((cleanupError) => failures.push(cleanupError));
    await appCliBridge?.close().catch((cleanupError) => failures.push(cleanupError));
    if (rootCreated) {
      await chmod(options.bridgeRoot, 0o700).catch((cleanupError) => failures.push(cleanupError));
      await unlinkIfPresent(options.socketPath).catch((cleanupError) => failures.push(cleanupError));
      await rmdir(options.bridgeRoot).catch((cleanupError) => failures.push(cleanupError));
    }
    throw failures.length === 1
      ? error
      : new AggregateError(failures, "System SDK bridge setup cleanup failed");
  }

  return Object.freeze({
    socketPath: options.socketPath,
    assertOpen: () => {
      assertUpstreamOpen(options.upstream, failure);
      if (!ready || closing) throw new Error("System SDK bridge is not open");
    },
    close: closeBridge,
  });
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

async function ensureMissing(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists`);
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function validateOptions(options: WorkloadSdkBridgeOptions): void {
  if (!options.bridgeRoot.startsWith("/") || options.bridgeRoot.endsWith("/")) {
    throw new Error("SDK bridge root must be an absolute normalized path");
  }
  if (options.socketPath !== `${options.bridgeRoot}/system.sock`) {
    throw new Error("SDK socket must be the fixed child of its bridge root");
  }
  if (!Number.isSafeInteger(options.uid) || options.uid < 1) {
    throw new Error("SDK bridge uid is invalid");
  }
  if (!Number.isSafeInteger(options.gid) || options.gid < 1) {
    throw new Error("SDK bridge gid is invalid");
  }
  if (
    typeof options.upstream !== "object"
    || options.upstream === null
    || typeof options.upstream.pipe !== "function"
    || typeof options.upstream.destroy !== "function"
  ) throw new Error("SDK bridge upstream must be an open Duplex stream");
  assertUpstreamOpen(options.upstream);
  if (options.appCli) {
    if (options.appCli.socketPath !== `${options.bridgeRoot}/cli.sock`) {
      throw new Error("App CLI socket must be the fixed child of its bridge root");
    }
    if (!options.appCli.editRoot.startsWith("/") || !options.appCli.lowerRoot.startsWith("/")) {
      throw new Error("App CLI materialization roots must be absolute");
    }
    assertUpstreamOpen(options.appCli.upstream);
  }
}

function assertUpstreamOpen(upstream: Duplex, failure?: Error): void {
  if (failure) throw failure;
  if (upstream.destroyed || upstream.readableEnded || upstream.writableEnded) {
    throw new Error("SDK bridge upstream must be an open authenticated stream");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
