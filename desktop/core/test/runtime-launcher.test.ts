import { afterEach, describe, expect, test } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(new URL("../src/runtime-launcher.mjs", import.meta.url));
const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

async function waitForLine(path: string, line: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").split("\n").includes(line)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${line}`);
}

describe("standalone runtime launcher", () => {
  test("starts Guard before Core and stops Core before Guard", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "lamarck-launcher-test-"));
    workspaces.push(workspace);
    const logPath = join(workspace, "lifecycle.log");
    const guardFixture = join(workspace, "fake-guard.mjs");
    const coreFixture = join(workspace, "fake-core.mjs");

    writeFileSync(
      guardFixture,
      `import { appendFileSync } from "node:fs";
import { join } from "node:path";
const logPath = join(process.argv[2], "lifecycle.log");
const valid = process.env.PORT === "0"
  && typeof process.env.LAMARCK_GUARD_TOKEN === "string"
  && process.env.LAMARCK_GUARD_TOKEN.length >= 16
  && process.env.LAMARCK_CORE_TOKEN === undefined
  && process.env.LAMARCK_VAULT_KEY === undefined;
process.once("SIGTERM", () => {
  appendFileSync(logPath, "guard:stop\\n");
  process.exit(0);
});
appendFileSync(logPath, valid ? "guard:start\\n" : "guard:bad-env\\n");
console.log(JSON.stringify({ type: "ready", port: 43123 }));
setInterval(() => {}, 1000);
`,
    );
    writeFileSync(
      coreFixture,
      `import { appendFileSync } from "node:fs";
import { join } from "node:path";
const logPath = join(process.argv[2], "lifecycle.log");
const valid = process.env.LAMARCK_GUARD_ORIGIN === "http://127.0.0.1:43123"
  && typeof process.env.LAMARCK_GUARD_TOKEN === "string"
  && process.env.LAMARCK_GUARD_TOKEN.length >= 16
  && process.env.LAMARCK_CORE_TOKEN === "core-test-secret"
  && process.env.LAMARCK_VAULT_KEY === "vault-test-secret";
process.once("SIGTERM", () => {
  appendFileSync(logPath, "core:stop\\n");
  process.exit(0);
});
appendFileSync(logPath, valid ? "core:start\\n" : "core:bad-env\\n");
setInterval(() => {}, 1000);
`,
    );

    const launcher = spawn(process.execPath, [launcherPath, workspace], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? "1",
        LAMARCK_ELECTRON_BIN: process.execPath,
        LAMARCK_NODE_BIN: process.env.LAMARCK_TEST_NODE_BIN ?? "node",
        LAMARCK_GUARD_ENTRY: guardFixture,
        LAMARCK_CORE_ENTRY: coreFixture,
        LAMARCK_CORE_TOKEN: "core-test-secret",
        LAMARCK_VAULT_KEY: "vault-test-secret",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    launcher.stdout.setEncoding("utf8");
    launcher.stderr.setEncoding("utf8");
    launcher.stdout.on("data", (chunk) => { stdout += chunk; });
    launcher.stderr.on("data", (chunk) => { stderr += chunk; });

    let exitCode: number;
    try {
      try {
        await waitForLine(logPath, "core:start");
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }
      launcher.kill("SIGTERM");
      exitCode = await new Promise<number>((resolve, reject) => {
        launcher.once("error", reject);
        launcher.once("exit", (code) => resolve(code ?? 1));
      });
    } finally {
      if (launcher.exitCode === null) {
        launcher.kill("SIGKILL");
        await new Promise<void>((resolve) => launcher.once("exit", () => resolve()));
      }
    }

    const unexpectedStderr = stderr
      .split("\n")
      .filter((line) => line && !line.includes("task_name_for_pid: (os/kern) failure (5)"))
      .join("\n");
    expect({ exitCode, stderr: unexpectedStderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).not.toContain("LAMARCK_GUARD_TOKEN");
    expect(stdout).not.toMatch(/(?:core|vault)-test-secret/);
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      "guard:start",
      "core:start",
      "core:stop",
      "guard:stop",
    ]);
  }, 15_000);
});
