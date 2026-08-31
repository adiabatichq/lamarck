import { createConnection } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { openWorkloadAppCliBridge } from "../src/app-edit/guest-bridge";
import {
  encodeAppCliFrame,
  parseAppCliRequest,
  parseAppCliResponse,
  type AppCliRequestV1,
} from "../src/app-edit/protocol";
import { AppCliStreamReader, writeAppCliBytes } from "../src/app-edit/stream";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("keeps edits private, supports short connections, and refreshes from immutable lower", async () => {
  const root = await mkdtemp(join(tmpdir(), "lamarck-app-cli-bridge-"));
  roots.push(root);
  const lowerRoot = join(root, "lower");
  const editRoot = join(root, "edits");
  const bridgeRoot = join(root, "bridge");
  const originalLowerPath = `example/${"a".repeat(40)}`;
  const newerLowerPath = `example/${"c".repeat(40)}`;
  await mkdir(join(lowerRoot, originalLowerPath), { recursive: true });
  await mkdir(join(lowerRoot, newerLowerPath), { recursive: true });
  await mkdir(bridgeRoot);
  await writeFile(join(lowerRoot, originalLowerPath, "manifest.json"), "host\n");
  await writeFile(join(lowerRoot, newerLowerPath, "manifest.json"), "host newer\n");
  const pair = duplexPair();
  const host = serveHost(pair.server, [originalLowerPath, newerLowerPath, newerLowerPath]);
  const bridge = await openWorkloadAppCliBridge({
    socketPath: join(bridgeRoot, "cli.sock"),
    upstream: pair.client,
    editRoot,
    lowerRoot,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  try {
    const listed = await invoke(join(bridgeRoot, "cli.sock"), {
      version: 1,
      requestId: 1,
      operation: "app.list",
      input: {},
    });
    expect(listed.result).toEqual([{
      id: "example",
      name: "Example",
      path: "/mnt/lamarck-apps/example",
      version: "a".repeat(40),
    }]);
    await writeFile(join(editRoot, "example", "manifest.json"), "private edit\n");
    expect(await readFile(join(lowerRoot, originalLowerPath, "manifest.json"), "utf8")).toBe("host\n");

    const listedAgain = await invoke(join(bridgeRoot, "cli.sock"), {
      version: 1,
      requestId: 2,
      operation: "app.list",
      input: {},
    });
    expect(listedAgain.result).toEqual([{
      id: "example",
      name: "Example",
      path: "/mnt/lamarck-apps/example",
      version: "a".repeat(40),
    }]);
    expect(await readFile(join(editRoot, "example", "manifest.json"), "utf8"))
      .toBe("private edit\n");

    const refreshed = await invoke(join(bridgeRoot, "cli.sock"), {
      version: 1,
      requestId: 3,
      operation: "app.refresh",
      input: { appId: "example" },
    });
    expect(refreshed.ok).toBe(true);
    expect(await readFile(join(editRoot, "example", "manifest.json"), "utf8")).toBe("host newer\n");
  } finally {
    await bridge.close();
    await host;
  }
});

test("accepts dotted, numeric-leading, and one-character canonical App ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "lamarck-app-cli-ids-"));
  roots.push(root);
  const lowerRoot = join(root, "lower");
  const editRoot = join(root, "edits");
  const bridgeRoot = join(root, "bridge");
  const ids = ["market.place", "7zip", "x"];
  await mkdir(bridgeRoot, { recursive: true });
  for (const id of ids) {
    await mkdir(join(lowerRoot, id, "draft-base"), { recursive: true });
    await writeFile(join(lowerRoot, id, "draft-base", "manifest.json"), `${id}\n`);
  }
  const pair = duplexPair();
  const host = serveInventoryHost(pair.server, ids);
  const bridge = await openWorkloadAppCliBridge({
    socketPath: join(bridgeRoot, "cli.sock"),
    upstream: pair.client,
    editRoot,
    lowerRoot,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  try {
    const listed = await invoke(join(bridgeRoot, "cli.sock"), {
      version: 1,
      requestId: 1,
      operation: "app.list",
      input: {},
    });
    expect(listed.ok).toBe(true);
    expect((listed.result as Array<{ id: string }>).map((item) => item.id)).toEqual(ids);
    for (const id of ids) {
      expect(await readFile(join(editRoot, id, "manifest.json"), "utf8")).toBe(`${id}\n`);
    }
  } finally {
    await bridge.close();
    await host;
  }
});

async function invoke(socketPath: string, request: AppCliRequestV1) {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const reader = new AppCliStreamReader(socket);
  await writeAppCliBytes(socket, encodeAppCliFrame(request));
  const response = parseAppCliResponse(await reader.readFrame());
  socket.end();
  return response;
}

async function serveHost(stream: Duplex, lowerPaths: readonly string[]): Promise<void> {
  const reader = new AppCliStreamReader(stream);
  for (let count = 0; count < lowerPaths.length; count += 1) {
    const request = parseAppCliRequest(await reader.readFrame(), true);
    const lowerPath = lowerPaths[count]!;
    const version = lowerPath.split("/")[1]!;
    const editBase = {
      schemaVersion: 1 as const,
      appId: "example",
      version,
      packageDigest: `sha256:${"b".repeat(64)}` as const,
      lowerPath,
    };
    await writeAppCliBytes(stream, encodeAppCliFrame({
      version: 1,
      requestId: request.requestId,
      ok: true,
      result: request.operation === "app.list"
        ? [{
            schemaVersion: 1,
            id: "example",
            name: "Example",
            path: "/mnt/lamarck-apps/example",
            version: editBase.version,
            editBase,
          }]
        : { result: { refreshed: true }, editBase },
    }));
  }
}

async function serveInventoryHost(stream: Duplex, ids: readonly string[]): Promise<void> {
  const reader = new AppCliStreamReader(stream);
  const request = parseAppCliRequest(await reader.readFrame(), true);
  await writeAppCliBytes(stream, encodeAppCliFrame({
    version: 1,
    requestId: request.requestId,
    ok: true,
    result: ids.map((id) => {
      const editBase = {
        schemaVersion: 1 as const,
        appId: id,
        version: null,
        packageDigest: `sha256:${"b".repeat(64)}` as const,
        lowerPath: `${id}/draft-base`,
      };
      return {
        schemaVersion: 1,
        id,
        name: id,
        path: `/mnt/lamarck-apps/${id}`,
        version: null,
        editBase,
      };
    }),
  }));
}

function duplexPair(): { client: MemoryDuplex; server: MemoryDuplex } {
  const client = new MemoryDuplex();
  const server = new MemoryDuplex();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

class MemoryDuplex extends Duplex {
  peer!: MemoryDuplex;
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.peer.push(Buffer.from(chunk));
    callback();
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.push(null);
    if (!this.peer.destroyed) this.peer.push(null);
    callback(error);
  }
}
