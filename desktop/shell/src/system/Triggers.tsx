import { useCallback, useEffect, useRef, useState } from "react";
import { useCorePolling } from "../hooks/useCorePolling";
import { manageTrigger, type TriggerDetail, type TriggerPreview, type TriggerSettings, type TriggerSummary, type TriggerTarget } from "../lib/api";
import styles from "./Triggers.module.css";

export interface TriggerFilter { appId?: string; sourceId?: string; triggerId?: string }
export interface TriggerDraft { name: string; target: string; enabled: boolean; kind: "event" | "schedule"; sql: string; params: string; cron: string; timezone: string }
const blank = (filter?: TriggerFilter): TriggerDraft => ({ name: "", target: filter?.sourceId ? `source:${filter.sourceId}:run` : "", enabled: false, kind: filter?.sourceId ? "schedule" : "event", sql: "SELECT id FROM events WHERE type = ?", params: '["example.event"]', cron: "0 9 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
const fromSettings = (s: TriggerSettings): TriggerDraft => ({ ...blank(), name: s.name, target: s.target, enabled: s.enabled, kind: s.condition.kind, ...(s.condition.kind === "event" ? { sql: s.condition.sql, params: JSON.stringify(s.condition.params ?? []) } : { cron: s.condition.cron, timezone: s.condition.timezone }) });

export function draftSettings(draft: TriggerDraft): TriggerSettings {
  return { name: draft.name, target: draft.target, enabled: draft.enabled, condition: draft.kind === "schedule"
    ? { kind: "schedule", cron: draft.cron, timezone: draft.timezone }
    : { kind: "event", sql: draft.sql, params: JSON.parse(draft.params || "[]") } };
}
export function targetInFilter(target: string, filter?: TriggerFilter): boolean {
  return !filter?.appId && !filter?.sourceId || !!filter.appId && target.startsWith(`app:${filter.appId}:job:`) || !!filter.sourceId && target === `source:${filter.sourceId}:run`;
}

export function Triggers({ filter, connected }: { filter?: TriggerFilter; connected: boolean }) {
  const [records, setRecords] = useState<TriggerSummary[]>([]), [targets, setTargets] = useState<TriggerTarget[]>([]);
  const [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<TriggerDetail | null>(null);
  const [draft, setDraft] = useState<TriggerDraft | null>(() => blank(filter)), [preview, setPreview] = useState<TriggerPreview | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false);
  const editingRevision = useRef<number | null>(null);
  const read = useCallback(async (signal: AbortSignal) => {
    try {
      const [records, targets, detail] = await Promise.all([
        manageTrigger<TriggerSummary[]>("trigger.list", {}, signal), manageTrigger<TriggerTarget[]>("trigger.targets", {}, signal),
        selected ? manageTrigger<TriggerDetail>("trigger.inspect", { triggerId: selected }, signal) : Promise.resolve(null),
      ]);
      if (signal.aborted) return;
      setRecords(records); setTargets(targets); setDetail(detail);
      if (detail && editingRevision.current === null) { editingRevision.current = detail.revision; setDraft(fromSettings(detail.settings)); }
    } catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [selected]);
  const refresh = useCorePolling(read, 3000, connected);
  useEffect(() => { editingRevision.current = null; setSelected(filter?.triggerId ?? null); setDetail(null); setDraft(filter?.triggerId ? null : blank(filter)); setPreview(null); setDeleting(false); }, [filter]);
  const choose = (id: string | null) => { editingRevision.current = null; setSelected(id); setDetail(null); setDraft(id ? null : blank(filter)); setPreview(null); setError(null); setDeleting(false); };
  const act = async (action: () => Promise<void>) => { setBusy(true); setError(null); try { await action(); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  return <TriggerView records={records.filter(r => targetInFilter(r.target, filter))} targets={targets.filter(t => targetInFilter(t.id, filter))}
    detail={detail} selected={selected} draft={draft} preview={preview} error={error} busy={busy || !connected} deleting={deleting} filter={filter}
    onSelect={choose} onDraft={value => { setDraft(value); setPreview(null); }} onDelete={() => setDeleting(true)} onCancelDelete={() => setDeleting(false)}
    onSave={() => void act(async () => {
      if (!draft) return;
      const config = draftSettings(draft);
      const saved = await manageTrigger<{ id: string }>(selected ? "trigger.update" : "trigger.create", selected ? { triggerId: selected, revision: editingRevision.current, config } : { config });
      editingRevision.current = null; setSelected(saved.id); setDraft(null); setPreview(null);
    })}
    onPreview={() => void act(async () => { if (draft) setPreview(await manageTrigger<TriggerPreview>("trigger.preview", { config: { condition: draftSettings(draft).condition }, limit: 5 })); })}
    onToggle={() => void act(async () => { if (detail) { await manageTrigger(detail.enabled ? "trigger.disable" : "trigger.enable", { triggerId: detail.id, revision: detail.revision }); editingRevision.current = null; setDraft(null); } })}
    onConfirmDelete={() => void act(async () => { if (detail) { await manageTrigger("trigger.delete", { triggerId: detail.id, revision: detail.revision }); choose(null); } })}
    onCancelRun={id => void act(async () => { await manageTrigger("trigger.cancel", { runId: id }); })} />;
}

export function TriggerView({ records, targets, detail, selected, draft, preview, error, busy, deleting, filter, onSelect, onDraft, onSave, onPreview, onToggle, onDelete, onCancelDelete, onConfirmDelete, onCancelRun }: {
  records: TriggerSummary[]; targets: TriggerTarget[]; detail: TriggerDetail | null; selected: string | null; draft: TriggerDraft | null;
  preview: TriggerPreview | null; error: string | null; busy: boolean; deleting: boolean; filter?: TriggerFilter;
  onSelect(id: string | null): void; onDraft(draft: TriggerDraft): void; onSave(): void; onPreview(): void; onToggle(): void;
  onDelete(): void; onCancelDelete(): void; onConfirmDelete(): void; onCancelRun(id: string): void;
}) {
  const field = (key: keyof TriggerDraft, value: string | boolean) => draft && onDraft({ ...draft, [key]: value });
  const target = targets.find(t => t.id === draft?.target);
  return <div className={styles.surface}>
    <section className={styles.master} aria-label="Triggers">
      <header><span className={styles.overline}>Subscriptions & schedules</span><h1>Triggers</h1>
        {filter && <p>For {filter.appId ?? filter.sourceId}</p>}
        <button type="button" disabled={busy} onClick={() => onSelect(null)}>New Trigger</button>
      </header>
      <div className={styles.list}>
        {!records.length && <p className={styles.hint}>No Triggers here yet. Choose a target and preview a condition to begin.</p>}
        {records.map(record => <button key={record.id} type="button" aria-pressed={selected === record.id} className={styles.row} onClick={() => onSelect(record.id)}>
          <strong>{record.name}</strong><span>{record.enabled ? "Enabled" : "Disabled"} · {record.kind === "event" ? "Subscription" : "Schedule"}</span>
          <small>{record.target}</small>
          {!record.available && <span className={styles.warning}>{record.unavailableReason}</span>}
          {record.error && <span className={styles.warning}>{record.error}</span>}
          <span>{record.lastRun ? `Last run: ${record.lastRun.status}` : "No runs"}{record.nextRunAt ? ` · Next: ${time(record.nextRunAt)}` : ""}</span>
        </button>)}
      </div>
    </section>
    <section className={styles.inspector} aria-label="Trigger settings">
      <header><span className={styles.overline}>{selected ? "Trigger settings" : "Create Trigger"}</span><h2>{detail?.name ?? "A condition and a target"}</h2>
        {detail && <p>{detail.id} · revision {detail.revision}</p>}
      </header>
      {error && <p role="alert" className={styles.warning}>{error}</p>}
      {draft ? <form onSubmit={e => { e.preventDefault(); onSave(); }}>
        <label>Name<input value={draft.name} onChange={e => field("name", e.target.value)} maxLength={200} required /></label>
        <label>Target<select value={draft.target} onChange={e => {
          const next = targets.find(t => t.id === e.target.value);
          onDraft({ ...draft, target: e.target.value, kind: next && !next.inputs.includes(draft.kind) ? next.inputs[0] : draft.kind });
        }} required>
          <option value="">Choose a declared job or Source</option>
          {draft.target && !target && <option value={draft.target}>{draft.target} · missing</option>}
          {targets.map(t => <option key={t.id} value={t.id}>{t.name}{t.available ? "" : " · unavailable"}</option>)}
        </select></label>
        {target?.reason && <p className={styles.hint}>{target.reason}</p>}
        <label>Condition<select value={draft.kind} onChange={e => field("kind", e.target.value)}>
          <option value="event" disabled={!!target && !target.inputs.includes("event")}>Subscription</option>
          <option value="schedule" disabled={!!target && !target.inputs.includes("schedule")}>Schedule</option>
        </select></label>
        {draft.kind === "event" ? <>
          <label>Read-only SQL<textarea className={styles.code} value={draft.sql} onChange={e => field("sql", e.target.value)} rows={5} required /></label>
          <label>Parameters (JSON)<textarea className={styles.code} value={draft.params} onChange={e => field("params", e.target.value)} rows={2} /></label>
        </> : <>
          <label>Cron<input className={styles.code} value={draft.cron} onChange={e => field("cron", e.target.value)} required /></label>
          <label>Timezone<input value={draft.timezone} onChange={e => field("timezone", e.target.value)} placeholder="Asia/Taipei" required /></label>
        </>}
        <label className={styles.check}><input type="checkbox" checked={draft.enabled} onChange={e => field("enabled", e.target.checked)} />Enabled</label>
        <p className={styles.hint}>Starts from now when created, enabled, or its condition or target changes. Queued runs keep their saved settings. Preview does not run the target.</p>
        <div className={styles.actions}><button type="button" disabled={busy} onClick={onPreview}>Preview</button><button type="submit" disabled={busy || !!selected && !detail}>{selected ? "Save settings" : "Create Trigger"}</button>
          {detail && <><button type="button" disabled={busy} onClick={onToggle}>{detail.enabled ? "Disable" : "Enable"}</button><button type="button" disabled={busy} onClick={onDelete}>Delete Trigger</button></>}
        </div>
      </form> : <p>Loading settings…</p>}
      {deleting && <div className={styles.confirm} role="alertdialog" aria-label="Delete Trigger"><p>Delete settings and cancel queued runs? Running work can finish; history is retained.</p><button disabled={busy} onClick={onConfirmDelete}>Delete settings</button><button onClick={onCancelDelete}>Keep Trigger</button></div>}
      {preview && <section className={styles.results} aria-label="Preview"><h3>{preview.kind === "event" ? "Historical sample" : "Upcoming times"}</h3>
        {preview.kind === "schedule" ? <ul>{preview.times.map(t => <li key={t}>{time(t)} <small>{new Date(t).toISOString()}</small></li>)}</ul> : <>
          {!preview.events.length && <p>No matching events.</p>}
          {preview.events.map(event => <p key={event.id}><strong>{event.type}</strong> · {event.source} · {time(event.startedAt)}<small>{event.id}</small></p>)}
          {preview.truncated && <p className={styles.hint}>Sample bounded by the response limit.</p>}
        </>}
      </section>}
      {detail && <section className={styles.results} aria-label="Execution history"><h3>Execution history</h3>
        {!detail.runs.length && <p>No runs yet.</p>}
        {detail.runs.map(run => <article key={run.id}><div><strong>{run.status}</strong> · {time(run.createdAt)} · revision {run.revision}</div>
          <p>{run.input.kind === "event" ? `${run.input.type} · ${run.input.eventId}` : `Scheduled for ${time(run.input.scheduledAt)}`}</p>
          <small>{run.id} · {run.target}</small>{run.error && <p className={styles.warning}>{run.error}</p>}
          {(run.status === "pending" || run.status === "running") && <button disabled={busy} onClick={() => onCancelRun(run.id)}>Cancel run</button>}
        </article>)}
      </section>}
    </section>
  </div>;
}
function time(value: number): string { return new Date(value).toLocaleString(); }
