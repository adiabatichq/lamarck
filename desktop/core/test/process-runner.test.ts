import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
