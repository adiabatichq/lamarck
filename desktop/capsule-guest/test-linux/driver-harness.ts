import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  type RuncExecution,
} from "../../capsule/src/drivers";
import {
  createOciBundlePlan,
  type OciBundlePlan,
  type OciExpectedIdentity,
  type OciPlanInput,
} from "../../capsule/src/oci/plan";
import { LinuxRuncDriver } from "../../capsule/src/oci/runc-driver";
import { TicketRegistry } from "../../capsule/src/protocol/tickets";
import type { WorkloadKind } from "../../capsule/src/protocol/types";
import { DATA_SCHEMA } from "../../core/src/data-schema";
import { SystemBroker } from "../../shell/electron/capsule/system-broker";
import { SystemStreamServer } from "../../shell/electron/capsule/system-stream";

const RUNC = "/usr/sbin/runc";
const RUNC_ROOT = "/run/lamarck/runc-driver-integration";
const CGROUP_MOUNT = "/sys/fs/cgroup";
const HOST_NODE = "/opt/lamarck/host-node/bin/node";
const APP_A_HANDLE = "AAAAAAAAAAAAAAAAAAAAAA";
const APP_B_HANDLE = "DDDDDDDDDDDDDDDDDDDDDD";
const ONESHOT_HANDLE = "BBBBBBBBBBBBBBBBBBBBBB";
const LONG_RUNNING_HANDLE = "CCCCCCCCCCCCCCCCCCCCCC";
const ISOLATION_A_HANDLE = "EEEEEEEEEEEEEEEEEEEEEE";
const ISOLATION_B_HANDLE = "FFFFFFFFFFFFFFFFFFFFFF";
const SYSTEM_RPC_HANDLE = "GGGGGGGGGGGGGGGGGGGGGG";
const SESSION_ID = "sssssssssssssssssssssssssssssssssssssssssss";
const ARTIFACT_DIGEST = `sha256:${"d".repeat(64)}`;
const MAPPED_UID = 100_000;
const MAPPED_GID = 200_000;
const RESOURCES = {
  memoryBytes: 256 * 1024 * 1024,
  pids: 64,
  cpuQuotaMicros: 100_000,
} as const;

const driver = new LinuxRuncDriver({
  runcPath: RUNC,
  runcRoot: RUNC_ROOT,
  cgroupMount: CGROUP_MOUNT,
  startTimeoutMs: 10_000,
  commandTimeoutMs: 10_000,
  diagnosticLogDirectory: "/run/lamarck/runc-driver-logs",
});

assert.equal(process.version, "v24.18.0", "integration gate must use the Guest Node version");
assert.equal(driver.available, true, "production LinuxRuncDriver must find real runc");
const hostNodeProbe = spawnSync(HOST_NODE, [
  "-e",
  "const { DatabaseSync } = require('node:sqlite');"
    + "const db = new DatabaseSync(':memory:');"
    + "if (typeof db.enableDefensive !== 'function' || typeof db.setAuthorizer !== 'function') process.exit(1);"
    + "db.close();",
], { encoding: "utf8", timeout: 5_000 });
assert.equal(
  hostNodeProbe.status,
  0,
  `Host-side Core/Guard Node runtime lacks required SQLite policy APIs: ${hostNodeProbe.stderr}`,
);

await runOneShot();
await runLongRunning();
await runTwoAppIsolation();
await runCapsuleCoreGuard();
process.stdout.write(
  "production LinuxRuncDriver + two-App isolation + real Capsule-to-Core-to-Guard passed\n",
);

async function runOneShot(): Promise<void> {
  const spec = workloadSpec(ONESHOT_HANDLE, "oneshot");
  const pair = await openSocketPair("oneshot");
  const ready = receiveLine(pair.peer, 10_000);
  let execution: RuncExecution | undefined;
  try {
    execution = await start(spec, pair.source);
    assert.equal(await ready, "oneshot-ready");
    const result = await execution.wait();
    assert.equal(result.exitCode, 0, `one-shot workload failed with ${JSON.stringify(result)}`);
    await driver.delete(execution.containerId);
    assert.equal(existsSync(spec.plan.bundlePath), false, "driver must remove retired bundle");
    assert.equal(existsSync(spec.plan.sdkBridgeRoot), false, "driver must remove SDK bridge authority");
    assertContainerStateDeleted(execution.containerId);
  } finally {
    pair.close();
  }
}

async function runLongRunning(): Promise<void> {
  const spec = workloadSpec(LONG_RUNNING_HANDLE, "long-running");
  const pair = await openSocketPair("long-running");
  const ready = receiveLine(pair.peer, 10_000);
  let execution: RuncExecution | undefined;
  try {
    execution = await start(spec, pair.source);
    assert.equal(await ready, "long-running-ready");

    const state = readRuncState(execution.containerId);
    assert.equal(state.status, "running", "runc must report the production workload running");
    assert.ok(Number.isSafeInteger(state.pid) && state.pid > 1, "runc state must expose init pid");
    await assertActualUserNamespace(state.pid, MAPPED_UID, MAPPED_GID);

    const cgroupPath = `${CGROUP_MOUNT}/${spec.plan.config.linux.cgroupsPath}`;
    assert.equal(await readCgroupPopulation(cgroupPath), 1, "workload cgroup must be populated");

    // grace=0 forces the production path through trusted cgroup.kill rather
    // than allowing the probe to exit gracefully.
    await driver.stop(execution.containerId, 0);
    assert.equal(
      await readCgroupPopulation(cgroupPath),
      0,
      "authoritative stop must prove cgroup populated=0",
    );
    const stopped = await execution.wait();
    assert.notEqual(
      stopped.exitCode,
      0,
      "the deliberately persistent probe must be terminated, not finish normally",
    );

    await driver.delete(execution.containerId);
    await driver.delete(execution.containerId);
    assert.equal(existsSync(spec.plan.bundlePath), false, "driver must remove deleted bundle");
    assert.equal(existsSync(spec.plan.sdkBridgeRoot), false, "driver must remove SDK bridge authority");
    assertContainerStateDeleted(execution.containerId);
    if (existsSync(cgroupPath)) {
      assert.equal(await readCgroupPopulation(cgroupPath), 0, "deleted cgroup cannot retain tasks");
    }
  } finally {
    pair.close();
  }
}

async function runTwoAppIsolation(): Promise<void> {
  const appA = createWorkloadSpec({
    appHandle: APP_A_HANDLE,
    workloadHandle: ISOLATION_A_HANDLE,
    mappedHostUid: MAPPED_UID,
    mappedHostGid: MAPPED_GID,
    argv: ["/bin/capsule-runtime-probe", "isolation", "app-a"],
  });
  const appB = createWorkloadSpec({
    appHandle: APP_B_HANDLE,
    workloadHandle: ISOLATION_B_HANDLE,
    mappedHostUid: 300_000,
    mappedHostGid: 400_000,
    argv: ["/bin/capsule-runtime-probe", "isolation", "app-b"],
  });
  assert.notEqual(appA.plan.runtimeRoot, appB.plan.runtimeRoot);
  assert.notEqual(appA.plan.networkNamespacePath, appB.plan.networkNamespacePath);
  assert.notEqual(appA.plan.config.linux.cgroupsPath, appB.plan.config.linux.cgroupsPath);

  // The production driver must reject a correctly authenticated ticket when
  // that ticket belongs to another App, before any OCI state is materialized.
  const mismatchedPair = await openSocketPair("mismatched-app-ticket");
  try {
    await assert.rejects(
      driver.start({
        plan: appA.plan,
        expectedIdentity: appA.expectedIdentity,
        sessionId: SESSION_ID,
        sdkChannel: {
          source: mismatchedPair.source,
          consumedTicket: issueSdkTicket(appB),
        },
      }),
      /another App/,
    );
    assert.equal(existsSync(appA.plan.bundlePath), false);
    assert.equal(existsSync(appA.plan.sdkBridgeRoot), false);
  } finally {
    mismatchedPair.close();
  }

  const pairA = await openSocketPair("isolation-app-a");
  const pairB = await openSocketPair("isolation-app-b");
  const readyA = receiveLine(pairA.peer, 10_000);
  const readyB = receiveLine(pairB.peer, 10_000);
  let executionA: RuncExecution | undefined;
  let executionB: RuncExecution | undefined;
  try {
    executionA = await start(appA, pairA.source);
    executionB = await start(appB, pairB.source);
    // Both probes bind 127.0.0.1:34567. Reaching readiness concurrently proves
    // that the Apps do not share a network namespace or loopback listener.
    assert.equal(await readyA, "isolation-ready:app-a");
    assert.equal(await readyB, "isolation-ready:app-b");

    const stateA = readRuncState(executionA.containerId);
    const stateB = readRuncState(executionB.containerId);
    assert.equal(stateA.status, "running");
    assert.equal(stateB.status, "running");
    await assertActualUserNamespace(stateA.pid, MAPPED_UID, MAPPED_GID);
    await assertActualUserNamespace(stateB.pid, 300_000, 400_000);
    await assertDistinctNamespaces(stateA.pid, stateB.pid);

    await exchange(pairA.peer, "ping", "pong:app-a");
    await exchange(pairB.peer, "ping", "pong:app-b");
    await exchange(
      pairA.peer,
      `assert-hidden ${appB.plan.runtimeRoot}/merged/isolation-owner.txt`,
      "hidden-path-ok",
    );
    await exchange(
      pairB.peer,
      `assert-hidden ${appA.plan.runtimeRoot}/merged/isolation-owner.txt`,
      "hidden-path-ok",
    );
    await exchange(pairA.peer, `assert-pid-hidden ${stateB.pid}`, "hidden-pid-ok");
    await exchange(pairB.peer, `assert-pid-hidden ${stateA.pid}`, "hidden-pid-ok");

    assert.equal(
      await readFile(`${appA.plan.runtimeRoot}/merged/isolation-owner.txt`, "utf8"),
      "app-a",
    );
    assert.equal(
      await readFile(`${appB.plan.runtimeRoot}/merged/isolation-owner.txt`, "utf8"),
      "app-b",
    );

    const cgroupA = `${CGROUP_MOUNT}/${appA.plan.config.linux.cgroupsPath}`;
    const cgroupB = `${CGROUP_MOUNT}/${appB.plan.config.linux.cgroupsPath}`;
    assert.equal(await readCgroupPopulation(cgroupA), 1);
    assert.equal(await readCgroupPopulation(cgroupB), 1);

    await driver.stop(executionA.containerId, 0);
    assert.notEqual((await executionA.wait()).exitCode, 0);
    assert.equal(await readCgroupPopulation(cgroupA), 0);
    await driver.delete(executionA.containerId);
    // Stopping App A cannot disturb App B's process, private listener, SDK
    // stream, or cgroup.
    assert.equal(await readCgroupPopulation(cgroupB), 1);
    await exchange(pairB.peer, "ping", "pong:app-b");

    await driver.stop(executionB.containerId, 0);
    assert.notEqual((await executionB.wait()).exitCode, 0);
    assert.equal(await readCgroupPopulation(cgroupB), 0);
    await driver.delete(executionB.containerId);
    for (const [spec, execution] of [[appA, executionA], [appB, executionB]] as const) {
      assert.equal(existsSync(spec.plan.bundlePath), false);
      assert.equal(existsSync(spec.plan.sdkBridgeRoot), false);
      assertContainerStateDeleted(execution.containerId);
    }
  } finally {
    for (const execution of [executionA, executionB]) {
      if (!execution) continue;
      await driver.stop(execution.containerId, 0).catch(() => undefined);
      await execution.wait().catch(() => undefined);
      await driver.delete(execution.containerId).catch(() => undefined);
    }
    pairA.close();
    pairB.close();
  }
}

async function runCapsuleCoreGuard(): Promise<void> {
  const testRoot = await mkdtemp("/run/lamarck/capsule-core-guard-");
  const workspace = join(testRoot, "workspace");
  const appDir = join(workspace, "apps", "app-a");
  const coreToken = "privileged-capsule-core-token";
  const guardToken = "privileged-capsule-guard-token";
  let coreProcess: ChildProcess | undefined;
  let guardProcess: ChildProcess | undefined;
  let coreOutput = () => "";
  let guardOutput = () => "";
  let execution: RuncExecution | undefined;
  let pair: Awaited<ReturnType<typeof openSocketPair>> | undefined;
  let detachStream: (() => void) | undefined;
  let broker: SystemBroker | undefined;
  try {
    await mkdir(join(workspace, ".lamarck"), { recursive: true });
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "manifest.json"), `${JSON.stringify({
      manifestVersion: 1,
      id: "app-a",
      name: "App A",
      description: "Linux Capsule guest test App.",
      runtime: {
        ui: { command: ["/bin/capsule-runtime-probe", "system-rpc"], port: 3000 },
      },
      permissions: { writes: { docs: [], tables: ["capsule_items"] } },
    }, null, 2)}\n`, "utf8");
    const db = new DatabaseSync(join(workspace, ".lamarck", "data.db"));
    try {
      db.exec(DATA_SCHEMA);
      db.exec(`
        CREATE TABLE capsule_items (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    } finally {
      db.close();
    }

    guardProcess = spawn(
      HOST_NODE,
      ["/usr/local/libexec/lamarck-guard-service-e2e.cjs", workspace],
      {
        env: { ...process.env, LAMARCK_GUARD_TOKEN: guardToken, PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    guardOutput = captureChildOutput(guardProcess);
    const guardPort = await waitForGuardService(guardProcess, guardOutput);

    const corePort = await reserveTcpPort();
    const coreOrigin = `http://127.0.0.1:${corePort}`;
    coreProcess = spawn(
      HOST_NODE,
      ["/usr/local/libexec/lamarck-core-e2e.mjs", workspace],
      {
        env: {
          ...process.env,
          LAMARCK_CORE_TOKEN: coreToken,
          LAMARCK_GUARD_ORIGIN: `http://127.0.0.1:${guardPort}`,
          LAMARCK_GUARD_TOKEN: guardToken,
          HOST: "127.0.0.1",
          PORT: String(corePort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    coreOutput = captureChildOutput(coreProcess);
    await waitForCoreService(coreProcess, coreOrigin, coreToken, coreOutput);

    const appRegistry = await hostJson(
      coreOrigin,
      coreToken,
      "/api/apps",
      {},
    ) as {
      apps?: Array<{
        id?: unknown;
        manifestGeneration?: unknown;
        manifestDigest?: unknown;
      }>;
    };
    const appAuthority = appRegistry.apps?.find((app) => app.id === "app-a");
    assert.ok(
      appAuthority
        && typeof appAuthority.manifestGeneration === "number"
        && Number.isSafeInteger(appAuthority.manifestGeneration)
        && appAuthority.manifestGeneration >= 1
        && typeof appAuthority.manifestDigest === "string",
      "Core did not publish exact app-a manifest authority",
    );
    const capability = await hostJson(
      coreOrigin,
      coreToken,
      "/api/app-runtime/channels",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: "app-a",
          workload: "ui",
          manifestGeneration: appAuthority.manifestGeneration,
          manifestDigest: appAuthority.manifestDigest,
        }),
      },
    ) as { capability: string; channelId: string };
    broker = new SystemBroker({
      coreBaseUrl: coreOrigin,
      revokeCapability: async (channelId) => {
        await hostJson(
          coreOrigin,
          coreToken,
          `/api/app-runtime/channels/${encodeURIComponent(channelId)}`,
          { method: "DELETE" },
        );
      },
    });
    const senderId = "real-runc-workload";
    broker.bindSender(senderId, capability);
    pair = await openSocketPair("real-capsule-core-guard");
    detachStream = new SystemStreamServer(broker, { unbindOnClose: false })
      .attach(senderId, pair.peer);

    const spec = createWorkloadSpec({
      appHandle: APP_A_HANDLE,
      workloadHandle: SYSTEM_RPC_HANDLE,
      workloadKind: "ui",
      mappedHostUid: MAPPED_UID,
      mappedHostGid: MAPPED_GID,
      argv: ["/bin/capsule-runtime-probe", "system-rpc"],
    });
    execution = await start(spec, pair.source);
    const result = await execution.wait();
    assert.equal(
      result.exitCode,
      0,
      `real Capsule System SDK workload failed: ${JSON.stringify(result)}`,
    );
    await driver.delete(execution.containerId);

    const query = await hostJson(coreOrigin, coreToken, "/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sql: `
          SELECT i.id, i.value, e.source, e.type, e.payload
          FROM capsule_items AS i
          JOIN events AS e
            ON e.source = 'app:app-a:ui'
           AND e.type = 'd2.insert'
          WHERE i.id = 'from-real-runc'
        `,
      }),
    }) as { rows: Array<Record<string, unknown>> };
    assert.equal(query.rows.length, 1, "real Capsule mutation or its Guard audit is missing");
    assert.deepEqual(
      {
        id: query.rows[0]!.id,
        value: query.rows[0]!.value,
        source: query.rows[0]!.source,
        type: query.rows[0]!.type,
      },
      {
        id: "from-real-runc",
        value: "committed",
        source: "app:app-a:ui",
        type: "d2.insert",
      },
    );
    const payload = JSON.parse(String(query.rows[0]!.payload)) as Record<string, unknown>;
    assert.equal(payload.table, "capsule_items");
    assert.equal(payload.affected_rows, 1);
    assert.equal(await broker.revoke(capability.channelId), true);
  } catch (error) {
    throw new AggregateError(
      [error],
      "real Capsule-to-Core-to-Guard gate failed"
        + `\nCore:\n${coreOutput() || "no output"}`
        + `\nGuard:\n${guardOutput() || "no output"}`,
    );
  } finally {
    if (execution) {
      await driver.stop(execution.containerId, 0).catch(() => undefined);
      await execution.wait().catch(() => undefined);
      await driver.delete(execution.containerId).catch(() => undefined);
    }
    detachStream?.();
    broker?.unbindAll();
    pair?.close();
    await stopChild(coreProcess);
    await stopChild(guardProcess);
    await rm(testRoot, { recursive: true, force: true });
  }
}

function workloadSpec(workloadHandle: string, mode: string): {
  plan: OciBundlePlan;
  expectedIdentity: OciExpectedIdentity;
} {
  return createWorkloadSpec({
    appHandle: APP_A_HANDLE,
    workloadHandle,
    mappedHostUid: MAPPED_UID,
    mappedHostGid: MAPPED_GID,
    argv: ["/bin/capsule-runtime-probe", mode],
  });
}

function createWorkloadSpec(options: {
  appHandle: string;
  workloadHandle: string;
  workloadKind?: WorkloadKind;
  mappedHostUid: number;
  mappedHostGid: number;
  argv: string[];
}): {
  plan: OciBundlePlan;
  expectedIdentity: OciExpectedIdentity;
} {
  const input: OciPlanInput = {
    appHandle: options.appHandle,
    workloadHandle: options.workloadHandle,
    workloadKind: options.workloadKind ?? "job",
    artifactDigest: ARTIFACT_DIGEST,
    mappedHostUid: options.mappedHostUid,
    mappedHostGid: options.mappedHostGid,
    argv: [...options.argv],
    cwd: "/app",
    environment: {},
    resources: { ...RESOURCES },
  };
  const expectedIdentity: OciExpectedIdentity = {
    appHandle: input.appHandle,
    workloadHandle: input.workloadHandle,
    workloadKind: input.workloadKind,
    artifactDigest: input.artifactDigest,
    mappedHostUid: input.mappedHostUid,
    mappedHostGid: input.mappedHostGid,
    argv: [...input.argv],
    cwd: input.cwd,
    environment: {},
    resources: { ...RESOURCES },
  };
  const plan = createOciBundlePlan(input);
  const denied = plan.config.linux.seccomp.syscalls.flatMap((rule) => rule.names);
  for (const syscall of [
    "io_uring_setup",
    "io_uring_enter",
    "io_uring_register",
    "socket",
  ]) {
    assert.ok(denied.includes(syscall), `production seccomp policy must cover ${syscall}`);
  }
  return { plan, expectedIdentity };
}

async function start(
  spec: { plan: OciBundlePlan; expectedIdentity: OciExpectedIdentity },
  sdkSocket: Socket,
): Promise<RuncExecution> {
  const consumed = issueSdkTicket(spec);
  return await driver.start({
    plan: spec.plan,
    expectedIdentity: spec.expectedIdentity,
    sessionId: SESSION_ID,
    sdkChannel: {
      source: sdkSocket,
      consumedTicket: consumed,
    },
  });
}

function issueSdkTicket(
  spec: { expectedIdentity: OciExpectedIdentity },
): ReturnType<TicketRegistry["consume"]> {
  const tickets = new TicketRegistry();
  const issued = tickets.issue({
    sessionId: SESSION_ID,
    kind: "sdk",
    appHandle: spec.expectedIdentity.appHandle,
    subjectHandle: spec.expectedIdentity.workloadHandle,
    ttlMs: 60_000,
  });
  return tickets.consume(issued.ticket, SESSION_ID, "sdk");
}

function readRuncState(containerId: string): { status: unknown; pid: number } {
  const result = spawnSync(RUNC, ["--root", RUNC_ROOT, "state", containerId], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, `runc state failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as { status: unknown; pid: number };
}

function assertContainerStateDeleted(containerId: string): void {
  const result = spawnSync(RUNC, ["--root", RUNC_ROOT, "state", containerId], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.notEqual(result.status, 0, "runc state survived production driver delete");
}

async function assertActualUserNamespace(
  pid: number,
  mappedHostUid: number,
  mappedHostGid: number,
): Promise<void> {
  const uidMap = await readFile(`/proc/${pid}/uid_map`, "utf8");
  const gidMap = await readFile(`/proc/${pid}/gid_map`, "utf8");
  assert.match(
    uidMap,
    new RegExp(`^\\s*0\\s+${mappedHostUid}\\s+65536\\s*$`, "m"),
    "actual UID map differs from plan",
  );
  assert.match(
    gidMap,
    new RegExp(`^\\s*0\\s+${mappedHostGid}\\s+65536\\s*$`, "m"),
    "actual GID map differs from plan",
  );

  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const processUid = mappedHostUid + 1_000;
  const processGid = mappedHostGid + 1_000;
  assert.match(
    status,
    new RegExp(`^Uid:\\s+${processUid}\\s+${processUid}\\s+${processUid}\\s+${processUid}\\s*$`, "m"),
  );
  assert.match(
    status,
    new RegExp(`^Gid:\\s+${processGid}\\s+${processGid}\\s+${processGid}\\s+${processGid}\\s*$`, "m"),
  );
}

async function assertDistinctNamespaces(pidA: number, pidB: number): Promise<void> {
  for (const namespace of ["mnt", "net", "pid", "user"] as const) {
    const [host, appA, appB] = await Promise.all([
      readlink(`/proc/self/ns/${namespace}`),
      readlink(`/proc/${pidA}/ns/${namespace}`),
      readlink(`/proc/${pidB}/ns/${namespace}`),
    ]);
    assert.notEqual(appA, host, `App A unexpectedly joined the Host ${namespace} namespace`);
    assert.notEqual(appB, host, `App B unexpectedly joined the Host ${namespace} namespace`);
    assert.notEqual(appA, appB, `Apps unexpectedly share the ${namespace} namespace`);
  }
}

async function readCgroupPopulation(path: string): Promise<number> {
  const events = await readFile(`${path}/cgroup.events`, "utf8");
  const values = [...events.matchAll(/^populated\s+([01])\s*$/gm)];
  assert.equal(values.length, 1, `malformed cgroup population state at ${path}`);
  return Number(values[0]![1]);
}

function captureChildOutput(child: ChildProcess): () => string {
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${String(chunk)}`.slice(-64 * 1024);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output;
}

async function waitForGuardService(
  child: ChildProcess,
  output: () => string,
): Promise<number> {
  if (!child.stdout) throw new Error("Guard stdout is unavailable");
  const lines = createInterface({ input: child.stdout });
  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, port?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(port!);
    };
    const onError = (error: Error) => finish(error);
    const onExit = () => finish(new Error(`Guard exited before readiness: ${output()}`));
    const timer = setTimeout(
      () => finish(new Error(`Guard startup timed out: ${output()}`)),
      15_000,
    );
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

async function reserveTcpPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string", "failed to reserve Core port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForCoreService(
  child: ChildProcess,
  origin: string,
  token: string,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Core exited before readiness: ${output()}`);
    }
    try {
      const response = await fetch(`${origin}/api/apps`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Core startup timed out: ${output()}`);
}

async function hostJson(
  origin: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${origin}${path}`, { ...init, headers });
  const body = await response.json() as { error?: string };
  if (!response.ok) {
    throw new Error(`Core Host request failed (${response.status}): ${body.error ?? "unknown"}`);
  }
  return body;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (graceful || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

async function openSocketPair(label: string): Promise<{
  source: Socket;
  peer: Socket;
  close(): void;
}> {
  const directory = "/run/lamarck/test-sockets";
  const path = `${directory}/${process.pid}-${label}.sock`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });

  const server = createServer();
  const accepted = new Promise<Socket>((resolve, reject) => {
    server.once("connection", resolve);
    server.once("error", reject);
  });
  server.listen(path);
  await once(server, "listening");
  const peer = createConnection(path);
  await once(peer, "connect");
  const source = await accepted;
  server.close();
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  return {
    source,
    peer,
    close: () => {
      source.destroy();
      peer.destroy();
      closeServer(server);
    },
  };
}

function receiveLine(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`SDK readiness marker was not received within ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      const value = Buffer.concat(chunks).toString("utf8");
      const end = value.indexOf("\n");
      if (end < 0) return;
      cleanup();
      resolve(value.slice(0, end));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("SDK channel ended before its readiness marker"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

async function exchange(socket: Socket, command: string, expected: string): Promise<void> {
  const response = receiveLine(socket, 10_000);
  socket.write(`${command}\n`);
  assert.equal(await response, expected);
}

function closeServer(server: Server): void {
  try {
    server.close();
  } catch {
    // The listener may already be closed after the connected pair was made.
  }
}
