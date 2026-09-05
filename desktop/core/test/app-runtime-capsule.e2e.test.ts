import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs, { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Duplex, PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HostCliTransport, runCli as runSharedCli, type CliIo } from "@lamarck/cli";
import { SystemBroker } from "../../shell/electron/capsule/system-broker";
import { SystemStreamServer } from "../../shell/electron/capsule/system-stream";
import { CliOperationDispatcher } from "../../shell/electron/cli-dispatcher";
import { DesktopCliGateway } from "../../shell/electron/cli-gateway";
import { createSystem } from "@lamarck/system";
import { FramedRpcClient } from "../../system-sdk/src/node-transport";
import { DATA_SCHEMA } from "../src/data-schema";
import { canonicalizeAppVersionRecordV1 } from "../src/apps/version-record";
import { hashConnectorPackage } from "../src/connectors";
import git from "isomorphic-git";

const START_TIMEOUT_MS = 15_000;
const CORE_TOKEN = "capsule-core-e2e-host-token";
const GUARD_TOKEN = "capsule-guard-e2e-token";

let testRoot = "";
let workspace = "";
let coreEntry = "";
let guardEntry = "";
let cliDescriptor = "";
let manifestFaultControl = "";
let coreOrigin = "";
let coreProcess: ChildProcess | undefined;
let guardProcess: ChildProcess | undefined;
let cliGateway: DesktopCliGateway | undefined;
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
      writeAppManifest("history-app", []),
      writeAppManifest("archive-app", []),
      writeConnectorPackage("lamarck.cli-fixture"),
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
    const cliRuntimeDirectory = join(testRoot, "cli");
    cliDescriptor = join(cliRuntimeDirectory, "runtime.json");
    cliGateway = new DesktopCliGateway({
      dispatcher: new CliOperationDispatcher({
        coreBaseUrl: () => coreOrigin,
        coreToken: CORE_TOKEN,
        runtimeStates: () => [],
      }),
      runtimeDirectory: cliRuntimeDirectory,
    });
    await cliGateway.start();
  }, 30_000);

  afterAll(async () => {
    await cliGateway?.stop();
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
    "preserves a running activation capability when authoring refresh fails with %s",
    async (code) => {
      const existing = await issueCapability("app-a");

      try {
        await writeFile(manifestFaultControl, code, "utf8");
        const failedRefresh = await fetch(`${coreOrigin}/api/apps`, {
          headers: { Authorization: `Bearer ${CORE_TOKEN}` },
        });
        expect(failedRefresh.status).toBe(500);
        await expect(failedRefresh.json()).resolves.toEqual({
          error: `injected manifest ${code}`,
        });

        // Authoring-state failure cannot rewrite the immutable activation
        // snapshot or revoke its running capability.
        expect((await appQuery(existing.capability, "SELECT 1 AS ok")).status).toBe(200);
      } finally {
        await rm(manifestFaultControl, { force: true });
      }
      await expect(issueCapability("app-a")).resolves.toMatchObject({
        appCommit: existing.appCommit,
        manifestDigest: existing.manifestDigest,
        packageDigest: existing.packageDigest,
      });
    },
  );

  test("discovers a directly-created App without revoking unchanged capabilities", async () => {
    await expect(hostRequest("/api/health")).resolves.toEqual({ ok: true });
    const existing = await issueCapability("app-a");

    // An unchanged Shell poll must not retire the running activation.
    await hostRequest("/api/apps");
    const beforeChange = await appQuery(existing.capability, "SELECT 1 AS ok");
    expect(beforeChange.status).toBe(200);

    await writeAppManifest("app-c", []);
    const refreshed = await hostRequest("/api/apps") as { apps: Array<{ id: string }> };
    expect(refreshed.apps.map(({ id }) => id)).toContain("app-c");

    // Inventory changes do not rewrite a running activation.
    const afterChange = await appQuery(existing.capability, "SELECT 1 AS ok");
    expect(afterChange.status).toBe(200);
    await expect(issueCapability("app-c")).resolves.toMatchObject({
      capability: expect.any(String),
      channelId: expect.any(String),
    });
  });

  test("Host CLI lists, saves, pages versions, restores forward, and emits stable JSON errors", async () => {
    const running = await issueCapability("app-a");
    const listed = JSON.parse(await runCli("app", "list", "--json")) as Array<{
      id: string;
      path: string;
      lifecycle: { version: string | null };
    }>;
    expect(listed.find((app) => app.id === "app-a")).toMatchObject({
      path: join(workspace, "apps", "app-a"),
      lifecycle: { version: running.appCommit },
    });

    const unchanged = JSON.parse(await runCli("app", "save", "app-a", "--json")) as {
      created: boolean;
      version: string;
    };
    expect(unchanged).toMatchObject({ created: false, version: running.appCommit });
    const beforeEvents = await appVersionEventCount("app-a");

    await writeFile(join(workspace, "apps", "app-a", "reference.sql"), "SELECT 1;\n");
    const saved = JSON.parse(await runCli(
      "app", "save", "app-a", "-m", "Add reference SQL", "--author", "Ada", "--json",
    )) as { created: boolean; version: string };
    expect(saved.created).toBe(true);
    expect((await appQuery(running.capability, "SELECT 1 AS ok")).status).toBe(200);

    const versions = JSON.parse(await runCli("app", "versions", "app-a", "--json")) as Array<{
      version: string;
      trigger: string;
      message?: string;
      author?: string;
    }>;
    expect(versions[0]).toMatchObject({
      version: saved.version,
      trigger: "save",
      message: "Add reference SQL",
      author: "Ada",
    });
    const restored = JSON.parse(await runCli(
      "app", "restore", "app-a", running.appCommit.slice(0, 12), "--json",
    )) as { created: boolean; version: string };
    expect(restored.created).toBe(true);
    expect(restored.version).not.toBe(running.appCommit);
    expect(await appVersionEventCount("app-a")).toBe(beforeEvents + 2);
    expect((await appQuery(running.capability, "SELECT 1 AS ok")).status).toBe(200);

    expect(await runCliFailure("app", "restore", "app-a", "deadbeef", "--json")).toEqual({
      error: {
        code: "APP_VERSION_NOT_FOUND",
        message: "Unknown App version: deadbeef",
      },
    });
  });

  test("Host CLI app versions returns only the newest 100 full commit IDs", async () => {
    const initial = JSON.parse(await runCli("app", "save", "history-app", "--json")) as {
      version: string;
    };
    const expectedNewestFirst = [initial.version];
    let parentVersion = initial.version;
    for (let sequence = 1; sequence <= 104; sequence += 1) {
      parentVersion = await appendFinalizedVersion("history-app", parentVersion, sequence);
      expectedNewestFirst.unshift(parentVersion);
    }

    const versions = JSON.parse(await runCli("app", "versions", "history-app", "--json")) as Array<{
      version: string;
      createdAt: number;
    }>;
    expect(versions).toHaveLength(100);
    expect(versions.map(({ version }) => version)).toEqual(expectedNewestFirst.slice(0, 100));
    expect(versions.every(({ version }) => /^[0-9a-f]{40}$/.test(version))).toBe(true);
  }, 30_000);

  test("Host CLI preserves typed schema, App, and Source domain errors", async () => {
    await expect(runCliFailure("app", "inspect", "missing-app", "--json")).resolves.toEqual({
      error: { code: "APP_NOT_FOUND", message: "App not found: missing-app" },
    });
    await expect(runCliFailure("source", "inspect", "missing-source", "--json")).resolves.toEqual({
      error: { code: "SOURCE_NOT_FOUND", message: "Source missing-source was not found." },
    });
    const schema = await runCliFailure("schema", "change", "SELECT 1", "--json") as {
      error: { code: string; message: string };
    };
    expect(schema.error.code).toBe("SCHEMA_REQUEST_REJECTED");
    expect(schema.error.message).toContain("rerun lamarck schema");
  });

  test("Host CLI list and inspect immediately report a Connector modified after Core startup", async () => {
    const connectorId = "lamarck.cli-fixture";
    const connectorDir = join(workspace, "connectors", connectorId);
    const before = JSON.parse(await runCli("connector", "inspect", connectorId, "--json")) as {
      packageHash: string;
      trust: string;
    };
    await writeFile(join(connectorDir, "index.mjs"), "export default { async run() { return 'modified'; } };\n");
    const currentHash = await hashConnectorPackage(connectorDir);
    expect(currentHash).not.toBe(before.packageHash);

    const listed = JSON.parse(await runCli("connector", "list", "--json")) as Array<{
      id: string;
      packageHash: string;
      trust: string;
      releaseId: string | null;
    }>;
    expect(listed.find(({ id }) => id === connectorId)).toMatchObject({
      packageHash: currentHash,
      trust: "modified",
      releaseId: null,
    });
    expect(JSON.parse(await runCli("connector", "inspect", connectorId, "--json"))).toMatchObject({
      packageHash: currentHash,
      trust: "modified",
      releaseId: null,
    });
  });

  test("Host-side App archive returns its result after Core state, D0, and Current Shape commit", async () => {
    await runCli("app", "save", "archive-app", "--json");
    const archived = JSON.parse(await runCli("app", "archive", "archive-app", "--yes", "--json"));
    expect(archived).toEqual({ id: "archive-app", archived: true });
    expect(existsSync(join(workspace, "apps", "archive-app"))).toBe(false);
    expect(existsSync(join(workspace, ".lamarck", "archived-apps", "archive-app"))).toBe(true);
    const current = JSON.parse(await runCli("app", "list", "--json")) as Array<{ id: string }>;
    expect(current.some(({ id }) => id === "archive-app")).toBe(false);
    const audit = await hostRequest("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sql: "SELECT source, payload FROM events WHERE type = 'app.archived' ORDER BY rowid DESC LIMIT 1",
        params: [],
      }),
    }) as { rows: Array<{ source: string; payload: string }> };
    expect(audit.rows[0]?.source).toBe("system:cli");
    expect(JSON.parse(audit.rows[0]!.payload)).toEqual({ appId: "archive-app" });
  });

  test("uses prepared immutable authority when source changes before channel issuance", async () => {
    const stale = await prepareActivation("app-a");
    await writeAppManifest("app-a", ["app_a_items", "app_b_items"]);

    const issued = await issueCapability("app-a", stale);
    expect(issued).toMatchObject({
      appCommit: stale.version,
      manifestDigest: stale.manifestDigest,
      packageDigest: stale.packageDigest,
    });
    const current = await prepareActivation("app-a");
    expect(current.version).not.toBe(stale.version);
    expect(current.manifestDigest).not.toBe(stale.manifestDigest);
    await releaseActivation(current.activationId);
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

async function writeConnectorPackage(connectorId: string): Promise<void> {
  const dir = join(workspace || join(testRoot, "workspace"), "connectors", connectorId);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, "connector.yaml"), `manifestVersion: 1
id: ${connectorId}
name: CLI Fixture
description: Connector modified-detection fixture.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
auth:
  type: none
`),
    writeFile(join(dir, "events.json"), `${JSON.stringify({
      catalogVersion: 1,
      eventTypes: {
        "cli.fixture": { description: "CLI fixture event", payloadSchema: true },
      },
    })}\n`),
    writeFile(join(dir, "index.mjs"), "export default { async run() {} };\n"),
  ]);
}

function runAppGit(appDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", appDir, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

async function appendFinalizedVersion(
  appId: string,
  parentVersion: string,
  sequence: number,
): Promise<string> {
  const appDir = join(workspace, "apps", appId);
  const { commit } = await git.readCommit({ fs, dir: appDir, oid: parentVersion });
  const { tree } = await git.readTree({ fs, dir: appDir, oid: commit.tree });
  const historyBlob = await git.writeBlob({
    fs,
    dir: appDir,
    blob: Buffer.from(`history ${sequence}\n`),
  });
  const historyIndex = tree.findIndex((entry) => entry.path === "history.txt");
  const nextEntries = historyIndex < 0
    ? [...tree, { mode: "100644" as const, path: "history.txt", oid: historyBlob, type: "blob" as const }]
    : tree.map((entry, index) => index === historyIndex ? { ...entry, oid: historyBlob } : entry);
  const nextTree = await git.writeTree({ fs, dir: appDir, tree: nextEntries });
  const person = {
    name: "Lamarck Test",
    email: "lamarck-test@example.invalid",
    timestamp: 1_800_000_000 + sequence,
    timezoneOffset: 0,
  };
  const version = await git.writeCommit({
    fs,
    dir: appDir,
    commit: {
      tree: nextTree,
      parent: [parentVersion],
      message: `History fixture ${sequence}`,
      author: person,
      committer: person,
    },
  });
  const record = {
    schemaVersion: 1 as const,
    appId,
    version,
    parentVersion,
    trigger: "save" as const,
    createdAt: 1_800_000_000_000 + sequence,
    message: `History fixture ${sequence}`,
  };
  const tagOid = await git.writeTag({
    fs,
    dir: appDir,
    tag: {
      object: version,
      type: "commit",
      tag: `lamarck-version-${version}`,
      tagger: person,
      message: canonicalizeAppVersionRecordV1(record),
    },
  });
  await git.writeRef({ fs, dir: appDir, ref: `refs/lamarck/versions/${version}`, value: tagOid });
  await git.writeRef({ fs, dir: appDir, ref: `refs/lamarck/current/${appId}`, value: version, force: true });
  await git.writeRef({ fs, dir: appDir, ref: "refs/heads/main", value: version, force: true });
  return version;
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

async function issueCapability(appId: string, prepared?: PreparedActivation): Promise<{
  capability: string;
  channelId: string;
  activationId: string;
  appCommit: string;
  manifestDigest: string;
  packageDigest: string;
}> {
  const authority = prepared ?? await prepareActivation(appId);
  try {
    return await hostRequest("/api/app-runtime/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, workload: "ui", activationId: authority.activationId }),
    }) as {
      capability: string;
      channelId: string;
      activationId: string;
      appCommit: string;
      manifestDigest: string;
      packageDigest: string;
    };
  } finally {
    await releaseActivation(authority.activationId);
  }
}

interface PreparedActivation {
  activationId: string;
  version: string;
  manifestDigest: string;
  packageDigest: string;
}

async function prepareActivation(appId: string): Promise<PreparedActivation> {
  const body = await hostRequest(
    `/api/apps/${encodeURIComponent(appId)}/activation/prepare`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workload: "ui" }),
    },
  ) as { activation: PreparedActivation };
  return body.activation;
}

async function releaseActivation(activationId: string): Promise<void> {
  await hostRequest(`/api/apps/activation/${encodeURIComponent(activationId)}`, {
    method: "DELETE",
  });
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

async function appVersionEventCount(appId: string): Promise<number> {
  const body = await hostRequest("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sql: "SELECT COUNT(*) AS count FROM events WHERE type = 'app.version.created' AND source = 'system:cli' AND json_extract(payload, '$.appId') = ?",
      params: [appId],
    }),
  }) as { rows: Array<{ count: number }> };
  return body.rows[0]?.count ?? 0;
}

async function runCli(...args: string[]): Promise<string> {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdin, { isTTY: false });
  Object.assign(stdout, { isTTY: false });
  stdin.end();
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
  const exitCode = await runSharedCli({
    environment: "host",
    argv: args,
    transport: new HostCliTransport({ descriptorPath: cliDescriptor }),
    io: { stdin, stdout, stderr } as CliIo,
  });
  const error = Buffer.concat(errors).toString("utf8");
  if (exitCode !== 0) throw Object.assign(new Error(error), { stderr: error });
  return Buffer.concat(output).toString("utf8");
}

async function runCliFailure(...args: string[]): Promise<unknown> {
  try {
    await runCli(...args);
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    return JSON.parse(String(stderr).trim());
  }
  throw new Error("Expected CLI command to fail");
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
