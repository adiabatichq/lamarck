import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openSystemDatabase } from '../src/db';
import { TriggerStore, type TriggerSettings, type TriggerInput } from '../src/triggers/store';
let workspace: string;
let db: DatabaseSync;
let store: TriggerStore;
const settings: TriggerSettings = { name: 'Example', target: 'test:job', enabled: true, condition: { kind: 'event', sql: 'SELECT id FROM events WHERE type = ?', params: ['example'] } };
const input: TriggerInput = { kind: 'schedule', scheduledAt: 123 };
beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'triggers-store-')); mkdirSync(join(workspace, '.lamarck')); db = openSystemDatabase(workspace); store = new TriggerStore(db); });
afterEach(() => { if (db.isOpen) db.close(); rmSync(workspace, { recursive: true, force: true }); });
test('fresh complete v1 storage and prior control-plane data survive reopen', () => {
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  for (const name of ['triggers', 'trigger_runs', 'idx_trigger_runs_history', 'idx_trigger_runs_pending']) {
    expect(db.prepare('SELECT name FROM sqlite_schema WHERE name = ?').get(name)?.name).toBe(name);
  }
  const record = store.create(settings, 4, null);
  const run = store.insertRun(record, input, 'manual', null, null);
  db.prepare('INSERT INTO d1_history_exclusions (path,is_prefix) VALUES (?,1)').run('keep/');
  db.close(); db = openSystemDatabase(workspace); store = new TriggerStore(db);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  expect(db.prepare('SELECT path FROM d1_history_exclusions').get()?.path).toBe('keep/');
  expect(store.get(record.id)).toEqual(record);
  expect(store.runs(record.id)).toEqual([run]);
});
test('settings, enablement, progress, and immutable queued inputs survive restart', () => {
  const record = store.create(settings, 8, null);
  expect(store.admitBatch(record, { cursor: 11, nextRunAt: null }, [{ key: 'event-11', input }])).toBe(true);
  const edited = store.replace(record.id, 1, { ...settings, enabled: false, name: 'User edit' }, 11, null);
  expect(edited.revision).toBe(2);
  db.close(); db = openSystemDatabase(workspace); store = new TriggerStore(db);
  expect(store.get(record.id)).toMatchObject({ revision: 2, cursor: 11, settings: { name: 'User edit', enabled: false } });
  expect(store.runs(record.id)[0]).toMatchObject({ settings, input, revision: 1, status: 'pending' });
  expect(store.admitBatch(record, { cursor: 12, nextRunAt: null }, [{ key: 'stale', input }])).toBe(false);
  expect(store.runs(record.id)).toHaveLength(1);
});
test('failed admission rolls back enqueued work and checkpoint together', () => {
  const record = store.create(settings, 0, null);
  expect(() => store.admitBatch(record, { cursor: 2, nextRunAt: null }, [{ key: 'duplicate', input }, { key: 'duplicate', input }])).toThrow();
  expect(store.get(record.id).cursor).toBe(0); expect(store.runs(record.id)).toEqual([]);
  expect(store.admitBatch(record, { cursor: 2, nextRunAt: null }, [{ key: 'duplicate', input }])).toBe(true);
  expect(store.get(record.id).cursor).toBe(2); expect(store.runs(record.id)).toHaveLength(1);
  expect(store.admitBatch(record, { cursor: 2, nextRunAt: null }, [{ key: 'duplicate', input }])).toBe(false);
});
test('operational history and revisions are separate from D0, and transitions are conditional', () => {
  const record = store.create(settings, 0, null);
  const run = store.insertRun(record, input, 'manual', null, null);
  expect(store.transition(run.id, 'pending', 'running')).toBe(true);
  expect(store.transition(run.id, 'pending', 'running')).toBe(false);
  expect(store.transition(run.id, 'running', 'error', 'Target failed')).toBe(true);
  const retry = store.insertRun(record, input, 'retry', run.id, null);
  expect(retry.retryOf).toBe(run.id);
  expect(store.removeConfiguration(record.id, record.revision)).toBe(true);
  expect(store.list()).toEqual([]); expect(store.runs(record.id)).toHaveLength(2);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='events'").get()).toBeUndefined();
});
