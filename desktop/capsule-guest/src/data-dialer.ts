import { spawn, type ChildProcess } from "node:child_process";
import { fixedCommandEnvironment } from "./fixed-command";

const READY_LINE = "READY\n";
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

export interface GuestDataDialer {
  open(): Promise<void>;
  close(): void;
}

export interface VsockDataDialerOptions {
  executable?: string;
  readyTimeoutMs?: number;
}

/**
 * Opens exactly one ticket-neutral Guest -> Host DATA transport. The Host
 * authenticates and assigns that raw connection by writing the framed ticket
 * prelude; the relay itself never sees or selects App identity.
 */
export class VsockDataDialer implements GuestDataDialer {
  private readonly executable: string;
  private readonly readyTimeoutMs: number;
  private readonly children = new Set<ChildProcess>();
  private closed = false;

  constructor(options: VsockDataDialerOptions = {}) {
    this.executable = options.executable ?? "/usr/libexec/lamarck-vsock-relay";
    this.readyTimeoutMs = options.readyTimeoutMs ?? 5_000;
    if (!this.executable.startsWith("/")) throw new Error("DATA dialer executable must be absolute");
    if (!Number.isSafeInteger(this.readyTimeoutMs) || this.readyTimeoutMs < 100 || this.readyTimeoutMs > 60_000) {
      throw new Error("DATA dialer readiness timeout is outside policy");
    }
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error("DATA dialer is closed");
    const child = spawn(this.executable, ["data"], {
      cwd: "/",
      env: fixedCommandEnvironment(),
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let diagnostic = Buffer.alloc(0);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stderr?.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) {
          child.kill("SIGKILL");
          reject(error);
        } else {
          resolve();
        }
      };
      const onData = (chunk: Buffer) => {
        if (diagnostic.byteLength < MAX_DIAGNOSTIC_BYTES) {
          diagnostic = Buffer.concat([
            diagnostic,
            chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - diagnostic.byteLength),
          ]);
        }
        const text = diagnostic.toString("utf8");
        if (text === READY_LINE) finish();
        else if (text.includes("\n")) finish(new Error(`DATA dialer emitted an invalid readiness record: ${bounded(text)}`));
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(new Error(
          `DATA dialer exited before readiness (${signal ?? code ?? "unknown"}): ${bounded(diagnostic.toString("utf8"))}`,
        ));
      };
      const timer = setTimeout(() => {
        finish(new Error(`DATA dialer did not connect within ${this.readyTimeoutMs}ms`));
      }, this.readyTimeoutMs);
      child.stderr?.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.children) child.kill("SIGKILL");
    this.children.clear();
  }
}

function bounded(value: string): string {
  const normalized = value.trim().replace(/[\r\n\t]+/g, " ");
  return normalized.slice(0, 512) || "no diagnostic";
}
