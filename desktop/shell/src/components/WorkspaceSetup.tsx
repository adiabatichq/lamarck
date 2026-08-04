import { useEffect, useRef, useState } from "react";
import styles from "./WorkspaceSetup.module.css";

export interface WorkspaceDescriptor {
  path: string;
  vaultId: string;
}

export interface WorkspaceSetupState {
  status: "setup";
  reason: "first-run" | "missing" | "invalid";
  suggestedPath: string;
  previousWorkspace?: {
    lastKnownPath: string;
    vaultId?: string;
  };
  detail?: string;
}

export interface WorkspaceSetupProps {
  state: WorkspaceSetupState;
  onReady: (workspace: WorkspaceDescriptor) => void | Promise<void>;
}

type PendingAction = "browse-create" | "create" | "open" | "recover" | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setupCopy(reason: WorkspaceSetupState["reason"]): {
  eyebrow: string;
  title: string;
  introduction: string;
} {
  if (reason === "missing") {
    return {
      eyebrow: "Workspace not found",
      title: "Choose where Lamarck lives.",
      introduction:
        "Open your existing Workspace from its new location, or create a fresh one somewhere else.",
    };
  }
  if (reason === "invalid") {
    return {
      eyebrow: "Workspace needs attention",
      title: "Choose a valid Workspace.",
      introduction:
        "Open another Lamarck Workspace, or create a fresh one in a new or empty folder.",
    };
  }
  return {
    eyebrow: "Your first Workspace",
    title: "Choose where Lamarck lives.",
    introduction:
      "Your apps, pages, and private data stay together in one folder you control.",
  };
}

export function WorkspaceSetup({ state, onReady }: WorkspaceSetupProps) {
  const [createPath, setCreatePath] = useState(state.suggestedPath);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryWorkspace, setRecoveryWorkspace] = useState<WorkspaceDescriptor | null>(null);
  const [recoveryCode, setRecoveryCode] = useState("");
  const recoveryInputRef = useRef<HTMLInputElement>(null);
  const copy = setupCopy(state.reason);
  const host = window.lamarckHost;
  const busy = pendingAction !== null;

  useEffect(() => {
    setCreatePath(state.suggestedPath);
  }, [state.suggestedPath]);

  useEffect(() => {
    if (recoveryWorkspace) recoveryInputRef.current?.focus();
  }, [recoveryWorkspace]);

  async function finish(workspace: WorkspaceDescriptor) {
    await onReady(workspace);
  }

  async function browseCreateLocation() {
    if (!host) return;
    setPendingAction("browse-create");
    setError(null);
    try {
      const result = await host.chooseWorkspacePath("create");
      if (result.path) setCreatePath(result.path);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }

  async function createWorkspace() {
    if (!host) return;
    const path = createPath.trim();
    if (!path) {
      setError("Choose a location for the new Workspace.");
      return;
    }
    setPendingAction("create");
    setError(null);
    try {
      const result = await host.createWorkspace(path);
      await finish(result.workspace);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }

  async function openWorkspace() {
    if (!host) return;
    setPendingAction("open");
    setError(null);
    try {
      const chosen = await host.chooseWorkspacePath("open");
      if (!chosen.path) return;
      const result = await host.openWorkspace(chosen.path);
      if (result.status === "recovery-required") {
        setRecoveryWorkspace(result.workspace);
        setRecoveryCode("");
        return;
      }
      await finish(result.workspace);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }

  async function recoverWorkspace() {
    if (!host || !recoveryWorkspace) return;
    const code = recoveryCode.trim();
    if (!code) {
      setError("Enter this Workspace’s recovery code.");
      return;
    }
    setPendingAction("recover");
    setError(null);
    try {
      const result = await host.openWorkspace(recoveryWorkspace.path, code);
      if (result.status === "recovery-required") {
        setError("That recovery code could not unlock this Workspace.");
        return;
      }
      await finish(result.workspace);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <main className={styles.screen}>
      <header className={styles.titlebar}>
        <div className={styles.wordmark}>Lamarck</div>
        <div className={styles.titlebarContext}>Workspace setup</div>
      </header>

      <div className={styles.canvas}>
        <aside className={styles.route} aria-hidden="true">
          <div className={styles.routeMark}>~/</div>
          <div className={styles.routeLine}>
            <span className={styles.routeNode} />
          </div>
          <div className={styles.routeLabel}>A place on this Mac</div>
        </aside>

        <section className={styles.setup}>
          <div className={styles.intro}>
            <div className={styles.eyebrow}>{copy.eyebrow}</div>
            <h1>{copy.title}</h1>
            <p>{copy.introduction}</p>
          </div>

          {state.reason === "missing" && state.previousWorkspace && (
            <div className={styles.previousNotice}>
              <span>Lamarck last used</span>
              <code title={state.previousWorkspace.lastKnownPath}>
                {state.previousWorkspace.lastKnownPath}
              </code>
              <span>but that location is no longer available.</span>
            </div>
          )}

          {state.reason === "invalid" && state.detail && (
            <div className={styles.invalidNotice}>{state.detail}</div>
          )}

          {recoveryWorkspace ? (
            <section className={styles.recoveryCard} aria-labelledby="recovery-title">
              <div className={styles.cardHeading}>
                <div>
                  <div className={styles.cardLabel}>Open Workspace</div>
                  <h2 id="recovery-title">Unlock this Workspace</h2>
                </div>
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={busy}
                  onClick={() => {
                    setRecoveryWorkspace(null);
                    setRecoveryCode("");
                    setError(null);
                  }}
                >
                  Choose another
                </button>
              </div>
              <p className={styles.cardCopy}>
                Lamarck can’t verify this Workspace’s vault key on this Mac. Enter its recovery
                code to continue.
              </p>
              <code className={styles.recoveryPath} title={recoveryWorkspace.path}>
                {recoveryWorkspace.path}
              </code>
              <label className={styles.fieldLabel} htmlFor="workspace-recovery-code">
                Recovery code
              </label>
              <input
                ref={recoveryInputRef}
                id="workspace-recovery-code"
                className={styles.recoveryInput}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Enter recovery code"
                value={recoveryCode}
                disabled={busy}
                onChange={(event) => setRecoveryCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && recoveryCode.trim() && !busy) {
                    void recoverWorkspace();
                  }
                }}
              />
              <button
                type="button"
                className={styles.primaryButton}
                disabled={busy || !recoveryCode.trim()}
                onClick={() => void recoverWorkspace()}
              >
                {pendingAction === "recover" ? "Unlocking…" : "Unlock and Open"}
              </button>
            </section>
          ) : (
            <div className={styles.choices}>
              <section className={styles.createCard} aria-labelledby="create-workspace-title">
                <div className={styles.cardLabel}>Create Workspace</div>
                <h2 id="create-workspace-title">Start somewhere new</h2>
                <p className={styles.cardCopy}>
                  Use a folder that does not exist yet, or one that is completely empty.
                </p>

                <label className={styles.fieldLabel} htmlFor="workspace-create-path">
                  Workspace location
                </label>
                <div className={styles.pathField}>
                  <input
                    id="workspace-create-path"
                    value={createPath}
                    disabled={busy}
                    spellCheck={false}
                    aria-describedby="workspace-path-rule"
                    onChange={(event) => {
                      setCreatePath(event.target.value);
                      setError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && createPath.trim() && !busy) {
                        void createWorkspace();
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void browseCreateLocation()}
                  >
                    {pendingAction === "browse-create" ? "Choosing…" : "Browse"}
                  </button>
                </div>
                <p id="workspace-path-rule" className={styles.pathRule}>
                  Lamarck will never merge a new Workspace into a folder that already has files.
                </p>

                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={busy || !createPath.trim() || !host}
                  onClick={() => void createWorkspace()}
                >
                  {pendingAction === "create" ? "Creating…" : "Create Workspace"}
                </button>
              </section>

              <section className={styles.openCard} aria-labelledby="open-workspace-title">
                <div>
                  <div className={styles.cardLabel}>Open Workspace</div>
                  <h2 id="open-workspace-title">Already have one?</h2>
                  <p className={styles.cardCopy}>
                    Choose an existing Lamarck Workspace. Its files stay where they are.
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busy || !host}
                  onClick={() => void openWorkspace()}
                >
                  {pendingAction === "open" ? "Opening…" : "Choose Workspace…"}
                </button>
              </section>
            </div>
          )}

          {!host && (
            <div className={styles.hostNotice}>
              Workspace setup is available in the Lamarck desktop app.
            </div>
          )}
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
