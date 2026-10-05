import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ProcessRunnerSession } from "../src/connectors/process-runner";

const runnerEntry = process.env.LAMARCK_CONNECTOR_RUNNER_ENTRY!;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Node connector runner process", () => {
  test("subscribes over IPC and executes event callbacks inside the Source child", async () => {
    const cwd = temporaryDirectory();
    const entryPath = join(cwd, "connector.mjs");
    writeFileSync(entryPath, `export default { async run(context) {
      let complete;
      const delivered = new Promise(resolve => complete = resolve);
      const listener = await context.subscribe({ sql: "SELECT id FROM events", params: [] }, async event => {
        await context.state.set({ event, pid: process.pid });
        complete();
      });
      await delivered;
      await listener.cancel();
      await listener.done;
    } }`);
    const session = new ProcessRunnerSession({ entryPath, contentHash: "test", cwd, runnerEntryPath: runnerEntry });
    const signal = new AbortController();
    const registrations: unknown[] = []; const delivered: any[] = []; const canceled: string[] = [];
    let released!: () => void;
    const idle = new Promise<{ sequence: number; events: any[] }>(resolve => { released = () => resolve({ sequence: 2, events: [] }); });
    try {
      await session.open(signal.signal);
      await session.run({ config: {}, signal: signal.signal, capabilities: {
        authType: "none", writeEvent: async () => ({}), writeEvents: async () => ({}), writeTextBlob: async () => ({}),
        stateGet: async () => null, stateSet: async value => { delivered.push(value); }, authGetToken: async () => "", warningSet: async () => {}, warningClear: async () => {},
        subscriptionStart: async input => { registrations.push(input); return { subscriptionId: "source-listener" }; },
        subscriptionNext: async input => input.acknowledged === 0 ? { sequence: 1, events: [{ id: "original", payload: { value: 7 } } as any] } : idle,
        subscriptionCancel: async input => { canceled.push(input.subscriptionId); released(); return { ok: true }; },
      } });
      expect(registrations).toEqual([{ sql: "SELECT id FROM events", params: [] }]);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].event).toEqual({ id: "original", payload: { value: 7 } });
      expect(delivered[0].pid).not.toBe(process.pid);
      expect(canceled).toEqual(["source-listener"]);
    } finally { signal.abort(); await session.close(); }
  });
  test("a spawn error rejects open without hanging close", async () => {
    const cwd = temporaryDirectory();
    const session = new ProcessRunnerSession({
      entryPath: join(cwd, "connector.mjs"),
      contentHash: "test",
      cwd,
      runnerEntryPath: runnerEntry,
      runnerExecPath: join(cwd, "missing-node-binary"),
      commandTimeoutMs: 250,
    });

    await expect(session.open()).rejects.toThrow();
    await expect(session.close()).resolves.toBeUndefined();
  });

  test("exits when the Core IPC parent disconnects", async () => {
    const child = fork(runnerEntry, [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("runner did not announce readiness")), 1_000);
        child.once("error", reject);
        child.on("message", (message) => {
          if ((message as { type?: string })?.type !== "hello") return;
          clearTimeout(timer);
          resolve();
        });
      });
      child.disconnect();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("orphaned runner did not exit")), 1_000);
        child.once("exit", (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lamarck-runner-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
