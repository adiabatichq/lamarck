import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Duplex, PassThrough, Readable } from "node:stream";
import { expect, test, vi } from "vitest";
import {
  MANAGED_CLI_OPERATIONS,
  ManagedCliTransport,
  encodeCliFrame,
  parseCliCapabilities,
  parseCliFrame,
  parseCliResponse,
  readCliResponse,
  runCli,
  type CliIo,
  type CliRequest,
  type CliResponse,
  CliStreamReader,
  writeCliBytes,
} from "@lamarck/cli";
import { openWorkloadAppCliBridge } from "../../../capsule/src/app-edit/guest-bridge";
import { hashAppEditPackage } from "../../../capsule/src/app-edit/snapshot";
import { CliOperationDispatcher, type ManagedCliIdentity } from "../cli-dispatcher";
import { AppCliStreamServer } from "./app-cli-broker";

const DIGEST = `sha256:${"a".repeat(64)}` as const;
const ARCHIVE = `sha256:${"b".repeat(64)}` as const;

test("binds every managed request to the launch identity and maps App paths privately", async () => {
  const dispatched: Array<{ request: CliRequest; context: unknown }> = [];
  const dispatcher = fakeDispatcher(async (request, context) => {
    dispatched.push({ request, context });
    return success(request, [{ id: "example", name: "Example", version: null }]);
  });
  const pair = duplexPair();
  const detach = new AppCliStreamServer({
    dispatcher: () => dispatcher,
  }).attach(identity(), pair.server);
  const response = await invoke(pair.client, {
    requestId: "request-1",
    operation: "app.list",
    input: {},
  });
  detach();

  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(response.error.message);
  expect(response.result).toEqual([{
    id: "example",
    name: "Example",
    path: "/mnt/lamarck-apps/example",
    version: null,
  }]);
  expect(dispatched).toEqual([{
    request: { requestId: "request-1", operation: "app.list", input: {} },
    context: { environment: "managed", principal: identity() },
  }]);
  expect(JSON.stringify(response)).not.toContain("host-secret");
});

test("forwards common lifecycle operations through the shared dispatcher", async () => {
  const records = [{ appId: "example", version: "a".repeat(40), parentVersion: null, trigger: "save", createdAt: 2 }];
  const dispatcher = fakeDispatcher(async (request) => success(request, records));
  const pair = duplexPair();
  const detach = new AppCliStreamServer({
    dispatcher: () => dispatcher,
  }).attach(identity(), pair.server);
  const response = await invoke(pair.client, {
    requestId: "request-2",
    operation: "app.versions",
    input: { appId: "example" },
  });
  detach();

  expect(response).toEqual({ requestId: "request-2", ok: true, result: records });
});

test("streams a complete App save upload with the bound principal", async () => {
  const archive = Buffer.alloc(256 * 1024, 0x61);
  let received = Buffer.alloc(0);
  let metadata: Record<string, unknown> | undefined;
  let principal: unknown;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/apps/edit-bases")) {
      return Response.json({ editBases: [base()] });
    }
    if (url.endsWith("/edit-package")) {
      metadata = JSON.parse(Buffer.from(new Headers(init?.headers).get("x-lamarck-app-edit-v1")!, "base64url").toString("utf8"));
      principal = JSON.parse(Buffer.from(new Headers(init?.headers).get("x-lamarck-cli-principal")!, "base64url").toString("utf8"));
      const chunks: Buffer[] = [];
      for await (const chunk of init!.body as unknown as Readable) chunks.push(Buffer.from(chunk));
      received = Buffer.concat(chunks);
      return Response.json({
        result: { version: "c".repeat(40), created: true },
        editBase: { ...base(), version: "c".repeat(40) },
      });
    }
    return Response.json({ editBase: { ...base(), version: "c".repeat(40) } });
  });
  const pair = duplexPair();
  const dispatcher = new CliOperationDispatcher({
    coreBaseUrl: "http://127.0.0.1:3000",
    coreToken: "host-secret",
    fetch: fetchImpl,
    runtimeStates: () => [],
  });
  const broker = new AppCliStreamServer({
    dispatcher: () => dispatcher,
  });
  const detach = broker.attach(identity(), pair.server);
  const request: CliRequest<"app.save"> = {
    requestId: "request-7",
    operation: "app.save",
    input: { appId: "example", message: "Save from Capsule" },
    upload: {
      kind: "app-package",
      archiveDigest: ARCHIVE,
      archiveBytes: archive.byteLength,
      baseVersion: null,
      basePackageDigest: DIGEST,
    },
  };
  const reader = new CliStreamReader(pair.client);
  parseCliCapabilities(parseCliFrame(await reader.readFrame()), "managed");
  expect(parseCliFrame(await reader.readFrame())).toMatchObject({
    type: "app-workspaces.sync",
    complete: true,
  });
  await writeCliBytes(pair.client, encodeCliFrame(request));
  for (let offset = 0; offset < archive.byteLength; offset += 17 * 1024) {
    await writeCliBytes(pair.client, archive.subarray(offset, offset + 17 * 1024));
  }
  const response = parseCliResponse(parseCliFrame(await reader.readFrame()), request.requestId);
  detach();

  expect(response).toMatchObject({ ok: true, requestId: "request-7" });
  expect(received.equals(archive)).toBe(true);
  expect(metadata).toMatchObject({
    schemaVersion: 1,
    baseVersion: null,
    basePackageDigest: DIGEST,
    archiveDigest: ARCHIVE,
    archiveBytes: archive.byteLength,
    message: "Save from Capsule",
  });
  expect(principal).toEqual(identity());
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
    "http://127.0.0.1:3000/api/apps/edit-bases",
    "http://127.0.0.1:3000/api/apps/example/edit-package",
  ]);
});

test("streams managed file stdin and native output outside control frames", async () => {
  const stdin = Buffer.alloc(256 * 1024, 0xa5);
  const stdout = Buffer.from([0, 255, 1, 254]);
  let dispatched: CliRequest | undefined;
  const dispatcher = fakeDispatcher(async (request) => {
    dispatched = request;
    return success(request, {
      success: true,
      exitCode: 0,
      stdoutBase64: stdout.toString("base64"),
      stderrBase64: "",
    });
  });
  const pair = duplexPair();
  const detach = new AppCliStreamServer({
    dispatcher: () => dispatcher,
  }).attach(identity(), pair.server);
  const request = {
    requestId: "file-1",
    operation: "file.command",
    input: { argv: ["tee", "blob.bin"] },
    upload: { kind: "file-stdin", bytes: stdin.byteLength },
  } as const;
  const reader = new CliStreamReader(pair.client);
  parseCliCapabilities(parseCliFrame(await reader.readFrame()), "managed");
  expect(parseCliFrame(await reader.readFrame())).toMatchObject({
    type: "app-workspaces.sync",
    complete: true,
  });
  await writeCliBytes(pair.client, encodeCliFrame(request));
  await writeCliBytes(pair.client, stdin);
  const response = await readCliResponse(reader, request.operation, request.requestId);
  detach();

  expect(dispatched).toMatchObject({
    requestId: "file-1",
    operation: "file.command",
    input: { argv: ["tee", "blob.bin"], stdinBase64: stdin.toString("base64") },
  });
  expect(response).toEqual({
    requestId: "file-1",
    ok: true,
    result: { success: true, exitCode: 0, stdoutBase64: stdout.toString("base64"), stderrBase64: "" },
  });
});

test("carries a large schema change in the normal typed control request", async () => {
  const ddl = `CREATE TABLE notes(id TEXT PRIMARY KEY);\n${"-- context\n".repeat(20_000)}`;
  let dispatched: CliRequest | undefined;
  const dispatcher = fakeDispatcher(async (request) => {
    dispatched = request;
    return success(request, { id: "schema-1", status: "pending" });
  });
  const pair = duplexPair();
  const detach = new AppCliStreamServer({ dispatcher: () => dispatcher }).attach(identity(), pair.server);
  const response = await invoke(pair.client, {
    requestId: "schema-1",
    operation: "schema.change",
    input: { ddl },
  });
  detach();

  expect(response).toMatchObject({ ok: true, result: { id: "schema-1", status: "pending" } });
  expect(dispatched).toEqual({ requestId: "schema-1", operation: "schema.change", input: { ddl } });
});

test("keeps idle sessions passive and debounces one App without overwriting local edits", async () => {
  const root = await mkdtemp("/tmp/lc-sync-");
  const lowerRoot = join(root, "lower");
  const editRoot = join(root, "edits");
  const bridgeRoot = join(root, "bridge");
  const appsRoot = join(root, "apps");
  await mkdir(join(appsRoot, "example"), { recursive: true });
  await mkdir(join(appsRoot, "other"), { recursive: true });
  await mkdir(bridgeRoot, { recursive: true });
  const first = await workspaceBase(lowerRoot, "a".repeat(40), "first\n");
  const second = await workspaceBase(lowerRoot, "b".repeat(40), "second\n");
  const other = await workspaceBase(lowerRoot, "c".repeat(40), "other\n", "other");
  let current = [first, other];
  let fullBaseReads = 0;
  const targetedBaseReads: string[] = [];
  const dispatcher = fakeDispatcher();
  dispatcher.managedAppEditBases = async () => {
    fullBaseReads += 1;
    return current;
  };
  dispatcher.managedAppEditBase = async (appId) => {
    targetedBaseReads.push(appId);
    return current.find((item) => item.appId === appId)!;
  };
  const watched = fakeWatchFactory();
  const pair = duplexPair();
  const broker = new AppCliStreamServer({
    dispatcher: () => dispatcher,
    appsRoot,
    watch: watched.factory,
    watchDebounceMs: 20,
  });
  const detach = broker.attach(identity(), pair.server);
  const bridge = await openWorkloadAppCliBridge({
    socketPath: join(bridgeRoot, "cli.sock"),
    upstream: pair.client,
    editRoot,
    lowerRoot,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  try {
    expect(await readFile(join(editRoot, "example", "manifest.json"), "utf8")).toBe("first\n");
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(fullBaseReads).toBe(1);
    expect(targetedBaseReads).toEqual([]);

    await writeFile(join(editRoot, "example", "manifest.json"), "local dirty\n");
    current = [second, other];
    for (let index = 0; index < 6; index += 1) {
      watched.current().notify("change", "example/index.ts");
    }
    watched.current().notify("change", "example/.git/index");
    await vi.waitFor(() => expect(targetedBaseReads).toEqual(["example"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fullBaseReads).toBe(1);
    expect(targetedBaseReads).toEqual(["example"]);
    expect(await readFile(join(editRoot, "example", "manifest.json"), "utf8"))
      .toBe("local dirty\n");
    expect(await readFile(join(editRoot, "other", "manifest.json"), "utf8"))
      .toBe("other\n");
  } finally {
    await bridge.close();
    detach();
    await rm(root, { recursive: true, force: true });
  }
});

test("uses full inventory for create/archive notifications and stops the shared watcher", async () => {
  const root = await mkdtemp("/tmp/lc-sync-membership-");
  const lowerRoot = join(root, "lower");
  const editRoot = join(root, "edits");
  const bridgeRoot = join(root, "bridge");
  const appsRoot = join(root, "apps");
  await mkdir(appsRoot, { recursive: true });
  await mkdir(bridgeRoot, { recursive: true });
  const initial = await workspaceBase(lowerRoot, "a".repeat(40), "ready\n");
  const created = await workspaceBase(lowerRoot, null, "created\n", "new.app");
  let current = [initial];
  let fullBaseReads = 0;
  const dispatcher = fakeDispatcher();
  dispatcher.managedAppEditBases = async () => {
    fullBaseReads += 1;
    return current;
  };
  const watched = fakeWatchFactory();
  const pair = duplexPair();
  const detach = new AppCliStreamServer({
    dispatcher: () => dispatcher,
    appsRoot,
    watch: watched.factory,
    watchDebounceMs: 20,
  })
    .attach(identity(), pair.server);
  const bridge = await openWorkloadAppCliBridge({
    socketPath: join(bridgeRoot, "cli.sock"),
    upstream: pair.client,
    editRoot,
    lowerRoot,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  try {
    expect(await readFile(join(editRoot, "example", "manifest.json"), "utf8")).toBe("ready\n");
    current = [initial, created];
    watched.current().notify("rename", "new.app");
    await vi.waitFor(async () => expect(await readFile(
      join(editRoot, "new.app", "manifest.json"), "utf8",
    )).toBe("created\n"));
    expect(fullBaseReads).toBe(2);

    current = [initial];
    watched.current().notify("rename", "new.app");
    await vi.waitFor(async () => expect(access(join(editRoot, "new.app")))
      .rejects.toMatchObject({ code: "ENOENT" }));
    expect(fullBaseReads).toBe(3);
  } finally {
    await bridge.close();
    detach();
    expect(watched.watchers.every((watcher) => watcher.closed)).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("watcher failure preserves the editing workspace and CLI bridge while retrying", async () => {
  const root = await mkdtemp("/tmp/lc-sync-watch-failure-");
  const lowerRoot = join(root, "lower");
  const editRoot = join(root, "edits");
  const bridgeRoot = join(root, "bridge");
  const appsRoot = join(root, "apps");
  await mkdir(appsRoot, { recursive: true });
  await mkdir(bridgeRoot, { recursive: true });
  const initial = await workspaceBase(lowerRoot, "a".repeat(40), "ready\n");
  const dispatcher = fakeDispatcher(async (request) => request.operation === "app.list"
    ? success(request, [{ id: "example", name: "Example" }])
    : success(request, {}));
  dispatcher.managedAppEditBases = async () => [initial];
  const watched = fakeWatchFactory();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const pair = duplexPair();
  const broker = new AppCliStreamServer({
    dispatcher: () => dispatcher,
    appsRoot,
    watch: watched.factory,
    watchRetryMs: 10,
  });
  const detach = broker.attach(identity(), pair.server);
  const socketPath = join(bridgeRoot, "cli.sock");
  const bridge = await openWorkloadAppCliBridge({
    socketPath,
    upstream: pair.client,
    editRoot,
    lowerRoot,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  try {
    watched.current().fail(new Error("watch failed"));
    await vi.waitFor(() => expect(watched.watchers).toHaveLength(2));
    expect(await readFile(join(editRoot, "example", "manifest.json"), "utf8")).toBe("ready\n");
    const transport = new ManagedCliTransport(socketPath);
    await expect(transport.execute({
      requestId: "list-after-watch-failure",
      operation: "app.list",
      input: {},
    })).resolves.toMatchObject({ ok: true, result: [{ id: "example" }] });
    transport.close();
    expect(warning).toHaveBeenCalledWith(
      "[cli] App workspace watcher failed; retrying:",
      expect.objectContaining({ message: "watch failed" }),
    );
  } finally {
    warning.mockRestore();
    await bridge.close();
    detach();
    await rm(root, { recursive: true, force: true });
  }
});

test("uses a fresh Guest local socket for consecutive operations on one ManagedTransport", async () => {
  const calls: string[] = [];
  await withGuestBridge(async (request) => {
    calls.push(request.operation);
    return success(request, { sourceId: "source-a", lifecycle: request.operation === "source.pause" ? "paused" : "active" });
  }, async (socketPath) => {
    const transport = new ManagedCliTransport(socketPath);
    try {
      await expect(transport.execute({ requestId: "pause-1", operation: "source.pause", input: { sourceId: "source-a" } }))
        .resolves.toMatchObject({ ok: true });
      await expect(transport.execute({ requestId: "resume-1", operation: "source.resume", input: { sourceId: "source-a" } }))
        .resolves.toMatchObject({ ok: true });
    } finally {
      transport.close();
    }
  });
  expect(calls).toEqual(["source.pause", "source.resume"]);
});

test("runs source run --wait status polling through Guest socket, bridge, and Host broker", async () => {
  const calls: string[] = [];
  let statusCalls = 0;
  await withGuestBridge(async (request) => {
    calls.push(request.operation);
    if (request.operation === "source.run") {
      return success(request, { sourceId: "source-a", runId: "run-a", status: "accepted" });
    }
    statusCalls += 1;
    return success(request, statusCalls === 1
      ? { sourceId: "source-a", runId: "run-a", status: "running", startedAt: 1 }
      : { sourceId: "source-a", runId: "run-a", status: "success", outcome: "success", startedAt: 1, endedAt: 2 });
  }, async (socketPath) => {
    const output = cliIo(false);
    expect(await runCli({
      environment: "managed",
      argv: ["source", "run", "source-a", "--wait", "--json"],
      transport: new ManagedCliTransport(socketPath),
      io: output.value,
    })).toBe(0);
    expect(JSON.parse(output.stdout())).toMatchObject({ runId: "run-a", outcome: "success" });
  });
  expect(calls).toEqual(["source.run", "source.run.status", "source.run.status"]);
});

test("inspects and confirms through one ManagedTransport before archive mutation", async () => {
  const calls: string[] = [];
  await withGuestBridge(async (request) => {
    calls.push(request.operation);
    return request.operation === "app.inspect"
      ? success(request, { id: "example", name: "Example" })
      : success(request, { id: "example", archived: true });
  }, async (socketPath) => {
    const output = cliIo(true, "yes\n");
    expect(await runCli({
      environment: "managed",
      argv: ["app", "archive", "example"],
      transport: new ManagedCliTransport(socketPath),
      io: output.value,
    })).toBe(0);
    expect(output.stdout()).toContain("running Capsules will terminate immediately");
  });
  expect(calls).toEqual(["app.inspect", "app.archive"]);
});

test("allows self-archive teardown to end the stream before a final response", async () => {
  const events: string[] = [];
  const pair = duplexPair();
  const dispatcher = fakeDispatcher(async (request) => {
    events.push("archived");
    pair.server.destroy();
    return success(request, { id: "initiator", archived: true });
  });
  const detach = new AppCliStreamServer({
    dispatcher: () => dispatcher,
  }).attach(identity(), pair.server);
  await expect(invoke(pair.client, {
    requestId: "archive-1",
    operation: "app.archive",
    input: { appId: "initiator" },
  })).rejects.toThrow();
  expect(events).toEqual(["archived"]);
  detach();
});

async function invoke(client: Duplex, request: CliRequest) {
  const reader = new CliStreamReader(client);
  parseCliCapabilities(parseCliFrame(await reader.readFrame()), "managed");
  expect(parseCliFrame(await reader.readFrame())).toMatchObject({
    type: "app-workspaces.sync",
    complete: true,
  });
  await writeCliBytes(client, encodeCliFrame(request));
  return parseCliResponse(parseCliFrame(await reader.readFrame()), request.requestId);
}

function identity(): ManagedCliIdentity {
  return {
    kind: "app",
    appId: "initiator",
    workload: "ui",
    appCommit: "d".repeat(40),
    writeTables: ["app_initiator_notes"],
    fileGrants: ["/data/app/initiator"],
    workloadHandle: "workload_123",
  };
}

function base() {
  return {
    schemaVersion: 1 as const,
    appId: "example",
    version: null,
    packageDigest: DIGEST,
    lowerPath: `example/draft-${"a".repeat(64)}`,
  };
}

async function workspaceBase(
  lowerRoot: string,
  version: string | null,
  contents: string,
  appId = "example",
) {
  const key = version ?? `draft-${Buffer.from(contents).toString("hex")}`;
  const lowerPath = `${appId}/${key}`;
  const path = join(lowerRoot, lowerPath);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "manifest.json"), contents);
  return {
    schemaVersion: 1 as const,
    appId,
    version,
    packageDigest: await hashAppEditPackage(path),
    lowerPath,
  };
}

function fakeDispatcher(
  dispatch: (request: CliRequest, context: unknown) => Promise<{ response: CliResponse }> = async (request) => success(request, {}),
): CliOperationDispatcher {
  return {
    capabilities: () => ({ protocolVersion: 1, environment: "managed", supportedOperations: MANAGED_CLI_OPERATIONS }),
    dispatch,
    managedAppEditBase: async () => base(),
    managedAppEditBases: async () => [base()],
  } as unknown as CliOperationDispatcher;
}

class FakePassiveWatcher {
  closed = false;
  private errorListener: ((error: Error) => void) | undefined;

  constructor(private readonly listener: (
    event: string,
    filename: string | Buffer | null,
  ) => void) {}

  notify(event: string, filename: string | Buffer | null): void {
    this.listener(event, filename);
  }

  fail(error: Error): void {
    this.errorListener?.(error);
  }

  on(_event: "error", listener: (error: Error) => void): this {
    this.errorListener = listener;
    return this;
  }

  unref(): this { return this; }

  close(): void { this.closed = true; }
}

function fakeWatchFactory() {
  const watchers: FakePassiveWatcher[] = [];
  return {
    watchers,
    factory: (
      _path: string,
      _options: { recursive: true },
      listener: (event: string, filename: string | Buffer | null) => void,
    ) => {
      const watcher = new FakePassiveWatcher(listener);
      watchers.push(watcher);
      return watcher;
    },
    current: () => watchers.at(-1)!,
  };
}

function success(request: CliRequest, result: unknown): { response: CliResponse } {
  return { response: { requestId: request.requestId, ok: true, result } as CliResponse };
}

async function withGuestBridge(
  dispatch: (request: CliRequest, context: unknown) => Promise<{ response: CliResponse }>,
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp("/tmp/lc-");
  const lowerRoot = join(root, "lower");
  const editRoot = join(root, "edits");
  const bridgeRoot = join(root, "bridge");
  const lowerPath = base().lowerPath;
  await mkdir(join(lowerRoot, lowerPath), { recursive: true });
  await mkdir(bridgeRoot, { recursive: true });
  await writeFile(join(lowerRoot, lowerPath, "manifest.json"), "{}\n");
  const pair = duplexPair();
  const detach = new AppCliStreamServer({
    dispatcher: () => fakeDispatcher(dispatch),
  }).attach(identity(), pair.server);
  const socketPath = join(bridgeRoot, "cli.sock");
  const bridge = await openWorkloadAppCliBridge({
    socketPath,
    upstream: pair.client,
    editRoot,
    lowerRoot,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  try {
    await run(socketPath);
  } finally {
    await bridge.close();
    detach();
    await rm(root, { recursive: true, force: true });
  }
}

function cliIo(tty: boolean, input = "") {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdin, { isTTY: tty });
  Object.assign(stdout, { isTTY: tty });
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => { out += chunk.toString(); });
  stderr.on("data", (chunk) => { err += chunk.toString(); });
  stdin.end(input);
  return {
    value: { stdin, stdout, stderr } as CliIo,
    stdout: () => out,
    stderr: () => err,
  };
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
  _final(callback: (error?: Error | null) => void): void {
    this.peer.push(null);
    callback();
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.push(null);
    if (!this.peer.destroyed) this.peer.push(null);
    callback(error);
  }
}
