import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLauncher } from "./components/AppLauncher";
import { MarketplaceHandoffController } from "./components/MarketplaceHandoffController";
import { SchemaApprovalModal } from "./components/SchemaApprovalModal";
import { WorkspaceSetup } from "./components/WorkspaceSetup";
import { AppRuntimeView } from "./content/AppRuntimeView";
import { UseWorkspace } from "./layout/UseWorkspace";
import {
  approveSchemaRequest,
  clearCoreBaseUrlCache,
  getLamarckSession,
  listApps,
  listSchemaRequests,
  logoutLamarckSession,
  rejectSchemaRequest,
  startLamarckLogin,
  type AppInfo,
  type LamarckSessionView,
  type SchemaRequest,
} from "./lib/api";
import { isUiApp } from "./lib/app-visual";
import { useCorePolling } from "./hooks/useCorePolling";
import {
  coreResponseDisposition,
  resolveCoreRequestFailure,
  type CoreStatus,
} from "./lib/core-availability";
import {
  closeUseApp,
  loadUseState,
  openUseApp,
  reconcileUseState,
  type StoredUseState,
  toggleUseAppPin,
  useWorkspaceStateKey,
} from "./lib/use-workspace-state";
import { SystemRoom } from "./system/SystemRoom";
import "./styles/global.css";

type ShellMode = "use" | "system";

export function App() {
  const [hostWorkspaceState, setHostWorkspaceState] = useState<HostWorkspaceState | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const host = window.lamarckHost;
    if (!host) {
      setBootstrapError("The Lamarck Host is unavailable.");
      return;
    }
    void host.getWorkspaceState()
      .then((state) => {
        if (!cancelled) setHostWorkspaceState(state);
      })
      .catch((error) => {
        if (!cancelled) {
          setBootstrapError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (bootstrapError) {
    return (
      <main className="workspace-bootstrap-message">
        <span>Lamarck</span>
        <p>{bootstrapError}</p>
        <button type="button" onClick={() => window.location.reload()}>Try again</button>
      </main>
    );
  }

  if (!hostWorkspaceState) {
    return (
      <main className="workspace-bootstrap-message" aria-live="polite">
        <span>Lamarck</span>
        <p>Preparing your Workspace…</p>
      </main>
    );
  }

  if (hostWorkspaceState.status === "setup") {
    const setupState = hostWorkspaceState;
    return (
      <WorkspaceSetup
        state={setupState}
        onReady={(nextWorkspace) => {
          setHostWorkspaceState({
            status: "ready",
            workspace: nextWorkspace,
          });
        }}
      />
    );
  }

  return (
    <ActiveWorkspaceShell
      key={hostWorkspaceState.workspace.vaultId}
      workspace={hostWorkspaceState.workspace}
    />
  );
}

function ActiveWorkspaceShell({ workspace }: { workspace: HostWorkspaceDescriptor }) {
  const [mode, setMode] = useState<ShellMode>("use");
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [coreStatus, setCoreStatus] = useState<CoreStatus>("checking");
  const [coreError, setCoreError] = useState<string | null>(null);
  const [schemaRequest, setSchemaRequest] = useState<SchemaRequest | null>(null);
  const [marketplaceHandoffOpen, setMarketplaceHandoffOpen] = useState(false);
  const [lamarckSession, setLamarckSession] = useState<LamarckSessionView>({ status: "signed_out" });
  const [identityBusy, setIdentityBusy] = useState(false);
  const storageKey = useWorkspaceStateKey(workspace.vaultId);
  const [workspaceState, setWorkspaceState] = useState<StoredUseState>(() => loadUseState(
    window.localStorage,
    workspace.vaultId,
  ));
  const [mountedAppIds, setMountedAppIds] = useState<string[]>(() => (
    workspaceState.activeAppId ? [workspaceState.activeAppId] : []
  ));

  const uiApps = useMemo(() => apps.filter(isUiApp), [apps]);
  const activeApp = useMemo(
    () => uiApps.find((app) => app.id === workspaceState.activeAppId) ?? null,
    [uiApps, workspaceState.activeAppId],
  );
  const mountedApps = useMemo(() => {
    const byId = new Map(uiApps.map((app) => [app.id, app]));
    return mountedAppIds
      .map((id) => byId.get(id))
      .filter((app): app is AppInfo => Boolean(app));
  }, [mountedAppIds, uiApps]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(workspaceState));
    } catch {
      // UI state is a convenience cache; a full Storage area must not break
      // the active Workspace.
    }
  }, [storageKey, workspaceState]);

  const readApps = useCallback(async (signal: AbortSignal) => {
    const host = window.lamarckHost;
    const isCurrent = () => !signal.aborted;
    const publishFailure = (failure: {
      status: "checking" | "offline";
      error: string | null;
    }) => {
      if (!isCurrent()) return;
      // Inventory from a prior runtime generation cannot keep a native App
      // surface mounted while Host authority is restarting or unavailable.
      setApps([]);
      setCoreStatus(failure.status);
      setCoreError(failure.error);
      setAppsLoading(failure.status === "checking");
    };

    try {
      const before = host ? await host.getCoreRuntimeState() : null;
      if (!isCurrent()) return;
      if (before && before.phase !== "ready") {
        publishFailure(await resolveCoreRequestFailure(
          new Error(before.error ?? "Core runtime is starting"),
          async () => before,
        ));
        return;
      }

      const result = await listApps(signal);
      const after = host ? await host.getCoreRuntimeState() : null;
      if (!isCurrent()) return;
      if (before && after) {
        const disposition = coreResponseDisposition(before, after);
        if (disposition === "retry") {
          // Discard the old inventory; the next poll resolves the new URL.
          clearCoreBaseUrlCache();
          publishFailure({ status: "checking", error: null });
          return;
        }
        if (disposition === "unavailable") {
          publishFailure(await resolveCoreRequestFailure(
            new Error(after.error ?? "Core runtime generation changed"),
            async () => after,
          ));
          return;
        }
      }
      setApps(result.apps);
      setCoreStatus("connected");
      setCoreError(null);
      setAppsLoading(false);
    } catch (error) {
      if (!isCurrent()) return;
      const runtime = host
        ? await host.getCoreRuntimeState().catch(() => null)
        : null;
      if (!isCurrent()) return;
      const failure = await resolveCoreRequestFailure(
        error,
        runtime ? async () => runtime : undefined,
      );
      publishFailure(failure);
      throw error;
    }
  }, []);

  const refreshApps = useCorePolling(readApps, 5_000);

  useEffect(() => {
    // An offline startup has no authoritative App inventory. Keep the user's
    // workspace state intact until Core has actually answered successfully.
    if (appsLoading || coreStatus !== "connected") return;
    const validIds = new Set(uiApps.map((app) => app.id));
    setWorkspaceState((current) => reconcileUseState(current, validIds));
    setMountedAppIds((current) => current.filter((id) => validIds.has(id)));
  }, [appsLoading, coreStatus, uiApps]);

  useEffect(() => {
    const activeAppId = workspaceState.activeAppId;
    if (!activeAppId) return;
    // Restored background Apps stay lazy. The active one is mounted on demand;
    // once mounted, switching away only hides its native surface.
    setMountedAppIds((current) => (
      current.includes(activeAppId) ? current : [...current, activeAppId]
    ));
  }, [workspaceState.activeAppId]);

  const readSchemaRequests = useCallback(async (signal: AbortSignal) => {
    const { requests } = await listSchemaRequests(signal);
    if (!signal.aborted) {
      setSchemaRequest(requests.find((request) => request.status === "pending") ?? null);
    }
  }, []);
  useCorePolling(readSchemaRequests, 1_000, coreStatus === "connected");

  const readIdentity = useCallback(async (signal: AbortSignal) => {
    try {
      const session = await getLamarckSession(signal);
      if (!signal.aborted) setLamarckSession(session);
    } catch (error) {
      if (!signal.aborted) {
        setLamarckSession({ status: "signed_out" });
        throw error;
      }
    }
  }, []);
  useCorePolling(readIdentity, 3_000, coreStatus === "connected");

  const openLauncher = useCallback(() => {
    setMode("use");
    setLauncherOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openLauncher();
      } else if (event.key === "Escape" && launcherOpen) {
        setLauncherOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [launcherOpen, openLauncher]);

  useEffect(() => {
    return window.lamarckHost?.onOpenLauncher?.(openLauncher);
  }, [openLauncher]);

  const openApp = useCallback((appId: string) => {
    setMountedAppIds((current) => (
      current.includes(appId) ? current : [...current, appId]
    ));
    setWorkspaceState((current) => openUseApp(current, appId));
    setLauncherOpen(false);
    setMode("use");
  }, []);

  const togglePin = useCallback((appId: string) => {
    setWorkspaceState((current) => toggleUseAppPin(current, appId));
  }, []);

  const closeApp = useCallback((appId: string) => {
    setMountedAppIds((current) => current.filter((id) => id !== appId));
    setWorkspaceState((current) => closeUseApp(current, appId));
  }, []);

  const handleApproveSchema = useCallback(async (id: string) => {
    await approveSchemaRequest(id);
    setSchemaRequest(null);
  }, []);

  const handleRejectSchema = useCallback(async (id: string) => {
    await rejectSchemaRequest(id);
    setSchemaRequest(null);
  }, []);

  const handleIdentitySignIn = useCallback(async () => {
    setIdentityBusy(true);
    try {
      const started = await startLamarckLogin();
      if (window.lamarckHost?.openExternal) {
        await window.lamarckHost.openExternal(started.authorizationUrl);
      } else {
        window.open(started.authorizationUrl, "_blank", "noopener");
      }
    } finally {
      setIdentityBusy(false);
    }
  }, []);

  const handleIdentitySignOut = useCallback(async () => {
    setIdentityBusy(true);
    try {
      await logoutLamarckSession();
      setLamarckSession({ status: "signed_out" });
    } finally {
      setIdentityBusy(false);
    }
  }, []);

  const viewerOccluded = Boolean(schemaRequest) || marketplaceHandoffOpen;
  const systemNeedsAttention = coreStatus === "offline" || viewerOccluded;

  return (
    <>
      {mode === "use" ? (
        <UseWorkspace
          apps={uiApps}
          activeApp={activeApp}
          pinnedIds={workspaceState.pinnedIds}
          openIds={workspaceState.openIds}
          launcherOpen={launcherOpen}
          launcher={(
            <AppLauncher
              apps={uiApps}
              recentIds={workspaceState.recentIds}
              pinnedIds={workspaceState.pinnedIds}
              loading={appsLoading}
              error={coreStatus === "offline" ? coreError : null}
              onOpen={openApp}
              onTogglePin={togglePin}
              onClose={() => setLauncherOpen(false)}
            />
          )}
          appSurface={mountedApps.map((app) => (
            <AppRuntimeView
              key={app.id}
              appId={app.id}
              appName={app.name}
              hidden={viewerOccluded || app.id !== activeApp?.id}
            />
          ))}
          coreStatus={coreStatus}
          systemNeedsAttention={systemNeedsAttention}
          onToggleLauncher={() => setLauncherOpen((open) => !open)}
          onOpenApp={openApp}
          onCloseApp={closeApp}
          onTogglePin={togglePin}
          onOpenSystem={() => {
            setLauncherOpen(false);
            setMode("system");
          }}
        />
      ) : (
        <SystemRoom
          apps={apps}
          coreStatus={coreStatus}
          coreError={coreError}
          schemaRequestPending={Boolean(schemaRequest)}
          lamarckSession={lamarckSession}
          identityBusy={identityBusy}
          onReturnToUse={() => setMode("use")}
          onOpenApp={openApp}
          onCoreChanged={refreshApps}
          onIdentitySignIn={handleIdentitySignIn}
          onIdentitySignOut={handleIdentitySignOut}
        />
      )}

      {schemaRequest && (
        <SchemaApprovalModal
          request={schemaRequest}
          onApprove={handleApproveSchema}
          onReject={handleRejectSchema}
        />
      )}
      <MarketplaceHandoffController
        onAppliedApp={async (appId) => {
          await refreshApps();
          openApp(appId);
        }}
        onVisibilityChange={setMarketplaceHandoffOpen}
      />
    </>
  );
}
