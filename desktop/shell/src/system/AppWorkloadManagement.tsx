import { useCallback, useState } from "react";
import type { AppServiceState, AppWorkloadDiagnostic } from "../../shared/app-runtime";
import { useCorePolling } from "../hooks/useCorePolling";
import { getAppWorkloadDiagnostics, setAppServiceEnabled, setAppEnabled } from "../lib/api";
import styles from "./SystemRoom.module.css";

/** Operational evidence and Service policy stay in the selected App's Console. */
export function AppWorkloadManagement({ appId, services, appEnabled, onAppDisabled }: { appId: string; services: readonly AppServiceState[]; appEnabled?: boolean; onAppDisabled?: (appId: string) => void }) {
  const [diagnostics, setDiagnostics] = useState<readonly AppWorkloadDiagnostic[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? readError;
  const [pending, setPending] = useState<string | null>(null);
  const read = useCallback(async (signal: AbortSignal) => {
    try {
      const value = await getAppWorkloadDiagnostics(appId);
      if (!signal.aborted) { setDiagnostics(value); setReadError(null); }
    } catch (cause) { if (!signal.aborted) setReadError(message(cause)); }
  }, [appId]);
  useCorePolling(read, 1500);
  const change = async (serviceId: string, enabled: boolean) => {
    setPending(serviceId); setError(null);
    try { await setAppServiceEnabled(appId, serviceId, enabled); }
    catch (cause) { setError(message(cause)); }
    finally { setPending(null); }
  };
  const changeApp = async () => {
    if (appEnabled === undefined) return;
    setPending("app"); setError(null);
    try { await setAppEnabled(appId, !appEnabled); if (appEnabled) onAppDisabled?.(appId); }
    catch (cause) { setError(message(cause)); }
    finally { setPending(null); }
  };
  return <section className={styles.appExecution} aria-label="Services and recent diagnostics">
    <h3>App enablement</h3>
    {appEnabled === undefined ? <p>Loading App enablement…</p> : <button type="button" role="switch" aria-label="App enabled" aria-checked={appEnabled} disabled={pending !== null} onClick={() => void changeApp()}>{appEnabled ? "Enabled" : "Disabled"}</button>}
    {pending === "app" && <p role="status">Saving App enablement · waiting for cleanup</p>}
    {!!services.length && <>
      <h3>Services</h3>
      <ul className={styles.activeJobs}>{services.map(service => <li key={service.serviceId}>
        <strong>{service.serviceId}</strong>
        <span role="status">{service.state === "unconfigured" ? "Service state unavailable" : service.state}</span>
        {service.restartAt !== null && service.state === "backoff" && <span>Next attempt: {new Date(service.restartAt).toLocaleTimeString()}</span>}
        {service.failure && <p className={styles.appFailure}>{service.failure}</p>}
        {service.enabled !== null && <button type="button" role="switch" aria-label={`Service ${service.serviceId} enabled`} aria-checked={service.enabled === true} disabled={pending !== null || service.enabled === null} onClick={() => void change(service.serviceId, !service.enabled)}>
          {service.enabled ? "Enabled" : "Disabled"}
        </button>}
        {pending === service.serviceId && <span role="status">Saving service enablement · waiting for cleanup</span>}
      </li>)}</ul>
    </>}
    <h3>Recent Service and Job diagnostics</h3>
    <p className={styles.executionHint}>Recent output is temporary and bounded. Completed executions remain here for up to one hour while Desktop is running.</p>
    {error && <p role="alert" className={styles.appFailure}>{error}</p>}
    {!diagnostics.length ? <p>No retained diagnostics.</p> : diagnostics.map(run => <details key={run.executionId}>
      <summary style={{ overflowWrap: "anywhere" }}>{run.kind === "service" ? "Service" : "Job"} {run.workloadId} · {run.endedAt === null ? "Active" : "Finished"} · {run.executionId}</summary>
      <p>Started {new Date(run.startedAt).toLocaleString()}{run.endedAt !== null ? ` · Ended ${new Date(run.endedAt).toLocaleString()}` : ""}</p>
      {run.version && <p>Version <code>{run.version}</code></p>}
      {run.failure && <p className={styles.appFailure}>{run.failure}</p>}
      {run.droppedBytes > 0 && <p>Earlier output discarded ({run.droppedBytes} bytes).</p>}
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 320, overflow: "auto" }}>{run.output || "No process output retained."}</pre>
    </details>)}
  </section>;
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
