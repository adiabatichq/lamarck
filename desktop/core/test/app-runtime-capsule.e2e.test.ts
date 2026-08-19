import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Duplex } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SystemBroker } from "../../shell/electron/capsule/system-broker";
import { SystemStreamServer } from "../../shell/electron/capsule/system-stream";
import { createSystem } from "@lamarck/system";
import { FramedRpcClient } from "../../system-sdk/src/node-transport";
import { DATA_SCHEMA } from "../src/data-schema";

const START_TIMEOUT_MS = 15_000;
const CORE_TOKEN = "capsule-core-e2e-host-token";
const GUARD_TOKEN = "capsule-guard-e2e-token";

let testRoot = "";
let workspace = "";
let coreEntry = "";
let guardEntry = "";
let manifestFaultControl = "";
let coreOrigin = "";
let coreProcess: ChildProcess | undefined;
let guardProcess: ChildProcess | undefined;
let coreOutput = "";
let guardOutput = "";

describe.sequential("Capsule System SDK to Core and Guard", () => {
  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "lamarck-capsule-core-e2e-"));
    workspace = join(testRoot, "workspace");
    coreEntry = fileURLToPath(new URL("../dist/core.mjs", import.meta.url));
    guardEntry = fileURLToPath(new URL("../dist/guard-service.cjs", import.meta.url));
    manifestFaultControl = join(testRoot, "manifest-read-fault");
    await Promise.all([
      mkdir(join(workspace, ".lamarck"), { recursive: true }),
      writeAppManifest("app-a", ["app_a_items"]),
      writeAppManifest("app-b", ["app_b_items"]),
    ]);
    seedDataDatabase();

    guardProcess = spawn(process.execPath, [guardEntry, workspace], {
      env: {
        ...process.env,
        LAMARCK_GUARD_TOKEN: GUARD_TOKEN,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    guardOutput = captureOutput(guardProcess);
    const guardPort = await waitForGuardReady(guardProcess);

    const corePort = await reservePort();
    coreOrigin = `http://127.0.0.1:${corePort}`;
    const manifestFaultPreload = fileURLToPath(new URL(
      "../test-node/manifest-read-fault-preload.mjs",
      import.meta.url,
    ));
    coreProcess = spawn(process.execPath, ["--import", manifestFaultPreload, coreEntry, workspace], {
      env: {
        ...process.env,
        LAMARCK_CORE_TOKEN: CORE_TOKEN,
        LAMARCK_GUARD_ORIGIN: `http://127.0.0.1:${guardPort}`,
        LAMARCK_GUARD_TOKEN: GUARD_TOKEN,
        LAMARCK_TEST_MANIFEST_READ_FAULT_CONTROL: manifestFaultControl,
        LAMARCK_TEST_MANIFEST_READ_FAULT_TARGET: join(
          workspace,
          "apps",
          "app-a",
          "manifest.json",
        ),
        HOST: "127.0.0.1",
        PORT: String(corePort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    coreOutput = captureOutput(coreProcess);
    await waitForCore();
  }, 30_000);

  afterAll(async () => {
    await stopProcess(coreProcess);
    await stopProcess(guardProcess);
    if (testRoot) await rm(testRoot, { recursive: true, force: true });
  });

  test("binds two App identities and commits or rolls back D2 audit atomically", async () => {
    const [appA, appB] = await Promise.all([
      issueCapability("app-a"),
      issueCapability("app-b"),
    ]);
    const broker = new SystemBroker({
      coreBaseUrl: coreOrigin,
      revokeCapability: async (channelId) => {
        await hostRequest(`/api/app-runtime/channels/${encodeURIComponent(channelId)}`, {
          method: "DELETE",
        });
      },
    });
    broker.bindSender("workload-a", appA);
    broker.bindSender("workload-b", appB);

    const pairA = duplexPair();
    const pairB = duplexPair();
    const streamServer = new SystemStreamServer(broker, { unbindOnClose: false });
    const detachA = streamServer.attach("workload-a", pairA.server);
    const detachB = streamServer.attach("workload-b", pairB.server);
    const clientA = new FramedRpcClient(pairA.client, { requestTimeoutMs: 10_000 });
    const clientB = new FramedRpcClient(pairB.client, { requestTimeoutMs: 10_000 });
    const systemA = createSystem(clientA.invoke);
    const systemB = createSystem(clientB.invoke);

    try {
      const insertedA = await systemA.mutate(
        "INSERT INTO app_a_items (id, value) VALUES (?, ?)",
        ["a-committed", "from-a"],
      );
      expect(insertedA.changes).toBe(1);
      expect(insertedA.auditEventIds).toHaveLength(1);

      await expect(systemB.mutate(
        "INSERT INTO app_a_items (id, value) VALUES (?, ?)",
        ["b-forged", "forbidden"],
      )).rejects.toThrow(/not authorized|permission|denied|grant/i);

      await expect(systemA.transaction([
        {
          sql: "INSERT INTO app_a_items (id, value) VALUES (?, ?)",
          params: ["a-rolled-back", "must-disappear"],
        },
        {
          sql: "INSERT INTO app_b_items (id, value) VALUES (?, ?)",
          params: ["a-cross-table", "forbidden"],
        },
      ])).rejects.toThrow(/not authorized|permission|denied|grant/i);

      const insertedB = await systemB.mutate(
        "INSERT INTO app_b_items (id, value) VALUES (?, ?)",
        ["b-committed", "from-b"],
      );
      expect(insertedB.auditEventIds).toHaveLength(1);

      await clientA.invoke("writeEvent", {
        type: "capsule.identity.probe",
        startedAt: 1,
        payload: { expected: "app-a" },
        source: "app:app-b:ui",
        appId: "app-b",
      } as never);

      const rowsA = await systemA.query(
        "SELECT id, value FROM app_a_items ORDER BY id",
      );
      expect(rowsA.rows).toEqual([{ id: "a-committed", value: "from-a" }]);
      const rowsB = await systemB.query(
        "SELECT id, value FROM app_b_items ORDER BY id",
      );
      expect(rowsB.rows).toEqual([{ id: "b-committed", value: "from-b" }]);

      const audit = await systemA.query(`
        SELECT source, type, payload
        FROM events
        WHERE source IN ('app:app-a:ui', 'app:app-b:ui')
        ORDER BY created_at, rowid
      `);
      const entries = audit.rows as Array<{ source: string; type: string; payload: string }>;
      const appAAudit = entries.filter((entry) => entry.source === "app:app-a:ui");
      const appBAudit = entries.filter((entry) => entry.source === "app:app-b:ui");
      expect(appAAudit.map(({ type }) => type)).toEqual([
        "workspace.table.rows.inserted",
        "capsule.identity.probe",
      ]);
      expect(appBAudit.map(({ type }) => type)).toEqual(["workspace.table.rows.inserted"]);
      expect(JSON.parse(appAAudit[0]!.payload)).toMatchObject({
        table: "app_a_items",
        affected_rows: 1,
      });
      expect(JSON.parse(appBAudit[0]!.payload)).toMatchObject({
        table: "app_b_items",
        affected_rows: 1,
      });
      expect(entries.some(({ payload }) => payload.includes("a-rolled-back"))).toBe(false);
      expect(entries.some(({ payload }) => payload.includes("b-forged"))).toBe(false);
    } finally {
      clientA.close();
      clientB.close();
      detachA();
      detachB();
      broker.unbindAll();
    }
  }, 30_000);

  test.each(["EIO", "EACCES"] as const)(
    "preserves the prior registry generation and capability when manifest refresh fails with %s",
    async (code) => {
      const existing = await issueCapability("app-a");
      const authority = {
        manifestGeneration: existing.manifestGeneration,
        manifestDigest: existing.manifestDigest,
      };

      try {
        await writeFile(manifestFaultControl, code, "utf8");
        const failedRefresh = await fetch(`${coreOrigin}/api/apps`, {
          headers: { Authorization: `Bearer ${CORE_TOKEN}` },
        });
        expect(failedRefresh.status).toBe(500);
        await expect(failedRefresh.json()).resolves.toEqual({
          error: `injected manifest ${code}`,
        });

        // The failed candidate scan must not retire the generation that was
        // already published or revoke capabilities issued from it.
        expect((await appQuery(existing.capability, "SELECT 1 AS ok")).status).toBe(200);
        await expect(appAuthority("app-a")).resolves.toEqual(authority);
        await expect(issueCapability("app-a")).resolves.toMatchObject(authority);
      } finally {
        await rm(manifestFaultControl, { force: true });
      }
    },
  );

  test("discovers a directly-created App without revoking unchanged capabilities", async () => {
    await expect(hostRequest("/api/health")).resolves.toEqual({ ok: true });
    const existing = await issueCapability("app-a");

    // An unchanged Shell poll must not retire the currently issued manifest
    // generation.
    await hostRequest("/api/apps");
    const beforeChange = await appQuery(existing.capability, "SELECT 1 AS ok");
    expect(beforeChange.status).toBe(200);

    await writeAppManifest("app-c", []);
    const refreshed = await hostRequest("/api/apps") as { apps: Array<{ id: string }> };
    expect(refreshed.apps.map(({ id }) => id)).toContain("app-c");

    // Publishing a changed registry retires the old authority snapshot.
    const afterChange = await appQuery(existing.capability, "SELECT 1 AS ok");
    expect(afterChange.status).toBe(401);
    await expect(issueCapability("app-c")).resolves.toMatchObject({
      capability: expect.any(String),
      channelId: expect.any(String),
    });
  });

  test("rejects stale authority when manifest changes between discovery and issuance", async () => {
    const stale = await appAuthority("app-a");
    await writeAppManifest("app-a", ["app_a_items", "app_b_items"]);

    const response = await fetch(`${coreOrigin}/api/app-runtime/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CORE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ appId: "app-a", workload: "ui", ...stale }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "App manifest authority changed; refresh and retry",
    });
    const current = await appAuthority("app-a");
    expect(current.manifestDigest).not.toBe(stale.manifestDigest);
    await expect(issueCapability("app-a")).resolves.toMatchObject(current);
  });
});

async function writeAppManifest(appId: string, tables: string[]): Promise<void> {
  const appDir = join(workspace || join(testRoot, "workspace"), "apps", appId);
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "manifest.json"), `${JSON.stringify({
    manifestVersion: 1,
    id: appId,
    name: appId === "app-a" ? "App A" : "App B",
    description: `${appId} end-to-end test App.`,
    runtime: {
      ui: { command: ["node", "server.mjs"], port: 3000 },
    },
    permissions: { writes: { files: [], tables } },
  }, null, 2)}\n`, "utf8");
  if (!existsSync(join(appDir, ".git"))) {
    runAppGit(appDir, "init", "--quiet");
    runAppGit(appDir, "config", "user.name", "Lamarck Test");
    runAppGit(appDir, "config", "user.email", "lamarck-test@example.invalid");
  }
  runAppGit(appDir, "add", "--all");
  runAppGit(
    appDir,
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    `Commit ${appId} activation`,
  );
}

function runAppGit(appDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", appDir, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function seedDataDatabase(): void {
  const db = new DatabaseSync(join(workspace, ".lamarck", "data.db"));
  try {
    db.exec(DATA_SCHEMA);
    db.exec(`
      CREATE TABLE app_a_items (
        id TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE app_b_items (
        id TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  } finally {
    db.close();
  }
}

async function issueCapability(appId: string): Promise<{
  capability: string;
  channelId: string;
  manifestGeneration: number;
  manifestDigest: string;
}> {
  const authority = await appAuthority(appId);
  return await hostRequest("/api/app-runtime/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, workload: "ui", ...authority }),
  }) as {
    capability: string;
    channelId: string;
    manifestGeneration: number;
    manifestDigest: string;
  };
}

async function appAuthority(appId: string): Promise<{
  manifestGeneration: number;
  manifestDigest: string;
}> {
  const body = await hostRequest("/api/apps") as {
    apps: Array<{
      id: string;
      manifestGeneration: number;
      manifestDigest: string;
    }>;
  };
  const app = body.apps.find((candidate) => candidate.id === appId);
  if (!app) throw new Error(`App not found: ${appId}`);
  return {
    manifestGeneration: app.manifestGeneration,
    manifestDigest: app.manifestDigest,
  };
}

async function appQuery(capability: string, sql: string): Promise<Response> {
  return await fetch(`${coreOrigin}/api/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-lamarck-app-capability": capability,
    },
    body: JSON.stringify({ sql, params: [] }),
  });
}

async function hostRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${CORE_TOKEN}`);
  const response = await fetch(`${coreOrigin}${path}`, { ...init, headers });
  const body = await response.json() as { error?: string };
  if (!response.ok) {
    throw new Error(`Host request ${path} failed (${response.status}): ${body.error ?? "unknown"}`);
  }
  return body;
}

async function waitForGuardReady(child: ChildProcess): Promise<number> {
  if (!child.stdout) throw new Error("Guard stdout is unavailable");
  const lines = createInterface({ input: child.stdout });
  return await new Promise<number>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error(`Guard startup timed out: ${guardOutput}`));
    }, START_TIMEOUT_MS);
    const finish = (error?: Error, port?: number) => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) rejectReady(error);
      else resolveReady(port!);
    };
    const onError = (error: Error) => finish(error);
    const onExit = () => finish(new Error(`Guard exited before readiness: ${guardOutput}`));
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { type?: unknown; port?: unknown };
        if (
          message.type === "ready"
          && Number.isInteger(message.port)
          && Number(message.port) > 0
        ) {
          finish(undefined, Number(message.port));
        }
      } catch {}
    });
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForCore(): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (coreProcess?.exitCode !== null) {
      throw new Error(`Core exited before readiness: ${coreOutput}`);
    }
    try {
      const response = await fetch(`${coreOrigin}/api/health`, {
        headers: { Authorization: `Bearer ${CORE_TOKEN}` },
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Core startup timed out: ${coreOutput}`);
}

function captureOutput(child: ChildProcess): string {
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${String(chunk)}`.slice(-64 * 1024);
    if (child === coreProcess) coreOutput = output;
    if (child === guardProcess) guardOutput = output;
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return output;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve Core port");
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (graceful || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
  ]);
}

function duplexPair(): { client: Duplex; server: Duplex } {
  const client = new MemoryDuplex();
  const server = new MemoryDuplex();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

class MemoryDuplex extends Duplex {
  peer: MemoryDuplex | undefined;

  _read(): void {}

  _write(
    chunk: Buffer | Uint8Array | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.peer?.destroyed) callback(new Error("peer closed"));
    else {
      this.peer?.push(Buffer.from(chunk));
      callback();
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    this.peer?.push(null);
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.peer?.push(null);
    callback(error);
  }
}
