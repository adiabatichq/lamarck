import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { BuildOciBundlePlan, BuildOciPlanInput } from "@lamarck/capsule";
import { assertBuildOciSecurityInvariants } from "@lamarck/capsule";
import { RUNC_PATH, RUNC_ROOT } from "./config";
import { GuestContainmentError } from "./containment-error";
import { fixedCommandEnvironment, runFixedCommand } from "./fixed-command";

const MAX_BUILD_LOG_BYTES = 1024 * 1024;
const BUILD_CGROUP_MOUNT = "/sys/fs/cgroup";
const CLEANUP_TIMEOUT_MS = 5_000;

export interface BuildRunResult {
  exitCode: number;
  logs: string;
}

export interface BuildCapsuleRunner {
  run(
    plan: BuildOciBundlePlan,
    expected: BuildOciPlanInput,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BuildRunResult>;
  cancel(containerId: string, graceMs: number): Promise<void>;
}

/** A fatal containment failure: Host must stop the Guest and retain identity/storage leases. */
export class BuildContainmentError extends GuestContainmentError {
  readonly code = "CAPSULE_BUILD_CONTAINMENT_FAILED";
  readonly storageMayBeInUse = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BuildContainmentError";
  }
}

/** One AbortSignal-owned cancellation path; avoids competing runc signals. */
export class BuildCancellationError extends Error {
  constructor(
    message: string,
    readonly graceMs: number,
  ) {
    super(message);
    this.name = "BuildCancellationError";
  }
}

interface ActiveBuild {
  child: ChildProcess;
  cgroupPath: string;
}

export interface BuildTeardownOperations {
  killCgroup(path: string): Promise<void>;
  waitCgroupEmpty(path: string, timeoutMs: number): Promise<void>;
  stopForeground(child: ChildProcess, timeoutMs: number): Promise<void>;
  deleteContainer(containerId: string): Promise<void>;
}

export interface BuildRunCleanupOperations {
  teardown(containerId: string, cgroupPath: string, child: ChildProcess): Promise<void>;
  removeBundle(bundlePath: string): Promise<void>;
}

export interface LinuxBuildCapsuleRunnerOptions {
  runcPath?: string;
  runcRoot?: string;
  cgroupMount?: string;
  cleanupTimeoutMs?: number;
}

export class LinuxBuildCapsuleRunner implements BuildCapsuleRunner {
  private readonly active = new Map<string, ActiveBuild>();
  private readonly runcPath: string;
  private readonly runcRoot: string;
  private readonly cgroupMount: string;
  private readonly cleanupTimeoutMs: number;

  constructor(options: LinuxBuildCapsuleRunnerOptions = {}) {
    this.runcPath = options.runcPath ?? RUNC_PATH;
    this.runcRoot = options.runcRoot ?? RUNC_ROOT;
    this.cgroupMount = options.cgroupMount ?? BUILD_CGROUP_MOUNT;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
    if (!this.runcPath.startsWith("/") || !this.runcRoot.startsWith("/") || !this.cgroupMount.startsWith("/")) {
      throw new Error("Build runner paths must be absolute");
    }
    if (!Number.isSafeInteger(this.cleanupTimeoutMs) || this.cleanupTimeoutMs < 100 || this.cleanupTimeoutMs > 30_000) {
      throw new Error("Build cleanup timeout is invalid");
    }
  }

  async run(
    plan: BuildOciBundlePlan,
    expected: BuildOciPlanInput,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BuildRunResult> {
    assertBuildOciSecurityInvariants(plan, expected);
    if (this.active.has(plan.containerId)) throw new Error("Build container is already running");
    if (signal?.aborted) throw signal.reason ?? new Error("Build aborted");
    const cgroupPath = this.cgroupPath(plan);
    let child: ChildProcess | undefined;
    let operationError: unknown;
    let result: BuildRunResult | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await mkdir(this.runcRoot, { recursive: true, mode: 0o700 });
      await rm(plan.bundlePath, { recursive: true, force: true });
      await mkdir(plan.bundlePath, { recursive: true, mode: 0o700 });
      await writeFile(`${plan.bundlePath}/config.json`, `${JSON.stringify(plan.config)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      if (signal?.aborted) throw signal.reason ?? new Error("Build aborted");

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
        env: fixedCommandEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.active.set(plan.containerId, { child, cgroupPath });
      const chunks: Buffer[] = [];
      let bytes = 0;
      const capture = (chunk: Buffer) => {
        if (bytes >= MAX_BUILD_LOG_BYTES) return;
        const kept = Buffer.from(chunk.subarray(0, MAX_BUILD_LOG_BYTES - bytes));
        chunks.push(kept);
        bytes += kept.byteLength;
      };
      child.stdout!.on("data", capture);
      child.stderr!.on("data", capture);

      const exit = waitForChild(child);
      const timeout = new Promise<{ type: "timeout" }>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
      });
      let resolveAbort!: () => void;
      const aborted = new Promise<{ type: "abort" }>((resolve) => {
        resolveAbort = () => resolve({ type: "abort" });
      });
      onAbort = () => resolveAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) resolveAbort();
      const outcome = await Promise.race([
        exit.then((exitCode) => ({ type: "exit" as const, exitCode })),
        timeout,
        aborted,
      ]);
      if (outcome.type === "timeout") {
        await this.cancel(plan.containerId, 0);
        throw new Error(`Build Capsule timed out after ${timeoutMs}ms`);
      }
      if (outcome.type === "abort") {
        const graceMs = signal?.reason instanceof BuildCancellationError
          ? signal.reason.graceMs
          : 0;
        await this.cancel(plan.containerId, graceMs);
        throw signal?.reason ?? new Error("Build aborted");
      }
      result = {
        exitCode: outcome.exitCode,
        logs: Buffer.concat(chunks).toString("utf8"),
      };
    } catch (error) {
      operationError = error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      try {
        await runAuthoritativeBuildRunCleanup({
          containerId: plan.containerId,
          bundlePath: plan.bundlePath,
          cgroupPath,
          child,
          operationError,
          operations: {
            teardown: async (containerId, targetCgroupPath, targetChild) => {
              await this.teardown(containerId, targetCgroupPath, targetChild);
            },
            removeBundle: async (bundlePath) => {
              await rm(bundlePath, { recursive: true, force: true });
            },
          },
        });
      } finally {
        this.active.delete(plan.containerId);
      }
    }
    if (operationError !== undefined) throw operationError;
    return result!;
  }

  async cancel(containerId: string, graceMs: number): Promise<void> {
    if (!/^b-[a-f0-9]{32}$/.test(containerId)) throw new Error("invalid Build container ID");
    const active = this.active.get(containerId);
    if (!active) return;
    await this.runcSignal(containerId, "TERM");
    if (graceMs > 0) {
      const exited = await Promise.race([
        waitForChild(active.child).then(() => true),
        delay(Math.min(graceMs, 30_000)).then(() => false),
      ]);
      if (exited) return;
    }
    if (active.child.exitCode === null) await this.runcSignal(containerId, "KILL");
  }

  private cgroupPath(plan: BuildOciBundlePlan): string {
    const relative = plan.config.linux.cgroupsPath;
    if (!/^lamarck\/builds\/b-[a-f0-9]{32}$/.test(relative)) {
      throw new Error("Build plan contains an invalid cgroup path");
    }
    return `${this.cgroupMount}/${relative}`;
  }

  private async teardown(containerId: string, cgroupPath: string, child: ChildProcess): Promise<void> {
    await runAuthoritativeBuildTeardown({
      containerId,
      cgroupPath,
      child,
      cleanupTimeoutMs: this.cleanupTimeoutMs,
      operations: {
        killCgroup,
        waitCgroupEmpty,
        stopForeground,
        deleteContainer: async (targetContainerId) => {
          const result = await runFixedCommand(this.runcPath, [
            "--root",
            this.runcRoot,
            "delete",
            "--force",
            targetContainerId,
          ], { allowExitCodes: [0, 1] });
          if (
            result.exitCode !== 0
            && !/does not exist|not found|cannot find/i.test(`${result.stderr}\n${result.stdout}`)
          ) {
            throw new Error(`runc delete failed: ${result.stderr || result.stdout || "no diagnostic"}`);
          }
        },
      },
    });
  }

  private async runcSignal(containerId: string, signal: "TERM" | "KILL"): Promise<void> {
    await runFixedCommand(this.runcPath, [
      "--root",
      this.runcRoot,
      "kill",
      containerId,
      signal,
    ]);
  }
}

/**
 * Closes both creator authority and its mutable OCI bundle. A bundle removal
 * failure is containment-fatal: a later launch must never inherit an old
 * config after this Build identity was reported retired.
 */
export async function runAuthoritativeBuildRunCleanup(options: {
  containerId: string;
  bundlePath: string;
  cgroupPath: string;
  child?: ChildProcess;
  operationError?: unknown;
  operations: BuildRunCleanupOperations;
}): Promise<void> {
  if (!/^b-[a-f0-9]{32}$/.test(options.containerId)) {
    throw new Error("invalid Build container ID");
  }
  if (!options.bundlePath.startsWith("/") || !options.cgroupPath.startsWith("/")) {
    throw new Error("Build cleanup paths must be absolute");
  }
  const failures: unknown[] = [];
  if (options.child) {
    try {
      await options.operations.teardown(
        options.containerId,
        options.cgroupPath,
        options.child,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await options.operations.removeBundle(options.bundlePath);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 0) return;
  const causes = options.operationError === undefined
    ? failures
    : [options.operationError, ...failures];
  throw new BuildContainmentError(
    `Build ${options.containerId} could not be proven retired; Guest must be terminated`,
    { cause: new AggregateError(causes, "Build operation and containment cleanup failed") },
  );
}

export async function runAuthoritativeBuildTeardown(options: {
  containerId: string;
  cgroupPath: string;
  child: ChildProcess;
  cleanupTimeoutMs: number;
  operations: BuildTeardownOperations;
}): Promise<void> {
  if (!/^b-[a-f0-9]{32}$/.test(options.containerId)) {
    throw new Error("invalid Build container ID");
  }
  if (!options.cgroupPath.startsWith("/")) throw new Error("Build cgroup path must be absolute");
  const failures: unknown[] = [];
  try {
    // The foreground runc invocation is the only trusted creator. Stop it
    // before killing or observing the cgroup so a populated=0 result cannot be
    // invalidated by a launch that was still in progress during cancellation.
    await options.operations.stopForeground(options.child, options.cleanupTimeoutMs);
  } catch (error) {
    failures.push(error);
  }
  try {
    await options.operations.killCgroup(options.cgroupPath);
  } catch (error) {
    failures.push(error);
  }
  try {
    await options.operations.waitCgroupEmpty(options.cgroupPath, options.cleanupTimeoutMs);
  } catch (error) {
    failures.push(error);
  }
  try {
    await options.operations.deleteContainer(options.containerId);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new BuildContainmentError(
      `Build ${options.containerId} containment cleanup failed`,
      { cause: new AggregateError(failures, "Build containment proof failed") },
    );
  }
}

async function stopForeground(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    waitForChild(child),
    delay(timeoutMs).then(() => {
      throw new Error("foreground runc process did not exit");
    }),
  ]);
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
    try {
      if (/^populated 0$/m.test(await readFile(`${path}/cgroup.events`, "utf8"))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await delay(20);
  }
  throw new Error(`Build cgroup ${path} remained populated after ${timeoutMs}ms`);
}

function waitForChild(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(128);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal === null ? code ?? 255 : 128));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
