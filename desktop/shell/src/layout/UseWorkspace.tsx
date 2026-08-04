import { useState, type FormEvent, type ReactNode } from "react";
import { createApp, type AppInfo } from "../lib/api";
import { AppMark } from "../components/AppMark";
import {
  emptyWorkspaceCopy,
  type CoreStatus,
} from "../lib/core-availability";
import styles from "./UseWorkspace.module.css";

interface UseWorkspaceProps {
  apps: AppInfo[];
  activeApp: AppInfo | null;
  pinnedIds: string[];
  openIds: string[];
  launcherOpen: boolean;
  launcher: ReactNode;
  appSurface: ReactNode;
  coreStatus: CoreStatus;
  systemNeedsAttention: boolean;
  onToggleLauncher: () => void;
  onOpenApp: (appId: string) => void;
  onCloseApp: (appId: string) => void;
  onTogglePin: (appId: string) => void;
  onOpenSystem: () => void;
}

export function UseWorkspace({
  apps,
  activeApp,
  pinnedIds,
  openIds,
  launcherOpen,
  launcher,
  appSurface,
  coreStatus,
  systemNeedsAttention,
  onToggleLauncher,
  onOpenApp,
  onCloseApp,
  onTogglePin,
  onOpenSystem,
}: UseWorkspaceProps) {
  const byId = new Map(apps.map((app) => [app.id, app]));
  const open = new Set(openIds);
  const pinned = new Set(pinnedIds);
  const pinnedApps = pinnedIds.map((id) => byId.get(id)).filter((app): app is AppInfo => Boolean(app));
  const openApps = openIds
    .filter((id) => !pinned.has(id))
    .map((id) => byId.get(id))
    .filter((app): app is AppInfo => Boolean(app));

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
          {activeApp && (
            <button
              type="button"
              className={styles.closeApp}
              onClick={() => onCloseApp(activeApp.id)}
              aria-label={`Close ${activeApp.name}`}
              title={`Close ${activeApp.name}`}
            >
              <CloseIcon />
            </button>
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
          <div className={styles.pins} aria-label="Open and pinned apps">
            {pinnedApps.map((app) => {
              const active = app.id === activeApp?.id;
              return (
                <RailApp
                  key={app.id}
                  app={app}
                  active={active}
                  open={open.has(app.id)}
                  pinned
                  onOpen={onOpenApp}
                  onTogglePin={onTogglePin}
                />
              );
            })}
            {pinnedApps.length > 0 && openApps.length > 0 && (
              <div className={styles.openRule} aria-hidden="true" />
            )}
            {openApps.map((app) => {
              const active = app.id === activeApp?.id;
              return (
                <RailApp
                  key={app.id}
                  app={app}
                  active={active}
                  open
                  pinned={false}
                  onOpen={onOpenApp}
                  onTogglePin={onTogglePin}
                />
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

function RailApp({
  app,
  active,
  open,
  pinned,
  onOpen,
  onTogglePin,
}: {
  app: AppInfo;
  active: boolean;
  open: boolean;
  pinned: boolean;
  onOpen: (appId: string) => void;
  onTogglePin: (appId: string) => void;
}) {
  return (
    <button
      type="button"
      className={[
        styles.appPin,
        active ? styles.appPinActive : "",
        !open ? styles.appPinDormant : "",
      ].filter(Boolean).join(" ")}
      onClick={() => onOpen(app.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        onTogglePin(app.id);
      }}
      aria-label={`${open ? "Switch to" : "Open"} ${app.name}`}
      aria-current={active ? "page" : undefined}
      title={`${app.name}\nRight-click to ${pinned ? "unpin" : "pin"}`}
    >
      <AppMark appId={app.id} name={app.name} size="medium" />
      {active && <span className={styles.activePip} />}
    </button>
  );
}

function EmptyUseWorkspace({
  hasApps,
  coreStatus,
  onOpen,
  onOpenSystem,
}: {
  hasApps: boolean;
  coreStatus: CoreStatus;
  onOpen: () => void;
  onOpenSystem: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const offline = coreStatus === "offline";
  const checking = coreStatus === "checking";
  const copy = emptyWorkspaceCopy(coreStatus, hasApps);

  async function submitBlankApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatePending(true);
    setCreateError(null);
    try {
      await createApp(id.trim(), name.trim() || id.trim(), description.trim());
      window.location.reload();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
      setCreatePending(false);
    }
  }

  return (
    <section className={styles.empty}>
      <div className={styles.emptyOrbit} aria-hidden="true">
        <span />
        <i />
      </div>
      <div className={styles.emptyCopy}>
        <span className={styles.emptyEyebrow}>{copy.eyebrow}</span>
        <h1>{copy.title}</h1>
        <p>{copy.detail}</p>
        {!offline && !checking && !hasApps && creating ? (
          <form className={styles.createForm} onSubmit={(event) => void submitBlankApp(event)}>
            <div className={styles.createFields}>
              <label>
                <span>App ID</span>
                <input
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  placeholder="daily-notes"
                  autoComplete="off"
                  required
                />
              </label>
              <label>
                <span>Name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Daily Notes"
                  autoComplete="off"
                />
              </label>
              <label className={styles.descriptionField}>
                <span>Purpose</span>
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="A private place to shape daily notes."
                  autoComplete="off"
                  required
                />
              </label>
            </div>
            {createError && <p className={styles.createError} role="alert">{createError}</p>}
            <div className={styles.emptyActions}>
              <button
                type="submit"
                className={styles.primaryAction}
                disabled={createPending || !id.trim() || !description.trim()}
              >
                {createPending ? "Creating…" : "Create Blank App"}
              </button>
              <button
                type="button"
                className={styles.textAction}
                disabled={createPending}
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className={styles.emptyActions}>
            {!offline && !checking && (
              hasApps ? (
                <button type="button" className={styles.primaryAction} onClick={onOpen}>
                  <OpenIcon />
                  Open an app
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.primaryAction}
                  onClick={() => setCreating(true)}
                >
                  <OpenIcon />
                  Create Blank App
                </button>
              )
            )}
            {!offline && !checking && !hasApps && (
              <button
                type="button"
                className={styles.textAction}
                onClick={() => void window.lamarckHost?.openExternal("https://app.lamarck.ai")}
              >
                Explore Marketplace
                <span aria-hidden="true">↗</span>
              </button>
            )}
            <button type="button" className={styles.textAction} onClick={onOpenSystem}>
              {offline ? "Open System" : "Inspect System"}
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        )}
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

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m6 6 8 8M14 6l-8 8" />
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
