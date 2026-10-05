import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { D0Event, SqlParams } from '@lamarck/system/protocol';

export type TriggerCondition =
  | { kind: 'event'; sql: string; params?: SqlParams }
  | { kind: 'schedule'; cron: string; timezone: string };
export interface TriggerSettings {
  name: string;
  target: string;
  enabled: boolean;
  condition: TriggerCondition;
}
export interface TriggerRecord {
  id: string;
  revision: number;
  settings: TriggerSettings;
  cursor: number;
  nextRunAt: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export type TriggerInput = { kind: 'event'; event: D0Event } | { kind: 'schedule'; scheduledAt: number };
export type TriggerRunStatus = 'pending' | 'running' | 'success' | 'error' | 'interrupted' | 'canceled';
export interface TriggerRun {
  id: string;
  triggerId: string;
  revision: number;
  settings: TriggerSettings;
  input: TriggerInput;
  status: TriggerRunStatus;
  origin: 'automatic' | 'manual' | 'retry';
  retryOf: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
}
export const TRIGGER_SCHEMA = `
CREATE TABLE triggers (
  id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  settings_json TEXT NOT NULL,
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  next_run_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE trigger_runs (
  id TEXT PRIMARY KEY NOT NULL,
  trigger_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','success','error','interrupted','canceled')),
  origin TEXT NOT NULL CHECK (origin IN ('automatic','manual','retry')),
  delivery_key TEXT UNIQUE,
  retry_of TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  error TEXT
);
CREATE INDEX idx_trigger_runs_history ON trigger_runs(trigger_id, created_at DESC, id);
CREATE INDEX idx_trigger_runs_pending ON trigger_runs(status, created_at, id);
`;

/** Private storage primitives. Dispatch/lifecycle policy belongs to the coordinator. */
export class TriggerStore {
  constructor(private db: DatabaseSync) {}
  list(): TriggerRecord[] { return this.db.prepare('SELECT * FROM triggers ORDER BY created_at, id').all().map(decodeTrigger); }
  get(id: string): TriggerRecord {
    const row = this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id);
    if (!row) throw new Error('Trigger not found');
    return decodeTrigger(row);
  }
  create(settings: TriggerSettings, cursor: number, nextRunAt: number | null, now = Date.now()): TriggerRecord {
    const id = randomUUID();
    this.db.prepare('INSERT INTO triggers (id,revision,settings_json,cursor,next_run_at,created_at,updated_at) VALUES (?,1,?,?,?,?,?)')
      .run(id, JSON.stringify(settings), cursor, nextRunAt, now, now);
    return this.get(id);
  }
  /** Revision checks fence stale evaluations without holding a DB transaction across Guard RPC. */
  replace(id: string, revision: number, settings: TriggerSettings, cursor: number, nextRunAt: number | null, now = Date.now()): TriggerRecord {
    const result = this.db.prepare('UPDATE triggers SET revision=revision+1,settings_json=?,cursor=?,next_run_at=?,error=NULL,updated_at=? WHERE id=? AND revision=?')
      .run(JSON.stringify(settings), cursor, nextRunAt, now, id, revision);
    if (Number(result.changes) !== 1) throw new Error('Trigger changed during this operation; reload and retry');
    return this.get(id);
  }
  setError(id: string, revision: number, error: string | null): void {
    this.db.prepare('UPDATE triggers SET error=? WHERE id=? AND revision=?').run(error?.slice(0, 2000) ?? null, id, revision);
  }
  /** One transaction admits immutable inputs AND advances progress, or neither. */
  admitBatch(record: TriggerRecord, checkpoint: { cursor: number; nextRunAt: number | null }, inputs: { key: string; input: TriggerInput }[], now = Date.now()): boolean {
    return this.atomic(() => {
      const current = this.db.prepare('SELECT revision,cursor,next_run_at FROM triggers WHERE id=?').get(record.id);
      if (!current || current.revision !== record.revision || current.cursor !== record.cursor || current.next_run_at !== record.nextRunAt) return false;
      for (const input of inputs) this.insertRun(record, input.input, 'automatic', null, `${record.id}:${input.key}`, now);
      this.db.prepare('UPDATE triggers SET cursor=?,next_run_at=?,error=NULL WHERE id=?').run(checkpoint.cursor, checkpoint.nextRunAt, record.id);
      return true;
    });
  }
  insertRun(record: TriggerRecord, input: TriggerInput, origin: TriggerRun['origin'], retryOf: string | null, deliveryKey: string | null, now = Date.now()): TriggerRun {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO trigger_runs
      (id,trigger_id,revision,settings_json,input_json,status,origin,delivery_key,retry_of,created_at)
      VALUES (?,?,?,?,?,'pending',?,?,?,?)`).run(id, record.id, record.revision, JSON.stringify(record.settings), JSON.stringify(input), origin, deliveryKey, retryOf, now);
    return this.run(id);
  }
  runs(triggerId: string, limit = 50): TriggerRun[] {
    checkLimit(limit);
    return this.db.prepare('SELECT * FROM trigger_runs WHERE trigger_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(triggerId, limit).map(decodeRun);
  }
  run(id: string): TriggerRun {
    const row = this.db.prepare('SELECT * FROM trigger_runs WHERE id=?').get(id);
    if (!row) throw new Error('Trigger run not found');
    return decodeRun(row);
  }
  pending(limit = 100): TriggerRun[] {
    checkLimit(limit);
    return this.db.prepare("SELECT * FROM trigger_runs WHERE status='pending' ORDER BY created_at,id LIMIT ?").all(limit).map(decodeRun);
  }
  pendingTargets(): string[] {
    return this.db.prepare(`SELECT DISTINCT json_extract(r.settings_json,'$.target') AS target
      FROM trigger_runs r JOIN triggers t ON t.id=r.trigger_id WHERE r.status='pending' AND json_extract(t.settings_json,'$.enabled')=1`).all().map(row => String(row.target));
  }
  pendingAvailability(target: string, reason: string | null): void {
    this.db.prepare("UPDATE trigger_runs SET error=? WHERE status='pending' AND json_extract(settings_json,'$.target')=? AND error IS NOT ?").run(reason, target, reason);
  }
  pendingForTarget(target: string): TriggerRun | null {
    const row = this.db.prepare(`SELECT r.* FROM trigger_runs r JOIN triggers t ON t.id=r.trigger_id
      WHERE r.status='pending' AND json_extract(r.settings_json,'$.target')=?
        AND json_extract(t.settings_json,'$.enabled')=1 ORDER BY r.created_at,r.id LIMIT 1`).get(target);
    return row ? decodeRun(row) : null;
  }
  recover(now = Date.now()): void {
    this.db.prepare("UPDATE trigger_runs SET status='interrupted',ended_at=?,error='Host stopped during execution; external effects may have occurred' WHERE status='running'").run(now);
  }
  pendingCount(triggerId: string): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM trigger_runs WHERE trigger_id=? AND status='pending'").get(triggerId)!.n);
  }
  cancelPending(triggerId: string, now = Date.now()): void {
    this.db.prepare("UPDATE trigger_runs SET status='canceled',ended_at=?,error='Trigger deleted' WHERE trigger_id=? AND status='pending'").run(now, triggerId);
  }
  transition(id: string, from: TriggerRunStatus, to: TriggerRunStatus, error: string | null = null, now = Date.now()): boolean {
    return Number(this.db.prepare(`UPDATE trigger_runs SET status=?,error=?,
      started_at=CASE WHEN ?='running' THEN ? ELSE started_at END,
      ended_at=CASE WHEN ? IN ('success','error','interrupted','canceled') THEN ? ELSE ended_at END
      WHERE id=? AND status=?`).run(to, error?.slice(0, 2000) ?? null, to, now, to, now, id, from).changes) === 1;
  }
  /** Does not choose what to do with pending/running work or erase history. */
  removeConfiguration(id: string, revision: number): boolean {
    return Number(this.db.prepare('DELETE FROM triggers WHERE id=? AND revision=?').run(id, revision).changes) === 1;
  }
  atomic<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
function checkLimit(limit: number) { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Limit must be 1–500'); }
function decodeTrigger(row: Record<string, unknown>): TriggerRecord {
  return { id: String(row.id), revision: Number(row.revision), settings: JSON.parse(String(row.settings_json)), cursor: Number(row.cursor), nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at), error: row.error as string | null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function decodeRun(row: Record<string, unknown>): TriggerRun {
  return { id: String(row.id), triggerId: String(row.trigger_id), revision: Number(row.revision), settings: JSON.parse(String(row.settings_json)), input: JSON.parse(String(row.input_json)), status: row.status as TriggerRunStatus, origin: row.origin as TriggerRun['origin'], retryOf: row.retry_of as string | null, createdAt: Number(row.created_at), startedAt: row.started_at === null ? null : Number(row.started_at), endedAt: row.ended_at === null ? null : Number(row.ended_at), error: row.error as string | null };
}
