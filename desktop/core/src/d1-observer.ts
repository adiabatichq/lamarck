import { watch, type FSWatcher } from "node:fs";
import { applyPatch } from "diff";
import type { ContentBlobRef } from "@lamarck/system/protocol";
import { ContentBlobStore } from "./blob-store";
import { D1ObserverState, type D1RecordedChange } from "./d1-observer-state";
import { D1Sequencer } from "./d1-sequencer";
import {
  compareFileSnapshots,
  digestBytes,
  externalizeFileChanges,
  metadataOnlyFileSnapshots,
  observerFilesToSnapshots,
  recordedChanges,
  scanD1Files,
  type D1FileChange,
  type D1FileSnapshot,
} from "./filesystem-changes";
import { BACKGROUND_GUARD_DEADLINE_MS, type RemoteGuard } from "./remote-guard";
import type { JsonValue } from "./json";

const COALESCE_MS = 120;
const POLL_MS = 2_000;

export class D1Observer {
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private rescan = false;
  private controller = new AbortController();
  private stopped = true;

  constructor(
    private readonly filesRoot: string,
    private readonly guard: RemoteGuard,
    private readonly state: D1ObserverState,
    private readonly blobStore: ContentBlobStore,
    private readonly sequencer: D1Sequencer,
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    if (this.pending) await this.pending.catch(() => {});
    if (!this.stopped) return;
    this.stopped = false;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.pending = this.sequencer.run(async () => {
      signal.throwIfAborted();
      await this.catchUpFromD0(signal);
      await this.observeExclusive(signal);
    });
    try {
      await this.pending;
    } catch (error) {
      this.stopped = true;
      throw error;
    } finally {
      this.pending = null;
    }
    if (this.stopped) return;
    try {
      this.watcher = watch(this.filesRoot, { recursive: true }, () => this.schedule());
      this.watcher.on("error", (error) => {
        console.warn(`[lamarck:d1] recursive observer warning: ${errorMessage(error)}`);
      });
    } catch (error) {
      console.warn(`[lamarck:d1] recursive watcher unavailable; polling remains active: ${errorMessage(error)}`);
    }
    this.pollTimer = setInterval(() => this.schedule(), POLL_MS);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.rescan = false;
    this.controller.abort();
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    await this.pending?.catch((error) => {
      if (!this.controller.signal.aborted) throw error;
    });
  }

  schedule(): void {
    if (this.stopped) return;
    this.rescan = true;
    if (this.pending || this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this.rescan = false;
      void this.observe().catch((error) => {
        if (!this.stopped) console.warn(`[lamarck:d1] observer scan failed: ${errorMessage(error)}`);
      });
    }, COALESCE_MS);
    this.coalesceTimer.unref?.();
  }

  observe(): Promise<void> {
    if (this.pending) return this.pending;
    const signal = this.controller.signal;
    this.pending = this.sequencer.run(() => this.observeExclusive(signal)).finally(() => {
      this.pending = null;
      if (this.rescan) this.schedule();
    });
    return this.pending;
  }

  private async observeExclusive(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const before = observerFilesToSnapshots(this.state.listFiles());
    const deferred = new Set<string>();
    const after = await scanD1Files(this.filesRoot, {
      isExcluded: (path) => this.state.isExcluded(path),
      onDeferred: (path) => deferred.add(path),
      onWarning: (message) => console.warn(`[lamarck:d1] ${message}`),
      previous: before,
      signal,
    });
    for (const path of deferred) {
      for (const [recordedPath, snapshot] of before) {
        if (recordedPath === path || recordedPath.startsWith(`${path}/`)) {
          after.set(recordedPath, snapshot);
        }
      }
    }
    const changes = compareFileSnapshots(before, after);
    const metadataUpdates = metadataOnlyFileSnapshots(before, after);
    if (changes.length === 0) {
      this.state.refreshMetadata(metadataUpdates);
      return;
    }
    signal.throwIfAborted();
    const eventId = await this.guard.writeWorkspaceEvent({
      type: "workspace.files.changed",
      startedAt: Date.now(),
      payload: externalizeFileChanges(changes, this.blobStore) as JsonValue,
    });
    this.state.apply(eventId, recordedChanges(changes), after, metadataUpdates);
  }

  private async catchUpFromD0(signal: AbortSignal): Promise<void> {
    let cursor = this.state.cursor();
    let materialized = observerFilesToSnapshots(this.state.listFiles());
    for (;;) {
      signal.throwIfAborted();
      const rows = await this.guard.withExecution({ signal, deadlineMs: BACKGROUND_GUARD_DEADLINE_MS }).query(
        `SELECT id, payload FROM events
         WHERE type = 'workspace.files.changed' AND id > ?
         ORDER BY id LIMIT 256`,
        [cursor ?? ""],
      ) as Array<{ id: string; payload: string | Record<string, unknown> }>;
      if (rows.length === 0) return;
      const current = await scanD1Files(this.filesRoot, {
        isExcluded: (path) => this.state.isExcluded(path),
        onWarning: (message) => console.warn(`[lamarck:d1] ${message}`),
        previous: materialized,
        signal,
      });
      for (const row of rows) {
        const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        const changes = this.resolveChanges(payload);
        const snapshots = new Map<string, D1FileSnapshot>();
        for (const change of changes) {
          const currentSnapshot = current.get(change.path);
          const snapshot = currentSnapshot?.digest === change.digest
            ? currentSnapshot
            : this.replaySnapshot(change, materialized);
          if (snapshot) snapshots.set(change.path, snapshot);
        }
        this.state.apply(row.id, changes.map(toRecordedChange), snapshots);
        materialized = observerFilesToSnapshots(this.state.listFiles());
        cursor = row.id;
      }
      if (rows.length < 256) return;
    }
  }

  private replaySnapshot(
    change: D1FileChange,
    materialized: ReadonlyMap<string, D1FileSnapshot>,
  ): D1FileSnapshot | null {
    if (change.kind === "deleted") return null;
    if (change.kind === "moved") {
      const source = materialized.get(change.from);
      return source?.digest === change.digest
        ? { ...source, path: change.path, statFingerprint: null }
        : null;
    }
    const patch = this.resolvePatch(change);
    if (patch === null) return null;
    const previous = change.kind === "added" ? Buffer.alloc(0) : materialized.get(change.path)?.markdownBaseline;
    if (previous === null || previous === undefined) return null;
    if (change.kind === "modified" && materialized.get(change.path)?.digest !== change.prevDigest) return null;
    const text = applyPatch(new TextDecoder("utf-8", { fatal: true }).decode(previous), patch);
    if (text === false) return null;
    const bytes = Buffer.from(text, "utf8");
    if (digestBytes(bytes) !== change.digest) return null;
    return {
      path: change.path,
      digest: change.digest,
      byteLength: bytes.byteLength,
      markdownBaseline: bytes,
      statFingerprint: null,
      bytes,
      markdown: true,
    };
  }

  private resolvePatch(change: Exclude<D1FileChange, { kind: "moved" }>): string | null {
    if (change.patch !== undefined) return change.patch;
    if (change.patchRef === undefined) return null;
    const resolved = this.blobStore.resolve(change.patchRef);
    if (resolved.status !== "resolved" || resolved.mediaType !== "text/plain; charset=utf-8") {
      throw new Error(`Could not resolve D1 Markdown patch: ${resolved.status}`);
    }
    return resolved.text;
  }

  private resolveChanges(payload: Record<string, unknown>): D1FileChange[] {
    if (Array.isArray(payload.changes)) return payload.changes as D1FileChange[];
    if (payload.changesRef) {
      const resolved = this.blobStore.resolve(payload.changesRef as ContentBlobRef);
      if (resolved.status !== "resolved" || resolved.mediaType !== "application/json") {
        throw new Error(`Could not resolve D1 changes manifest: ${resolved.status}`);
      }
      const changes = JSON.parse(resolved.text);
      if (!Array.isArray(changes)) throw new Error("D1 changes manifest is not an array");
      return changes as D1FileChange[];
    }
    throw new Error("workspace.files.changed payload has no changes evidence");
  }
}

function toRecordedChange(change: D1FileChange): D1RecordedChange {
  return {
    kind: change.kind,
    path: change.path,
    ...(change.kind === "moved" ? { from: change.from } : {}),
    digest: change.digest,
    ...(change.kind === "modified" ? { prevDigest: change.prevDigest } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
