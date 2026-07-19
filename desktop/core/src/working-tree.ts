import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  docIdsHavePortableMaterializationConflict,
  portableDocMaterializationSegments,
  portablePathSegmentKey,
  resolveDocFilePath,
  validateDocId,
} from "./doc-id";
import type { GuardSqlParams } from "./guard-service/protocol";
import {
  WorkingTreeStateStore,
  type WorkingTreeConflictRecord,
  type WorkingTreeMirrorRecord,
} from "./working-tree-state";

const POLL_INTERVAL_MS = 250;
const FULL_HASH_SCAN_EVERY = 20;
const MAX_RECONCILIATION_ATTEMPTS = 4;
const DATABASE_ID_PAGE_SIZE = 512;
const RECONCILIATION_CONCURRENCY = 8;
const TEMP_FILE_NAME = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.lamarck-tmp$/i;
const FILESYSTEM_READ_FAILURES = new Set([
  "EACCES",
  "EBUSY",
  "EIO",
  "ELOOP",
  "ENAMETOOLONG",
  "ENOTDIR",
  "EPERM",
  "ETXTBSY",
]);
// Preserve a leading BOM as U+FEFF. The file hash is over exact UTF-8 bytes,
// so consuming the BOM while decoding would make the imported DB text hash
// differ from the file hash and manufacture a conflict.
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface WorkingTreeOptions {
  guard: WorkingTreeGuard;
  pagesDir: string;
  stateStore: WorkingTreeStateStore;
}

interface WorkingTreeGuard {
  withSource(source: string, opts?: { copyDocHook?: boolean }): WorkingTreeGuard;
  query(sql: string, params?: GuardSqlParams): unknown[] | Promise<unknown[]>;
  readDocForWorkingTree(id: string): unknown | null | Promise<unknown | null>;
  listLockedDocHashesForWorkingTree(
    afterId: string,
    limit: number,
  ): unknown[] | Promise<unknown[]>;
  writeDoc(id: string, content: string, metadata?: Record<string, unknown>): void | Promise<void>;
  deleteDoc(id: string): boolean | Promise<boolean>;
  compareAndWriteDoc(
    id: string,
    expectedHash: string | null,
    expectedUpdatedAt: number | null,
    content: string,
    metadata?: Record<string, unknown>,
  ): boolean | Promise<boolean>;
  compareAndDeleteDoc(
    id: string,
    expectedHash: string,
    expectedUpdatedAt: number,
  ): boolean | Promise<boolean>;
  docChangeSubscribers?: Array<(id: string) => void>;
}

interface DatabaseDoc {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  updatedAt: number;
  hash: string;
}

type FileSnapshot =
  | {
      kind: "absent";
      content: null;
      hash: null;
      mtimeMs: null;
      size: null;
    }
  | {
      kind: "regular";
      content: string;
      hash: string;
      mtimeMs: number;
      size: number;
    }
  | {
      kind: "unsafe";
      content: null;
      hash: null;
      mtimeMs: number | null;
      size: number | null;
      error: string;
    };

interface KnownFile {
  mtimeMs: number;
  size: number;
}

export type WorkingTreeReconciliationAction =
  | "converged"
  | "absent"
  | "file-to-database"
  | "database-to-file"
  | "conflict";

/**
 * Pure B/D/F state machine. A null side is absent; a null baseline means that
 * Core has never confirmed a converged version for this document. Once a
 * conflict is recorded it remains sticky until both live sides are equal or a
 * Host explicitly resolves it.
 */
export function planWorkingTreeReconciliation(
  baselineHash: string | null,
  databaseHash: string | null,
  fileHash: string | null,
  stickyConflict = false,
  databaseRevisionChanged = false,
): WorkingTreeReconciliationAction {
  if (databaseHash === fileHash) return databaseHash === null ? "absent" : "converged";
  if (stickyConflict) return "conflict";
  if (baselineHash === null) {
    if (databaseHash === null) return "file-to-database";
    if (fileHash === null) return "database-to-file";
    return "conflict";
  }
  if (databaseHash === baselineHash && !databaseRevisionChanged) return "file-to-database";
  if (fileHash === baselineHash) return "database-to-file";
  return "conflict";
}

export interface WorkingTreeConflictSummary {
  docId: string;
  expectedVersion: string;
  baseHash: string | null;
  database: {
    exists: boolean;
    hash: string | null;
    updatedAt: number | null;
  };
  file: {
    exists: boolean;
    hash: string | null;
    mtimeMs: number | null;
    error?: string;
  };
  detectedAt: number;
  error?: string;
}

export interface WorkingTreeConflictDetail extends WorkingTreeConflictSummary {
  database: WorkingTreeConflictSummary["database"] & { content: string | null };
  file: WorkingTreeConflictSummary["file"] & { content: string | null };
}

export type WorkingTreeConflictResolution = "use-database" | "use-file" | "keep-both";

export class WorkingTreeConflictNotFoundError extends Error {
  readonly code = "WORKING_TREE_CONFLICT_NOT_FOUND";

  constructor(docId: string) {
    super(`Working Tree conflict not found for ${docId}`);
    this.name = "WorkingTreeConflictNotFoundError";
  }
}

export class WorkingTreeConflictStaleError extends Error {
  readonly code = "WORKING_TREE_CONFLICT_STALE";

  constructor(docId: string) {
    super(`Working Tree conflict changed before it was resolved: ${docId}`);
    this.name = "WorkingTreeConflictStaleError";
  }
}

export class WorkingTreeResolutionError extends Error {
  readonly code = "WORKING_TREE_RESOLUTION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkingTreeResolutionError";
  }
}

/**
 * Bidirectional D1 Working Tree adapter.
 *
 * data.db remains authoritative. pages/ is an editable materialized view. A
 * device-local system.db row stores B, the exact UTF-8 SHA-256 that Core last
 * verified on both sides. Startup and live changes both use the same B/D/F
 * state machine; mtime and fs.watch are latency hints only.
 */
export class WorkingTree {
  private readonly guard: WorkingTreeGuard;
  private readonly fileGuard: WorkingTreeGuard;
  private readonly pagesDir: string;
  private readonly pagesRoot: string;
  private readonly state: WorkingTreeStateStore;
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private knownFiles = new Map<string, KnownFile>();
  private fileOps = new Map<string, Promise<void>>();
  private retryDocIds = new Set<string>();
  private stopPromise: Promise<void> | null = null;
  private scanPromise: Promise<void> | null = null;
  private dbTriggered = new Set<string>();
  private scanCount = 0;
  private reconciliationErrors = new Map<string, string>();
  private started = false;
  private stopping = false;
  private stopped = false;
  private subscribed = false;
  private readonly docChangeListener: (id: string) => void;

  constructor(opts: WorkingTreeOptions) {
    this.guard = opts.guard;
    this.fileGuard = opts.guard.withSource("working-tree:pages", { copyDocHook: false });
    this.pagesDir = opts.pagesDir;
    this.pagesRoot = resolve(opts.pagesDir);
    this.state = opts.stateStore;
    this.docChangeListener = (id) => {
      if (this.stopping || this.stopped) return;
      const filePath = resolveDocFilePath(this.pagesDir, id);
      void this.queueFileOp(filePath, () => this.reconcileDoc(id)).catch((error) => {
        this.retryDocIds.add(id);
        console.error(`[working-tree] database change reconciliation failed for ${id}:`, error);
      });
    };

  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopping || this.stopped) {
      throw new Error("A stopped Working Tree instance cannot be restarted");
    }
    await mkdir(this.pagesDir, { recursive: true });
    await syncDirectory(dirname(this.pagesRoot));
    await this.assertSafeDirectory(this.pagesRoot);
    await this.cleanupStaleTemporaryFiles(this.pagesRoot);

    // Reconcile the full union before installing a watcher. This catches
    // offline file edits/deletes, DB-only writes, and failed materialization.
    await this.reconcileNow();

    // The shared subscriber set follows every Guard facade. Unlike the old
    // single onDocChange callback, connectors/facades created before this class
    // starts cannot miss materialization notifications. Subscribe only after
    // startup reconciliation so pre-start writes remain truly offline.
    if (!this.subscribed && this.guard.docChangeSubscribers) {
      this.guard.docChangeSubscribers.push(this.docChangeListener);
      this.subscribed = true;
    }

    this.watcher = watch(this.pagesDir, { recursive: true }, (_eventType, filename) => {
      if (this.stopping || this.stopped) return;
      if (!filename) return;
      const relativeName = String(filename).split(sep).join("/");
      if (!relativeName.endsWith(".md")) return;
      const docId = relativeName.slice(0, -3);
      try {
        validateDocId(docId);
      } catch {
        return;
      }
      const fullPath = resolveDocFilePath(this.pagesDir, docId);
      if (this.dbTriggered.has(fullPath)) return;
      void this.queueFileOp(fullPath, () => this.reconcileDoc(docId)).catch((error) => {
        this.retryDocIds.add(docId);
        console.error(`[working-tree] file reconciliation failed for ${docId}:`, error);
      });
    });
    this.watcher.on("error", (error) => {
      // Polling is authoritative. A native watcher failure only loses the
      // low-latency hint; the periodic exact-hash sweep still converges.
      console.warn("[working-tree] native watcher unavailable; using polling:", error.message);
      this.watcher?.close();
      this.watcher = null;
    });
    this.pollTimer = setInterval(() => {
      this.requestScan();
    }, POLL_INTERVAL_MS);
    this.started = true;
  }

  async reconcileNow(docId?: string, allowDuringStop = false): Promise<void> {
    if (!allowDuringStop) this.assertAcceptingWork();
    if (docId !== undefined) {
      validateDocId(docId);
      await this.queueFileOp(resolveDocFilePath(this.pagesDir, docId), () => this.reconcileDoc(docId));
      return;
    }

    const ids = await this.collectAllDocIds();
    await this.refreshCurrentLockedContentHashes();
    const sortedIds = [...ids].sort();
    const results = await mapSettledBounded(
      sortedIds,
      RECONCILIATION_CONCURRENCY,
      (id) => this.queueFileOp(resolveDocFilePath(this.pagesDir, id), () => this.reconcileDoc(id)),
    );
    const failures: unknown[] = [];
    results.forEach((result, index) => {
      if (result.status !== "rejected") return;
      const id = sortedIds[index];
      this.retryDocIds.add(id);
      failures.push(result.reason);
      console.error(`[working-tree] initial reconciliation failed for ${id}:`, result.reason);
    });
    // One broken path must not prevent Core from exposing other docs or
    // conflicts. Failed operational work remains in retryDocIds.
    if (failures.length > 0) return;
  }

  async idle(): Promise<void> {
    await this.drainFileOps();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    this.stopping = true;

    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const subscribers = this.guard.docChangeSubscribers;
    if (subscribers && this.subscribed) {
      const index = subscribers.indexOf(this.docChangeListener);
      if (index >= 0) subscribers.splice(index, 1);
      this.subscribed = false;
    }
    this.stopPromise = (async () => {
      // A scan that passed the stopping check may still be enumerating files.
      // Wait for it to finish enqueueing before draining the per-file queues.
      const scan = this.scanPromise;
      if (scan) await scan;
      await this.drainFileOps();
      this.started = false;
      this.stopped = true;
    })();
    return this.stopPromise;
  }

  async listConflicts(): Promise<WorkingTreeConflictSummary[]> {
    this.assertAcceptingWork();
    const records = this.state.listConflicts();
    const reconciled = await mapSettledBounded(
      records,
      RECONCILIATION_CONCURRENCY,
      (record) => this.reconcileNow(record.docId),
    );
    reconciled.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          `[working-tree] conflict refresh failed for ${records[index].docId}:`,
          result.reason,
        );
      }
    });
    const refreshed = this.state.listConflicts();
    const summaries = await mapSettledBounded(
      refreshed,
      RECONCILIATION_CONCURRENCY,
      (record) => this.conflictView(record, false),
    );
    return summaries.flatMap((result, index) => {
      if (result.status === "fulfilled") return result.value ? [result.value] : [];
      return [degradedConflictSummary(refreshed[index], result.reason)];
    });
  }

  async getConflict(docId: string): Promise<WorkingTreeConflictDetail | null> {
    this.assertAcceptingWork();
    validateDocId(docId);
    await this.reconcileNow(docId);
    const record = this.state.getConflict(docId);
    if (!record) return null;
    return this.conflictView(record, true) as Promise<WorkingTreeConflictDetail | null>;
  }

  async resolveConflict(
    docId: string,
    options: {
      resolution: WorkingTreeConflictResolution;
      expectedVersion: string;
      newId?: string;
    },
  ): Promise<{ ok: true; newDocId?: string }> {
    this.assertAcceptingWork();
    validateDocId(docId);
    const filePath = resolveDocFilePath(this.pagesDir, docId);
    return this.queueFileOp(filePath, async () => {
      const record = this.state.getConflict(docId);
      if (!record) throw new WorkingTreeConflictNotFoundError(docId);
      await this.observeAndRecordConflict(docId, record);
      const currentRecord = this.state.getConflict(docId);
      if (!currentRecord) throw new WorkingTreeConflictStaleError(docId);
      const current = await this.conflictView(currentRecord, true);
      if (!current || current.expectedVersion !== options.expectedVersion) {
        throw new WorkingTreeConflictStaleError(docId);
      }
      const reconciliationError = this.reconciliationErrors.get(docId);
      if (reconciliationError) {
        throw new WorkingTreeResolutionError(
          `${reconciliationError}. Rename or remove the colliding local path, then retry.`,
        );
      }

      const database = await this.readDatabaseDoc(docId);
      const file = await this.readFileSnapshot(docId);
      if (conflictVersionForObservations(currentRecord, database, file) !== options.expectedVersion) {
        throw new WorkingTreeConflictStaleError(docId);
      }
      if (options.resolution === "use-database") {
        const applied = await this.applyDatabaseToFile(docId, database, file, true);
        if (!applied) throw new WorkingTreeConflictStaleError(docId);
        await this.confirmConvergence(docId);
        return { ok: true };
      }

      if (options.resolution === "use-file") {
        if (file.kind === "unsafe") {
          throw new WorkingTreeResolutionError(`Local file for ${docId} is not a regular UTF-8 file`);
        }
        const applied = await this.applyFileToDatabase(
          docId,
          database,
          file,
          currentRecord.baselineLocked === true,
        );
        if (!applied) throw new WorkingTreeConflictStaleError(docId);
        await this.confirmConvergence(docId);
        return { ok: true };
      }

      if (!database || file.kind !== "regular") {
        throw new WorkingTreeResolutionError("Keep Both requires an existing database document and local file");
      }
      const newDocId = options.newId?.trim();
      if (!newDocId) throw new WorkingTreeResolutionError("Keep Both requires a new document id");
      try {
        validateDocId(newDocId);
      } catch {
        throw new WorkingTreeResolutionError("Keep Both document id is invalid");
      }
      if (newDocId === docId) throw new WorkingTreeResolutionError("Keep Both requires a different document id");

      const newFile = await this.readFileSnapshot(newDocId);
      const newDatabase = await this.readDatabaseDoc(newDocId);
      const mustRemainLocked = database.metadata?.locked === true
        || currentRecord.baselineLocked === true
        || this.state.isContentHashProtected(file.hash);
      const inheritedMetadata = {
        ...(database.metadata ?? {}),
        ...(mustRemainLocked ? { locked: true } : {}),
      };
      const intendedMetadata = Object.keys(inheritedMetadata).length > 0
        ? inheritedMetadata
        : null;
      if (newDatabase) {
        // A previous Keep Both attempt may have committed the copy before the
        // original file publication failed. Accept that exact safe copy as an
        // idempotent continuation instead of forcing another duplicate id.
        if (
          newDatabase.content !== file.content
          || !jsonValuesEqual(newDatabase.metadata, intendedMetadata)
          || newFile.kind === "unsafe"
          || (newFile.kind === "regular" && newFile.content !== file.content)
        ) {
          throw new WorkingTreeResolutionError(`Document already exists: ${newDocId}`);
        }
      } else {
        if (newFile.kind !== "absent") {
          throw new WorkingTreeResolutionError(`Document already exists: ${newDocId}`);
        }
        const created = await this.fileGuard.compareAndWriteDoc(
          newDocId,
          null,
          null,
          file.content,
          intendedMetadata ?? undefined,
        );
        if (!created) throw new WorkingTreeResolutionError(`Document already exists: ${newDocId}`);
      }
      await this.reconcileNow(newDocId, true);

      const restored = await this.applyDatabaseToFile(docId, database, file, true);
      if (!restored) throw new WorkingTreeConflictStaleError(docId);
      await this.confirmConvergence(docId);
      return { ok: true, newDocId };
    });
  }

  private async reconcileDoc(docId: string): Promise<void> {
    validateDocId(docId);
    for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
      const database = await this.readDatabaseDoc(docId);
      const file = await this.readFileSnapshot(docId);
      const mirror = this.state.getMirror(docId);
      const existingConflict = this.state.getConflict(docId);
      if (database?.metadata?.locked === true) {
        this.state.protectContentHash(database.hash);
      }

      if (file.kind === "unsafe") {
        if (
          !database
          && !mirror
          && existingConflict
          && file.error.startsWith("Working Tree path uses ")
        ) {
          // This conflict represented an exact-spelling alias that has since
          // been renamed away. A case-insensitive lookup may still resolve the
          // canonical sibling, but the aliased logical path is now absent.
          this.state.markAbsent(docId);
          this.reconciliationErrors.delete(docId);
          this.retryDocIds.delete(docId);
          return;
        }
        // Unsafe standalone paths (for example symlinks) are never imported.
        // Once D1 or a baseline exists, preserve an explicit conflict instead
        // of mistaking the unsafe path for a user-requested deletion.
        if (!database && !mirror && !existingConflict) {
          this.retryDocIds.delete(docId);
          return;
        }
        const unsafeFileMarker = mirror?.contentHash ?? existingConflict?.fileHash;
        if (!database && unsafeFileMarker == null) {
          this.retryDocIds.delete(docId);
          return;
        }
        this.recordConflict(
          docId,
          mirror,
          existingConflict,
          database?.hash ?? null,
          unsafeFileMarker ?? null,
        );
        this.retryDocIds.delete(docId);
        return;
      }

      const action = planWorkingTreeReconciliation(
        mirror?.contentHash ?? null,
        database?.hash ?? null,
        file.hash,
        existingConflict !== undefined,
        mirror !== undefined && database?.updatedAt !== mirror.databaseUpdatedAt,
      );

      if (action === "converged") {
        this.state.markConverged({
          docId,
          contentHash: database!.hash,
          baselineLocked: database!.metadata?.locked === true,
          databaseUpdatedAt: database!.updatedAt,
          verifiedAt: Date.now(),
        });
        this.reconciliationErrors.delete(docId);
        this.retryDocIds.delete(docId);
        return;
      }
      if (action === "absent") {
        this.state.markAbsent(docId);
        this.reconciliationErrors.delete(docId);
        this.retryDocIds.delete(docId);
        return;
      }
      if (action === "conflict") {
        if (!database && file.kind === "regular") {
          const collision = await this.findDatabasePortableCollision(docId);
          if (collision) {
            this.reconciliationErrors.set(
              docId,
              `Guard: doc id ${JSON.stringify(docId)} collides with portable Working Tree id ${JSON.stringify(collision)}`,
            );
          } else {
            this.reconciliationErrors.delete(docId);
          }
        }
        this.recordConflict(
          docId,
          mirror,
          existingConflict,
          database?.hash ?? null,
          file.hash,
        );
        this.retryDocIds.delete(docId);
        return;
      }

      let applied: boolean;
      try {
        applied = action === "file-to-database"
          ? await this.applyFileToDatabase(docId, database, file, mirror?.baselineLocked === true)
          : await this.applyDatabaseToFile(docId, database, file, false);
      } catch (error) {
        if (action === "file-to-database" && isPortableCollisionError(error)) {
          this.reconciliationErrors.set(docId, errorMessage(error));
          this.recordConflict(
            docId,
            mirror,
            existingConflict,
            database?.hash ?? null,
            file.hash,
          );
          this.retryDocIds.delete(docId);
          return;
        }
        throw error;
      }
      if (!applied) continue;
      // Never advance B from an operation's intended result. Re-read both live
      // sides in the next iteration and only then mark convergence.
    }

    this.retryDocIds.add(docId);
  }

  private async confirmConvergence(docId: string): Promise<void> {
    const database = await this.readDatabaseDoc(docId);
    const file = await this.readFileSnapshot(docId);
    if (file.kind === "unsafe" || database?.hash !== file.hash) {
      throw new WorkingTreeConflictStaleError(docId);
    }
    if (!database) {
      this.state.markAbsent(docId);
      this.reconciliationErrors.delete(docId);
      return;
    }
    this.state.markConverged({
      docId,
      contentHash: database.hash,
      baselineLocked: database.metadata?.locked === true,
      databaseUpdatedAt: database.updatedAt,
      verifiedAt: Date.now(),
    });
    this.reconciliationErrors.delete(docId);
  }

  private async applyFileToDatabase(
    docId: string,
    database: DatabaseDoc | null,
    file: Exclude<FileSnapshot, { kind: "unsafe" }>,
    baselineLocked: boolean,
  ): Promise<boolean> {
    if (file.kind === "absent") {
      if (!database) return true;
      return this.fileGuard.compareAndDeleteDoc(docId, database.hash, database.updatedAt);
    }
    const mustRemainLocked = baselineLocked || this.state.isContentHashProtected(file.hash);
    const metadata = mustRemainLocked
      ? { ...(database?.metadata ?? {}), locked: true }
      : undefined;
    return this.fileGuard.compareAndWriteDoc(
      docId,
      database?.hash ?? null,
      database?.updatedAt ?? null,
      file.content,
      metadata,
    );
  }

  private async applyDatabaseToFile(
    docId: string,
    database: DatabaseDoc | null,
    file: FileSnapshot,
    allowUnsafeReplacement: boolean,
  ): Promise<boolean> {
    if (file.kind === "unsafe" && !allowUnsafeReplacement) return false;
    if (!database) return this.removeFileConditionally(docId, file, allowUnsafeReplacement);
    return this.materializeFileConditionally(
      docId,
      database.content,
      file,
      allowUnsafeReplacement,
    );
  }

  private recordConflict(
    docId: string,
    mirror: WorkingTreeMirrorRecord | undefined,
    existing: WorkingTreeConflictRecord | undefined,
    databaseHash: string | null,
    fileHash: string | null,
  ): void {
    const detectedAt = existing?.detectedAt ?? Date.now();
    const updatedAt = Math.max(Date.now(), existing?.updatedAt ?? detectedAt, detectedAt);
    this.state.upsertConflict({
      docId,
      baselineHash: mirror?.contentHash ?? existing?.baselineHash ?? null,
      baselineLocked: mirror?.baselineLocked ?? existing?.baselineLocked ?? null,
      baselineDatabaseUpdatedAt:
        mirror?.databaseUpdatedAt ?? existing?.baselineDatabaseUpdatedAt ?? null,
      databaseHash,
      fileHash,
      detectedAt,
      updatedAt,
    });
  }

  private async observeAndRecordConflict(
    docId: string,
    existing: WorkingTreeConflictRecord,
  ): Promise<void> {
    const database = await this.readDatabaseDoc(docId);
    const file = await this.readFileSnapshot(docId);
    if (file.kind !== "unsafe" && database?.hash === file.hash) {
      await this.confirmConvergence(docId);
      return;
    }
    this.recordConflict(
      docId,
      this.state.getMirror(docId),
      existing,
      database?.hash ?? null,
      file.kind === "regular" ? file.hash : null,
    );
  }

  private async conflictView(
    record: WorkingTreeConflictRecord,
    includeContent: boolean,
  ): Promise<WorkingTreeConflictSummary | WorkingTreeConflictDetail | null> {
    const database = await this.readDatabaseDoc(record.docId);
    const file = await this.readFileSnapshot(record.docId);
    const latest = this.state.getConflict(record.docId);
    if (!latest) return null;
    const expectedVersion = conflictVersionForObservations(latest, database, file);
    const base = {
      docId: record.docId,
      expectedVersion,
      baseHash: latest.baselineHash,
      database: {
        exists: database !== null,
        hash: database?.hash ?? null,
        updatedAt: database?.updatedAt ?? null,
      },
      file: {
        exists: file.kind === "regular",
        hash: file.kind === "regular" ? file.hash : null,
        mtimeMs: file.mtimeMs,
        ...(file.kind === "unsafe" ? { error: file.error } : {}),
      },
      detectedAt: latest.detectedAt,
      ...(this.reconciliationErrors.has(record.docId)
        ? { error: this.reconciliationErrors.get(record.docId)! }
        : {}),
    } satisfies WorkingTreeConflictSummary;
    if (!includeContent) return base;
    return {
      ...base,
      database: { ...base.database, content: database?.content ?? null },
      file: { ...base.file, content: file.kind === "regular" ? file.content : null },
    };
  }

  private async readDatabaseDoc(docId: string): Promise<DatabaseDoc | null> {
    const row = await this.guard.readDocForWorkingTree(
      docId,
    ) as Record<string, unknown> | null;
    if (!row) return null;
    if (typeof row.id !== "string" || typeof row.content !== "string") {
      throw new Error(`Invalid D1 row returned for ${docId}`);
    }
    const updatedAt = row.updatedAt;
    if (typeof updatedAt !== "number") throw new Error(`Invalid D1 timestamp returned for ${docId}`);
    return {
      id: row.id,
      content: row.content,
      metadata: parseStoredMetadata(row.metadata),
      updatedAt,
      hash: hashWorkingTreeContent(row.content),
    };
  }

  private async readFileSnapshot(docId: string): Promise<FileSnapshot> {
    const filePath = resolveDocFilePath(this.pagesDir, docId);
    let lastMtimeMs: number | null = null;
    let lastSize: number | null = null;
    try {
      const spelling = await this.inspectMaterializedPathSpelling(docId);
      if (spelling.kind === "absent") {
        this.knownFiles.delete(docId);
        return { kind: "absent", content: null, hash: null, mtimeMs: null, size: null };
      }
      if (spelling.kind === "alias") {
        this.knownFiles.delete(docId);
        return {
          kind: "unsafe",
          content: null,
          hash: null,
          mtimeMs: null,
          size: null,
          error: `Working Tree path uses ${JSON.stringify(spelling.actual)} where ${JSON.stringify(spelling.expected)} is required`,
        };
      }
      await this.assertSafeParent(dirname(filePath), false);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = await lstat(filePath);
        lastMtimeMs = before.mtimeMs;
        lastSize = before.size;
        if (before.isSymbolicLink() || !before.isFile()) {
          this.knownFiles.delete(docId);
          return {
            kind: "unsafe",
            content: null,
            hash: null,
            mtimeMs: before.mtimeMs,
            size: before.size,
            error: "Working Tree path is not a regular file",
          };
        }
        const bytes = await readFile(filePath);
        const after = await lstat(filePath);
        lastMtimeMs = after.mtimeMs;
        lastSize = after.size;
        if (
          before.dev !== after.dev
          || before.ino !== after.ino
          || before.size !== after.size
          || before.mtimeMs !== after.mtimeMs
        ) continue;
        let content: string;
        try {
          content = UTF8_DECODER.decode(bytes);
        } catch {
          this.knownFiles.delete(docId);
          return {
            kind: "unsafe",
            content: null,
            hash: null,
            mtimeMs: after.mtimeMs,
            size: after.size,
            error: "Working Tree file is not valid UTF-8",
          };
        }
        const snapshot: FileSnapshot = {
          kind: "regular",
          content,
          hash: createHash("sha256").update(bytes).digest("hex"),
          mtimeMs: after.mtimeMs,
          size: after.size,
        };
        this.knownFiles.set(docId, { mtimeMs: after.mtimeMs, size: after.size });
        return snapshot;
      }
      this.knownFiles.delete(docId);
      return {
        kind: "unsafe",
        content: null,
        hash: null,
        mtimeMs: lastMtimeMs,
        size: lastSize,
        error: "Working Tree file kept changing while it was being read",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.knownFiles.delete(docId);
        return { kind: "absent", content: null, hash: null, mtimeMs: null, size: null };
      }
      if (error instanceof UnsafeWorkingTreePathError) {
        this.knownFiles.delete(docId);
        return {
          kind: "unsafe",
          content: null,
          hash: null,
          mtimeMs: null,
          size: null,
          error: error.message,
        };
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code && FILESYSTEM_READ_FAILURES.has(code)) {
        this.knownFiles.delete(docId);
        return {
          kind: "unsafe",
          content: null,
          hash: null,
          mtimeMs: lastMtimeMs,
          size: lastSize,
          error: `Working Tree file could not be read safely (${code})`,
        };
      }
      throw error;
    }
  }

  private async inspectMaterializedPathSpelling(docId: string): Promise<
    | { kind: "exact" }
    | { kind: "absent" }
    | { kind: "alias"; expected: string; actual: string }
  > {
    let directory = this.pagesRoot;
    for (const segment of portableDocMaterializationSegments(docId)) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
        throw error;
      }
      const exact = entries.find((entry) => entry.name === segment.spelling);
      if (exact) {
        directory = join(directory, exact.name);
        continue;
      }
      const alias = entries.find(
        (entry) => portablePathSegmentKey(entry.name) === segment.key,
      );
      if (alias) {
        return { kind: "alias", expected: segment.spelling, actual: alias.name };
      }
      return { kind: "absent" };
    }
    return { kind: "exact" };
  }

  private async materializeFileConditionally(
    docId: string,
    content: string,
    expected: FileSnapshot,
    allowUnsafeReplacement: boolean,
  ): Promise<boolean> {
    const filePath = resolveDocFilePath(this.pagesDir, docId);
    await this.assertSafeParent(dirname(filePath), true);
    const tempPath = join(dirname(filePath), `.${randomUUID()}.lamarck-tmp`);
    this.dbTriggered.add(filePath);
    let tempExists = false;
    try {
      const handle = await open(tempPath, "wx", 0o644);
      tempExists = true;
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      const current = await this.readFileSnapshot(docId);
      if (!sameFileObservation(current, expected, allowUnsafeReplacement)) return false;

      if (current.kind === "absent") {
        try {
          await link(tempPath, filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw error;
        }
        await unlink(tempPath);
        tempExists = false;
      } else {
        await rename(tempPath, filePath);
        tempExists = false;
      }
      await syncDirectory(dirname(filePath));
      const published = await this.readFileSnapshot(docId);
      return published.kind === "regular" && published.hash === hashWorkingTreeContent(content);
    } finally {
      if (tempExists) await unlink(tempPath).catch(() => {});
      setTimeout(() => this.dbTriggered.delete(filePath), 100);
    }
  }

  private async removeFileConditionally(
    docId: string,
    expected: FileSnapshot,
    allowUnsafeReplacement: boolean,
  ): Promise<boolean> {
    const filePath = resolveDocFilePath(this.pagesDir, docId);
    await this.assertSafeParent(dirname(filePath), false).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    this.dbTriggered.add(filePath);
    try {
      const current = await this.readFileSnapshot(docId);
      if (!sameFileObservation(current, expected, allowUnsafeReplacement)) return false;
      if (current.kind === "absent") return true;
      if (current.kind === "unsafe") {
        const info = await lstat(filePath);
        if (!info.isSymbolicLink() && !info.isFile()) {
          throw new WorkingTreeResolutionError(`Refusing to remove non-file path for ${docId}`);
        }
      }
      await unlink(filePath);
      await syncDirectory(dirname(filePath));
      this.knownFiles.delete(docId);
      return (await this.readFileSnapshot(docId)).kind === "absent";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.knownFiles.delete(docId);
        return expected.kind === "absent";
      }
      throw error;
    } finally {
      setTimeout(() => this.dbTriggered.delete(filePath), 100);
    }
  }

  private async collectAllDocIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const databaseIds = new Set<string>();
    let afterId = "";
    for (;;) {
      const rows = await this.guard.query(
        `SELECT id FROM docs
         WHERE id > ?
         ORDER BY id
         LIMIT ${DATABASE_ID_PAGE_SIZE}`,
        [afterId],
      ) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      for (const row of rows) {
        if (typeof row.id !== "string") {
          throw new Error("Invalid D1 id returned during reconciliation");
        }
        validateDocId(row.id);
        ids.add(row.id);
        databaseIds.add(row.id);
      }
      const nextAfterId = rows.at(-1)?.id;
      if (typeof nextAfterId !== "string" || nextAfterId === afterId) {
        throw new Error("D1 id pagination did not advance during reconciliation");
      }
      afterId = nextAfterId;
      if (rows.length < DATABASE_ID_PAGE_SIZE) break;
    }
    // Guard prevents new aliases. If an externally modified/legacy data.db
    // already contains two impossible physical identities, fail before either
    // one can overwrite the other's materialization. User-created file aliases
    // are handled per-path as conflicts below and do not brick Core startup.
    assertPortableMaterializationIds(databaseIds);
    for (const mirror of this.state.listMirrors()) ids.add(mirror.docId);
    for (const conflict of this.state.listConflicts()) ids.add(conflict.docId);
    await this.collectFileIds(this.pagesRoot, ids);
    return ids;
  }

  private async findDatabasePortableCollision(docId: string): Promise<string | null> {
    let afterId = "";
    for (;;) {
      const rows = await this.guard.query(
        `SELECT id FROM docs
         WHERE id > ?
         ORDER BY id
         LIMIT ${DATABASE_ID_PAGE_SIZE}`,
        [afterId],
      ) as Array<Record<string, unknown>>;
      if (rows.length === 0) return null;
      for (const row of rows) {
        if (typeof row.id !== "string") {
          throw new Error("Invalid D1 id returned during collision inspection");
        }
        if (docIdsHavePortableMaterializationConflict(row.id, docId)) return row.id;
      }
      const nextAfterId = rows.at(-1)?.id;
      if (typeof nextAfterId !== "string" || nextAfterId === afterId) {
        throw new Error("D1 id pagination did not advance during collision inspection");
      }
      afterId = nextAfterId;
      if (rows.length < DATABASE_ID_PAGE_SIZE) return null;
    }
  }

  private async refreshCurrentLockedContentHashes(): Promise<void> {
    let afterId = "";
    for (;;) {
      const rows = await this.guard.listLockedDocHashesForWorkingTree(
        afterId,
        DATABASE_ID_PAGE_SIZE,
      ) as Array<Record<string, unknown>>;
      if (rows.length === 0) return;
      for (const row of rows) {
        if (
          typeof row.id !== "string"
          || typeof row.contentHash !== "string"
          || !/^[0-9a-f]{64}$/.test(row.contentHash)
        ) {
          throw new Error("Invalid locked D1 hash returned during reconciliation");
        }
        this.state.protectContentHash(row.contentHash);
      }
      const nextAfterId = rows.at(-1)?.id;
      if (typeof nextAfterId !== "string" || nextAfterId === afterId) {
        throw new Error("Locked D1 hash pagination did not advance during reconciliation");
      }
      afterId = nextAfterId;
      if (rows.length < DATABASE_ID_PAGE_SIZE) return;
    }
  }

  private async cleanupStaleTemporaryFiles(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let removed = false;
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await this.cleanupStaleTemporaryFiles(fullPath);
        continue;
      }
      if (!TEMP_FILE_NAME.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        console.warn(`[working-tree] reserved temporary path is not a regular file: ${fullPath}`);
        continue;
      }
      await unlink(fullPath);
      removed = true;
    }
    if (removed) await syncDirectory(directory);
  }

  private async collectFileIds(directory: string, ids: Set<string>): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await this.collectFileIds(fullPath, ids);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const docId = this.docIdForPath(fullPath);
      if (docId) ids.add(docId);
    }
  }

  private async scanForChanges(): Promise<void> {
    if (this.stopping || this.stopped) return;
    this.scanCount += 1;
    const verifyEveryFile = this.scanCount % FULL_HASH_SCAN_EVERY === 0;
    const seen = new Set<string>();
    await this.scanDirectory(this.pagesRoot, seen, verifyEveryFile);

    const queued = new Set<string>();
    for (const docId of this.knownFiles.keys()) {
      if (this.stopping || this.stopped) break;
      if (seen.has(docId)) continue;
      queued.add(docId);
    }
    for (const docId of this.retryDocIds) {
      if (this.stopping || this.stopped) break;
      queued.add(docId);
    }
    await mapSettledBounded(
      [...queued],
      RECONCILIATION_CONCURRENCY,
      (docId) => this.reconcileNow(docId),
    );
  }

  private requestScan(): void {
    if (this.stopping || this.stopped || this.scanPromise) return;
    const scan = this.scanForChanges().catch((error) => {
      console.error("[working-tree] scan failed:", error);
    });
    this.scanPromise = scan;
    void scan.finally(() => {
      if (this.scanPromise === scan) this.scanPromise = null;
    });
  }

  private async scanDirectory(
    directory: string,
    seen: Set<string>,
    verifyEveryFile: boolean,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (this.stopping || this.stopped) return;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await this.scanDirectory(fullPath, seen, verifyEveryFile);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const docId = this.docIdForPath(fullPath);
      if (!docId) continue;
      seen.add(docId);
      const filePath = resolveDocFilePath(this.pagesDir, docId);
      if (this.dbTriggered.has(filePath)) continue;
      let changed = verifyEveryFile || entry.isSymbolicLink() || !entry.isFile();
      if (!changed) {
        const info = await lstat(fullPath);
        const known = this.knownFiles.get(docId);
        changed = !known || known.mtimeMs !== info.mtimeMs || known.size !== info.size;
      }
      if (changed) await this.reconcileNow(docId);
    }
  }

  private docIdForPath(filePath: string): string | null {
    const rel = relative(this.pagesRoot, filePath).split(sep).join("/");
    if (!rel.endsWith(".md")) return null;
    const docId = rel.slice(0, -3);
    try {
      validateDocId(docId);
      return docId;
    } catch {
      console.warn(`[working-tree] ignoring invalid markdown path: ${rel}`);
      return null;
    }
  }

  private async assertSafeDirectory(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new UnsafeWorkingTreePathError("Working Tree root must be a real directory");
    }
  }

  private async assertSafeParent(parent: string, create: boolean): Promise<void> {
    const rel = relative(this.pagesRoot, parent);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).includes("..")) {
      throw new UnsafeWorkingTreePathError("Working Tree path escapes pages root");
    }
    await this.assertSafeDirectory(this.pagesRoot);
    if (!rel) return;
    let current = this.pagesRoot;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new UnsafeWorkingTreePathError("Working Tree parent contains a non-directory or symlink");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
        try {
          await mkdir(current);
        } catch (mkdirError) {
          // Multiple bounded workers may need the same parent. EEXIST is safe
          // only after the winner's path is revalidated below.
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        await syncDirectory(dirname(current));
        await this.assertSafeDirectory(current);
      }
    }
  }

  private queueFileOp<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.fileOps.get(filePath) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const tracked = next.then(() => undefined);
    this.fileOps.set(filePath, tracked);
    const cleanup = () => {
      if (this.fileOps.get(filePath) === tracked) this.fileOps.delete(filePath);
    };
    void tracked.then(cleanup, cleanup);
    return next;
  }

  private assertAcceptingWork(): void {
    if (this.stopping || this.stopped) {
      throw new Error("Working Tree is stopping");
    }
  }

  private async drainFileOps(): Promise<void> {
    const failures: unknown[] = [];
    while (this.fileOps.size > 0) {
      const pending = [...new Set(this.fileOps.values())];
      const results = await Promise.allSettled(pending);
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Working Tree file operations failed during shutdown");
    }
  }
}

class UnsafeWorkingTreePathError extends Error {}

export function hashWorkingTreeContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function parseStoredMetadata(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored D1 metadata must be an object or null");
  }
  return parsed as Record<string, unknown>;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function isPortableCollisionError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (
      ("code" in error && error.code === "GUARD_DOC_PATH_COLLISION")
      || ("message" in error
        && typeof error.message === "string"
        && error.message.includes("collides with portable Working Tree id"))
    ),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

function degradedConflictSummary(
  record: WorkingTreeConflictRecord,
  error: unknown,
): WorkingTreeConflictSummary {
  const message = error instanceof Error ? error.message : String(error);
  return {
    docId: record.docId,
    expectedVersion: createHash("sha256")
      .update("lamarck-working-tree-degraded-conflict-v1\0")
      .update(JSON.stringify(record))
      .digest("hex"),
    baseHash: record.baselineHash,
    database: {
      exists: record.databaseHash !== null,
      hash: record.databaseHash,
      updatedAt: null,
    },
    file: {
      exists: record.fileHash !== null,
      hash: record.fileHash,
      mtimeMs: null,
    },
    detectedAt: record.detectedAt,
    error: `Working Tree conflict could not be fully inspected: ${message}`,
  };
}

async function mapSettledBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        try {
          results[index] = { status: "fulfilled", value: await operation(values[index], index) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function sameFileObservation(
  current: FileSnapshot,
  expected: FileSnapshot,
  allowUnsafeReplacement: boolean,
): boolean {
  if (expected.kind === "unsafe") return allowUnsafeReplacement && current.kind === "unsafe";
  if (current.kind !== expected.kind) return false;
  if (current.kind === "absent") return true;
  return current.hash === expected.hash;
}

function workingTreeConflictVersion(value: {
  baselineHash: string | null;
  baselineLocked: boolean | null;
  baselineDatabaseUpdatedAt: number | null;
  databaseHash: string | null;
  databaseUpdatedAt: number | null;
  fileHash: string | null;
  fileMtimeMs: number | null;
  fileKind: FileSnapshot["kind"];
}): string {
  return createHash("sha256")
    .update("lamarck-working-tree-conflict-v1\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

function conflictVersionForObservations(
  record: WorkingTreeConflictRecord,
  database: DatabaseDoc | null,
  file: FileSnapshot,
): string {
  return workingTreeConflictVersion({
    baselineHash: record.baselineHash,
    baselineLocked: record.baselineLocked,
    baselineDatabaseUpdatedAt: record.baselineDatabaseUpdatedAt,
    databaseHash: database?.hash ?? null,
    databaseUpdatedAt: database?.updatedAt ?? null,
    fileHash: file.kind === "regular" ? file.hash : null,
    fileMtimeMs: file.mtimeMs,
    fileKind: file.kind,
  });
}

function assertPortableMaterializationIds(ids: Iterable<string>): void {
  interface PathNode {
    spelling: string;
    kind: "directory" | "file";
    owner: string;
    children: Map<string, PathNode>;
  }
  const root = new Map<string, PathNode>();
  for (const id of ids) {
    let level = root;
    for (const segment of portableDocMaterializationSegments(id)) {
      const existing = level.get(segment.key);
      if (existing) {
        if (existing.spelling !== segment.spelling || existing.kind !== segment.kind) {
          portableMaterializationCollision(existing.owner, id);
        }
        if (existing.kind === "file") portableMaterializationCollision(existing.owner, id);
        level = existing.children;
        continue;
      }
      const created: PathNode = {
        spelling: segment.spelling,
        kind: segment.kind,
        owner: id,
        children: new Map(),
      };
      level.set(segment.key, created);
      level = created.children;
    }
  }
}

function portableMaterializationCollision(existing: string, requested: string): never {
  throw new WorkingTreeResolutionError(
    `D1 document ids ${JSON.stringify(existing)} and ${JSON.stringify(requested)} map to incompatible portable Working Tree paths`,
  );
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
