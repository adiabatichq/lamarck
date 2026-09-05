import { createConnection } from "node:net";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { openWorkloadAppCliBridge } from "../src/app-edit/guest-bridge";
import { hashAppEditPackage } from "../src/app-edit/snapshot";
import {
  MANAGED_CLI_OPERATIONS,
  encodeCliFrame,
  parseCliCapabilities,
  parseCliFrame,
  parseCliRequest,
  type CliRequest,
  type CliResponse,
  CliStreamReader,
  readCliResponse,
  writeCliBytes,
} from "@lamarck/cli";

interface EditBase {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly version: string | null;
  readonly packageDigest: `sha256:${string}`;
  readonly lowerPath: string;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("preinitializes every App, keeps reads pure, and reconciles clean, dirty, created, and archived workspaces", async () => {
  const fixture = await workspaceFixture();
  const exampleA = await lower(fixture.lowerRoot, "example", "a".repeat(40), "host A\n");
  const otherA = await lower(fixture.lowerRoot, "other", "1".repeat(40), "other A\n");
  const exampleB = await lower(fixture.lowerRoot, "example", "b".repeat(40), "host B\n");
  const exampleC = await lower(fixture.lowerRoot, "example", "c".repeat(40), "other Capsule C\n");
  const exampleD = await lower(fixture.lowerRoot, "example", "d".repeat(40), "host D\n");
  let canonical = exampleA;
  let visible = [exampleA, otherA];
  const host = startHost(fixture.pair.server, visible, async (request) => {
    if (request.operation === "app.list") return success(request, visible.map(appShape));
    if (request.operation === "app.inspect") {
      const appId = (request as CliRequest<"app.inspect">).input.appId;
      const base = visible.find((item) => item.appId === appId);
      return base ? success(request, appShape(base)) : failure(request, "APP_NOT_FOUND", `App not found: ${appId}`);
    }
    if (request.operation === "app.refresh") {
      return success(request, {
        result: { id: canonical.appId, refreshed: true },
        editBase: canonical,
      });
    }
    if (request.operation === "app.save") {
      return failure(request, "APP_VERSION_CONFLICT", "The Host App changed after this Capsule workspace was created");
    }
    return success(request, {});
  });
  const bridge = await openBridge(fixture);
  try {
    // Initialization completes before the local CLI socket is published.
    expect(await readFile(join(fixture.editRoot, "example", "manifest.json"), "utf8")).toBe("host A\n");
    expect(await readFile(join(fixture.editRoot, "other", "manifest.json"), "utf8")).toBe("other A\n");
    const beforeMembers = await readdir(fixture.editRoot);

    const listed = await invoke(fixture.socketPath, {
      requestId: "list-1", operation: "app.list", input: {},
    });
    const inspected = await invoke(fixture.socketPath, {
      requestId: "inspect-1", operation: "app.inspect", input: { appId: "example" },
    });
    expect(listed).toMatchObject({ ok: true, result: [{ id: "example" }, { id: "other" }] });
    expect(inspected).toMatchObject({ ok: true, result: { id: "example", path: "/mnt/lamarck-apps/example" } });
    expect(await readdir(fixture.editRoot)).toEqual(beforeMembers);
    expect(await readFile(join(fixture.editRoot, "example", "manifest.json"), "utf8")).toBe("host A\n");

    // Host editing and another Capsule save both fast-forward a clean tree.
    canonical = exampleB;
    visible = [exampleB, otherA];
    await host.push(visible, true);
    await vi.waitFor(async () => expect(await readFile(
      join(fixture.editRoot, "example", "manifest.json"), "utf8",
    )).toBe("host B\n"));
    canonical = exampleC;
    visible = [exampleC, otherA];
    await host.push([exampleC], false);
    await vi.waitFor(async () => expect(await readFile(
      join(fixture.editRoot, "example", "manifest.json"), "utf8",
    )).toBe("other Capsule C\n"));

    // Dirty state keeps its old base and therefore conflicts on save.
    await writeFile(join(fixture.editRoot, "example", "manifest.json"), "private dirty\n");
    canonical = exampleD;
    visible = [exampleD, otherA];
    await host.push([exampleD], false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readFile(join(fixture.editRoot, "example", "manifest.json"), "utf8")).toBe("private dirty\n");
    const conflicted = await invoke(fixture.socketPath, {
      requestId: "save-conflict", operation: "app.save", input: { appId: "example" },
    });
    expect(conflicted).toMatchObject({ ok: false, error: { code: "APP_VERSION_CONFLICT" } });
    expect((host.requests.at(-1) as CliRequest<"app.save">).upload).toMatchObject({
      baseVersion: exampleC.version,
      basePackageDigest: exampleC.packageDigest,
    });

    // Refresh is the explicit destructive adoption path.
    const refreshed = await invoke(fixture.socketPath, {
      requestId: "refresh-1", operation: "app.refresh", input: { appId: "example" },
    });
    expect(refreshed).toMatchObject({ ok: true, result: { id: "example", refreshed: true } });
    expect(await readFile(join(fixture.editRoot, "example", "manifest.json"), "utf8")).toBe("host D\n");

    const created = await lower(fixture.lowerRoot, "new.app", null, "new App\n");
    visible = [exampleD, otherA, created];
    await host.push(visible, true);
    await vi.waitFor(async () => expect(await readFile(
      join(fixture.editRoot, "new.app", "manifest.json"), "utf8",
    )).toBe("new App\n"));
    visible = [exampleD];
    await host.push(visible, true);
    await vi.waitFor(async () => {
      await expect(access(join(fixture.editRoot, "other"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(fixture.editRoot, "new.app"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  } finally {
    await bridge.close();
    await host.close();
  }
});

test("managed save advances only base metadata and preserves edits made after its snapshot", async () => {
  const fixture = await workspaceFixture();
  const initial = await lower(fixture.lowerRoot, "example", "a".repeat(40), "host A\n");
  const committed = await lower(fixture.lowerRoot, "example", "b".repeat(40), "snapshot A\n");
  let saveCount = 0;
  let uploadReceived!: () => void;
  let releaseSave!: () => void;
  const uploaded = new Promise<void>((resolve) => { uploadReceived = resolve; });
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const host = startHost(fixture.pair.server, [initial], async (request) => {
    if (request.operation !== "app.save") return success(request, appShape(initial));
    saveCount += 1;
    if (saveCount === 1) {
      uploadReceived();
      await saveGate;
      return success(request, {
        result: { version: committed.version, created: true },
        editBase: committed,
      });
    }
    return failure(request, "APP_VERSION_CONFLICT", "fixture stop");
  });
  const bridge = await openBridge(fixture);
  try {
    await writeFile(join(fixture.editRoot, "example", "manifest.json"), "snapshot A\n");
    const saving = invoke(fixture.socketPath, {
      requestId: "save-1", operation: "app.save", input: { appId: "example" },
    });
    await uploaded;
    await writeFile(join(fixture.editRoot, "example", "manifest.json"), "later B\n");
    releaseSave();
    await expect(saving).resolves.toMatchObject({
      ok: true,
      result: { version: committed.version, created: true },
    });
    expect(await readFile(join(fixture.editRoot, "example", "manifest.json"), "utf8")).toBe("later B\n");
    expect(host.requests.map((request) => request.operation)).toEqual(["app.save"]);

    await invoke(fixture.socketPath, {
      requestId: "save-2", operation: "app.save", input: { appId: "example" },
    });
    const second = host.requests[1] as CliRequest<"app.save">;
    expect(second.upload).toMatchObject({
      baseVersion: committed.version,
      basePackageDigest: committed.packageDigest,
    });
    expect(host.requests.some((request) => request.operation === "app.inspect")).toBe(false);
  } finally {
    releaseSave();
    await bridge.close();
    await host.close();
  }
});

test("skips a missing incremental lower, cleans staging, and accepts the next current lower", async () => {
  const fixture = await workspaceFixture();
  const initial = await lower(fixture.lowerRoot, "example", "a".repeat(40), "host A\n");
  const superseded = await lower(fixture.lowerRoot, "example", "b".repeat(40), "host B\n");
  const current = await lower(fixture.lowerRoot, "example", "c".repeat(40), "host C\n");
  await rm(join(fixture.lowerRoot, ...superseded.lowerPath.split("/")), {
    recursive: true,
    force: true,
  });
  const host = startHost(fixture.pair.server, [initial], async (request) => success(request, {}));
  const bridge = await openBridge(fixture);
  try {
    await host.push([superseded], false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await readFile(join(fixture.editRoot, "example", "manifest.json"), "utf8"))
      .toBe("host A\n");
    expect((await readdir(fixture.editRoot)).filter((name) => name.startsWith(".materialize-")))
      .toEqual([]);

    await host.push([current], false);
    await vi.waitFor(async () => expect(await readFile(
      join(fixture.editRoot, "example", "manifest.json"), "utf8",
    )).toBe("host C\n"));
    expect((await readdir(fixture.editRoot)).filter((name) => name.startsWith(".materialize-")))
      .toEqual([]);
  } finally {
    await bridge.close();
    await host.close();
  }
});

test("missing preinitialized workspace fails save internally without inspecting or rematerializing", async () => {
  const fixture = await workspaceFixture();
  const initial = await lower(fixture.lowerRoot, "example", null, "host\n");
  const host = startHost(fixture.pair.server, [initial], async (request) => success(request, {}));
  const bridge = await openBridge(fixture);
  try {
    await rm(join(fixture.editRoot, "example"), { recursive: true, force: true });
    const response = await invoke(fixture.socketPath, {
      requestId: "save-missing", operation: "app.save", input: { appId: "example" },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "CLI_INTERNAL" } });
    expect(host.requests).toEqual([]);
    await expect(access(join(fixture.editRoot, "example"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await bridge.close();
    await host.close();
  }
});

test("preinitializes dotted, numeric-leading, and one-character canonical App ids", async () => {
  const fixture = await workspaceFixture();
  const bases = await Promise.all(["market.place", "7zip", "x"].map((id) =>
    lower(fixture.lowerRoot, id, null, `${id}\n`)));
  const host = startHost(fixture.pair.server, bases, async (request) =>
    success(request, bases.map(appShape)));
  const bridge = await openBridge(fixture);
  try {
    for (const base of bases) {
      expect(await readFile(join(fixture.editRoot, base.appId, "manifest.json"), "utf8"))
        .toBe(`${base.appId}\n`);
    }
  } finally {
    await bridge.close();
    await host.close();
  }
});

async function workspaceFixture() {
  const root = await mkdtemp("/tmp/lamarck-app-cli-bridge-");
  roots.push(root);
  const lowerRoot = join(root, "lower");
  const editRoot = join(root, "edits");
  const bridgeRoot = join(root, "bridge");
  await mkdir(bridgeRoot, { recursive: true });
  return {
    lowerRoot,
    editRoot,
    socketPath: join(bridgeRoot, "cli.sock"),
    pair: duplexPair(),
  };
}

async function openBridge(fixture: Awaited<ReturnType<typeof workspaceFixture>>) {
  return openWorkloadAppCliBridge({
    socketPath: fixture.socketPath,
    upstream: fixture.pair.client,
    editRoot: fixture.editRoot,
    lowerRoot: fixture.lowerRoot,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
}

async function lower(
  lowerRoot: string,
  appId: string,
  version: string | null,
  contents: string,
): Promise<EditBase> {
  const key = version ?? `draft-${Buffer.from(contents).toString("hex")}`;
  const path = join(lowerRoot, appId, key);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "manifest.json"), contents);
  return Object.freeze({
    schemaVersion: 1,
    appId,
    version,
    packageDigest: await hashAppEditPackage(path),
    lowerPath: `${appId}/${key}`,
  });
}

function appShape(base: EditBase) {
  return {
    id: base.appId,
    name: base.appId,
    description: `${base.appId} App`,
    path: `/mnt/lamarck-apps/${base.appId}`,
    lifecycle: {
      version: base.version,
      hasUnrecordedChanges: false,
      manifestHealth: "valid",
      versionHealth: base.version === null ? "unversioned" : "healthy",
    },
    runtime: { running: false },
  };
}

function startHost(
  stream: Duplex,
  initial: readonly EditBase[],
  handler: (request: CliRequest, upload?: Buffer) => Promise<CliResponse>,
) {
  const reader = new CliStreamReader(stream);
  const requests: CliRequest[] = [];
  let writeTail = Promise.resolve();
  let closing = false;
  const write = (value: unknown) => {
    const operation = writeTail.then(() => writeCliBytes(stream, encodeCliFrame(value)));
    writeTail = operation.catch(() => {});
    return operation;
  };
  const push = (editBases: readonly EditBase[], complete: boolean) => write({
    type: "app-workspaces.sync",
    schemaVersion: 1,
    complete,
    editBases,
  });
  const run = (async () => {
    await write({ protocolVersion: 1, environment: "managed", supportedOperations: MANAGED_CLI_OPERATIONS });
    await push(initial, true);
    while (!closing && !stream.destroyed) {
      const request = parseCliRequest(parseCliFrame(await reader.readFrame()), true);
      requests.push(request);
      const upload = request.upload?.kind === "app-package"
        ? await reader.readExact(request.upload.archiveBytes)
        : request.upload?.kind === "file-stdin"
          ? await reader.readExact(request.upload.bytes)
          : undefined;
      await write(await handler(request, upload));
    }
  })();
  return {
    requests,
    push,
    close: async () => {
      closing = true;
      stream.destroy();
      await run.catch(() => {});
    },
  };
}

async function invoke(socketPath: string, request: CliRequest): Promise<CliResponse> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const reader = new CliStreamReader(socket);
  parseCliCapabilities(parseCliFrame(await reader.readFrame()), "managed");
  await writeCliBytes(socket, encodeCliFrame(request));
  const response = await readCliResponse(reader, request.operation, request.requestId);
  socket.end();
  return response;
}

function success(request: CliRequest, result: unknown): CliResponse {
  return { requestId: request.requestId, ok: true, result } as CliResponse;
}

function failure(request: CliRequest, code: string, message: string): CliResponse {
  return { requestId: request.requestId, ok: false, error: { code, message } } as CliResponse;
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
