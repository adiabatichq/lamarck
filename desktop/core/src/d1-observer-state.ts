import type { DatabaseSync, StatementSync } from "node:sqlite";
import { validateD1Grant, validateD1Path } from "@lamarck/system/internal/vfs";

export interface D1ObserverFile {
  path: string;
  digest: string;
  byteLength: number;
  markdownBaseline: Buffer | null;
  statFingerprint: string | null;
}

export interface D1RecordedChange {
  kind: "added" | "modified" | "deleted" | "moved";
  path: string;
  from?: string;
  digest: string;
  prevDigest?: string;
}

export interface D1HistoryExclusion {
  path: string;
  prefix: boolean;
}

export class D1ObserverState {
  constructor(private readonly db: DatabaseSync) {
    this.db.prepare(
      `INSERT INTO d1_observer_cursor (singleton, last_event_id)
       VALUES (1, NULL) ON CONFLICT(singleton) DO NOTHING`,
    ).run();
  }

  listFiles(): D1ObserverFile[] {
    const rows = this.db.prepare(
      `SELECT path, digest, byte_length, markdown_baseline, stat_fingerprint
       FROM d1_observer_files ORDER BY path`,
    ).all() as Array<{
      path: string;
      digest: string;
      byte_length: number;
      markdown_baseline: Uint8Array | null;
      stat_fingerprint: string | null;
    }>;
    return rows.map((row) => ({
      path: row.path,
      digest: row.digest,
      byteLength: row.byte_length,
      markdownBaseline: row.markdown_baseline === null ? null : Buffer.from(row.markdown_baseline),
      statFingerprint: row.stat_fingerprint,
    }));
  }

  refreshMetadata(files: ReadonlyMap<string, D1ObserverFile>): void {
    if (files.size === 0) return;
    const refresh = this.db.prepare(
      `UPDATE d1_observer_files
       SET byte_length = ?, stat_fingerprint = ?
       WHERE path = ? AND digest = ?
         AND (byte_length <> ? OR stat_fingerprint IS NOT ?)`,
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.refreshMetadataRows(files, refresh);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cursor(): string | null {
    const row = this.db.prepare(
      "SELECT last_event_id FROM d1_observer_cursor WHERE singleton = 1",
    ).get() as { last_event_id: string | null } | undefined;
    return row?.last_event_id ?? null;
  }

  apply(
    eventId: string,
    changes: readonly D1RecordedChange[],
    snapshots: ReadonlyMap<string, D1ObserverFile>,
    metadataUpdates: ReadonlyMap<string, D1ObserverFile> = new Map(),
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.db.prepare("DELETE FROM d1_observer_files WHERE path = ?");
      const upsert = this.db.prepare(
        `INSERT INTO d1_observer_files
           (path, digest, byte_length, markdown_baseline, stat_fingerprint)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           digest = excluded.digest,
           byte_length = excluded.byte_length,
           markdown_baseline = excluded.markdown_baseline,
           stat_fingerprint = excluded.stat_fingerprint`,
      );
      for (const change of changes) {
        if (change.kind === "deleted") {
          remove.run(change.path);
          continue;
        }
        if (change.kind === "moved" && change.from) remove.run(change.from);
        const snapshot = snapshots.get(change.path);
        if (snapshot) {
          upsert.run(
            change.path,
            snapshot.digest,
            snapshot.byteLength,
            snapshot.markdownBaseline,
            snapshot.statFingerprint,
          );
        } else {
          upsert.run(change.path, change.digest, 0, null, null);
        }
      }
      if (metadataUpdates.size > 0) {
        const refresh = this.db.prepare(
          `UPDATE d1_observer_files
           SET byte_length = ?, stat_fingerprint = ?
           WHERE path = ? AND digest = ?
             AND (byte_length <> ? OR stat_fingerprint IS NOT ?)`,
        );
        this.refreshMetadataRows(metadataUpdates, refresh);
      }
      this.db.prepare(
        "UPDATE d1_observer_cursor SET last_event_id = ? WHERE singleton = 1",
      ).run(eventId);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private refreshMetadataRows(
    files: ReadonlyMap<string, D1ObserverFile>,
    refresh: StatementSync,
  ): void {
    for (const file of files.values()) {
      if (file.statFingerprint === null) continue;
      refresh.run(
        file.byteLength,
        file.statFingerprint,
        file.path,
        file.digest,
        file.byteLength,
        file.statFingerprint,
      );
    }
  }

  listExclusions(): D1HistoryExclusion[] {
    return (this.db.prepare(
      "SELECT path, is_prefix FROM d1_history_exclusions ORDER BY path",
    ).all() as Array<{ path: string; is_prefix: number }>).map((row) => ({
      path: row.path,
      prefix: row.is_prefix === 1,
    }));
  }

  isExcluded(path: string): boolean {
    return this.listExclusions().some((rule) => rule.prefix
      ? path === rule.path || path.startsWith(`${rule.path}/`)
      : path === rule.path);
  }

  addExclusion(rule: string): D1HistoryExclusion {
    const prefix = rule.endsWith("/");
    validateD1Grant(rule);
    const path = prefix ? rule.slice(0, -1) : rule;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO d1_history_exclusions (path, is_prefix) VALUES (?, ?)
         ON CONFLICT(path) DO UPDATE SET is_prefix = excluded.is_prefix`,
      ).run(path, prefix ? 1 : 0);
      if (prefix) {
        this.db.prepare(
          "DELETE FROM d1_observer_files WHERE path = ? OR path LIKE ? ESCAPE '\\'",
        ).run(path, `${escapeLike(path)}/%`);
      } else {
        this.db.prepare("DELETE FROM d1_observer_files WHERE path = ?").run(path);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    return { path, prefix };
  }

  removeExclusion(rule: string): boolean {
    const prefix = rule.endsWith("/");
    const path = prefix ? rule.slice(0, -1) : rule;
    validateD1Path(path);
    return Number(this.db.prepare(
      "DELETE FROM d1_history_exclusions WHERE path = ? AND is_prefix = ?",
    ).run(path, prefix ? 1 : 0).changes) > 0;
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
