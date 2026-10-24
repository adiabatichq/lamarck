import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DATA_SCHEMA_V1 } from "../src/data-schema";
import { SYSTEM_SCHEMA_V1 } from "../src/db";

const token = "observer-startup-test";
let workspace: string;
let release: string;
let entered: string;
let preload: string;
let child: ChildProcess | undefined;
let output: string;
let origin: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "lamarck-observer-startup-"));
  await mkdir(join(workspace, ".lamarck"));
  await mkdir(join(workspace, "files"));
  await writeFile(join(workspace, "files", "slow-cache.bin"), "cloud-backed cache");
  await writeFile(join(workspace, "files", "existing.bin"), "retained file");
  release = join(workspace, "release-read");
  entered = join(workspace, "entered-read");
  preload = join(workspace, "stall-read.mjs");
  // Stall one real file descriptor, as a cloud-backed read can, without
  // delaying HTTP, SQLite, or any other file operation in the child process.
  await writeFile(preload, `
import { existsSync, fstatSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const probe = await open(${JSON.stringify(join(workspace, "files", "slow-cache.bin"))}, 'r');
const target = await probe.stat();
const prototype = Object.getPrototypeOf(probe);
const read = prototype.read;
await probe.close();
prototype.read = async function (...args) {
  const current = fstatSync(this.fd);
  if (current.dev === target.dev && current.ino === target.ino) {
    writeFileSync(${JSON.stringify(entered)}, 'entered');
    while (!existsSync(${JSON.stringify(release)})) await delay(10);
  }
  return Reflect.apply(read, this, args);
};
`);
  output = "";
});

afterEach(async () => {
  await writeFile(release, "release");
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    const current = child;
    const timer = setTimeout(() => current.kill("SIGKILL"), 5_000);
    child.kill("SIGTERM");
    try { await exited; } finally { clearTimeout(timer); }
  }
  child = undefined;
  await rm(workspace, { recursive: true, force: true });
});

test("reset can reopen while a Files read stalls, without admitting writes before history is rebuilt", async () => {
  const old = new DatabaseSync(join(workspace, ".lamarck", "system.db"));
  old.exec(SYSTEM_SCHEMA_V1.replace(",\n  mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal', 'exp'))", ""));
  old.exec("PRAGMA user_version = 1");
  old.close();
  seedEvent({ changes: [{ kind: "added", path: "existing.bin", digest: `sha256:${createHash("sha256").update("retained file").digest("hex")}` }] });
  await launch(true);
  await waitFor(() => existsSync(entered));
  await waitForHealth();
  expect(await request("/api/query", { sql: "SELECT count(*) AS n FROM events" })).toEqual({ rows: [{ n: 1 }] });

  const cancelled = new AbortController();
  const abandoned = fetch(origin + "/api/vfs/command", {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ command: "tee cancelled.txt", options: { stdin: { encoding: "utf8", data: "must not write" } } }),
    signal: cancelled.signal,
  }).catch(() => {});

  let settled = false;
  const mutation = request("/api/vfs/command", {
    command: "tee after.txt",
    options: { stdin: { encoding: "utf8", data: "after recovery" } },
  }).finally(() => { settled = true; });
  try {
    await delay(50);
    cancelled.abort();
    await abandoned;
    await delay(25);
    expect(settled).toBe(false);
    expect(existsSync(join(workspace, "files", "after.txt"))).toBe(false);
  } finally {
    await writeFile(release, "release");
    await mutation;
  }
  expect(await readFile(join(workspace, "files", "after.txt"), "utf8")).toBe("after recovery");
  expect(existsSync(join(workspace, "files", "cancelled.txt"))).toBe(false);
  const { rows } = await request("/api/query", { sql: "SELECT payload FROM events WHERE type = 'workspace.files.changed' ORDER BY id" });
  expect(rows).toHaveLength(3);
  expect(rows.map((row: { payload: string }) => JSON.parse(row.payload).changes.map((change: { path: string }) => change.path)))
    .toEqual([["existing.bin"], ["slow-cache.bin"], ["after.txt"]]);
  const system = new DatabaseSync(join(workspace, ".lamarck", "system.db"), { readOnly: true });
  expect(system.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  system.close();
}, 15_000);

test("a failed initial history rebuild still terminates Core instead of silently disabling observation", async () => {
  seedEvent({ changesRef: { invalid: true } });
  await writeFile(release, "release");
  await launch(false);
  await waitFor(() => child!.exitCode !== null);
  expect(child!.exitCode).toBe(1);
  expect(output).toContain("[lamarck:d1] Initial observation failed:");
  expect(output).toContain("Could not resolve D1 changes manifest");
}, 15_000);

function seedEvent(payload: unknown): void {
  const db = new DatabaseSync(join(workspace, ".lamarck", "data.db"));
  db.exec(DATA_SCHEMA_V1);
  db.exec("PRAGMA user_version = 1");
  db.prepare("INSERT INTO events (id, source, producer_ref, type, started_at, payload) VALUES (?, 'test', 'test', 'workspace.files.changed', 1, ?)")
    .run("0000000000001", JSON.stringify(payload));
  db.close();
}

async function launch(reset: boolean): Promise<void> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL("../src/runtime-launcher.mjs", import.meta.url)), workspace], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${preload}`,
      LAMARCK_CORE_TOKEN: token,
      LAMARCK_RESET_SYSTEM_SETTINGS: reset ? "1" : "0",
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { output += chunk; });
}

async function request(path: string, body?: unknown): Promise<any> {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitForHealth(): Promise<void> {
  await waitFor(async () => {
    try { return (await request("/api/health")).ok === true; } catch { return false; }
  });
}

async function waitFor(ready: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await delay(25);
  }
  throw new Error(`Startup condition did not settle:\n${output}`);
}
