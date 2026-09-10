import { readFile, writeFile } from "node:fs/promises";
import { runFixedCommand } from "./fixed-command";
import { BuildContainmentError } from "./build-runner";

export type BuildPhaseRequest =
  | { op: "materialize"; source: string; destination: string }
  | { op: "validate-input"; workspace: string; installDigest: string }
  | { op: "install-input"; workspace: string }
  | { op: "validate-dependencies"; directory: string }
  | { op: "validate-sdk"; nodeModules: string }
  | { op: "chown"; root: string; uid: number; gid: number }
  | { op: "seal"; workspace: string; output: string; mkfsPath: string; warm: boolean };

/** A native trampoline enters the cgroup BEFORE Node allocates its heap. */
export async function runBuildPhase<T>(cgroup: string, request: BuildPhaseRequest, signal: AbortSignal): Promise<T> {
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 16_384) throw new Error("Build worker request exceeds its bound");
  try {
    const result = await runFixedCommand("/usr/libexec/lamarck-build-worker", [cgroup, payload], {
      signal, timeoutMs: 5 * 60_000,
    });
    const value = JSON.parse(result.stdout);
    if (value.error) {
      const error = new Error(String(value.error));
      if (value.code) Object.assign(error, { code: value.code });
      throw error;
    }
    return value.result as T;
  } finally {
    // A killed worker may have a live mkfs child. Confirm the entire worker
    // subtree is empty before the caller may unmount or release its grant.
    const worker = `${cgroup}/worker`;
    try {
      await writeFile(`${worker}/cgroup.kill`, "1");
      const deadline = Date.now() + 5_000;
      while (!/^populated 0$/m.test(await readFile(`${worker}/cgroup.events`, "utf8"))) {
        if (Date.now() >= deadline) throw new Error("Build worker descendants remained live");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } catch (error) {
      throw new BuildContainmentError("Build worker cleanup was not authoritative", { cause: error });
    }
  }
}
