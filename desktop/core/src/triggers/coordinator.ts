import { setTimeout as delay } from 'node:timers/promises';
import { subscriptionQuery, type EventMatcher } from './listeners';
import { nextScheduledTime, upcomingTimes } from './schedule';
import { TriggerStore, type TriggerSettings, type TriggerRecord, type TriggerRun } from './store';

export interface TriggerTarget {
  id: string; name: string; kind: 'app-job' | 'source-run'; appId?: string; sourceId?: string;
  inputs: ('event' | 'schedule')[]; available: boolean; reason: string | null;
}
export interface TriggerTargets {
  list(): Promise<TriggerTarget[]>;
  invoke(target: TriggerTarget, run: TriggerRun, signal: AbortSignal): Promise<void>;
}
/** Host control plane only. Proposed lifecycle policies are documented alongside
 * the ADR; temporary runtime listeners never enter this coordinator or store. */
export class TriggerCoordinator {
  private active = new Map<string, { target: string; controller: AbortController; task: Promise<void> }>();
  private stopping = false;
  private ticking: Promise<void> | null = null;
  private loop: Promise<void> | null = null;
  private controller = new AbortController();
  constructor(readonly store: TriggerStore, private matcher: EventMatcher, private targets: TriggerTargets, private now = Date.now) { store.recover(now()); }

  async catalog() { return this.targets.list(); }
  async list() {
    const targets = await this.catalog();
    return this.store.list().map(record => {
      const target = targets.find(t => t.id === record.settings.target);
      return { id: record.id, revision: record.revision, name: record.settings.name, kind: record.settings.condition.kind, target: record.settings.target, enabled: record.settings.enabled, available: target?.available ?? false, unavailableReason: target?.reason ?? (target ? null : 'Target is missing'), error: record.error, nextRunAt: record.nextRunAt, lastRun: this.history(record.id, 1)[0] ?? null };
    });
  }
  async inspect(id: string) { return { ...this.store.get(id), ...(await this.list()).find(t => t.id === id), runs: this.history(id) }; }
  history(id: string, limit = 50) {
    return this.store.runs(id, limit).map(run => ({ id: run.id, triggerId: run.triggerId, revision: run.revision, name: run.settings.name, target: run.settings.target, status: run.status, origin: run.origin, retryOf: run.retryOf, createdAt: run.createdAt, startedAt: run.startedAt, endedAt: run.endedAt, error: run.error, input: run.input.kind === 'event' ? { kind: 'event', eventId: run.input.event.id, type: run.input.event.type } : run.input }));
  }
  async validate(value: unknown): Promise<TriggerSettings> {
    const raw = object(value); only(raw, ['name', 'target', 'enabled', 'condition']);
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200 || typeof raw.target !== 'string' || typeof raw.enabled !== 'boolean') throw new Error('Trigger requires name, supported target, enabled, and condition');
    if (Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024) throw new Error('Trigger settings exceed 16 KiB');
    const condition = object(raw.condition);
    if (condition.kind === 'event') {
      only(condition, ['kind', 'sql', 'params']);
      await this.matcher.matchEvents({ ...subscriptionQuery({ sql: condition.sql, ...(condition.params === undefined ? {} : { params: condition.params }) }), after: await this.matcher.eventBoundary(), limit: 1 });
    } else if (condition.kind === 'schedule') {
      only(condition, ['kind', 'cron', 'timezone']);
      if (typeof condition.cron !== 'string' || typeof condition.timezone !== 'string') throw new Error('Schedule requires cron and IANA timezone');
      nextScheduledTime(condition.cron, condition.timezone, this.now());
    } else throw new Error('Condition must be event or schedule');
    if (Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024) throw new Error('Trigger settings exceed 16 KiB');
    const target = (await this.catalog()).find(t => t.id === raw.target);
    if (!target || !target.inputs.includes(condition.kind)) throw new Error('Target does not support this condition');
    return JSON.parse(JSON.stringify(raw)) as unknown as TriggerSettings;
  }
  async create(value: unknown) {
    const settings = await this.validate(value); const cursor = await this.matcher.eventBoundary();
    return this.store.create(settings, cursor, this.next(settings), this.now());
  }
  async update(id: string, revision: number, patch: unknown) {
    const old = this.store.get(id); const raw = object(patch); only(raw, ['name', 'target', 'enabled', 'condition']);
    const settings = await this.validate({ ...old.settings, ...raw });
    const resets = (!old.settings.enabled && settings.enabled) || old.settings.target !== settings.target || JSON.stringify(old.settings.condition) !== JSON.stringify(settings.condition);
    const boundary = resets ? await this.matcher.eventBoundary() : null;
    // Evaluation may commit while validation awaits Guard/catalog. Preserve
    // that latest checkpoint; revision CAS still rejects another settings edit.
    const current = this.store.get(id);
    const cursor = boundary === null ? current.cursor : Math.max(boundary, current.cursor);
    return this.store.replace(id, revision, settings, cursor, resets ? this.next(settings) : current.nextRunAt, this.now());
  }
  async enable(id: string, enabled: boolean, revision?: number) {
    const current = this.store.get(id);
    if (!enabled) return this.store.replace(id, revision ?? current.revision, { ...current.settings, enabled }, current.cursor, current.nextRunAt, this.now());
    return this.update(id, revision ?? current.revision, { enabled });
  }
  remove(id: string, revision: number) {
    this.store.atomic(() => {
      if (!this.store.removeConfiguration(id, revision)) throw new Error('Trigger changed; reload and retry');
      this.store.cancelPending(id, this.now());
    });
    return { ok: true };
  }
  async preview(value: unknown, limit = 5) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Preview limit must be 1–20');
    const raw = object(value); const condition = object(raw.condition ?? raw);
    if (condition.kind === 'schedule') {
      only(condition, ['kind', 'cron', 'timezone']);
      if (typeof condition.cron !== 'string' || typeof condition.timezone !== 'string') throw new Error('Schedule requires cron and timezone');
      return { kind: 'schedule', times: upcomingTimes(condition.cron, condition.timezone, this.now(), limit) };
    }
    if (condition.kind !== 'event') throw new Error('Condition must be event or schedule');
    only(condition, ['kind', 'sql', 'params']);
    const result = await this.matcher.matchEvents({ ...subscriptionQuery({ sql: condition.sql, ...(condition.params === undefined ? {} : { params: condition.params }) }), after: 0, preview: true, limit });
    return { kind: 'event', truncated: result.truncated, events: result.events.map(e => ({ id: e.id, type: e.type, source: e.source, startedAt: e.started_at })) };
  }
  cancelRun(id: string) {
    const run = this.store.run(id);
    if (run.status === 'pending') this.store.transition(id, 'pending', 'canceled', 'Canceled by user', this.now());
    if (run.status === 'running') { this.store.transition(id, 'running', 'canceled', 'Canceled by user; external effects may have occurred', this.now()); this.active.get(id)?.controller.abort(); }
    return { ok: true };
  }
  start(): void {
    if (this.loop) return;
    this.loop = (async () => {
      while (!this.stopping) {
        try { await this.tick(); } catch (error) { console.error('[triggers]', error); }
        try { await delay(1000, undefined, { signal: this.controller.signal }); } catch { break; }
      }
    })();
  }
  tick(): Promise<void> { return this.ticking ??= this.evaluate().finally(() => { this.ticking = null; }); }
  private async evaluate(): Promise<void> {
    if (this.stopping) return;
    const targets = await this.catalog();
    for (const record of this.store.list()) {
      if (this.stopping || !record.settings.enabled) continue;
      const target = targets.find(t => t.id === record.settings.target);
      if (!target?.available) { this.store.setError(record.id, record.revision, target?.reason ?? 'Target is missing'); continue; }
      const capacity = 256 - this.store.pendingCount(record.id);
      if (capacity <= 0) continue;
      try {
        const condition = record.settings.condition;
        if (condition.kind === 'event') {
          const result = await this.matcher.matchEvents({ sql: condition.sql, params: condition.params, after: record.cursor, limit: Math.min(100, capacity) });
          if (!this.stopping) this.store.admitBatch(record, { cursor: result.cursor, nextRunAt: null }, result.events.map(event => ({ key: `event:${event.id}`, input: { kind: 'event', event } })), this.now());
        } else if (record.nextRunAt !== null && record.nextRunAt <= this.now()) {
          const scheduledAt = record.nextRunAt;
          this.store.admitBatch(record, { cursor: record.cursor, nextRunAt: nextScheduledTime(condition.cron, condition.timezone, this.now()) }, [{ key: `schedule:${scheduledAt}`, input: { kind: 'schedule', scheduledAt } }], this.now());
        } else this.store.setError(record.id, record.revision, null);
      } catch (error) { this.store.setError(record.id, record.revision, message(error)); }
    }
    // A per-target lane prevents overlapping effects; four lanes bound Host work.
    for (const id of this.store.pendingTargets()) {
      const target = targets.find(target => target.id === id);
      this.store.pendingAvailability(id, target?.available ? null : target?.reason ?? 'Queued target is missing');
    }
    const lanes = targets.filter(target => target.available && ![...this.active.values()].some(t => t.target === target.id))
      .map(target => ({ target, run: this.store.pendingForTarget(target.id) }))
      .filter((lane): lane is { target: TriggerTarget; run: TriggerRun } => lane.run !== null)
      .sort((a, b) => a.run.createdAt - b.run.createdAt || a.run.id.localeCompare(b.run.id));
    for (const { target, run } of lanes) {
      if (this.stopping || this.active.size >= 4) break;
      if (!this.store.transition(run.id, 'pending', 'running', null, this.now())) continue;
      const controller = new AbortController();
      const task = Promise.resolve().then(() => this.targets.invoke(target, run, controller.signal)).then(
        () => { this.store.transition(run.id, 'running', 'success', null, this.now()); },
        error => { this.store.transition(run.id, 'running', this.stopping ? 'interrupted' : 'error', message(error), this.now()); },
      ).finally(() => { this.active.delete(run.id); });
      this.active.set(run.id, { target: target.id, controller, task });
    }
  }
  async close(): Promise<void> {
    this.stopping = true; this.controller.abort();
    for (const entry of this.active.values()) entry.controller.abort(new Error('Host stopped during execution; external effects may have occurred'));
    await Promise.allSettled([this.loop, this.ticking, ...[...this.active.values()].map(e => e.task)]);
  }
  private next(settings: TriggerSettings) { return settings.condition.kind === 'schedule' ? nextScheduledTime(settings.condition.cron, settings.condition.timezone, this.now()) : null; }
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected configuration object'); return value as Record<string, unknown>; }
function only(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).some(k => !keys.includes(k))) throw new Error('Unknown or Host-owned configuration field'); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
