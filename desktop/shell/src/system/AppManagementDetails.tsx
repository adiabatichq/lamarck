import { useCallback, useId, useState, type KeyboardEvent, type ReactElement } from "react";
import type { AppHistoryView, AppRuntimeView } from "../hooks/useAppsManager";
import { useCorePolling } from "../hooks/useCorePolling";
import { manageTrigger, type AppInfo, type AppVersionRecordV1, type TriggerSummary } from "../lib/api";
import { AppMark } from "../components/AppMark";
import { workloadName } from "../lib/app-visual";
import { AppActivity, AppEnablementSwitch, AppServices, useAppEnablement } from "./AppWorkloadManagement";
import styles from "./AppsManager.module.css";

const TABS = ["Manage", "Activity", "Permissions", "Versions"] as const;
type Tab = typeof TABS[number];

export interface AppManagementDetailsProps {
  app: AppInfo;
  runtime?: AppRuntimeView;
  history: AppHistoryView;
  loading: boolean;
  busy: "restore" | "rebuild" | null;
  error: string | null;
  executionPending?: ReadonlySet<string>;
  executionError?: string | null;
  onOpenApp: (appId: string) => void;
  onCloseUi?: (appId: string) => void;
  onStopJob?: (appId: string, runId: string) => void;
  onAppDisabled?: (appId: string) => void;
  onManageTriggers?: (appId: string, triggerId?: string) => void;
  onPolicyChanged?: () => Promise<void>;
  onLoadMore: () => void;
  onRequestRestore: (app: AppInfo, version: AppVersionRecordV1) => void;
  onRequestRebuild: (app: AppInfo) => void;
}

export function AppManagementDetails({ app, runtime, history, loading, busy, error, executionPending = new Set(),
  executionError, onOpenApp, onCloseUi, onStopJob, onAppDisabled, onManageTriggers, onPolicyChanged,
  onLoadMore, onRequestRestore, onRequestRebuild }: AppManagementDetailsProps) {
  const [tab, setTab] = useState<Tab>("Manage");
  const tabId = useId();
  const policy = useAppEnablement(app.id, onPolicyChanged, onAppDisabled);
  const [triggers, setTriggers] = useState<readonly TriggerSummary[]>([]);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [triggersLoaded, setTriggersLoaded] = useState(false);
  const jobIds = Object.keys(app.runtime?.jobs ?? {});
  const readTriggers = useCallback(async (signal: AbortSignal) => {
    try {
      const records = await manageTrigger<TriggerSummary[]>("trigger.list", {}, signal);
      if (!signal.aborted) { setTriggers(records.filter(record => record.target.startsWith(`app:${app.id}:job:`))); setTriggerError(null); setTriggersLoaded(true); }
    } catch (cause) {
      if (!signal.aborted) setTriggerError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [app.id]);
  useCorePolling(readTriggers, 3000, tab === "Manage" && jobIds.length > 0);
  const serviceIds = [...new Set([...Object.keys(app.runtime?.services ?? {}), ...(runtime?.services ?? []).map(service => service.serviceId)])];
  const services = serviceIds.map(serviceId => runtime?.services?.find(service => service.serviceId === serviceId)
    ?? { serviceId, enabled: null, state: "unconfigured" as const, executionId: null, restartAt: null, failure: null });
  const appStopping = !!runtime?.stopping || executionPending.has(`app:${app.id}`);
  const uiPending = executionPending.has(`ui:${app.id}`);
  const failure = app.manifestHealth.status === "invalid" ? app.manifestHealth.message
    : app.versionHealth.status === "unavailable" ? app.versionHealth.message : runtime?.latestFailure;
  const errors = [...new Set([error, executionError, policy.error, failure].filter(Boolean))];
  const grants = [...new Set([`apps/${app.id}/`, ...(app.permissions?.writes.files ?? [])])];
  const navigateTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length
      : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); setTab(TABS[next]); document.getElementById(`${tabId}-${TABS[next]}`)?.focus();
  };
  return <section className={styles.appDetails} aria-label={`${app.name} settings`}>
    <header className={styles.appHeader}>
      <div className={styles.appIdentity}><AppMark appId={app.id} name={app.name} size="large" />
        <div><h2>{app.name}</h2>{app.description && <p>{app.description}</p>}</div>
      </div>
      <AppEnablementSwitch label="App enabled" enabled={runtime?.enabled} disabled={policy.pending !== null || appStopping}
        onChange={enabled => void policy.changeApp(enabled)} />
    </header>
    <div className={styles.primaryActions}>
      {app.runtime?.ui && <button type="button" className={styles.primaryButton}
        disabled={loading || runtime?.enabled !== true || appStopping || policy.pending !== null} onClick={() => onOpenApp(app.id)}>Open app <span aria-hidden="true">↗</span></button>}
      {app.runtime?.ui && onCloseUi && (uiPending || runtime?.ui && runtime.ui !== "closed") && <button type="button" className={styles.secondaryButton}
        disabled={loading || appStopping || uiPending || runtime?.ui === "stopping" || policy.pending !== null}
        onClick={() => onCloseUi(app.id)}>{uiPending ? "Closing UI…" : "Close UI"}</button>}
      {runtime?.enabled === false && <p className={styles.hint}>App is disabled. Its service and Trigger settings are preserved.</p>}
    </div>
    {policy.pending === "app" && <p className={styles.hint} role="status">Saving App setting · waiting for cleanup</p>}
    {appStopping && <p className={styles.hint} role="status">Stopping App · waiting for cleanup</p>}
    {errors.map(value => <p key={value} className={styles.failure} role="alert">{value}</p>)}
    <div className={styles.tabs} role="tablist" aria-label="App settings">
      {TABS.map((value, index) => <button type="button" role="tab" key={value} id={`${tabId}-${value}`} aria-controls={`${tabId}-panel`}
        aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => navigateTab(event, index)}>{value}</button>)}
    </div>
    <div className={styles.tabPanel} role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`}>
      {tab === "Manage" && <>
        <AppServices services={services} appEnabled={runtime?.enabled} pending={policy.pending} onChange={(id, enabled) => void policy.changeService(id, enabled)} />
        {(jobIds.length > 0 || (runtime?.jobs?.length ?? 0) > 0) && <AppExecutionView appId={app.id} runtime={runtime} jobIds={jobIds} loading={loading}
          pending={executionPending} error={executionError ?? null} onStopJob={onStopJob} onManageTriggers={onManageTriggers}
          triggers={triggers} triggersLoaded={triggersLoaded} triggerError={triggerError} />}
        {!app.runtime?.ui && !services.length && !jobIds.length && <p className={styles.empty}>This app has no declared workloads.</p>}
      </>}
      {tab === "Activity" && <AppActivity appId={app.id} />}
      {tab === "Permissions" && <section aria-label="Write permissions"><h3>Write permissions</h3>
        <p className={styles.hint}>This app can write to the following locations.</p>
        <GrantList label="Files" values={grants} empty="No writable folders" />
        <GrantList label="Tables" values={app.permissions?.writes.tables ?? []} empty="No table writes allowed" />
        <details className={styles.technicalDetails}><summary>App details</summary><dl><dt>App ID</dt><dd><code>{app.id}</code></dd></dl></details>
      </section>}
      {tab === "Versions" && <AppVersions app={app} history={history} busy={busy} onLoadMore={onLoadMore} onRequestRestore={onRequestRestore} onRequestRebuild={onRequestRebuild} />}
    </div>
  </section>;
}

export function AppExecutionView({ appId, runtime, jobIds = [], loading, pending, error, onStopJob, onManageTriggers,
  triggers = [], triggersLoaded = true, triggerError = null }: {
  appId: string; runtime?: AppRuntimeView; jobIds?: readonly string[]; loading: boolean; pending: ReadonlySet<string>; error: string | null;
  onStopJob?: (appId: string, runId: string) => void;
  onManageTriggers?: (appId: string, triggerId?: string) => void;
  triggers?: readonly TriggerSummary[]; triggersLoaded?: boolean; triggerError?: string | null;
}): ReactElement {
  const appStopping = !!runtime?.stopping || pending.has(`app:${appId}`);
  const active = runtime?.jobs ?? [];
  const declared = [...new Set([...jobIds, ...active.map(job => job.jobId)])];
  const labels = { starting: "Starting", running: "Running", stopping: "Stopping · waiting for cleanup", "cleanup-failed": "Cleanup failed · stop unconfirmed" };
  return <section className={styles.workloadSection} aria-label="Jobs">
    <h3>Jobs</h3>
    {appStopping && <p className={styles.hint} role="status">Stopping App · waiting for cleanup</p>}
    {triggerError && <p className={styles.failure} role="alert">Trigger settings could not be loaded: {triggerError}</p>}
    {loading && !runtime ? <p className={styles.hint} role="status">Checking active jobs…</p>
      : !active.length && (error || !declared.length) && <p className={styles.hint}>{error ? "Active job state could not be confirmed." : "No active jobs."}</p>}
    <ul className={styles.workloadList}>{declared.map(jobId => {
      const jobs = active.filter(job => job.jobId === jobId);
      const conditions = triggers.filter(trigger => trigger.target === `app:${appId}:job:${jobId}`);
      const lastRun = conditions.flatMap(trigger => trigger.lastRun ? [trigger.lastRun] : []).sort((a, b) => b.createdAt - a.createdAt)[0];
      const nextRun = conditions.filter(trigger => trigger.enabled && trigger.available && trigger.nextRunAt !== null).sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0]?.nextRunAt;
      return <li key={jobId}>
        <div className={styles.workloadRow}><div className={styles.workloadCopy}><h4>{workloadName(jobId)}</h4>
          {!jobs.length && <p>{error ? "Execution state unavailable" : lastRun ? `Last run: ${runLabel(lastRun.status)} · ${formatTime(lastRun.endedAt ?? lastRun.createdAt)}` : triggerError ? "Run history unavailable" : triggersLoaded ? "No runs yet" : "Checking last run…"}</p>}
        </div>{onManageTriggers && <button type="button" className={styles.secondaryButton} aria-label={`Manage triggers for ${jobId}`}
          onClick={() => onManageTriggers(appId, conditions.length === 1 ? conditions[0].id : undefined)}>Manage triggers <span aria-hidden="true">›</span></button>}</div>
        <ul className={styles.activeJobs}>{jobs.map(job => {
          const stopping = pending.has(`job:${job.runId}`) || job.state === "stopping";
          return <li key={job.runId}><div className={styles.workloadRow}>
            <span role="status">{job.state === "cleanup-failed" ? labels[job.state] : stopping ? labels.stopping : labels[job.state]}</span>
            <div className={styles.rowActions}>{job.triggerId && onManageTriggers && <button type="button" className={styles.textButton}
              onClick={() => onManageTriggers(appId, job.triggerId!)}>View trigger</button>}
              {onStopJob && <button type="button" className={styles.secondaryButton} aria-label={`Stop job ${job.jobId}, run ${job.runId}`}
                disabled={appStopping || stopping || job.state === "cleanup-failed"}
                onClick={() => onStopJob(appId, job.runId)}>{stopping ? "Stopping job…" : "Stop job"}</button>}</div>
          </div>{job.cleanupError && <p className={styles.failure} role="alert">{job.cleanupError}</p>}
            <details className={styles.technicalDetails}><summary>Run details</summary><dl><dt>Run ID</dt><dd><code>{job.runId}</code></dd>
              {job.triggerId && <><dt>Trigger ID</dt><dd><code>{job.triggerId}</code></dd></>}</dl></details>
          </li>;
        })}</ul>
        {conditions.length > 0 && <p className={styles.triggerSummary}>{conditions.map(trigger => trigger.name).join(" · ")} · {conditions.filter(trigger => trigger.enabled).length} enabled
          {runtime?.enabled !== false && nextRun != null ? ` · Next ${formatTime(nextRun)}` : ""}</p>}
        {!conditions.length && triggersLoaded && !triggerError && <p className={styles.triggerSummary}>No triggers configured</p>}
      </li>;
    })}</ul>
  </section>;
}

export function AppVersions({ app, history, busy, onLoadMore, onRequestRestore, onRequestRebuild }: {
  app: AppInfo; history: AppHistoryView; busy: "restore" | "rebuild" | null; onLoadMore: () => void;
  onRequestRestore: (app: AppInfo, version: AppVersionRecordV1) => void; onRequestRebuild: (app: AppInfo) => void;
}) {
  return <section aria-label="Version history"><h3>Versions</h3>
    {app.versionHealth.status === "unavailable" ? <div className={styles.historyUnavailable}>
      <h4>App version history is unavailable</h4><p>The app’s files are still in place. Rebuild recovers readable history where possible.</p>
      <button type="button" className={styles.secondaryButton} disabled={busy !== null} onClick={() => onRequestRebuild(app)}>{busy === "rebuild" ? "Rebuilding…" : "Rebuild version history"}</button>
    </div> : history.loading && !history.versions.length ? <p className={styles.empty}>Loading version history…</p>
      : history.error ? <p className={styles.failure} role="alert">{history.error}</p>
        : !history.versions.length ? <p className={styles.empty}>No versions yet. Saving or opening this app creates its first version.</p>
          : <><ol className={styles.versionList}>{history.versions.map((version, index) => <li key={version.version}>
            <div className={styles.workloadRow}><div className={styles.workloadCopy}>
              <h4>{version.message ?? (version.trigger === "restore" ? "Restore app" : version.trigger === "activate" ? "Activate app" : "Save app")}</h4>
              <p><time dateTime={new Date(version.createdAt).toISOString()}>{formatTime(version.createdAt)}</time>{index === 0 ? " · Current version" : ""}</p>
            </div>{index > 0 && <button type="button" className={styles.secondaryButton} disabled={busy !== null}
              onClick={() => onRequestRestore(app, version)}>Restore this version</button>}</div>
            <details className={styles.technicalDetails}><summary>Version details</summary><dl><dt>Version ID</dt><dd><code>{version.version}</code></dd>
              {version.author && <><dt>Author</dt><dd>{version.author}</dd></>}</dl></details>
          </li>)}</ol>{history.nextCursor && <button type="button" className={styles.secondaryButton} disabled={history.loading} onClick={onLoadMore}>{history.loading ? "Loading…" : "Load earlier versions"}</button>}</>}
  </section>;
}

function GrantList({ label, values, empty }: { label: string; values: readonly string[]; empty: string }) {
  return <div className={styles.grants}><h4>{label}</h4>{values.length ? <ul>{values.map(value => <li key={value}><code>{value}</code></li>)}</ul> : <p className={styles.hint}>{empty}</p>}</div>;
}

function runLabel(status: string): string {
  return ({ pending: "Queued", running: "Running", success: "Completed", error: "Failed", interrupted: "Interrupted", canceled: "Canceled" } as Record<string, string>)[status] ?? status;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(value);
}
