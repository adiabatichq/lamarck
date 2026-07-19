import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import {
  assertRuncLaunchRequest,
  type RuncDriver,
  type RuncExecution,
  type RuncLaunchRequest,
  type WorkloadExit,
} from "../drivers";
import { openWorkloadSdkBridge, type WorkloadSdkBridge } from "./sdk-bridge";

const DEFAULT_RUNC_PATH = "/usr/sbin/runc";
const DEFAULT_RUNC_ROOT = "/run/lamarck/runc";
const DEFAULT_CGROUP_MOUNT = "/sys/fs/cgroup";
const START_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const CONTAINER_ID_PATTERN = /^[wb]-[a-f0-9]{32}$/;

export interface LinuxRuncDriverOptions {
  runcPath?: string;
  runcRoot?: string;
  startTimeoutMs?: number;
  commandTimeoutMs?: number;
  diagnosticLogDirectory?: string;
  cgroupMount?: string;
}

interface ActiveExecution {
  child: ChildProcess;
  exit: Promise<WorkloadExit>;
  exited: boolean;
  launchError?: Error;
  cgroupPath: string;
  bundlePath: string;
  sdkBridge: WorkloadSdkBridge;
  stopPromise?: Promise<void>;
  deletePromise?: Promise<void>;
}

export interface RuncRollbackOperations {
  killCgroup(path: string): Promise<void>;
  waitCgroupEmpty(path: string, timeoutMs: number): Promise<void>;
  stopForeground(timeoutMs: number): Promise<void>;
  deleteContainer(containerId: string): Promise<void>;
}

export type RuncStopOperations = Omit<RuncRollbackOperations, "deleteContainer">;

/** Signals that a workload process may have survived its launch transaction. */
export class RuncContainmentError extends Error {
  readonly code = "CAPSULE_RUNC_CONTAINMENT_FAILED";
  readonly fatalGuest = true;
  readonly storageMayBeInUse = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuncContainmentError";
  }
}

/** A bounded runc control command failed to produce an authoritative result. */
export class RuncCommandTimeoutError extends Error {
  readonly code = "CAPSULE_RUNC_COMMAND_TIMEOUT";

  constructor(readonly timeoutMs: number, options?: ErrorOptions) {
    super(`runc control command did not settle within ${timeoutMs}ms`, options);
    this.name = "RuncCommandTimeoutError";
  }
}

/**
 * The only production process adapter used inside the Linux Guest.
 *
 * It always invokes a fixed runc binary without a shell, materializes the
 * already-authorized OCI plan verbatim, exposes the authenticated SDK stream
 * only through a workload-private Unix socket, and keeps the foreground runc
 * process as the authoritative waiter.
 */
export class LinuxRuncDriver implements RuncDriver {
  readonly available: boolean;
  private readonly runcPath: string;
  private readonly runcRoot: string;
  private readonly startTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly diagnosticLogDirectory: string | undefined;
  private readonly cgroupMount: string;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly retired = new Set<string>();

  constructor(options: LinuxRuncDriverOptions = {}) {
    this.runcPath = options.runcPath ?? DEFAULT_RUNC_PATH;
    this.runcRoot = options.runcRoot ?? DEFAULT_RUNC_ROOT;
    this.startTimeoutMs = boundedTimeout(options.startTimeoutMs ?? START_TIMEOUT_MS, "startTimeoutMs");
    this.commandTimeoutMs = boundedTimeout(options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS, "commandTimeoutMs");
    this.diagnosticLogDirectory = options.diagnosticLogDirectory;
    this.cgroupMount = options.cgroupMount ?? DEFAULT_CGROUP_MOUNT;
    if (!this.cgroupMount.startsWith("/")) throw new Error("cgroupMount must be absolute");
    this.available = isExecutable(this.runcPath) && process.platform === "linux";
  }

  async start(request: RuncLaunchRequest): Promise<RuncExecution> {
    if (!this.available) throw new Error(`runc is unavailable at ${this.runcPath}`);
    assertRuncLaunchRequest(request);
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new Error("runc launch aborted");
    }
    const { plan } = request;
    assertContainerId(plan.containerId);
    if (this.active.has(plan.containerId)) {
      throw new Error(`runc container ${plan.containerId} is already active`);
    }
    if (this.retired.has(plan.containerId)) {
      throw new Error(`runc container ${plan.containerId} cannot be reused in this Guest boot`);
    }
    const cgroupPath = this.cgroupPath(plan.config.linux.cgroupsPath);

    await mkdir(this.runcRoot, { recursive: true, mode: 0o700 });
    await rm(plan.bundlePath, { recursive: true, force: true });
    await mkdir(plan.bundlePath, { recursive: true, mode: 0o700 });
    await writeFile(
      `${plan.bundlePath}/config.json`,
      `${JSON.stringify(plan.config)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    let sdkBridge: WorkloadSdkBridge;
    try {
      sdkBridge = await openWorkloadSdkBridge({
        bridgeRoot: plan.sdkBridgeRoot,
        socketPath: plan.sdkSocketHostPath,
        uid: request.expectedIdentity.mappedHostUid + 1_000,
        gid: request.expectedIdentity.mappedHostGid + 1_000,
        upstream: request.sdkChannel.source,
      });
      sdkBridge.assertOpen();
    } catch (error) {
      request.sdkChannel.source.destroy();
      await rm(plan.bundlePath, { recursive: true, force: true });
      throw error;
    }

    const stderrCapture = new PassThrough();
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    stderrCapture.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_DIAGNOSTIC_BYTES) return;
      const remaining = MAX_DIAGNOSTIC_BYTES - stderrBytes;
      const kept = Buffer.from(chunk.subarray(0, remaining));
      stderrChunks.push(kept);
      stderrBytes += kept.byteLength;
    });

    let diagnosticFile: ReturnType<typeof createWriteStream> | undefined;
    let child: ChildProcess;
    try {
      diagnosticFile = this.diagnosticLogDirectory
        ? await this.openDiagnosticLog(plan.containerId)
        : undefined;
      sdkBridge.assertOpen();
      child = spawn(this.runcPath, [
      "--root",
      this.runcRoot,
      "run",
      "--bundle",
      plan.bundlePath,
      "--keep",
      plan.containerId,
      ], {
        cwd: "/",
        env: fixedRuncEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await sdkBridge.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      await rm(plan.bundlePath, { recursive: true, force: true }).catch((cleanupError) => {
        failures.push(cleanupError);
      });
      throw failures.length === 1
        ? error
        : new AggregateError(failures, "runc launch preparation cleanup failed");
    }
    child.stderr?.pipe(stderrCapture);
    if (diagnosticFile) child.stderr?.pipe(diagnosticFile, { end: false });
    if (request.logsChannel) {
      child.stdout?.pipe(request.logsChannel.source, { end: false });
      child.stderr?.pipe(request.logsChannel.source, { end: false });
    } else {
      child.stdout?.resume();
    }

    const active: ActiveExecution = {
      child,
      exited: false,
      exit: Promise.resolve({ exitCode: null, signal: null }),
      cgroupPath,
      bundlePath: plan.bundlePath,
      sdkBridge,
    };
    active.exit = waitForChild(child).then(
      async (exit) => {
        active.exited = true;
        diagnosticFile?.end();
        await this.closeSdkBridge(plan.containerId, sdkBridge);
        return exit;
      },
      async (error) => {
        active.launchError = error instanceof Error ? error : new Error(String(error));
        diagnosticFile?.end();
        try {
          await this.closeSdkBridge(plan.containerId, sdkBridge);
        } catch (cleanupError) {
          throw new RuncContainmentError(
            `runc launch failure retained SDK authority for ${plan.containerId}`,
            { cause: new AggregateError([active.launchError, cleanupError]) },
          );
        }
        throw active.launchError;
      },
    );
    // Start observes this rejection below; the side observer prevents a
    // failed spawn from becoming an unhandled process-level rejection while
    // state polling is still in flight.
    void active.exit.catch(() => undefined);
    this.active.set(plan.containerId, active);

    try {
      const started = await this.waitUntilStarted(plan.containerId, active, request.signal);
      if (!started) {
        const exit = await active.exit;
        if (active.launchError) throw active.launchError;
        if (exit.exitCode !== 0) {
          throw new Error(
            `runc failed to start ${plan.containerId}: ${boundedDiagnostic(stderrChunks)}`,
          );
        }
      }
      if (request.signal?.aborted) {
        throw request.signal.reason ?? new Error("runc launch aborted");
      }
    } catch (error) {
      try {
        await this.authoritativeLaunchRollback(
          plan.containerId,
          plan.bundlePath,
          cgroupPath,
          active,
        );
      } catch (cleanupError) {
        throw new RuncContainmentError(
          `runc launch rollback for ${plan.containerId} could not prove containment`,
          { cause: new AggregateError([error, cleanupError], "runc launch and rollback failed") },
        );
      }
      throw error;
    }

    const onAbort = () => {
      void this.stop(plan.containerId, 0).catch(() => undefined);
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    const exit = active.exit.finally(() => {
      request.signal?.removeEventListener("abort", onAbort);
    });
    return {
      containerId: plan.containerId,
      wait: async () => ({ ...await exit }),
    };
  }

  async stop(containerId: string, graceMs: number): Promise<void> {
    assertContainerId(containerId);
    const boundedGrace = Math.max(0, Math.min(30_000, Math.trunc(graceMs)));
    const execution = this.active.get(containerId);
    if (!execution) {
      if (this.retired.has(containerId)) return;
      throw new RuncContainmentError(
        `runc cannot prove containment for unknown container ${containerId}`,
      );
    }
    if (execution.deletePromise) {
      await execution.deletePromise;
      return;
    }
    execution.stopPromise ??= this.authoritativeStop(containerId, execution, boundedGrace);
    await execution.stopPromise;
  }

  async delete(containerId: string): Promise<void> {
    assertContainerId(containerId);
    const execution = this.active.get(containerId);
    if (!execution) {
      if (this.retired.has(containerId)) return;
      throw new RuncContainmentError(
        `runc cannot authoritatively delete unknown container ${containerId}`,
      );
    }
    await this.deleteExecution(containerId, execution);
  }

  private async waitUntilStarted(
    containerId: string,
    active: ActiveExecution,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("runc launch aborted");
      if (active.launchError) throw active.launchError;
      if (active.exited) return false;
      const state = await this.runCommand(["state", containerId], true);
      if (state.exitCode === 0) {
        try {
          const parsed = JSON.parse(state.stdout) as { status?: unknown };
          if (parsed.status === "running" || parsed.status === "created") return true;
        } catch {
          // Keep polling; malformed state is treated as launch failure at timeout.
        }
      }
      await delay(20);
    }
    throw new Error(`runc did not report ${containerId} started within ${this.startTimeoutMs}ms`);
  }

  private async kill(containerId: string, signal: "TERM" | "KILL"): Promise<void> {
    const result = await this.runCommand(["kill", containerId, signal], true);
    if (result.exitCode !== 0 && !isMissingContainerDiagnostic(result.stderr)) {
      throw new Error(`runc kill ${signal} failed: ${result.stderr}`);
    }
  }

  private async authoritativeLaunchRollback(
    containerId: string,
    bundlePath: string,
    cgroupPath: string,
    active: ActiveExecution,
  ): Promise<void> {
    if (active.bundlePath !== bundlePath || active.cgroupPath !== cgroupPath) {
      throw new RuncContainmentError(`runc launch authority changed for ${containerId}`);
    }
    await this.deleteExecution(containerId, active);
  }

  private async authoritativeStop(
    containerId: string,
    active: ActiveExecution,
    graceMs: number,
  ): Promise<void> {
    if (!active.exited && graceMs > 0) {
      try {
        await this.kill(containerId, "TERM");
        await Promise.race([
          active.exit.then(() => undefined),
          delay(graceMs),
        ]);
      } catch {
        // A graceful runc signal is best-effort. The trusted cgroup kill and
        // final population proof below remain the authority boundary.
      }
    }
    await runAuthoritativeRuncStop({
      containerId,
      cgroupPath: active.cgroupPath,
      timeoutMs: this.commandTimeoutMs,
      operations: {
        killCgroup,
        waitCgroupEmpty,
        stopForeground: async (timeoutMs) => this.stopForeground(active, timeoutMs),
      },
    });
  }

  private async deleteExecution(containerId: string, active: ActiveExecution): Promise<void> {
    active.deletePromise ??= (async () => {
      const failures: unknown[] = [];
      if (active.stopPromise) {
        try {
          await active.stopPromise;
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await runAuthoritativeRuncRollback({
          containerId,
          cgroupPath: active.cgroupPath,
          timeoutMs: this.commandTimeoutMs,
          operations: {
            killCgroup,
            waitCgroupEmpty,
            stopForeground: async (timeoutMs) => this.stopForeground(active, timeoutMs),
            deleteContainer: async (targetContainerId) => {
              const result = await this.runCommand(["delete", "--force", targetContainerId], true);
              if (result.exitCode !== 0 && !isMissingContainerDiagnostic(result.stderr)) {
                throw new Error(`runc delete failed: ${result.stderr || "no diagnostic"}`);
              }
            },
          },
        });
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.closeSdkBridge(containerId, active.sdkBridge);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new RuncContainmentError(
          `runc deletion for ${containerId} could not prove containment and SDK cleanup`,
          { cause: new AggregateError(failures) },
        );
      }
      // Retain the active handle and bundle as quarantine evidence until both
      // the cgroup proof and exact runc-state deletion have succeeded.
      await rm(active.bundlePath, { recursive: true, force: true });
      this.active.delete(containerId);
      this.rememberRetired(containerId);
    })();
    await active.deletePromise;
  }

  private async closeSdkBridge(containerId: string, bridge: WorkloadSdkBridge): Promise<void> {
    try {
      await bridge.close();
    } catch (cause) {
      throw new RuncContainmentError(
        `System SDK bridge for ${containerId} could not be removed`,
        { cause },
      );
    }
  }

  private rememberRetired(containerId: string): void {
    this.retired.add(containerId);
    while (this.retired.size > 4_096) {
      const oldest = this.retired.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.retired.delete(oldest);
    }
  }

  private async stopForeground(active: ActiveExecution, timeoutMs: number): Promise<void> {
    if (active.exited || active.child.exitCode !== null || active.child.signalCode !== null) return;
    // A spawn failure has no OS process even though ChildProcess emits `error`
    // rather than `exit`.
    if (active.child.pid === undefined) return;
    const signaled = active.child.kill("SIGKILL");
    if (!signaled && !active.exited) throw new Error("foreground runc process rejected SIGKILL");
    await Promise.race([
      active.exit.then(() => undefined),
      delay(timeoutMs).then(() => {
        throw new Error("foreground runc process did not exit after SIGKILL");
      }),
    ]);
  }

  private cgroupPath(relativePath: string): string {
    if (!/^lamarck\/apps\/a-[a-f0-9]{32}\/workloads\/w-[a-f0-9]{32}$/.test(relativePath)) {
      throw new Error("trusted OCI plan contains an invalid workload cgroup path");
    }
    return `${this.cgroupMount}/${relativePath}`;
  }

  private async runCommand(
    args: string[],
    tolerateSpawnFailure = false,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const child = spawn(this.runcPath, ["--root", this.runcRoot, ...args], {
      cwd: "/",
      env: fixedRuncEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return await waitForRuncCommandResult(
      child,
      this.commandTimeoutMs,
      tolerateSpawnFailure,
    );
  }

  private async openDiagnosticLog(containerId: string) {
    const directory = this.diagnosticLogDirectory!;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = `${directory}/${containerId}.log`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return createWriteStream(path, { flags: "a", mode: 0o600 });
  }
}

/**
 * Collect a runc control command without ever waiting indefinitely for an
 * `exit` event. A timeout is uncertainty, not success: callers performing
 * teardown aggregate it into RuncContainmentError and terminate the Guest.
 */
export async function waitForRuncCommandResult(
  child: ChildProcess,
  timeoutMsValue: number,
  tolerateSpawnFailure = false,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const timeoutMs = boundedTimeout(timeoutMsValue, "runc command timeoutMs");
  return await new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      operation();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled || stdoutBytes >= MAX_DIAGNOSTIC_BYTES) return;
      const kept = Buffer.from(chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - stdoutBytes));
      stdout.push(kept);
      stdoutBytes += kept.byteLength;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled || stderrBytes >= MAX_DIAGNOSTIC_BYTES) return;
      const kept = Buffer.from(chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - stderrBytes));
      stderr.push(kept);
      stderrBytes += kept.byteLength;
    });
    child.once("error", (error) => {
      finish(() => {
        if (tolerateSpawnFailure) {
          resolve({ exitCode: null, stdout: "", stderr: error.message });
        } else reject(error);
      });
    });
    child.once("exit", (exitCode) => {
      finish(() => resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      }));
    });
    timer = setTimeout(() => {
      // The deadline owns settlement before signalling the child. This avoids
      // a synchronous/mock exit emitted by kill() being mistaken for a timely
      // authoritative command result.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let cause: Error | undefined;
      try {
        if (!child.kill("SIGKILL")) cause = new Error("runc control process rejected SIGKILL");
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
      }
      reject(new RuncCommandTimeoutError(timeoutMs, cause ? { cause } : undefined));
    }, timeoutMs);
  });
}

export async function runAuthoritativeRuncRollback(options: {
  containerId: string;
  cgroupPath: string;
  timeoutMs: number;
  operations: RuncRollbackOperations;
}): Promise<void> {
  assertContainerId(options.containerId);
  if (!options.cgroupPath.startsWith("/")) throw new Error("workload cgroup path must be absolute");
  boundedTimeout(options.timeoutMs, "rollback timeoutMs");
  const failures: unknown[] = [];
  try {
    await options.operations.killCgroup(options.cgroupPath);
  } catch (error) {
    failures.push(error);
  }
  try {
    // Stop the foreground creator before the final population proof. If the
    // first cgroup.kill raced initial container creation, the subsequent
    // populated=0 check cannot be invalidated by this runc invocation.
    await options.operations.stopForeground(options.timeoutMs);
  } catch (error) {
    failures.push(error);
  }
  try {
    await options.operations.waitCgroupEmpty(options.cgroupPath, options.timeoutMs);
  } catch (error) {
    failures.push(error);
  }
  try {
    await options.operations.deleteContainer(options.containerId);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new RuncContainmentError(
      `runc rollback for ${options.containerId} failed`,
      { cause: new AggregateError(failures, "runc containment proof failed") },
    );
  }
}

export async function runAuthoritativeRuncStop(options: {
  containerId: string;
  cgroupPath: string;
  timeoutMs: number;
  operations: RuncStopOperations;
}): Promise<void> {
  assertContainerId(options.containerId);
  if (!options.cgroupPath.startsWith("/")) throw new Error("workload cgroup path must be absolute");
  boundedTimeout(options.timeoutMs, "stop timeoutMs");
  const failures: unknown[] = [];
  try {
    await options.operations.killCgroup(options.cgroupPath);
  } catch (error) {
    failures.push(error);
  }
  try {
    // The foreground runc invocation is the only trusted creator. It must be
    // gone before populated=0 can be accepted as a stable containment proof.
    await options.operations.stopForeground(options.timeoutMs);
  } catch (error) {
    failures.push(error);
  }
  try {
    await options.operations.waitCgroupEmpty(options.cgroupPath, options.timeoutMs);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new RuncContainmentError(
      `runc stop for ${options.containerId} failed`,
      { cause: new AggregateError(failures, "runc stop containment proof failed") },
    );
  }
}

async function killCgroup(path: string): Promise<void> {
  try {
    await writeFile(`${path}/cgroup.kill`, "1\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function waitCgroupEmpty(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let events: string;
    try {
      events = await readFile(`${path}/cgroup.events`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const populated = [...events.matchAll(/^populated\s+([01])\s*$/gm)];
    if (populated.length !== 1) throw new Error(`cgroup ${path} has malformed population state`);
    if (populated[0]![1] === "0") return;
    await delay(20);
  }
  throw new Error(`cgroup ${path} remained populated after ${timeoutMs}ms`);
}

function waitForChild(child: ChildProcess): Promise<WorkloadExit> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function fixedRuncEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: "/root",
    LANG: "C.UTF-8",
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    TMPDIR: "/run/lamarck/tmp",
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function assertContainerId(value: string): void {
  if (!CONTAINER_ID_PATTERN.test(value)) throw new Error("invalid derived runc container ID");
}

function boundedTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new Error(`${label} must be between 100 and 60000 milliseconds`);
  }
  return value;
}

function boundedDiagnostic(chunks: Buffer[]): string {
  const diagnostic = Buffer.concat(chunks).toString("utf8").trim();
  return diagnostic.length > 0 ? diagnostic : "no runc diagnostic";
}

function isMissingContainerDiagnostic(value: string): boolean {
  return /does not exist|not found|cannot find/i.test(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
