import { useMemo, useState, type ReactElement } from "react";
import { AppMark } from "../components/AppMark";
import {
  useAppsManager,
  type AppHistoryView,
  type AppRuntimeView,
} from "../hooks/useAppsManager";
import { appWorkloads } from "../lib/app-visual";
import type { AppInfo, AppVersionRecordV1 } from "../lib/api";
import styles from "./SystemRoom.module.css";

export type AppPrimaryStatus = "Running" | "Ready" | "Failed";

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
  if ((runtime?.runningWorkloads ?? 0) > 0) return { status: "Running", detail: null };
  return { status: "Ready", detail: null };
}

type PendingAction =
  | { readonly kind: "restore"; readonly app: AppInfo; readonly version: AppVersionRecordV1 }
  | { readonly kind: "rebuild"; readonly app: AppInfo };

export function AppsManager({
  seedApps,
  onOpenApp,
  onInventoryChanged,
}: {
  seedApps: readonly AppInfo[];
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
      history={manager.history}
      loading={manager.loading}
      error={actionError ?? manager.error}
      busy={manager.busy}
      pending={pending}
      onSelect={manager.select}
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

export function AppsManagerView({
  apps,
  selected,
  runtimeByApp,
  selectedRuntime,
  history,
  loading,
  error,
  busy,
  pending,
  onSelect,
  onOpenApp,
  onLoadMore,
  onRequestRestore,
  onRequestRebuild,
  onCancel,
  onConfirm,
}: {
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
}): ReactElement {
  const selectedStatus = selected
    ? deriveAppPrimaryStatus(selected, selectedRuntime)
    : null;
  const grants = useMemo(() => selected ? {
    files: [...new Set([
      `apps/${selected.id}/`,
      ...(selected.permissions?.writes.files ?? []),
    ])],
    tables: selected.permissions?.writes.tables ?? [],
  } : { files: [], tables: [] }, [selected]);

  return (
    <div className={styles.appsManager} data-testid="apps-manager">
      <section className={styles.appsMaster} aria-label="Installed Apps">
        <header className={styles.appsManagerHeader}>
          <div>
            <span className={styles.overline}>Installed system shape</span>
            <h1>Apps</h1>
          </div>
          <span className={styles.inventoryCount}>{apps.length.toString().padStart(2, "0")}</span>
        </header>

        <div className={styles.appMasterList} role="listbox" aria-label="Apps">
          {loading && apps.length === 0 ? (
            <div className={styles.inventoryEmpty}>Loading Apps…</div>
          ) : apps.length === 0 ? (
            <div className={styles.inventoryEmpty}>No registered Apps in this workspace.</div>
          ) : apps.map((app) => {
            const primary = deriveAppPrimaryStatus(app, runtimeByApp.get(app.id));
            return (
              <button
                type="button"
                role="option"
                aria-selected={selected?.id === app.id}
                key={app.id}
                className={`${styles.appMasterRow} ${selected?.id === app.id ? styles.appMasterRowSelected : ""}`}
                onClick={() => onSelect(app.id)}
              >
                <AppMark appId={app.id} name={app.name} size="medium" />
                <span><strong>{app.name}</strong><small>{app.id}</small></span>
                <i className={styles[`appStatus${primary.status}`]}>{primary.status}</i>
              </button>
            );
          })}
        </div>

        {selected && selectedStatus && (
          <div className={styles.appDetails}>
            <div className={styles.appDetailsTitle}>
              <div>
                <span className={styles.overline}>Selected App</span>
                <h2>{selected.name}</h2>
                <p>{selected.description}</p>
              </div>
              <span className={`${styles.appPrimaryStatus} ${styles[`appStatus${selectedStatus.status}`]}`}>
                {selectedStatus.status}
              </span>
            </div>
            {selectedStatus.detail && <p className={styles.appFailure} role="status">{selectedStatus.detail}</p>}
            <div className={styles.appFactLine}>
              <span>Workloads</span>
              <strong>{appWorkloads(selected).join(" · ") || "No workload declared"}</strong>
            </div>
            <GrantList label="Writable file prefixes" values={grants.files} empty="No writable file prefixes" />
            <GrantList label="Writable D2 tables" values={grants.tables} empty="No writable D2 tables" />
            {selected.runtime?.ui && (
              <button type="button" className={styles.openApp} onClick={() => onOpenApp(selected.id)}>
                Open in Use <span>↗</span>
              </button>
            )}
          </div>
        )}
      </section>

      <section className={styles.versionPane} aria-label="Version history">
        <header className={styles.versionHeader}>
          <div><span className={styles.overline}>Version history</span><h2>{selected?.name ?? "Select an App"}</h2></div>
          {selected?.version && <code>{selected.version.slice(0, 9)}</code>}
        </header>
        {error && <p className={styles.appsManagerError} role="alert">{error}</p>}
        {!selected ? (
          <div className={styles.versionEmpty}>Select an App to inspect its versions.</div>
        ) : selected.versionHealth.status === "unavailable" ? (
          <div className={styles.historyUnavailable}>
            <span aria-hidden="true">!</span>
            <h3>App version history is unavailable</h3>
            <p>The App package is still in place. Rebuild tries readable history first, then resets only the broken repository.</p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onRequestRebuild(selected)}
            >{busy === "rebuild" ? "Rebuilding…" : "Rebuild version history"}</button>
          </div>
        ) : history.loading && history.versions.length === 0 ? (
          <div className={styles.versionEmpty}>Loading version history…</div>
        ) : history.error ? (
          <div className={styles.versionEmpty}>{history.error}</div>
        ) : history.versions.length === 0 ? (
          <div className={styles.versionEmpty}>No versions yet. The first save or activation creates the root version.</div>
        ) : (
          <div className={styles.versionScroll} data-scroll-owner="version-history">
            <ol className={styles.versionList}>
              {history.versions.map((version, index) => (
                <li key={version.version} className={index === 0 ? styles.versionLatest : ""}>
                  <button
                    type="button"
                    disabled={index === 0 || busy !== null}
                    onClick={() => onRequestRestore(selected, version)}
                    aria-label={index === 0
                      ? `Latest version ${version.version.slice(0, 9)}`
                      : `Restore version ${version.version.slice(0, 9)}`}
                  >
                    <span className={styles.versionRail}><i /></span>
                    <span className={styles.versionCommit}>
                      <code>{version.version.slice(0, 9)}</code>
                      {index === 0 && <b>Latest</b>}
                    </span>
                    <span className={styles.versionMeta}>
                      <strong>{version.message ?? defaultVersionMessage(version.trigger)}</strong>
                      <small>{version.trigger}{version.author ? ` · ${version.author}` : ""}</small>
                    </span>
                    <time dateTime={new Date(version.createdAt).toISOString()}>{formatTime(version.createdAt)}</time>
                  </button>
                </li>
              ))}
            </ol>
            {history.nextCursor && (
              <button type="button" className={styles.loadVersions} disabled={history.loading} onClick={onLoadMore}>
                {history.loading ? "Loading…" : "Load earlier versions"}
              </button>
            )}
          </div>
        )}
      </section>

      {pending && (
        <div className={styles.appConfirmScrim} role="presentation">
          <section className={styles.appConfirm} role="dialog" aria-modal="true" aria-labelledby="app-confirm-title">
            <span className={styles.overline}>{pending.kind === "restore" ? "Restore App" : "Exceptional repair"}</span>
            <h2 id="app-confirm-title">
              {pending.kind === "restore"
                ? `Restore ${pending.version.version.slice(0, 9)}?`
                : "Rebuild version history?"}
            </h2>
            <p>{pending.kind === "restore"
              ? "This creates a new forward version from the selected package. It does not launch the App."
              : "Lamarck will preserve the current package and recover readable history when possible. Unrecoverable versions will disappear from this list; historical D0 evidence is not changed."}</p>
            <div>
              <button type="button" onClick={onCancel}>Cancel</button>
              <button type="button" className={styles.confirmPrimary} onClick={onConfirm}>
                {pending.kind === "restore" ? "Restore version" : "Rebuild version history"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function GrantList({ label, values, empty }: { label: string; values: readonly string[]; empty: string }) {
  return (
    <div className={styles.appGrantBlock}>
      <span>{label}</span>
      {values.length === 0 ? <small>{empty}</small> : (
        <ul>{values.map((value) => <li key={value}><code>{value}</code></li>)}</ul>
      )}
    </div>
  );
}

function defaultVersionMessage(trigger: AppVersionRecordV1["trigger"]): string {
  if (trigger === "restore") return "Restore App";
  if (trigger === "activate") return "Activate App";
  return "Save App";
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
