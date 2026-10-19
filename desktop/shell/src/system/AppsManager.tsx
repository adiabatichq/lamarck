import { useState, type ReactElement } from "react";
import { AppManagementDetails } from "./AppManagementDetails";
export { AppExecutionView } from "./AppManagementDetails";
import { AppMark } from "../components/AppMark";
import {
  useAppsManager,
  type AppHistoryView,
  type AppRuntimeView,
} from "../hooks/useAppsManager";
import type { AppInfo, AppVersionRecordV1 } from "../lib/api";
import styles from "./AppsManager.module.css";

export type AppPrimaryStatus = "Running" | "Ready" | "Failed" | "Disabled";

export function deriveAppPrimaryStatus(
  app: AppInfo,
  runtime?: AppRuntimeView,
): { status: AppPrimaryStatus; detail: string | null } {
  if (app.versionHealth.status === "unavailable") {
    return { status: "Failed", detail: app.versionHealth.message };
  }
  if (app.manifestHealth.status === "invalid") {
    return { status: "Failed", detail: app.manifestHealth.message };
  }
  if (runtime?.latestFailure) return { status: "Failed", detail: runtime.latestFailure };
  if (runtime?.enabled === false) return { status: "Disabled", detail: null };
  if ((runtime?.runningWorkloads ?? 0) > 0) return { status: "Running", detail: null };
  return { status: "Ready", detail: null };
}

type PendingAction =
  | { readonly kind: "restore"; readonly app: AppInfo; readonly version: AppVersionRecordV1 }
  | { readonly kind: "rebuild"; readonly app: AppInfo };

export function AppsManager({
  seedApps,
  inventoryLoading = false,
  inventoryError = null,
  onOpenApp,
  onInventoryChanged,
  onManageTriggers,
  onUiClosed,
}: {
  onManageTriggers?: (appId: string, triggerId?: string) => void;
  onUiClosed?: (appId: string) => void;
  seedApps: readonly AppInfo[];
  inventoryLoading?: boolean;
  inventoryError?: string | null;
  onOpenApp: (appId: string) => void;
  onInventoryChanged: () => void | Promise<void>;
}) {
  const manager = useAppsManager(seedApps, onInventoryChanged);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const runtime = manager.selected
    ? manager.runtimeByApp.get(manager.selected.id)
    : undefined;

  const confirm = async () => {
    if (!pending) return;
    setActionError(null);
    try {
      if (pending.kind === "restore") {
        await manager.restore(pending.app.id, pending.version.version);
      } else {
        await manager.rebuild(pending.app.id);
      }
      setPending(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <AppsManagerView
      apps={manager.apps}
      selected={manager.selected}
      runtimeByApp={manager.runtimeByApp}
      selectedRuntime={runtime}
      onAppDisabled={onUiClosed}
      onPolicyChanged={manager.refresh}
      executionPending={manager.executionPending}
      executionError={manager.executionError ?? manager.error}
      onStopJob={(appId, runId) => { void manager.stopJob(appId, runId).catch(() => {}); }}
      onCloseUi={appId => { void manager.closeUi(appId).then(() => onUiClosed?.(appId)).catch(() => {}); }}
      history={manager.history}
      loading={inventoryLoading || manager.loading}
      error={actionError ?? inventoryError ?? manager.error}
      busy={manager.busy}
      pending={pending}
      onSelect={manager.select}
      onManageTriggers={onManageTriggers}
      onOpenApp={onOpenApp}
      onLoadMore={() => void manager.loadMore()}
      onRequestRestore={(app, version) => setPending({ kind: "restore", app, version })}
      onRequestRebuild={(app) => setPending({ kind: "rebuild", app })}
      onCancel={() => {
        setPending(null);
        setActionError(null);
      }}
      onConfirm={() => void confirm()}
    />
  );
}

export interface AppsManagerViewProps {
  apps: readonly AppInfo[];
  selected: AppInfo | null;
  runtimeByApp: ReadonlyMap<string, AppRuntimeView>;
  selectedRuntime?: AppRuntimeView;
  history: AppHistoryView;
  loading: boolean;
  error: string | null;
  busy: "restore" | "rebuild" | null;
  pending: PendingAction | null;
  onSelect: (appId: string) => void;
  onOpenApp: (appId: string) => void;
  onLoadMore: () => void;
  onRequestRestore: (app: AppInfo, version: AppVersionRecordV1) => void;
  onRequestRebuild: (app: AppInfo) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onManageTriggers?: (appId: string, triggerId?: string) => void;
  onAppDisabled?: (appId: string) => void;
  onPolicyChanged?: () => Promise<void>;
  executionPending?: ReadonlySet<string>;
  executionError?: string | null;
  onStopJob?: (appId: string, runId: string) => void;
  onCloseUi?: (appId: string) => void;
}

export function AppsManagerView({ apps, selected, runtimeByApp, selectedRuntime, history, loading, error, busy, pending,
  onSelect, onOpenApp, onLoadMore, onRequestRestore, onRequestRebuild, onCancel, onConfirm, onManageTriggers,
  executionPending, executionError, onStopJob, onCloseUi, onAppDisabled, onPolicyChanged }: AppsManagerViewProps): ReactElement {
  return <div className={styles.appsManager} data-testid="apps-manager">
    <section className={styles.appsMaster} aria-label="Installed Apps">
      <header className={styles.appsManagerHeader}><h1>Apps</h1><span>{apps.length}</span></header>
      <div className={styles.appMasterList} role="listbox" aria-label="Apps">
        {loading && !apps.length ? <p className={styles.empty}>Loading apps…</p>
          : !apps.length ? <p className={styles.empty}>No apps in this workspace yet.</p>
            : apps.map(app => {
              const runtime = runtimeByApp.get(app.id);
              const primary = deriveAppPrimaryStatus(app, runtime);
              const status = primary.status === "Failed" ? "Needs attention" : runtime?.enabled === false ? "Disabled" : runtime?.enabled === true ? "Enabled" : "Checking status…";
              return <button type="button" role="option" aria-selected={selected?.id === app.id} key={app.id}
                className={styles.appMasterRow} onClick={() => onSelect(app.id)}>
                <AppMark appId={app.id} name={app.name} size="medium" />
                <span><strong>{app.name}</strong><small className={primary.status === "Failed" ? styles.failureText : undefined}>{status}</small></span>
              </button>;
            })}
      </div>
    </section>
    {selected ? <AppManagementDetails key={selected.id} app={selected} runtime={selectedRuntime} history={history}
      loading={loading} busy={busy} error={error} executionPending={executionPending} executionError={executionError}
      onOpenApp={onOpenApp} onCloseUi={onCloseUi} onStopJob={onStopJob} onAppDisabled={onAppDisabled}
      onManageTriggers={onManageTriggers} onPolicyChanged={onPolicyChanged} onLoadMore={onLoadMore}
      onRequestRestore={onRequestRestore} onRequestRebuild={onRequestRebuild} />
      : <div className={styles.empty}>{error && <p className={styles.failure} role="alert">{error}</p>}Select an app to manage it.</div>}
    {pending && <div className={styles.confirmScrim} role="presentation">
      <section className={styles.confirmDialog} role="dialog" aria-modal="true" aria-labelledby="app-confirm-title">
        <h2 id="app-confirm-title">{pending.kind === "restore" ? `Restore ${pending.app.name}?` : "Rebuild version history?"}</h2>
        <p>{pending.kind === "restore"
          ? "This creates a new version from the selected package. It does not launch the App."
          : "Lamarck will preserve the current package and recover readable history when possible. Unrecoverable versions will disappear from this list; historical D0 evidence is not changed."}</p>
        <div className={styles.rowActions}><button type="button" className={styles.secondaryButton} disabled={busy !== null} onClick={onCancel}>Cancel</button>
          <button type="button" className={styles.primaryButton} disabled={busy !== null} onClick={onConfirm}>
            {busy ? "Working…" : pending.kind === "restore" ? "Restore version" : "Rebuild version history"}</button></div>
        {error && <p className={styles.failure} role="alert">{error}</p>}
      </section>
    </div>}
  </div>;
}
