// Standalone two-process host for Docker and local Core development.
//
// The Guard must be ready before Core starts, and Core must stop before the
// Guard releases its exclusive data.db handle. Electron implements the same
// lifecycle in desktop/shell/electron/main.ts.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const GUARD_START_TIMEOUT_MS = 10_000;
const GUARD_HEARTBEAT_INTERVAL_MS = 5_000;
const GUARD_HEARTBEAT_TIMEOUT_MS = 30_000;
const GUARD_HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;

const workspacePath = resolve(process.argv[2] || process.cwd());
const guardEntry = process.env.LAMARCK_GUARD_ENTRY
  || fileURLToPath(new URL("../dist/guard-service.cjs", import.meta.url));
const coreEntry = process.env.LAMARCK_CORE_ENTRY
  || fileURLToPath(new URL("../dist/core.mjs", import.meta.url));
const guardToken = randomBytes(32).toString("base64url");

let guardProcess;
let coreProcess;
let shuttingDown = false;
let shutdownPromise;
let requestedExitCode = 0;
let guardHeartbeatTimer;
let guardLastHealthyAt = 0;
let guardHealthCheckInFlight = false;

function nodeSupportsRuntime(version = process.versions.node) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 24 || (major === 24 && minor >= 10);
}

function guardRuntime() {
  if (process.env.LAMARCK_NODE_BIN) {
    return { command: process.env.LAMARCK_NODE_BIN, extraEnv: {} };
  }
  if (nodeSupportsRuntime()) {
    return { command: process.execPath, extraEnv: {} };
  }

  try {
    const electronBin = process.env.LAMARCK_ELECTRON_BIN || require("electron");
    return {
      command: electronBin,
      extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
    };
  } catch {
    throw new Error(
      `Core and Guard require Node.js 24.10+ (current: ${process.versions.node}). `
      + "Install Node 24 or the desktop shell's Electron 42 development dependency.",
    );
  }
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveWait(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopProcess(child, name) {
  if (!child || hasExited(child) || child.pid === undefined) return;
  const gracefulExit = waitForExit(child, PROCESS_STOP_TIMEOUT_MS);
  child.kill("SIGTERM");
  if (await gracefulExit) return;

  console.warn(`[launcher] ${name} did not stop in time; terminating it`);
  child.kill("SIGKILL");
  await waitForExit(child, 1_000);
}

function shutdown(exitCode = 0) {
  if (exitCode !== 0) requestedExitCode = exitCode;
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  stopGuardHeartbeat();
  shutdownPromise = (async () => {
    // Core may still issue Guard RPCs, so this order is part of the data
    // ownership contract.
    await stopProcess(coreProcess, "Node Core");
    await stopProcess(guardProcess, "Node Guard");
    process.exit(requestedExitCode);
  })();
  return shutdownPromise;
}

function stopGuardHeartbeat() {
  if (guardHeartbeatTimer) clearInterval(guardHeartbeatTimer);
  guardHeartbeatTimer = undefined;
  guardHealthCheckInFlight = false;
}

function startGuardHeartbeat(origin) {
  stopGuardHeartbeat();
  guardLastHealthyAt = Date.now();

  const check = async () => {
    if (shuttingDown || hasExited(guardProcess)) {
      stopGuardHeartbeat();
      return;
    }
    if (Date.now() - guardLastHealthyAt > GUARD_HEARTBEAT_TIMEOUT_MS) {
      console.error("[launcher] Node Guard became unresponsive; terminating it");
      stopGuardHeartbeat();
      guardProcess.kill("SIGKILL");
      return;
    }
    if (guardHealthCheckInFlight) return;
    guardHealthCheckInFlight = true;
    try {
      const response = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(GUARD_HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) guardLastHealthyAt = Date.now();
    } catch {
      // A child replacement or process failure can make health transiently
      // unavailable. The outer elapsed deadline still fails the pair closed.
    } finally {
      guardHealthCheckInFlight = false;
    }
  };

  void check();
  guardHeartbeatTimer = setInterval(() => void check(), GUARD_HEARTBEAT_INTERVAL_MS);
}

function unexpectedExit(name, code, signal) {
  if (shuttingDown) return;
  const detail = code === null ? `signal ${signal || "unknown"}` : `code ${code}`;
  console.error(`[launcher] ${name} exited unexpectedly (${detail})`);
  void shutdown(typeof code === "number" && code > 0 ? code : 1);
}

function waitForGuardReady(child) {
  if (!child.stdout) return Promise.reject(new Error("Guard stdout pipe is unavailable"));
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const lines = createInterface({ input: child.stdout });
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) rejectReady(error);
      else resolveReady(port);
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
      const detail = code === null ? `signal ${signal || "unknown"}` : `code ${code}`;
      finish(new Error(`Node Guard exited before readiness (${detail})`));
    };
    const timer = setTimeout(
      () => finish(new Error("Node Guard did not become ready in time")),
      GUARD_START_TIMEOUT_MS,
    );

    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (
          message?.type === "ready"
          && Number.isInteger(message.port)
          && message.port > 0
          && message.port <= 65_535
        ) {
          finish(undefined, message.port);
          return;
        }
      } catch {
        // Forward non-protocol service output without ever printing env values.
      }
      console.log(`[guard] ${line}`);
    });
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function main() {
  const runtime = guardRuntime();
  console.log(`[launcher] Starting Node Guard for ${workspacePath}`);
  guardProcess = spawn(runtime.command, [guardEntry, workspacePath], {
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      PORT: "0",
      LAMARCK_GUARD_TOKEN: guardToken,
      ...runtime.extraEnv,
    },
  });

  const guardPort = await waitForGuardReady(guardProcess);
  guardProcess.once("exit", (code, signal) => unexpectedExit("Node Guard", code, signal));
  if (hasExited(guardProcess)) {
    throw new Error("Node Guard stopped during startup");
  }

  const guardOrigin = `http://127.0.0.1:${guardPort}`;
  startGuardHeartbeat(guardOrigin);
  console.log(`[launcher] Node Guard ready on ${guardOrigin}`);
  console.log("[launcher] Starting Node Core");
  coreProcess = spawn(runtime.command, [coreEntry, workspacePath], {
    stdio: "inherit",
    env: {
      ...process.env,
      LAMARCK_GUARD_ORIGIN: guardOrigin,
      LAMARCK_GUARD_TOKEN: guardToken,
      ...runtime.extraEnv,
    },
  });
  coreProcess.once("error", (error) => {
    if (shuttingDown) return;
    console.error(`[launcher] Node Core failed to start: ${error.message}`);
    void shutdown(1);
  });
  coreProcess.once("exit", (code, signal) => unexpectedExit("Node Core", code, signal));
}

process.once("SIGTERM", () => void shutdown(0));
process.once("SIGINT", () => void shutdown(0));

void main().catch((error) => {
  if (shuttingDown) return;
  console.error(`[launcher] ${error instanceof Error ? error.message : String(error)}`);
  void shutdown(1);
});
