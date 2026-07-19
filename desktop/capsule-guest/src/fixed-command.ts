import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 64 * 1024;

export interface FixedCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runFixedCommand(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    allowExitCodes?: readonly number[];
    signal?: AbortSignal;
  } = {},
): Promise<FixedCommandResult> {
  if (!executable.startsWith("/")) throw new Error("fixed command executable must be absolute");
  if (args.some((argument) => argument.includes("\0"))) throw new Error("command argument contains NUL");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60_000) {
    throw new Error("fixed command timeout is outside the allowed range");
  }
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error("fixed command aborted");
  }
  const allowed = new Set(options.allowExitCodes ?? [0]);
  const result = await new Promise<FixedCommandResult>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd ?? "/",
      env: options.env ?? fixedCommandEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      // Like timeout, settlement waits for `close`: callers must not begin
      // privileged rollback while the command can still mutate containment.
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) return;
      const kept = Buffer.from(chunk.subarray(0, MAX_OUTPUT_BYTES - stdoutBytes));
      stdout.push(kept);
      stdoutBytes += kept.byteLength;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) return;
      const kept = Buffer.from(chunk.subarray(0, MAX_OUTPUT_BYTES - stderrBytes));
      stderr.push(kept);
      stderrBytes += kept.byteLength;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // Do not settle here. A privileged command may still be inside mount(2)
      // or another containment-changing operation until the kernel reports
      // process exit and Node closes its stdio handles. Callers must not begin
      // rollback or reuse the affected path before that authoritative point.
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (timedOut || aborted) return;
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (timedOut) {
        reject(new Error(`${executable} timed out after ${timeoutMs}ms`));
        return;
      }
      if (aborted) {
        reject(options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error(`${executable} was aborted`));
        return;
      }
      if (signal !== null) {
        reject(new Error(`${executable} terminated by ${signal}`));
        return;
      }
      resolve({
        exitCode: code ?? 255,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
  });
  if (!allowed.has(result.exitCode)) {
    throw new Error(
      `${executable} exited ${result.exitCode}: ${result.stderr || result.stdout || "no diagnostic"}`,
    );
  }
  return result;
}

export function fixedCommandEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: "/root",
    LANG: "C.UTF-8",
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    TMPDIR: "/run/lamarck/tmp",
  };
}
