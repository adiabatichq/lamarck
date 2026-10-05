import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuardEngine } from '../src/guard-service/engine';
import type { GuardPrincipal } from '../src/guard-service/protocol';
import { RuntimeListeners, type EventMatcher } from '../src/triggers/listeners';
import { TEST_PRODUCER_REF } from './support/test-guard';
import type { JsonValue } from '../src/json';
const principal: GuardPrincipal = { source: 'system:test', producerRef: TEST_PRODUCER_REF, tableGrants: '*', schemaGrant: true };
let workspace: string;
let engine: GuardEngine;
const query = { sql: 'SELECT id FROM events WHERE type = ?', params: ['test.event'] };
function append(startedAt = 100, payload: JsonValue = { value: 42 }, type = 'test.event') { return engine.writeEvent(principal, { type, startedAt, payload }); }
function matcher(): EventMatcher { return { eventBoundary: async () => engine.eventBoundary(principal), matchEvents: async (input) => engine.matchEvents(principal, input) }; }
beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'trigger-test-')); engine = new GuardEngine({ workspacePath: workspace }); });
afterEach(() => { engine.close(); rmSync(workspace, { recursive: true, force: true }); });

describe('Guard event matching', () => {
  test('size boundaries advance through preceding nonmatches and leave the overflowing match unread', () => {
    engine.close(); engine = new GuardEngine({ workspacePath: workspace, maxResultBytes: 1024 });
    append(100, {}, 'other.event');
    const a = append(1, { value: 'a'.repeat(512) });
    append(100, {}, 'other.event'); const beforeB = engine.eventBoundary(principal);
    const b = append(2, { value: 'b'.repeat(512) });
    append(100, {}, 'other.event'); const beforeC = engine.eventBoundary(principal);
    const c = append(3, { value: 'c'.repeat(512) });
    append(100, {}, 'other.event'); const end = engine.eventBoundary(principal);
    const duplicateQuery = { ...query, sql: 'SELECT e.id FROM events e JOIN json_each(\'[1,2]\') j WHERE e.type = ?' };
    const first = engine.matchEvents(principal, { ...duplicateQuery, after: 0 });
    expect(first.events.map(e => e.id)).toEqual([a]); expect(first.cursor).toBe(beforeB);
    const second = engine.matchEvents(principal, { ...duplicateQuery, after: first.cursor });
    expect(second.events.map(e => e.id)).toEqual([b]); expect(second.cursor).toBe(beforeC);
    const third = engine.matchEvents(principal, { ...duplicateQuery, after: second.cursor });
    expect(third.events.map(e => e.id)).toEqual([c]); expect(third.cursor).toBe(end);
    for (const batch of [first, second, third]) expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(1024);
    const preview = engine.matchEvents(principal, { ...query, sql: `${query.sql} ORDER BY rowid`, after: 0, preview: true });
    expect(preview.events.map(e => e.id)).toEqual([a]); expect(preview.truncated).toBe(true); expect(preview.cursor).toBe(0);
  });
  test('a single oversized event fails distinctly without skipping or truncating it', () => {
    const before = engine.eventBoundary(principal);
    const id = append(1, { value: 'x'.repeat(8 * 1024 * 1024) });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => engine.matchEvents(principal, { ...query, after: before })).toThrowError(expect.objectContaining({ code: 'GUARD_SUBSCRIPTION_EVENT_TOO_LARGE' }));
    }
    // Writing D0 remains allowed; only subscription response size is bounded.
    expect(engine.eventBoundary(principal)).toBeGreaterThan(before);
    expect(engine.matchEvents(principal, { sql: 'SELECT id FROM events WHERE id != ?', params: [id], after: before }).events).toEqual([]);
  });
  test('safe matches before an oversized event are delivered before that distinct error', () => {
    engine.close(); engine = new GuardEngine({ workspacePath: workspace, maxResultBytes: 1024 });
    const safe = append();
    append(100, {}, 'other.event'); const beforeOversized = engine.eventBoundary(principal);
    append(1, { value: 'x'.repeat(1024) });
    const batch = engine.matchEvents(principal, { ...query, after: 0 });
    expect(batch.events.map(e => e.id)).toEqual([safe]); expect(batch.cursor).toBe(beforeOversized);
    expect(() => engine.matchEvents(principal, { ...query, after: batch.cursor })).toThrowError(expect.objectContaining({ code: 'GUARD_SUBSCRIPTION_EVENT_TOO_LARGE' }));
  });
  test('append order, original envelope, native LIMIT, joins, grouping and deduplication', () => {
    append(); const boundary = engine.eventBoundary(principal); const imported = append(1, { value: 7 });
    const match = engine.matchEvents(principal, { ...query, after: boundary });
    expect(match.events.map((event) => event.id)).toEqual([imported]);
    expect(match.events[0].payload).toEqual({ value: 7 });
    expect(match.events[0].source).toBe('system:test');
    expect(engine.matchEvents(principal, { sql: 'SELECT id FROM events ORDER BY rowid LIMIT 1', after: boundary }).events).toEqual([]);
    expect(engine.matchEvents(principal, { sql: 'SELECT e.id, 999 AS payload FROM events e JOIN json_each(\'[1,2,3]\') j GROUP BY e.id, j.value', after: boundary }).events).toEqual(match.events);
    expect(engine.matchEvents(principal, { sql: 'SELECT id FROM events WHERE id IN (SELECT id FROM events ORDER BY rowid DESC LIMIT 1)', after: boundary }).events[0].id).toBe(imported);
  });
  test('writes, control plane, administrative SQL, bad parameters and missing id fail closed', () => {
    for (const sql of ['DELETE FROM events', 'SELECT * FROM connector_sources', 'PRAGMA user_version', 'ATTACH DATABASE \'x\' AS x', 'SELECT type FROM events WHERE 0', 'SELECT count(*) FROM events', 'SELECT 1 AS id']) expect(() => engine.matchEvents(principal, { sql, after: 0 })).toThrow();
    expect(() => engine.matchEvents(principal, { ...query, params: [{ bad: true } as any], after: 0 })).toThrow();
  });
  test('bounded preview leaves matching and append progress unchanged', () => {
    append(); append(); append(); const boundary = engine.eventBoundary(principal);
    const preview = engine.matchEvents(principal, { ...query, after: 0, preview: true, limit: 2 });
    expect(preview.events).toHaveLength(2); expect(preview.truncated).toBe(true);
    expect(engine.eventBoundary(principal)).toBe(boundary);
    expect(engine.matchEvents(principal, { ...query, after: 0 }).events).toHaveLength(3);
  });
  test('historical results larger than query limit do not truncate matches', () => {
    engine.close(); engine = new GuardEngine({ workspacePath: workspace, maxResultRows: 2 });
    append(); append(); append(); const boundary = engine.eventBoundary(principal); const last = append();
    expect(engine.matchEvents(principal, { ...query, after: boundary }).events.map((e) => e.id)).toEqual([last]);
  });
  test('changed joined data does not reconsider consumed events', () => {
    const plan = engine.schemaPlan(principal, 'CREATE TABLE choices (id TEXT PRIMARY KEY NOT NULL, enabled INTEGER)');
    engine.schemaApply(principal, plan, true); const id = append();
    const sql = 'SELECT e.id FROM events e JOIN choices c ON e.id = c.id WHERE c.enabled = 1';
    const first = engine.matchEvents(principal, { sql, after: 0 }); expect(first.events).toEqual([]);
    engine.mutate(principal, 'INSERT INTO choices VALUES (?, 1)', [id]);
    expect(engine.matchEvents(principal, { sql, after: first.cursor }).events).toEqual([]);
    expect(engine.matchEvents(principal, { sql, after: 0, preview: true }).events[0].id).toBe(id);
  });
});
describe('runtime listeners', () => {
  test('100 matching 90 KiB events split below 8 MiB, repeat until ack, and keep the listener active', async () => {
    const listeners = new RuntimeListeners(); const runtime = new AbortController();
    try {
      const handle = await listeners.start('burst', matcher(), query, runtime.signal);
      const payload = { value: 'x'.repeat(90 * 1024) };
      const ids = Array.from({ length: 100 }, (_, i) => append(i + 1, payload));
      const first = await listeners.next('burst', handle.subscriptionId, 0);
      expect(first.events.length).toBeGreaterThan(0); expect(first.events.length).toBeLessThan(100);
      expect(await listeners.next('burst', handle.subscriptionId, 0)).toEqual(first);
      const second = await listeners.next('burst', handle.subscriptionId, first.sequence);
      expect([...first.events, ...second.events].map(e => e.id)).toEqual(ids);
      expect(first.events[0].payload).toEqual(payload);
      for (const batch of [first, second]) expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(8 * 1024 * 1024);
      const later = append();
      expect((await listeners.next('burst', handle.subscriptionId, second.sequence)).events.map(e => e.id)).toEqual([later]);
    } finally { listeners.close(); }
  });
  test('independent registrations start now; acknowledgements and cancellation are owner-bound', async () => {
    const listeners = new RuntimeListeners(); const runtime = new AbortController(); append();
    const a = await listeners.start('app:one', matcher(), query, runtime.signal);
    const b = await listeners.start('app:one', matcher(), query, runtime.signal); const id = append();
    const first = await listeners.next('app:one', a.subscriptionId, 0);
    expect(first.events.map((e) => e.id)).toEqual([id]);
    expect(await listeners.next('app:one', a.subscriptionId, 0)).toEqual(first);
    expect((await listeners.next('app:one', b.subscriptionId, 0)).events.map((e) => e.id)).toEqual([id]);
    await expect(listeners.next('app:two', a.subscriptionId, 0)).rejects.toThrow('unavailable');
    expect(() => listeners.cancel('app:two', a.subscriptionId)).toThrow('unavailable');
    listeners.cancel('app:one', a.subscriptionId);
    await expect(listeners.next('app:one', a.subscriptionId, 1)).rejects.toThrow('unavailable');
    runtime.abort(); await expect(listeners.next('app:one', b.subscriptionId, 1)).rejects.toThrow('unavailable');
  });
  test('restart discards listeners and a new call skips events appended while absent', async () => {
    let listeners = new RuntimeListeners(); const runtime = new AbortController();
    const old = await listeners.start('source:one', matcher(), query, runtime.signal);
    listeners.close(); append(); engine.close(); engine = new GuardEngine({ workspacePath: workspace }); listeners = new RuntimeListeners();
    await expect(listeners.next('source:one', old.subscriptionId, 0)).rejects.toThrow('unavailable');
    const fresh = await listeners.start('source:one', matcher(), query, runtime.signal); const id = append();
    expect((await listeners.next('source:one', fresh.subscriptionId, 0)).events.map((e) => e.id)).toEqual([id]); listeners.close();
  });
  test('failed evaluation keeps candidates unread; fn/name/id registration is rejected', async () => {
    const listeners = new RuntimeListeners(); const runtime = new AbortController(); let failed = false; const delegate = matcher();
    const guarded: EventMatcher = { ...delegate, matchEvents: async (input) => { if (failed) throw new Error('Guard unavailable'); return delegate.matchEvents(input); } };
    for (const extra of [{ fn: 'code' }, { id: 'saved' }, { name: 'named' }]) await expect(listeners.start('a', guarded, { ...query, ...extra }, runtime.signal)).rejects.toThrow();
    const listener = await listeners.start('a', guarded, query, runtime.signal); const id = append(); failed = true;
    await expect(listeners.next('a', listener.subscriptionId, 0)).rejects.toThrow('Guard unavailable'); failed = false;
    expect((await listeners.next('a', listener.subscriptionId, 0)).events[0].id).toBe(id); listeners.close();
  });
});
