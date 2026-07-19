import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { openWorkloadSdkBridge, type WorkloadSdkBridge } from "../src/oci/sdk-bridge";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await Promise.resolve(cleanup()).catch(() => undefined);
  }
});

describe("workload System SDK Unix bridge", () => {
  test("relays one client, rejects reconnects, and removes all authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-sdk-bridge-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const upstream = await socketPair(root, "upstream.sock");
    const bridgeRoot = join(root, "bridge");
    const socketPath = join(bridgeRoot, "system.sock");
    const bridge = await openWorkloadSdkBridge({
      bridgeRoot,
      socketPath,
      uid: bridgeOwnerUid(),
      gid: bridgeOwnerGid(),
      upstream: upstream.source,
    });
    cleanups.push(async () => bridge.close(), upstream.close);

    const details = await stat(socketPath);
    expect(details.mode & 0o777).toBe(0o600);
    const local = createConnection(socketPath);
    await once(local, "connect");
    cleanups.push(() => { local.destroy(); });

    const fromWorkload = onceData(upstream.peer);
    local.write("request");
    expect((await fromWorkload).toString("utf8")).toBe("request");

    const fromHost = onceData(local);
    upstream.peer.write("response");
    expect((await fromHost).toString("utf8")).toBe("response");

    const duplicate = createConnection(socketPath);
    const duplicateError = once(duplicate, "error");
    await expect(duplicateError).resolves.toBeDefined();
    duplicate.destroy();

    await bridge.close();
    await expect(stat(bridgeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(upstream.source.destroyed).toBe(true);
  });

  test("closes without a client so an SDK-free Job cannot be kept alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-sdk-idle-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const upstream = await socketPair(root, "upstream.sock");
    const bridgeRoot = join(root, "bridge");
    const bridge = await openWorkloadSdkBridge({
      bridgeRoot,
      socketPath: join(bridgeRoot, "system.sock"),
      uid: bridgeOwnerUid(),
      gid: bridgeOwnerGid(),
      upstream: upstream.source,
    });
    cleanups.push(upstream.close);

    await bridge.close();
    await expect(stat(bridgeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("revokes the socket when the authenticated upstream closes before connect", async () => {
    const root = await mkdtemp(join(tmpdir(), "l-sdk-upclose-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const upstream = await socketPair(root, "upstream.sock");
    const bridgeRoot = join(root, "bridge");
    const socketPath = join(bridgeRoot, "system.sock");
    const bridge = await openWorkloadSdkBridge({
      bridgeRoot,
      socketPath,
      uid: bridgeOwnerUid(),
      gid: bridgeOwnerGid(),
      upstream: upstream.source,
    });
    cleanups.push(async () => bridge.close(), upstream.close);

    upstream.peer.destroy();
    await waitUntilMissing(bridgeRoot);
    expect(() => bridge.assertOpen()).toThrow("Authenticated System SDK upstream");

    const local = createConnection(socketPath);
    await expect(once(local, "error")).resolves.toBeDefined();
    local.destroy();
  });

  test("rejects an upstream that is already closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-sdk-closed-source-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const upstream = await socketPair(root, "upstream.sock");
    const bridgeRoot = join(root, "bridge");
    upstream.source.destroy();
    await once(upstream.source, "close");
    cleanups.push(upstream.close);

    await expect(openWorkloadSdkBridge({
      bridgeRoot,
      socketPath: join(bridgeRoot, "system.sock"),
      uid: bridgeOwnerUid(),
      gid: bridgeOwnerGid(),
      upstream: upstream.source,
    })).rejects.toThrow("open authenticated stream");
    await expect(stat(bridgeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("catches an upstream close racing bridge setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "l-sdk-uprace-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const upstream = await socketPair(root, "upstream.sock");
    const bridgeRoot = join(root, "bridge");
    upstream.peer.destroy();
    cleanups.push(upstream.close);

    await expect(openWorkloadSdkBridge({
      bridgeRoot,
      socketPath: join(bridgeRoot, "system.sock"),
      uid: bridgeOwnerUid(),
      gid: bridgeOwnerGid(),
      upstream: upstream.source,
    })).rejects.toThrow("Authenticated System SDK upstream");
    await expect(stat(bridgeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed instead of deleting a stale bridge root", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-sdk-stale-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const upstream = await socketPair(root, "upstream.sock");
    const bridgeRoot = join(root, "bridge");
    await mkdir(bridgeRoot);
    cleanups.push(upstream.close);

    await expect(openWorkloadSdkBridge({
      bridgeRoot,
      socketPath: join(bridgeRoot, "system.sock"),
      uid: bridgeOwnerUid(),
      gid: bridgeOwnerGid(),
      upstream: upstream.source,
    })).rejects.toThrow("already exists");
    await expect(stat(bridgeRoot)).resolves.toBeDefined();
  });
});

async function socketPair(root: string, name: string): Promise<{
  source: Socket;
  peer: Socket;
  close(): Promise<void>;
}> {
  const path = join(root, name);
  const server = createServer();
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  const peer = createConnection(path);
  await once(peer, "connect");
  const source = await accepted;
  return {
    source,
    peer,
    close: async () => {
      source.destroy();
      peer.destroy();
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function onceData(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once("data", (chunk: Buffer) => resolve(Buffer.from(chunk)));
    socket.once("error", reject);
  });
}

async function waitUntilMissing(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path} removal`);
}

function bridgeOwnerUid(): number {
  const uid = process.getuid?.() ?? 1_000;
  return uid === 0 ? 1_000 : uid;
}

function bridgeOwnerGid(): number {
  const gid = process.getgid?.() ?? 1_000;
  return gid === 0 ? 1_000 : gid;
}
