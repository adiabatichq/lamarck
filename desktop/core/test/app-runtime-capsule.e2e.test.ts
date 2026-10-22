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
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { HostCliTransport, runCli as runSharedCli, type CliIo } from "@lamarck/cli";
import { CapsuleJobWorker } from "../../shell/electron/capsule/job-worker";
import { CapsuleManager } from "../../shell/electron/capsule/manager";
import { UnavailableCapsuleBackend, type CapsuleBackend } from "../../shell/electron/capsule/backend";
import type { JobInvocation } from "@lamarck/system/protocol";
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
let managementManager: CapsuleManager;
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
      writeAppManifest("exp-app", ["app_a_items"]),
      writeAppManifest("history-app", []),
      writeAppManifest("archive-app", []),
      writeAppManifest("trigger-app", []),
      writeAppManifest("service-app", []),
      writeAppManifest("gated-app", []),
      writeAppManifest("ai-reference-app", [], { summary: { name: "Summary", provider: "openai" } }),
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
    managementManager = new CapsuleManager({ backend: new UnavailableCapsuleBackend(), workspacePath: () => workspace,
      coreBaseUrl: () => coreOrigin, coreToken: CORE_TOKEN, bindSystemSender() {}, unbindSystemSender() {} });
    cliGateway = new DesktopCliGateway({
      dispatcher: new CliOperationDispatcher({
        coreBaseUrl: () => coreOrigin,
        coreToken: CORE_TOKEN,
        runtimeStates: () => managementManager.appRuntimeStates(),
        setAppMode: (appId, mode) => managementManager.setAppMode(appId, mode),
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

  test("exp mode rejects SDK and forged managed mutations while Host schema and App versions retain evidence", async () => {
    expect(JSON.parse(await runCli("app", "inspect", "exp-app", "--json")).runtime.mode).toBe("normal");
    expect(JSON.parse(await runCli("app", "mode", "exp-app", "exp", "--json"))).toEqual({ appId: "exp-app", mode: "exp" });
    const issued = await issueCapability("exp-app"); expect(issued.mode).toBe("exp");
    const broker = new SystemBroker({ coreBaseUrl: coreOrigin, revokeCapability: async () => {} });
    broker.bindSender("exp", { ...issued, appId: "exp-app" });
    const system = createSystem((operation, input) => broker.invoke("exp", operation, input));
    const snapshot = async () => hostRequest("/api/query", { method: "POST", body: JSON.stringify({ sql: "SELECT count(*) AS n FROM events" }) });
    const before = await snapshot();
    try {
      expect((await system.query("SELECT 1 AS value")).rows).toEqual([{ value: 1 }]);
      expect(await system.transaction([{ sql: "SELECT 2 AS value" }])).toMatchObject([{ kind: "query", rows: [{ value: 2 }] }]);
      await expect(system.writeEvent({ type: "exp.denied", startedAt: 1, payload: {} })).rejects.toThrow(/Experiment mode/);
      await expect(system.mutate("INSERT INTO app_a_items VALUES ('exp-denied', 'x')")).rejects.toThrow(/Experiment mode/);
      await expect(system.transaction([{ sql: "SELECT 1" }, { sql: "INSERT INTO app_a_items VALUES ('exp-denied', 'x')" }])).rejects.toThrow(/Experiment mode/);
      const write = await system.vfs.command("mkdir -p apps/exp-app/denied");
      expect(write.success).toBe(false); expect(new TextDecoder().decode(write.stderr)).toMatch(/Experiment mode/);
      expect(existsSync(join(workspace, "files", "apps", "exp-app", "denied"))).toBe(false);
      const file = await system.vfs.command("tee apps/exp-app/denied.txt", { stdin: "must not persist" });
      expect(file.success).toBe(false); expect(existsSync(join(workspace, "files", "apps", "exp-app", "denied.txt"))).toBe(false);
      const read = await system.vfs.command("ls"); expect(read.success).toBe(true);
      const subscription = await system.subscribe({ sql: "SELECT id FROM events WHERE type='exp.subscription'" }, async () => {});
      await subscription.cancel(); await subscription.done;
      const principal = { kind: "app", appId: "exp-app", workload: "ui", appCommit: issued.appCommit, writeTables: ["app_a_items"], fileGrants: ["apps/exp-app/"], workloadHandle: "bound-workload" };
      const modeSpoof = await fetch(`${coreOrigin}/api/app-runtime/apps/exp-app/mode`, { method: "POST", headers: { "x-lamarck-app-capability": issued.capability }, body: JSON.stringify({ mode: "normal" }) });
      expect(modeSpoof.status).toBe(403);
      const upload = await fetch(`${coreOrigin}/api/apps/exp-app/edit-package`, { method: "POST", headers: {
        Authorization: `Bearer ${CORE_TOKEN}`, "X-Lamarck-CLI-Principal": Buffer.from(JSON.stringify(principal)).toString("base64url"),
      }, body: "denied before archive staging" });
      expect(upload.status).toBe(403); expect(await upload.json()).toMatchObject({ error: { code: "APP_EXPERIMENT_READ_ONLY" } });
      const pendingBefore = await hostRequest("/api/schema/requests");
      const sourcesBefore = JSON.parse(await runCli("source", "list", "--json"));
      const changes = [
        ["schema.change", { ddl: "CREATE TABLE exp_denied (id TEXT PRIMARY KEY NOT NULL)" }],
        ["source.run", { sourceId: "source" }], ["source.pause", { sourceId: "source" }], ["source.resume", { sourceId: "source" }],
        ["connector.install", { packageId: "package" }], ["connector.update", { connectorId: "lamarck.cli-fixture" }], ["connector.remove", { connectorId: "lamarck.cli-fixture" }],
        ["app.create", { appId: "denied-app", name: "Denied", description: "Denied" }], ["app.save", { appId: "exp-app" }],
        ["app.restore", { appId: "exp-app", version: issued.appCommit }], ["app.archive", { appId: "exp-app" }], ["app.refresh", { appId: "exp-app" }],
        ["file.command", { argv: ["mkdir", "apps/exp-app/denied"] }],
      ];
      for (const [operation, input] of changes) expect(await hostRequest("/api/cli/execute", { method: "POST", body: JSON.stringify({ principal, request: { requestId: "exp", operation, input } }) }))
        .toMatchObject({ ok: false, error: { code: "APP_EXPERIMENT_READ_ONLY" } });
      expect(await hostRequest("/api/schema/requests")).toEqual(pendingBefore);
      expect(JSON.parse(await runCli("source", "list", "--json"))).toEqual(sourcesBefore);
      expect(existsSync(join(workspace, "apps", "denied-app"))).toBe(false);
      expect(await snapshot()).toEqual(before);
      const spoof = await fetch(`${coreOrigin}/api/events`, { method: "POST", headers: { "x-lamarck-app-capability": issued.capability }, body: JSON.stringify({ mode: "normal", source: "system:host", readOnly: false, type: "exp.denied", startedAt: 1, payload: {} }) });
      expect(spoof.ok).toBe(false); expect(await snapshot()).toEqual(before);
      expect(await runCliFailure("app", "mode", "exp-app", "normal", "--json")).toMatchObject({ error: { code: "APP_MODE_REQUIRES_STOP" } });
      // Independent Host authoring and schema management keep their ordinary evidence.
      await writeFile(join(workspace, "apps", "exp-app", "note.txt"), "Host edit");
      expect(JSON.parse(await runCli("app", "save", "exp-app", "--json"))).toMatchObject({ created: true });
      const pending = await hostRequest("/api/schema/change/request", { method: "POST", body: JSON.stringify({ ddl: "CREATE TABLE exp_host_schema (id TEXT PRIMARY KEY NOT NULL)", author: "Host test" }) }) as { request: { id: string } };
      expect(await hostRequest(`/api/schema/requests/${pending.request.id}/approve`, { method: "POST", body: "{}" })).toMatchObject({ request: { status: "applied" } });
      const evidence = await hostRequest("/api/query", { method: "POST", body: JSON.stringify({ sql: "SELECT type, source FROM events WHERE type IN ('workspace.schema.changed', 'app.version.created') ORDER BY rowid DESC LIMIT 2" }) }) as { rows: { type: string; source: string }[] };
      expect(evidence.rows.map(row => row.type)).toEqual(["workspace.schema.changed", "app.version.created"]);
      expect(evidence.rows.every(row => row.source.startsWith("system:"))).toBe(true);
      expect(JSON.parse(await runCli("app", "inspect", "exp-app", "--json")).runtime.mode).toBe("exp");
    } finally {
      broker.unbindAll(); await hostRequest(`/api/app-runtime/channels/${issued.channelId}`, { method: "DELETE" });
    }
    expect(JSON.parse(await runCli("app", "mode", "exp-app", "normal", "--json"))).toEqual({ appId: "exp-app", mode: "normal" });
  }, 30_000);

  test("AI references survive activation release and stay pinned until a new channel is issued", async () => {
    // issueCapability releases the preparation record, as the real UI open does.
    const original = await issueCapability("ai-reference-app");
    const broker = new SystemBroker({
      coreBaseUrl: coreOrigin,
      revokeCapability: async (channelId) => {
        await hostRequest(`/api/app-runtime/channels/${encodeURIComponent(channelId)}`, { method: "DELETE" });
      },
    });
    broker.bindSender("ai-original", original);
    const system = createSystem((operation, input) => broker.invoke("ai-original", operation, input));
    const selection = { model: "openai:gpt-5.6-luna", accessSource: "summary" };
    const call = () => system.ai.languageModel(selection).doGenerate({ prompt: [] });

    await expect(call()).rejects.toMatchObject({ code: "source_configuration_required", retryable: false });
    await expect(system.ai.embeddingModel({ model: "openai:text-embedding-3-small", accessSource: "summary" }).maxEmbeddingsPerCall)
      .rejects.toMatchObject({ code: "source_configuration_required", retryable: false });

    await writeAppManifest("ai-reference-app", [], { chat: { name: "Chat", provider: "anthropic" } });
    await expect(call()).rejects.toMatchObject({ code: "source_configuration_required", retryable: false });
    await expect(system.ai.languageModel({ ...selection, accessSource: "chat" }).doGenerate({ prompt: [] }))
      .rejects.toMatchObject({ code: "unknown_reference", retryable: false });

    const updated = await issueCapability("ai-reference-app");
    broker.bindSender("ai-updated", updated);
    const nextSystem = createSystem((operation, input) => broker.invoke("ai-updated", operation, input));
    await expect(nextSystem.ai.languageModel(selection).doGenerate({ prompt: [] }))
      .rejects.toMatchObject({ code: "unknown_reference", retryable: false });
    await expect(nextSystem.ai.languageModel({ model: "anthropic:claude-sonnet-5", accessSource: "chat" }).doGenerate({ prompt: [] }))
      .rejects.toMatchObject({ code: "source_configuration_required", retryable: false });

    await hostRequest(`/api/app-runtime/channels/${encodeURIComponent(original.channelId)}`, { method: "DELETE" });
    await expect(call()).rejects.toThrow(/unauthorized/i);
    await hostRequest(`/api/app-runtime/channels/${encodeURIComponent(updated.channelId)}`, { method: "DELETE" });
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
        expect(await runCliFailure("app", "list", "--json")).toEqual({
          error: { code: "CLI_INTERNAL", message: "Lamarck could not complete the command." },
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

  test("Host CLI distinguishes query rejections and invalid SQL through Core and Guard", async () => {
    const rejected = "Query not authorized: only read-only relational queries are allowed; writes, schema changes, and administrative statements are not supported.";
    for (const sql of [
      "DELETE FROM events WHERE 0", "PRAGMA user_version",
      "SELECT load_extension('forbidden')", "BEGIN IMMEDIATE",
    ]) {
      expect(await runCliFailure("query", sql, "--json")).toEqual({
        error: { code: "QUERY_REJECTED", message: rejected },
      });
    }
    for (const [sql, message] of [
      ["SELEC 1", 'near "SELEC": syntax error'],
      ["SELECT * FROM missing_query_table", "no such table: missing_query_table"],
      ["SELECT missing_query_column FROM events", "no such column: missing_query_column"],
    ]) {
      expect(await runCliFailure("query", sql, "--json")).toEqual({
        error: { code: "QUERY_INVALID", message },
      });
      await expect(runCli("query", sql)).rejects.toMatchObject({ exitCode: 1, stderr: `${message}\n` });
    }
    await expect(runCli("query", "PRAGMA user_version")).rejects.toMatchObject({
      exitCode: 1, stderr: `${rejected}\n`,
    });
    expect(JSON.parse(await runCli("query", "WITH value(n) AS (SELECT 42) SELECT n FROM value", "--json")))
      .toEqual([{ n: 42 }]);
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
  test("Service policy is Host-only, persists in v1, and never grants runtime administration to App channels", async () => {
    const path = "/api/app-runtime/services/service-app/indexer";
    const initial = await hostRequest("/api/app-runtime/services") as { services: { appId: string; policy: unknown }[] };
    expect(initial.services.find(value => value.appId === "service-app")?.policy).toMatchObject({ enabled: true });
    const { policy } = await hostRequest(path, { method: "POST", body: JSON.stringify({ operation: "enablement", enabled: true }) }) as { policy: { enabled: boolean; revision: number } };
    expect(policy.enabled).toBe(true);
    const capability = await issueCapability("app-a");
    for (const [target, init] of [["/api/app-runtime/services", {}], [path, { method: "POST", body: JSON.stringify({ operation: "enablement", enabled: false }) }]] as const) {
      const denied = await fetch(`${coreOrigin}${target}`, { ...init, headers: { "x-lamarck-app-capability": capability.capability } });
      expect(denied.status).toBe(403);
    }
    const persisted = new DatabaseSync(join(workspace, ".lamarck", "system.db"), { readOnly: true });
    try {
      expect(persisted.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(persisted.prepare("SELECT enabled FROM app_services WHERE app_id = ? AND service_id = ?").get("service-app", "indexer")?.enabled).toBe(1);
    } finally { persisted.close(); }
    await hostRequest(path, { method: "POST", body: JSON.stringify({ operation: "enablement", enabled: false }) });
    await hostRequest(`/api/app-runtime/channels/${capability.channelId}`, { method: "DELETE" });
  });

  test("Core admission blocks every disabled-App workload and stale channel issuance while preserving child settings", async () => {
    const activations: { workload: string; activationId: string }[] = [];
    for (const workload of ["ui", "service:indexer", "job:inbox"]) {
      const result = await hostRequest("/api/apps/gated-app/activation/prepare", { method: "POST", body: JSON.stringify({ workload }) }) as { activation: { activationId: string } };
      activations.push({ workload, activationId: result.activation.activationId });
    }
    const capability = await issueCapability("gated-app");
    const deniedSetting = await fetch(`${coreOrigin}/api/app-runtime/apps/gated-app/enablement`, { method: "POST", headers: { "x-lamarck-app-capability": capability.capability }, body: JSON.stringify({ enabled: false }) });
    expect(deniedSetting.status).toBe(403);
    await hostRequest("/api/app-runtime/apps/gated-app/enablement", { method: "POST", body: JSON.stringify({ enabled: false }) });
    try {
      for (const activation of activations) {
        const prepared = await fetch(`${coreOrigin}/api/apps/gated-app/activation/prepare`, { method: "POST", headers: { Authorization: `Bearer ${CORE_TOKEN}` }, body: JSON.stringify({ workload: activation.workload }) });
        expect(prepared.ok).toBe(false);
        const issued = await fetch(`${coreOrigin}/api/app-runtime/channels`, { method: "POST", headers: { Authorization: `Bearer ${CORE_TOKEN}` }, body: JSON.stringify({ appId: "gated-app", ...activation }) });
        expect(issued.status).toBe(409);
      }
      const inventory = await hostRequest("/api/app-runtime/services") as { apps: { appId: string; enabled: boolean }[]; services: { appId: string; policy: { enabled: boolean } }[] };
      expect(inventory.apps.find(app => app.appId === "gated-app")?.enabled).toBe(false);
      expect(inventory.services.find(app => app.appId === "gated-app")?.policy.enabled).toBe(true);
      const catalog = await hostRequest("/api/triggers/manage", { method: "POST", body: JSON.stringify({ operation: "trigger.targets", input: {} }) }) as unknown;
      expect(JSON.stringify(catalog)).toContain("App is disabled");
    } finally {
      await hostRequest("/api/app-runtime/apps/gated-app/enablement", { method: "POST", body: JSON.stringify({ enabled: true }) });
      for (const activation of activations) await hostRequest(`/api/apps/activation/${activation.activationId}`, { method: "DELETE" });
      await hostRequest("/api/app-runtime/services/gated-app/indexer", { method: "POST", body: JSON.stringify({ operation: "enablement", enabled: false }) });
    }
  });

  test.each(["normal", "exp"] as const)("a Service-only App preserves supervision, identity, and enablement in %s mode", async mode => {
    await hostRequest("/api/app-runtime/apps/service-app/mode", { method: "POST", body: JSON.stringify({ mode }) });
    const path = "/api/app-runtime/services/service-app/indexer";
    await hostRequest(path, { method: "POST", body: JSON.stringify({ operation: "enablement", enabled: true }) });
    const broker = new SystemBroker({ coreBaseUrl: coreOrigin, revokeCapability: async channelId => { await hostRequest(`/api/app-runtime/channels/${channelId}`, { method: "DELETE" }); } });
    let launches = 0;
    const backend = Object.assign(new UnavailableCapsuleBackend(), {
      status: async () => ({ available: true, backend: "isolated-Guest-fixture" }),
      runService: async (spec: import("../../shell/electron/capsule/backend").CapsuleServiceSpec, signal: AbortSignal, state?: (value: "running" | "stopping") => void, output?: (bytes: Uint8Array) => void) => {
        expect(spec).not.toHaveProperty("port");
        expect(spec.serviceId).toBe("indexer");
        const system = createSystem((operation, input) => broker.invoke(spec.sdkSenderId, operation, input));
        await expect(system.jobInput()).rejects.toThrow();
        expect(spec.mode).toBe(mode);
        const write = () => system.writeEvent({ type: "service.fixture.result", startedAt: Date.now(), payload: { value: "business output" } });
        if (mode === "exp") await expect(write()).rejects.toThrow(/Experiment mode/); else await write();
        launches++; state?.("running"); output?.(Buffer.from("indexer alive\n"));
        await new Promise<void>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const manager = new CapsuleManager({ backend, workspacePath: () => workspace, coreBaseUrl: () => coreOrigin, coreToken: CORE_TOKEN,
      bindSystemSender: (id, binding) => broker.bindSender(id, binding), unbindSystemSender: id => broker.unbindSender(id) });
    try {
      manager.startServices(); await vi.waitFor(() => { expect(launches).toBe(1); expect(manager.appRuntimeStates().find(value => value.appId === "service-app")?.services?.[0].state).toBe("running"); }, { timeout: 10000 });
      await manager.closeAppUi("service-app"); expect(manager.appRuntimeStates().find(value => value.appId === "service-app")?.services?.[0].state).toBe("running");
      await manager.setAppEnabled("service-app", false); await manager.reconcileServices(); expect(launches).toBe(1);
      expect(manager.appRuntimeStates().find(value => value.appId === "service-app")?.services?.[0].state).toBe("stopped");
      expect((await hostRequest("/api/app-runtime/services") as { services: { appId: string; policy: { enabled: boolean } }[] }).services.find(value => value.appId === "service-app")?.policy.enabled).toBe(true);
      await manager.setAppEnabled("service-app", true); await vi.waitFor(() => expect(launches).toBe(2), { timeout: 10000 });
      const evidence = await hostRequest("/api/query", { method: "POST", body: JSON.stringify({ sql: "SELECT source FROM events WHERE type = ?", params: ["service.fixture.result"] }) }) as { rows: { source: string }[] };
      expect(evidence.rows).toEqual([{ source: "app:service-app:service:indexer" }, { source: "app:service-app:service:indexer" }]);
      expect(manager.workloadDiagnostics("service-app")).toHaveLength(2);
    } finally {
      await manager.stopAll();
      await hostRequest(path, { method: "POST", body: JSON.stringify({ operation: "enablement", enabled: false }) });
    }
  });

  test.each(["normal", "exp"] as const)("Host Triggers preserve bound Job input, cancellation, history, and diagnostics in %s mode", async mode => {
    await hostRequest("/api/app-runtime/apps/trigger-app/mode", { method: "POST", body: JSON.stringify({ mode }) });
    const broker = new SystemBroker({ coreBaseUrl: coreOrigin, revokeCapability: async channelId => { await hostRequest(`/api/app-runtime/channels/${channelId}`, { method: "DELETE" }); } });
    const received: JobInvocation[] = [];
    let holdNext = false, activeJobCapability = ""; const cleanupGate = Promise.withResolvers<void>();
    const backend: CapsuleBackend = {
      status: async () => ({ available: true, backend: "isolated-Guest-fixture" }), stopAll: async () => {}, stopAppUi: async () => {},
      prepareUi: async () => { throw new Error("Fixture supports jobs only"); },
      commitPreparedUi: async () => { throw new Error("Fixture supports jobs only"); },
      abortPreparedUi: async () => {}, stopUi: async () => {}, stopApp: async () => {}, retireApp: async () => {},
      startUi: async () => { throw new Error("Fixture supports jobs only"); },
      replaceUi: async () => { throw new Error("Fixture supports jobs only"); },
      openUiStream: async () => { throw new Error("Fixture supports jobs only"); },
      runJob: async (spec, signal, onState) => {
        signal.throwIfAborted(); const pair = duplexPair(); const streams = new SystemStreamServer(broker, { unbindOnClose: false });
        const detach = streams.attach(spec.sdkSenderId, pair.server); const rpc = new FramedRpcClient(pair.client, { requestTimeoutMs: 10_000 }); const system = createSystem(rpc.invoke);
        try {
          const invocation = await system.jobInput(); received.push(invocation);
          onState?.("running");
          if (holdNext) {
            holdNext = false;
            try { await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
            finally { await cleanupGate.promise; }
          }
          await expect(rpc.invoke("job.input", { runId: "foreign" } as never)).rejects.toThrow();
          expect(spec.mode).toBe(mode);
          const write = () => system.writeEvent({ type: "trigger.result", startedAt: Date.now(), payload: { runId: invocation.runId, input: JSON.parse(JSON.stringify(invocation.input)) } });
          if (mode === "exp") await expect(write()).rejects.toThrow(/Experiment mode/); else await write();
        } finally { rpc.close(); detach(); pair.client.destroy(); pair.server.destroy(); }
      },
    };
    const manager = new CapsuleManager({ backend, workspacePath: () => workspace, coreBaseUrl: () => coreOrigin, coreToken: CORE_TOKEN, bindSystemSender: (id, binding) => { activeJobCapability = binding.capability; broker.bindSender(id, binding); }, unbindSystemSender: id => broker.unbindSender(id) });
    const worker = new CapsuleJobWorker(manager, CORE_TOKEN); worker.start(coreOrigin);
    let triggerId = "";
    try {
      const source = await issueCapability("app-b");
      const prior = await hostRequest("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "trigger.fixture", startedAt: 1, payload: { historical: true } }) });
      triggerId = (JSON.parse(await runCli("trigger", "create", "--name", "Inbox", "--target", "app:trigger-app:job:inbox", "--sql", "SELECT e.id, 999 AS payload FROM events e JOIN json_each('[1,2]') j WHERE e.type='trigger.fixture'", "--enabled", "--json")) as { id: string }).id;
      const consoleList = await hostRequest("/api/triggers/manage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "trigger.list", input: {} }) }) as { id: string }[];
      expect(consoleList.map(r => r.id)).toContain(triggerId);
      const appResponse = await fetch(`${coreOrigin}/api/events`, { method: "POST", headers: { "Content-Type": "application/json", "x-lamarck-app-capability": source.capability }, body: JSON.stringify({ type: "trigger.fixture", startedAt: 2, payload: { original: "unaltered" } }) }); expect(appResponse.ok).toBe(true); const written = await appResponse.json() as { id: string };
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 10_000 });
      expect(received[0]).toMatchObject({ version: 1, triggerId, revision: 1, input: { kind: "event", event: { id: written.id, source: "app:app-b:ui", payload: { original: "unaltered" } } } });
      expect(received[0].input).not.toEqual(prior);
      await vi.waitFor(async () => { const runs = JSON.parse(await runCli("trigger", "runs", triggerId, "--json")); expect(runs).toMatchObject([{ status: "success", input: { eventId: written.id } }]); }, { timeout: 10_000 });
      const detail = JSON.parse(await runCli("trigger", "inspect", triggerId, "--json"));
      const preview = await hostRequest("/api/triggers/manage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "trigger.preview", input: { triggerId, limit: 2 } }) }); expect(preview).toMatchObject({ kind: "event", events: expect.any(Array) });
      expect(JSON.parse(await runCli("trigger", "inspect", triggerId, "--json")).cursor).toBe(detail.cursor);
      for (const path of ["/api/triggers/manage", "/api/triggers/jobs/claim", "/api/app-runtime/job-input"]) {
        const response = await fetch(`${coreOrigin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-lamarck-app-capability": source.capability }, body: "{}" }); expect(response.status).toBe(403);
      }
      const managed = await hostRequest("/api/cli/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principal: { kind: "app", appId: "app-b", workload: "ui", appCommit: source.appCommit, writeTables: [], fileGrants: [], workloadHandle: "guest-workload" }, request: { requestId: "denied", operation: "trigger.list", input: {} } }) });
      expect(managed).toMatchObject({ ok: false, error: { code: "CLI_UNSUPPORTED_COMMAND" } });
      const update = JSON.parse(await runCli("trigger", "update", triggerId, "--name", "Renamed", "--revision", "1", "--json")); expect(update.revision).toBe(2);
      expect(await runCliFailure("trigger", "update", triggerId, "--name", "Stale", "--revision", "1", "--json")).toMatchObject({ error: { code: "CLI_USAGE", message: expect.stringContaining("reload") } });
      await runCli("trigger", "disable", triggerId, "--json"); expect(JSON.parse(await runCli("trigger", "inspect", triggerId, "--json")).enabled).toBe(false);
      await runCli("trigger", "enable", triggerId, "--json");
      holdNext = true;
      const append = () => hostRequest("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "trigger.fixture", startedAt: 3, payload: { cancellation: true } }) });
      await append(); await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 10_000 });
      const ui = await issueCapability("trigger-app");
      const unauthorized = await fetch(`${coreOrigin}/api/app-runtime/apps/trigger-app/channels?workload=ui`, { method: "DELETE", headers: { "x-lamarck-app-capability": activeJobCapability } }); expect(unauthorized.status).toBe(403);
      const invalidScope = await fetch(`${coreOrigin}/api/app-runtime/apps/trigger-app/channels?workload=job:inbox`, { method: "DELETE", headers: { Authorization: `Bearer ${CORE_TOKEN}` } }); expect(invalidScope.status).toBe(400);
      expect(await hostRequest("/api/app-runtime/apps/trigger-app/channels?workload=ui", { method: "DELETE" })).toMatchObject({ revoked: 1 });
      const uiRequest = await fetch(`${coreOrigin}/api/app-runtime/job-input`, { method: "POST", headers: { "Content-Type": "application/json", "x-lamarck-app-capability": ui.capability }, body: "{}" }); expect(uiRequest.status).toBe(401);
      const jobInput = await fetch(`${coreOrigin}/api/app-runtime/job-input`, { method: "POST", headers: { "Content-Type": "application/json", "x-lamarck-app-capability": activeJobCapability }, body: "{}" }); expect(jobInput.status).toBe(200); expect(await jobInput.json()).toMatchObject({ runId: received[1].runId });
      expect(manager.appRuntimeStates().find(state => state.appId === "trigger-app")!.jobs).toEqual([
        { jobId: "inbox", runId: received[1].runId, triggerId, state: "running", cleanupError: null },
      ]);
      let stopped = false;
      const stopping = manager.stopJob("trigger-app", received[1].runId).then(result => { stopped = true; return result; });
      await vi.waitFor(() => expect(manager.appRuntimeStates().find(state => state.appId === "trigger-app")!.jobs[0].state).toBe("stopping"));
      await runCli("trigger", "cancel", received[1].runId, "--json"); await append();
      await new Promise(resolve => setTimeout(resolve, 1500)); expect(received).toHaveLength(2);
      const duringCleanup = JSON.parse(await runCli("trigger", "runs", triggerId, "--json")); expect(duringCleanup.some((run: { status: string }) => run.status === "pending")).toBe(true);
      expect(stopped).toBe(false);
      cleanupGate.resolve(); expect(await stopping).toEqual({ active: true });
      expect(await manager.stopJob("trigger-app", received[1].runId)).toEqual({ active: false });
      await vi.waitFor(() => expect(received).toHaveLength(3), { timeout: 10_000 });
      await vi.waitFor(async () => expect(JSON.parse(await runCli("trigger", "runs", triggerId, "--json")).map((run: { status: string }) => run.status)).toEqual(["success", "canceled", "success"]), { timeout: 10_000 });
      await hostRequest(`/api/app-runtime/channels/${source.channelId}`, { method: "DELETE" });
    } finally {
      cleanupGate.resolve();
      if (triggerId) await runCli("trigger", "delete", triggerId, "--yes", "--json");
      await Promise.all([worker.stop(), manager.stopAll()]);
    }
    expect(JSON.parse(await runCli("trigger", "runs", triggerId, "--json")).map((run: { status: string }) => run.status)).toEqual(["success", "canceled", "success"]);
  }, 30_000);

  test.each(["Asia/Taipei", "Japan", "CET"])("schedule previews for %s share Console and CLI validation without creating clock events or execution", async timezone => {
    const config = { name: "Daily", target: "app:trigger-app:job:inbox", enabled: false, condition: { kind: "schedule", cron: "0 9 * * *", timezone } };
    const created = JSON.parse(await runCli("trigger", "create", "--config", JSON.stringify(config), "--json"));
    try {
      const cli = JSON.parse(await runCli("trigger", "preview", created.id, "--limit", "3", "--json"));
      const console = await hostRequest("/api/triggers/manage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "trigger.preview", input: { triggerId: created.id, limit: 3 } }) }); expect(console).toEqual(cli);
      expect(JSON.parse(await runCli("trigger", "runs", created.id, "--json"))).toEqual([]);
      expect(await runCliFailure("trigger", "update", created.id, "--cron", "60 * * * *", "--timezone", "UTC", "--json")).toMatchObject({ error: { code: "CLI_USAGE" } });
      const response = await fetch(`${coreOrigin}/api/triggers/manage`, { method: "POST", headers: { Authorization: `Bearer ${CORE_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation: "trigger.update", input: { triggerId: created.id, config: { condition: { kind: "schedule", cron: "60 * * * *", timezone: "UTC" } } } }) }); expect(response.status).toBe(400);
    } finally { await runCli("trigger", "delete", created.id, "--yes", "--json"); }
  });

});

async function writeAppManifest(appId: string, tables: string[], aiAccessSources?: Record<string, { name: string; provider: string }>): Promise<void> {
  const appDir = join(workspace || join(testRoot, "workspace"), "apps", appId);
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "manifest.json"), `${JSON.stringify({
    manifestVersion: 1,
    id: appId,
    name: appId === "app-a" ? "App A" : "App B",
    description: `${appId} end-to-end test App.`,
    runtime: {
      ...(appId === "service-app" ? {} : { ui: { command: ["node", "server.mjs"], port: 3000 } }),
      ...(["service-app", "gated-app"].includes(appId) ? { services: { indexer: { command: ["node", "indexer.mjs"] } } } : {}),
      ...(["trigger-app", "gated-app"].includes(appId) ? { jobs: { inbox: { command: ["node", "inbox.mjs"] } } } : {}),
    },
    permissions: { writes: { files: [], tables } },
    ...(aiAccessSources ? { ai: { accessSources: aiAccessSources } } : {}),
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
  mode: "normal" | "exp";
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
      mode: "normal" | "exp";
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
  if (exitCode !== 0) throw Object.assign(new Error(error), { stderr: error, exitCode });
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
