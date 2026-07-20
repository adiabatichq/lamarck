import { useEffect, useRef, useState } from "react";
import { AppMark } from "../components/AppMark";
import styles from "./AppRuntimeView.module.css";

interface AppRuntimeViewProps {
  appId: string;
  appName?: string;
  /** Zero the native viewer bounds without closing it, so DOM surfaces above can show. */
  hidden?: boolean;
}

const MAX_OPEN_ATTEMPTS = 4;

export function AppRuntimeView({ appId, appName = appId, hidden = false }: AppRuntimeViewProps) {
  const hostElement = useRef<HTMLDivElement>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [takingLong, setTakingLong] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let openedViewerId: string | null = null;
    let retryTimer: number | null = null;
    let animationFrame = 0;
    setViewerId(null);
    setError(null);
    setTakingLong(false);

    const longTimer = window.setTimeout(() => setTakingLong(true), 1_200);

    async function open(attempt = 1): Promise<void> {
      try {
        const result = await window.lamarckHost?.openAppViewer(appId);
        if (!result) throw new Error("App Capsule Host is unavailable");
        openedViewerId = result.viewerId;
        if (cancelled) {
          window.lamarckHost?.setAppViewerBounds(result.viewerId, zeroBounds());
          await window.lamarckHost?.closeAppViewer(result.viewerId);
          return;
        }
        setViewerId(result.viewerId);
      } catch (reason) {
        if (cancelled) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        if (attempt < MAX_OPEN_ATTEMPTS && /already has an active viewer|already has an active/i.test(message)) {
          retryTimer = window.setTimeout(() => void open(attempt + 1), attempt * 140);
          return;
        }
        setError(message);
      }
    }

    // React StrictMode replays effects in development. Deferring one frame lets
    // the discarded effect cancel before it asks the Host to allocate a viewer.
    animationFrame = window.requestAnimationFrame(() => void open());

    return () => {
      cancelled = true;
      window.clearTimeout(longTimer);
      window.cancelAnimationFrame(animationFrame);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (openedViewerId) {
        // Native WebContentsView sits above Shell DOM. Hide it synchronously so
        // System and approval surfaces are never briefly covered during close.
        window.lamarckHost?.setAppViewerBounds(openedViewerId, zeroBounds());
        void window.lamarckHost?.closeAppViewer(openedViewerId);
      }
    };
  }, [appId, retryKey]);

  useEffect(() => {
    const element = hostElement.current;
    if (!element || !viewerId) return;

    if (hidden) {
      window.lamarckHost?.setAppViewerBounds(viewerId, zeroBounds());
      return;
    }

    const update = () => {
      const rect = element.getBoundingClientRect();
      window.lamarckHost?.setAppViewerBounds(viewerId, {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.lamarckHost?.setAppViewerBounds(viewerId, zeroBounds());
    };
  }, [viewerId, hidden]);

  return (
    <div ref={hostElement} className={styles.host}>
      {error ? (
        <div className={styles.error} role="alert">
          <span className={styles.errorCode}>VIEWER / FAILED</span>
          <AppMark appId={appId} name={appName} size="large" muted />
          <h1>{appName} could not open.</h1>
          <p>{error}</p>
          <button type="button" onClick={() => setRetryKey((key) => key + 1)}>Retry App</button>
        </div>
      ) : !viewerId ? (
        <div className={styles.launchPlate}>
          <div className={styles.orbit} aria-hidden="true"><span /></div>
          <AppMark appId={appId} name={appName} size="large" />
          <strong>{appName}</strong>
          <span>{takingLong ? "Preparing its isolated runtime…" : "Opening…"}</span>
        </div>
      ) : null}
    </div>
  );
}

function zeroBounds() {
  return { x: 0, y: 0, width: 0, height: 0 };
}
