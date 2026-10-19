import { useCallback, useState } from "react";
import type { AppServiceState, AppWorkloadDiagnostic } from "../../shared/app-runtime";
import { useCorePolling } from "../hooks/useCorePolling";
import { getAppWorkloadDiagnostics, setAppServiceEnabled, setAppEnabled } from "../lib/api";
import { workloadName } from "../lib/app-visual";
import styles from "./AppsManager.module.css";

export function useAppEnablement(appId: string, onChanged?: () => Promise<void>, onAppDisabled?: (appId: string) => void) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = async (key: string, operation: () => Promise<unknown>) => {
    setPending(key); setError(null);
    try { await operation(); await onChanged?.(); }
    catch (cause) { setError(message(cause)); }
    finally { setPending(null); }
  };
  return {
    pending, error,
    changeApp: (enabled: boolean) => change("app", async () => {
      await setAppEnabled(appId, enabled);
      if (!enabled) onAppDisabled?.(appId);
    }),
    changeService: (serviceId: string, enabled: boolean) => change(`service:${serviceId}`, () => setAppServiceEnabled(appId, serviceId, enabled)),
  };
}

export function AppEnablementSwitch({ enabled, label, disabled, onChange }: {
  enabled: boolean | undefined; label: string; disabled: boolean; onChange: (enabled: boolean) => void;
}) {
  return <button type="button" className={styles.enablementSwitch} role="switch" aria-label={label}
    aria-checked={enabled === true} disabled={disabled || enabled === undefined}
    onClick={() => enabled !== undefined && onChange(!enabled)}>
    <span>{enabled === undefined ? "Checking…" : enabled ? "Enabled" : "Disabled"}</span>
    <span className={styles.switchTrack} aria-hidden="true" />
  </button>;
}

export function AppServices({ services, appEnabled, pending, onChange }: {
  services: readonly AppServiceState[]; appEnabled?: boolean; pending: string | null;
  onChange: (serviceId: string, enabled: boolean) => void;
}) {
  if (!services.length) return null;
  return <section className={styles.workloadSection} aria-label="Background services">
    <h3>Background services</h3>
    <ul className={styles.workloadList}>{services.map(service => <li key={service.serviceId}>
      <div className={styles.workloadRow}>
        <div className={styles.workloadCopy}><h4>{workloadName(service.serviceId)}</h4><p role="status">{serviceStatus(service, appEnabled)}</p></div>
        <AppEnablementSwitch label={`Service ${service.serviceId} enabled`} enabled={service.enabled ?? undefined}
          disabled={pending !== null} onChange={enabled => onChange(service.serviceId, enabled)} />
      </div>
      {service.restartAt !== null && service.state === "backoff" && <p className={styles.hint}>Next attempt at {new Date(service.restartAt).toLocaleTimeString("en")}</p>}
      {service.failure && <p className={styles.failure} role="alert">{service.failure}</p>}
      {pending === `service:${service.serviceId}` && <p className={styles.hint} role="status">Saving service setting · waiting for cleanup</p>}
    </li>)}</ul>
  </section>;
}

function serviceStatus(service: AppServiceState, appEnabled?: boolean): string {
  if (service.state === "cleanup-failed") return "Cleanup failed · stop unconfirmed";
  if (service.state === "stopping") return "Stopping · waiting for cleanup";
  if (service.enabled === false) return "Disabled";
  if (appEnabled === false) return "App is disabled";
  const labels = { unconfigured: "Service state unavailable", disabled: "Disabled", starting: "Starting", running: "Running", backoff: "Waiting to retry", stopped: "Stopped" };
  return labels[service.state];
}

/** Fetch operational output only while Activity is open. */
export function AppActivity({ appId }: { appId: string }) {
  const [diagnostics, setDiagnostics] = useState<readonly AppWorkloadDiagnostic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const read = useCallback(async (signal: AbortSignal) => {
    try {
      const value = await getAppWorkloadDiagnostics(appId);
      if (!signal.aborted) { setDiagnostics(value); setError(null); }
    } catch (cause) { if (!signal.aborted) setError(message(cause)); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [appId]);
  useCorePolling(read, 1500);
  return <AppActivityView diagnostics={diagnostics} loading={loading} error={error} />;
}

export function AppActivityView({ diagnostics, loading, error }: {
  diagnostics: readonly AppWorkloadDiagnostic[]; loading: boolean; error: string | null;
}) {
  return <section aria-label="Recent activity">
    <h3>Recent activity</h3>
    <p className={styles.hint}>Recent service and job activity is kept for up to an hour while Desktop is running.</p>
    {error && <p role="alert" className={styles.failure}>{error}</p>}
    {!diagnostics.length ? <p className={styles.empty} role="status">{loading ? "Loading recent activity…" : error ? "Recent activity could not be loaded." : "No recent activity."}</p>
      : <ul className={styles.activityList}>{diagnostics.map(run => {
        const stopped = run.endedAt !== null && run.failure !== null && NORMAL_STOP_REASONS.has(run.failure);
        const needsAttention = !!run.failure && !stopped;
        const status = needsAttention ? "Needs attention" : stopped ? run.kind === "job" ? "Canceled" : "Stopped" : run.endedAt === null ? "Running" : "Finished";
        return <li key={run.executionId}>
        <details className={styles.activityEntry}>
          <summary><span><strong>{workloadName(run.workloadId)}</strong><small>{run.kind === "service" ? "Background service" : "Job"} · {new Date(run.startedAt).toLocaleString("en")}</small></span>
            <span className={needsAttention ? styles.failureText : styles.hint}>{status}</span></summary>
          <div className={styles.activityDetails}>
            <p className={styles.hint}>Started {new Date(run.startedAt).toLocaleString("en")}{run.endedAt !== null ? ` · Ended ${new Date(run.endedAt).toLocaleString("en")}` : ""}</p>
            {run.failure && (needsAttention ? <p className={styles.failure} role="alert">{run.failure}</p> : <p className={styles.hint}>{run.failure}</p>)}
            <details className={styles.technicalDetails}>
              <summary>Technical details</summary>
              <dl><dt>Workload ID</dt><dd><code>{run.workloadId}</code></dd><dt>Execution ID</dt><dd><code>{run.executionId}</code></dd>{run.version && <><dt>Version</dt><dd><code>{run.version}</code></dd></>}</dl>
              {run.droppedBytes > 0 && <p className={styles.hint}>Earlier output discarded ({run.droppedBytes} bytes).</p>}
              <pre className={styles.processOutput}>{run.output || "No process output retained."}</pre>
            </details>
          </div>
        </details>
      </li>; })}</ul>}
  </section>;
}
// Exact Host stop reasons only; cleanup errors and unexpected exits remain failures.
const NORMAL_STOP_REASONS = new Set([
  "Job stopped by user", "Service disabled", "App stopped", "Host stopped",
  "Service activation replaced", "Service declaration retired", "App retired",
]);
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
