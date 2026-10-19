import type { AppWorkloadDiagnostic } from "../../shared/app-runtime";

export const DIAGNOSTIC_BYTES = 128 * 1024;
export const DIAGNOSTIC_RUNS = 64;
export const DIAGNOSTIC_APP_RUNS = 8;
export const DIAGNOSTIC_RETENTION_MS = 60 * 60 * 1000;
interface Entry {
  value: Omit<AppWorkloadDiagnostic, "output">;
  bytes: Buffer;
  secrets: string[];
}

/** Disposable Host evidence. No disk store, D0 events, or runtime authority. */
export class CapsuleDiagnostics {
  readonly #entries = new Map<string, Entry>();
  constructor(private readonly hostSecrets: readonly string[], private readonly now = Date.now) {}

  begin(appId: string, kind: "service" | "job", workloadId: string, executionId: string): void {
    this.#prune();
    if (this.#entries.has(executionId)) throw new Error("Duplicate diagnostic execution");
    const appRuns = [...this.#entries].filter(([, entry]) => entry.value.appId === appId);
    while (appRuns.length >= DIAGNOSTIC_APP_RUNS) this.#entries.delete(appRuns.shift()![0]);
    while (this.#entries.size >= DIAGNOSTIC_RUNS) this.#entries.delete(this.#entries.keys().next().value!);
    this.#entries.set(executionId, {
      value: { appId, kind, workloadId, executionId, version: null, startedAt: this.now(), endedAt: null, failure: null, droppedBytes: 0 },
      bytes: Buffer.alloc(0), secrets: [...this.hostSecrets],
    });
  }

  bind(executionId: string, version: string, secrets: readonly string[]): void {
    const entry = this.#entries.get(executionId);
    if (!entry) return;
    entry.value = { ...entry.value, version };
    entry.secrets.push(...secrets.filter(Boolean));
  }

  append(executionId: string, chunk: Uint8Array): void {
    const entry = this.#entries.get(executionId);
    if (!entry) return;
    const excess = Math.max(0, entry.bytes.length + chunk.byteLength - DIAGNOSTIC_BYTES);
    entry.value = { ...entry.value, droppedBytes: entry.value.droppedBytes + excess };
    // Copy only the retained suffix; a large chunk cannot retain its backing buffer.
    entry.bytes = chunk.byteLength >= DIAGNOSTIC_BYTES
      ? Buffer.from(chunk.subarray(chunk.byteLength - DIAGNOSTIC_BYTES))
      : Buffer.concat([entry.bytes.subarray(Math.min(excess, entry.bytes.length)), chunk]);
  }

  finish(executionId: string, failure: unknown = null): void {
    const entry = this.#entries.get(executionId);
    if (!entry) return;
    entry.value = { ...entry.value, endedAt: this.now(), failure: failure === null ? null : sanitize(String(failure instanceof Error ? failure.message : failure), entry.secrets).slice(0, 4000) };
    this.#prune();
  }

  sanitize(executionId: string, value: string): string {
    return sanitize(value, this.#entries.get(executionId)?.secrets ?? this.hostSecrets);
  }

  /** Call only after trusted Shell authorization; IDs select evidence, never authority. */
  read(appId: string, executionId?: string): readonly AppWorkloadDiagnostic[] {
    this.#prune();
    if (executionId && this.#entries.get(executionId)?.value.appId !== appId) throw new Error("Diagnostic execution is unavailable for this App");
    return [...this.#entries.values()].filter(e => e.value.appId === appId && (!executionId || e.value.executionId === executionId))
      .map(e => Object.freeze({ ...e.value, output: sanitize(e.bytes.toString("utf8"), e.secrets) })).reverse();
  }

  clear(): void { this.#entries.clear(); }

  #prune(): void {
    for (const [id, entry] of this.#entries) if (entry.value.endedAt !== null && this.now() - entry.value.endedAt >= DIAGNOSTIC_RETENTION_MS) this.#entries.delete(id);
  }
}

function sanitize(value: string, secrets: readonly string[]): string {
  value = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  for (const secret of secrets) {
    if (!secret) continue;
    value = value.split(secret).join("[redacted]");
    // A bounded suffix or a chunk arriving across a read can cut authority at
    // either edge. Do not publish that partial transport credential either.
    const publicPrefix = /^(activation_|capsule_|channel[-_])/.exec(secret)?.[0].length ?? 0;
    for (let n = secret.length - 1; n >= 4; n--) {
      if (value.startsWith(secret.slice(-n))) value = "[redacted]" + value.slice(n);
      if (n >= publicPrefix + 4 && value.endsWith(secret.slice(0, n))) value = value.slice(0, -n) + "[redacted]";
    }
  }
  return value;
}
