import { watch, type FSWatcher } from "node:fs";
import { createRequire } from "node:module";
import type { ContentBlobRef } from "@lamarck/system/protocol";
import { ContentBlobStore } from "./blob-store";
import { D1ObserverState, type D1RecordedChange } from "./d1-observer-state";
import {
  compareFileSnapshots,
  digestBytes,
  externalizeFileChanges,
  observerFilesToSnapshots,
  recordedChanges,
  scanD1Files,
  type D1FileChange,
  type D1FileSnapshot,
} from "./filesystem-changes";
import type { RemoteGuard } from "./remote-guard";
import type { JsonValue } from "./json";

const COALESCE_MS = 120;
const POLL_MS = 2_000;
const require = createRequire(import.meta.url);
const { applyPatch } = require("diff") as {
  applyPatch(source: string, patch: string): string | false;
};

export class D1Observer {
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private stopped = true;

  constructor(
    private readonly filesRoot: string,
    private readonly guard: RemoteGuard,
    private readonly state: D1ObserverState,
    private readonly blobStore: ContentBlobStore,
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.catchUpFromD0();
    await this.observe();
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
    if (this.stopped) return;
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    await this.tail;
  }

  schedule(): void {
    if (this.stopped || this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this.tail = this.tail.then(() => this.observe()).catch((error) => {
        console.warn(`[lamarck:d1] observer scan failed: ${errorMessage(error)}`);
      });
    }, COALESCE_MS);
    this.coalesceTimer.unref?.();
  }

  async observe(): Promise<void> {
    const before = observerFilesToSnapshots(this.state.listFiles());
    const deferred = new Set<string>();
    const after = await scanD1Files(this.filesRoot, {
      isExcluded: (path) => this.state.isExcluded(path),
      onDeferred: (path) => deferred.add(path),
      onWarning: (message) => console.warn(`[lamarck:d1] ${message}`),
    });
    for (const path of deferred) {
      for (const [recordedPath, snapshot] of before) {
        if (recordedPath === path || recordedPath.startsWith(`${path}/`)) {
          after.set(recordedPath, snapshot);
        }
      }
    }
    const changes = compareFileSnapshots(before, after);
    if (changes.length === 0) return;
    const eventId = await this.guard.writeWorkspaceEvent({
      type: "workspace.files.changed",
      startedAt: Date.now(),
      payload: externalizeFileChanges(changes, this.blobStore) as JsonValue,
    });
    this.state.apply(eventId, recordedChanges(changes), after);
  }

  private async catchUpFromD0(): Promise<void> {
    let cursor = this.state.cursor();
    let materialized = observerFilesToSnapshots(this.state.listFiles());
    for (;;) {
      const rows = await this.guard.query(
        `SELECT id, payload FROM events
         WHERE type = 'workspace.files.changed' AND id > ?
         ORDER BY id LIMIT 256`,
        [cursor ?? ""],
      ) as Array<{ id: string; payload: string | Record<string, unknown> }>;
      if (rows.length === 0) return;
      const current = await scanD1Files(this.filesRoot, {
        isExcluded: (path) => this.state.isExcluded(path),
        onWarning: (message) => console.warn(`[lamarck:d1] ${message}`),
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
      return source?.digest === change.digest ? { ...source, path: change.path } : null;
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
