import { useEffect, useState } from "react";
import type { DesktopUpdateState } from "../../electron/desktop-updater";
import styles from "./DesktopUpdate.module.css";

export function DesktopUpdate() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const host = window.lamarckHost;
    if (!host) return;
    let live = true;
    let receivedEvent = false;
    const unsubscribe = host.onDesktopUpdate((next) => {
      receivedEvent = true;
      if (live) setState(next);
    });
    void host.getDesktopUpdateState().then((next) => {
      if (live && !receivedEvent) setState(next);
    }).catch(() => {});
    return () => { live = false; unsubscribe(); };
  }, []);
  if (!state || state.phase === "unavailable") return null;
  const busy = ["checking", "downloading", "verifying", "installing"].includes(state.phase);
  const label = state.phase === "ready" ? "Update & Restart"
    : state.phase === "checking" ? "Checking…"
    : state.phase === "downloading" ? `Downloading update${state.downloadPercent === null ? "…" : ` ${Math.floor(state.downloadPercent)}%`}`
    : state.phase === "verifying" ? "Preparing update…"
    : state.phase === "installing" ? "Restarting…"
    : state.phase === "error" ? "Retry update" : "Check for updates";
  return (
    <div className={styles.update}>
      <button type="button" disabled={busy}
        title={error ?? state.error ?? `Lamarck ${state.currentVersion}${state.nextVersion ? ` → ${state.nextVersion}` : ""}`}
        onClick={() => {
          setError(null);
          const host = window.lamarckHost!;
          void (state.phase === "ready" ? host.installDesktopUpdate() : host.checkDesktopUpdate())
            .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)));
        }}>
        <span aria-live="polite">{label}</span>
      </button>
      {(error ?? state.error) && <span className={styles.error} role="alert">{error ?? state.error}</span>}
    </div>
  );
}
