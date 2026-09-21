import { useEffect, useState, type ReactNode } from "react";
import { clearCoreBaseUrlCache } from "../lib/api";
import { WorkspaceSetup } from "./WorkspaceSetup";
import styles from "./WorkspaceRuntimeGate.module.css";

type RuntimeState = Awaited<ReturnType<NonNullable<Window["lamarckHost"]>["getCoreRuntimeState"]>>;

export function WorkspaceRuntimeGate({ workspace, children }: {
  workspace: HostWorkspaceDescriptor;
  children: ReactNode;
}) {
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [hasBeenReady, setHasBeenReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const receive = (next: RuntimeState) => {
      if (!live) return;
      setRuntime(next);
      if (next.phase === "ready") setHasBeenReady(true);
      // Keep setup mounted through retries and candidate startup so its open/
      // recovery action can finish before returning to the active Workspace.
      if (next.phase === "failed") setFailure(next.error || "Lamarck could not start this Workspace.");
    };
    const host = window.lamarckHost;
    if (!host) {
      receive({ generation: 0, phase: "failed", error: "The Lamarck Host is unavailable." });
      return;
    }
    let receivedEvent = false;
    const unsubscribe = host.onCoreRuntimeState((next) => {
      receivedEvent = true;
      receive(next);
    });
    void host.getCoreRuntimeState().then((next) => {
      if (!receivedEvent) receive(next);
    }).catch((error) => {
      if (!receivedEvent) receive({ generation: 0, phase: "failed", error: message(error) });
    });
    return () => { live = false; unsubscribe(); };
  }, []);

  async function retry() {
    const host = window.lamarckHost;
    if (!host) throw new Error("The Lamarck Host is unavailable.");
    await host.retryCore();
    clearCoreBaseUrlCache();
    setFailure(null);
  }

  if (failure !== null) {
    return <WorkspaceSetup state={{
      status: "setup",
      reason: "startup-failed",
      suggestedPath: "",
      previousWorkspace: { lastKnownPath: workspace.path, vaultId: workspace.vaultId },
      detail: failure,
    }} onRetry={retry} onReady={() => {
      clearCoreBaseUrlCache();
      window.location.reload();
    }} />;
  }

  return (
    <>
      {hasBeenReady ? children : (
        <main className="workspace-bootstrap-message" role="status">
          <span>Lamarck</span>
          <p>Preparing your Workspace…</p>
        </main>
      )}
      {hasBeenReady && runtime?.phase !== "ready" && (
        <div className={styles.reconnecting} role="status">Reconnecting to your Workspace…</div>
      )}
    </>
  );
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
