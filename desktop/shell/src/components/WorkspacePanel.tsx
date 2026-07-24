// WorkspacePanel — shows the active workspace and lets the Electron host switch it.

import { useCallback, useEffect, useState } from "react";
import { clearCoreBaseUrlCache, getWorkspace } from "../lib/api";
import styles from "./WorkspacePanel.module.css";

interface WorkspacePanelProps {
  coreStatus: "checking" | "connected" | "offline";
  onCoreChanged: () => void | Promise<void>;
}

export function WorkspacePanel({ coreStatus, onCoreChanged }: WorkspacePanelProps) {
  const [workspacePath, setWorkspacePath] = useState("");
  const [corePath, setCorePath] = useState("");
  const [hostPath, setHostPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [coreBaseUrl, setCoreBaseUrl] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [busy, setBusy] = useState(false);

  const hasHost = Boolean(window.lamarckHost);

  const refresh = useCallback(async () => {
    setError(null);
    setMessage(null);
    const [host, baseUrl, startError, runtime] = await Promise.all([
      window.lamarckHost?.getWorkspacePath().catch(() => "") ?? Promise.resolve(""),
      window.lamarckHost?.getCoreBaseUrl().catch(() => "") ?? Promise.resolve(""),
      window.lamarckHost?.getCoreStartError().catch(() => null) ?? Promise.resolve(null),
      window.lamarckHost?.getCoreRuntimeState().catch(() => null) ?? Promise.resolve(null),
    ]);
    setHostPath(host);
    setCoreBaseUrl(baseUrl);
    if (host) setWorkspacePath(host);
    if (runtime?.phase === "starting") {
      setCorePath("");
      return;
    }
    if (startError) {
      setError(startError);
      setCorePath("");
      return;
    }
    try {
      const core = await getWorkspace();
      setCorePath(core.path);
      setWorkspacePath(host || core.path);
    } catch (err) {
      setCorePath("");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, coreStatus]);

  const switchWorkspace = useCallback(
    async (nextPath: string) => {
      if (!window.lamarckHost) return;
      const normalized = nextPath.trim();
      if (!normalized) {
        setError("Workspace path is required.");
        return;
      }
      setBusy(true);
      setError(null);
      setMessage("Switching workspace...");
      try {
        const result = await window.lamarckHost.setWorkspacePath(normalized);
        clearCoreBaseUrlCache();
        setWorkspacePath(result.path);
        setHostPath(result.path);
        setCorePath(result.path);
        setMessage("Workspace switched. Reloading shell...");
        await onCoreChanged();
        window.setTimeout(() => window.location.reload(), 250);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setMessage(null);
      } finally {
        setBusy(false);
      }
    },
    [onCoreChanged],
  );

  const chooseWorkspace = useCallback(async () => {
    if (!window.lamarckHost) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.lamarckHost.chooseWorkspacePath();
      if (!result.path) return;
      clearCoreBaseUrlCache();
      setWorkspacePath(result.path);
      setHostPath(result.path);
      setCorePath(result.path);
      setMessage("Workspace switched. Reloading shell...");
      await onCoreChanged();
      window.setTimeout(() => window.location.reload(), 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onCoreChanged]);

  const retryCore = useCallback(async () => {
    if (!window.lamarckHost) return;
    setBusy(true);
    setError(null);
    setMessage("Retrying core...");
    try {
      await window.lamarckHost.retryCore();
      clearCoreBaseUrlCache();
      await onCoreChanged();
      await refresh();
      setMessage("Core is running.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessage(null);
    } finally {
      setBusy(false);
    }
  }, [onCoreChanged, refresh]);

  const rotateCorePort = useCallback(async () => {
    if (!window.lamarckHost) return;
    setBusy(true);
    setError(null);
    setMessage("Rotating core port...");
    try {
      const result = await window.lamarckHost.rotateCorePort();
      clearCoreBaseUrlCache();
      setCoreBaseUrl(result.coreBaseUrl);
      await onCoreChanged();
      setMessage("Core port rotated. OAuth providers with exact redirect matching need their callback URL updated before reconnecting.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessage(null);
    } finally {
      setBusy(false);
    }
  }, [onCoreChanged]);

  const revealRecoveryCode = useCallback(async () => {
    if (!window.lamarckHost) return;
    setError(null);
    try {
      setRecoveryCode(await window.lamarckHost.getRecoveryCode());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const importRecoveryCode = useCallback(async () => {
    if (!window.lamarckHost || !recoveryInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.lamarckHost.importRecoveryCode(recoveryInput.trim());
      clearCoreBaseUrlCache();
      setCoreBaseUrl(result.coreBaseUrl);
      await onCoreChanged();
      await refresh();
      setRecoveryInput("");
      setMessage("Recovery code imported.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onCoreChanged, recoveryInput, refresh]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Workspace</span>
        <button className={styles.iconButton} title="Refresh" onClick={refresh}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.527 1.225.527 1.924a4.008 4.008 0 0 1-4.5 3.969l.008-.047L6.3 13.499l.093.009A5.993 5.993 0 0 0 14.255 7.5a5.965 5.965 0 0 0-.804-1.891zM8 2.5a5.981 5.981 0 0 0-4.255 1.778l-.451-.312.579.939.804 1.891 1.068-.812.076-.094A4.007 4.007 0 0 1 10.5 4.031l-.008.047L11.7 2.501l-.093-.009A5.961 5.961 0 0 0 8 2.5z" />
          </svg>
        </button>
      </div>

      <div className={styles.body}>
        <section className={styles.section}>
          <div className={styles.label}>Core</div>
          <div className={styles.statusRow}>
            <span className={`${styles.dot} ${styles[coreStatus]}`} />
            <span className={styles.statusText}>{coreStatus}</span>
          </div>
          <div className={styles.pathBox} title={corePath || "Unknown"}>
            {corePath || "Unknown workspace"}
          </div>
          {coreBaseUrl && (
            <div className={styles.pathBox} title={coreBaseUrl}>
              {coreBaseUrl}
            </div>
          )}
          <div className={styles.buttonRow}>
            <button
              className={styles.button}
              onClick={retryCore}
              disabled={!hasHost || busy || coreStatus === "checking"}
            >
              Retry Core
            </button>
            <button
              className={styles.button}
              onClick={rotateCorePort}
              disabled={!hasHost || busy || coreStatus === "checking"}
            >
              Rotate Port
            </button>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.label}>Path</div>
          <input
            className={styles.input}
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
            readOnly={!hasHost || busy}
            spellCheck={false}
          />
          <div className={styles.buttonRow}>
            <button className={styles.button} onClick={chooseWorkspace} disabled={!hasHost || busy}>
              Choose Folder
            </button>
            <button
              className={styles.button}
              onClick={() => switchWorkspace(workspacePath)}
              disabled={!hasHost || busy || workspacePath.trim() === hostPath}
            >
              Apply
            </button>
          </div>
        </section>

        {!hasHost && (
          <p className={styles.note}>
            Workspace switching is available in the Electron shell. This browser session can still
            show the workspace that the local core is already running with.
          </p>
        )}

        {hasHost && (
          <section className={styles.section}>
            <div className={styles.label}>Vault Recovery</div>
            {recoveryCode ? (
              <div className={styles.pathBox} title={recoveryCode}>{recoveryCode}</div>
            ) : (
              <button className={styles.button} onClick={revealRecoveryCode} disabled={busy}>
                Reveal Recovery Code
              </button>
            )}
            <input
              className={styles.input}
              type="password"
              placeholder="import recovery code"
              value={recoveryInput}
              onChange={(event) => setRecoveryInput(event.target.value)}
              disabled={busy}
            />
            <button
              className={styles.button}
              onClick={importRecoveryCode}
              disabled={busy || !recoveryInput.trim()}
            >
              Import Recovery Code
            </button>
          </section>
        )}

        {message && <div className={styles.message}>{message}</div>}
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </div>
  );
}
