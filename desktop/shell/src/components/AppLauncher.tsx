import { useEffect, useMemo, useRef, useState } from "react";
import type { AppInfo } from "../lib/api";
import { appWorkloads } from "../lib/app-visual";
import { AppMark } from "./AppMark";
import styles from "./AppLauncher.module.css";

interface AppLauncherProps {
  apps: AppInfo[];
  recentIds: string[];
  pinnedIds: string[];
  loading: boolean;
  error: string | null;
  onOpen: (appId: string) => void;
  onTogglePin: (appId: string) => void;
  onClose: () => void;
}

export function AppLauncher({
  apps,
  recentIds,
  pinnedIds,
  loading,
  error,
  onOpen,
  onTogglePin,
  onClose,
}: AppLauncherProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pinned = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return apps;
    return apps.filter((app) =>
      `${app.name} ${app.id}`.toLocaleLowerCase().includes(needle),
    );
  }, [apps, query]);

  const recent = useMemo(() => {
    const byId = new Map(filtered.map((app) => [app.id, app]));
    return recentIds.map((id) => byId.get(id)).filter((app): app is AppInfo => Boolean(app));
  }, [filtered, recentIds]);

  const recentSet = useMemo(() => new Set(recent.map((app) => app.id)), [recent]);
  const available = filtered.filter((app) => query.trim() || !recentSet.has(app.id));
  // Enter must open the row rendered first: Recent leads when there is no query.
  const firstVisible = !query.trim() && recent.length > 0 ? recent[0] : available[0] ?? null;

  return (
    <aside className={styles.drawer} aria-label="Open an app">
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Use workspace</span>
          <h1>Open</h1>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close app launcher">
          <CloseIcon />
        </button>
      </header>

      <label className={styles.search}>
        <SearchIcon />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && firstVisible) onOpen(firstVisible.id);
            if (event.key === "Escape") onClose();
          }}
          placeholder="Search apps"
          aria-label="Search apps"
        />
        <kbd>esc</kbd>
      </label>

      <div className={styles.body}>
        {loading ? (
          <LauncherMessage title="Reading this workspace" detail="Finding interfaces you can open…" />
        ) : error ? (
          <LauncherMessage title="Apps are unavailable" detail={error} tone="error" />
        ) : filtered.length === 0 ? (
          <LauncherMessage
            title={query ? "Nothing matches" : "No app UI yet"}
            detail={query ? `No app matches “${query}”.` : "Build or install an App with a UI to use it here."}
          />
        ) : (
          <>
            {!query && recent.length > 0 && (
              <AppGroup
                label="Recent"
                apps={recent}
                pinned={pinned}
                onOpen={onOpen}
                onTogglePin={onTogglePin}
              />
            )}
            {available.length > 0 && (
              <AppGroup
                label={query ? "Results" : "Available"}
                apps={available}
                pinned={pinned}
                onOpen={onOpen}
                onTogglePin={onTogglePin}
              />
            )}
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <span><kbd>↵</kbd> open</span>
        <span>Pin the interfaces you return to.</span>
      </footer>
    </aside>
  );
}

function AppGroup({
  label,
  apps,
  pinned,
  onOpen,
  onTogglePin,
}: {
  label: string;
  apps: AppInfo[];
  pinned: Set<string>;
  onOpen: (appId: string) => void;
  onTogglePin: (appId: string) => void;
}) {
  return (
    <section className={styles.group}>
      <div className={styles.groupLabel}>{label}</div>
      <div className={styles.list}>
        {apps.map((app, index) => (
          <div
            key={app.id}
            className={styles.appRow}
            style={{ animationDelay: `${Math.min(index, 7) * 24}ms` }}
          >
            <button type="button" className={styles.appOpen} onClick={() => onOpen(app.id)}>
              <AppMark appId={app.id} name={app.name} size="medium" />
              <span className={styles.appCopy}>
                <strong>{app.name}</strong>
                <span>
                  {app.id}
                  <i aria-hidden="true">·</i>
                  {appWorkloads(app).join(" · ") || "App"}
                </span>
              </span>
              <ArrowIcon />
            </button>
            <button
              type="button"
              className={`${styles.pin} ${pinned.has(app.id) ? styles.pinned : ""}`}
              onClick={() => onTogglePin(app.id)}
              aria-label={pinned.has(app.id) ? `Unpin ${app.name}` : `Pin ${app.name}`}
              aria-pressed={pinned.has(app.id)}
            >
              <PinIcon />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function LauncherMessage({
  title,
  detail,
  tone = "neutral",
}: {
  title: string;
  detail: string;
  tone?: "neutral" | "error";
}) {
  return (
    <div className={`${styles.message} ${tone === "error" ? styles.messageError : ""}`}>
      <span className={styles.messageGlyph}>{tone === "error" ? "!" : "○"}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.4" /><path d="m15.6 15.6 4.2 4.2" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 6.5 11 11m0-11-11 11" /></svg>;
}

function ArrowIcon() {
  return <svg className={styles.arrow} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13m-5-5 5 5-5 5" /></svg>;
}

function PinIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 4 6 0-.7 5 3.2 3.2v1.3h-11v-1.3L9.7 9 9 4Z" /><path d="M12 13.5V21" /></svg>;
}
