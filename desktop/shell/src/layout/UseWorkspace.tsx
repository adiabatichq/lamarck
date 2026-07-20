import type { ReactNode } from "react";
import type { AppInfo } from "../lib/api";
import { AppMark } from "../components/AppMark";
import styles from "./UseWorkspace.module.css";

interface UseWorkspaceProps {
  apps: AppInfo[];
  activeApp: AppInfo | null;
  pinnedIds: string[];
  launcherOpen: boolean;
  launcher: ReactNode;
  appSurface: ReactNode;
  coreStatus: "checking" | "connected" | "offline";
  systemNeedsAttention: boolean;
  onToggleLauncher: () => void;
  onOpenApp: (appId: string) => void;
  onTogglePin: (appId: string) => void;
  onOpenSystem: () => void;
}

export function UseWorkspace({
  apps,
  activeApp,
  pinnedIds,
  launcherOpen,
  launcher,
  appSurface,
  coreStatus,
  systemNeedsAttention,
  onToggleLauncher,
  onOpenApp,
  onTogglePin,
  onOpenSystem,
}: UseWorkspaceProps) {
  const byId = new Map(apps.map((app) => [app.id, app]));
  const pinnedApps = pinnedIds.map((id) => byId.get(id)).filter((app): app is AppInfo => Boolean(app));

  return (
    <div className={`${styles.workspace} ${launcherOpen ? styles.launcherOpen : ""}`}>
      <header className={styles.titleBar}>
        <div className={styles.wordmark} aria-label="Lamarck">
          <span className={styles.wordmarkGlyph}>L</span>
          <span>Lamarck</span>
        </div>
        <div className={styles.activeTitle}>
          {activeApp ? (
            <>
              <span className={styles.titleDot} />
              <span>{activeApp.name}</span>
            </>
          ) : (
            <span className={styles.quietTitle}>Use workspace</span>
          )}
        </div>
        <div className={styles.titleStatus}>
          {coreStatus !== "connected" && (
            <span className={`${styles.coreState} ${styles[coreStatus]}`}>
              <span />
              {coreStatus === "checking" ? "Connecting" : "System offline"}
            </span>
          )}
        </div>
      </header>

      <nav className={styles.rail} aria-label="Use workspace">
        <div className={styles.railTop}>
          <button
            type="button"
            className={`${styles.railAction} ${launcherOpen ? styles.railActionActive : ""}`}
            onClick={onToggleLauncher}
            aria-expanded={launcherOpen}
            aria-label={launcherOpen ? "Close app launcher" : "Open an app"}
            title="Open an app"
          >
            <OpenIcon />
            <span>Open</span>
          </button>

          <div className={styles.pinRule} />
          <div className={styles.pins} aria-label="Pinned apps">
            {pinnedApps.map((app) => {
              const active = app.id === activeApp?.id;
              return (
                <button
                  type="button"
                  key={app.id}
                  className={`${styles.appPin} ${active ? styles.appPinActive : ""}`}
                  onClick={() => onOpenApp(app.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onTogglePin(app.id);
                  }}
                  aria-label={`Open ${app.name}`}
                  aria-current={active ? "page" : undefined}
                  title={`${app.name}\nRight-click to unpin`}
                >
                  <AppMark appId={app.id} name={app.name} size="medium" />
                  {active && <span className={styles.activePip} />}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          className={styles.systemButton}
          onClick={onOpenSystem}
          aria-label="Open System"
          title="System"
        >
          <SystemIcon />
          <span>System</span>
          {systemNeedsAttention && <i className={styles.attentionDot} />}
        </button>
      </nav>

      <div className={styles.launcher}>{launcherOpen ? launcher : null}</div>

      <main className={styles.canvas}>
        {activeApp ? appSurface : (
          <EmptyUseWorkspace
            hasApps={apps.length > 0}
            coreStatus={coreStatus}
            onOpen={onToggleLauncher}
            onOpenSystem={onOpenSystem}
          />
        )}
      </main>
    </div>
  );
}

function EmptyUseWorkspace({
  hasApps,
  coreStatus,
  onOpen,
  onOpenSystem,
}: {
  hasApps: boolean;
  coreStatus: "checking" | "connected" | "offline";
  onOpen: () => void;
  onOpenSystem: () => void;
}) {
  const offline = coreStatus === "offline";
  return (
    <section className={styles.empty}>
      <div className={styles.emptyOrbit} aria-hidden="true">
        <span />
        <i />
      </div>
      <div className={styles.emptyCopy}>
        <span className={styles.emptyEyebrow}>{offline ? "System unavailable" : "Quiet canvas"}</span>
        <h1>{offline ? "The workspace is offline." : hasApps ? "Open an app." : "Nothing needs to be here."}</h1>
        <p>
          {offline
            ? "Use System to inspect the workspace and retry its runtime."
            : hasApps
              ? "Choose an interface when you need it. The workspace stays out of the way otherwise."
              : "Apps with a UI will appear here when you build or install them."}
        </p>
        <div className={styles.emptyActions}>
          {!offline && (
            <button type="button" className={styles.primaryAction} onClick={onOpen}>
              <OpenIcon />
              Open an app
            </button>
          )}
          <button type="button" className={styles.textAction} onClick={onOpenSystem}>
            {offline ? "Open System" : "Inspect System"}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </div>
      <div className={styles.emptyIndex} aria-hidden="true">USE / 00</div>
    </section>
  );
}

function OpenIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="5.8" />
      <path d="m15 15 4 4" />
      <path d="M10.5 7.8v5.4M7.8 10.5h5.4" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5 19 7.6v8.8l-7 4.1-7-4.1V7.6l7-4.1Z" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3.8V9.4M5.2 7.8l4.4 2.7M18.8 7.8l-4.4 2.7M12 14.6v5.6" />
    </svg>
  );
}
