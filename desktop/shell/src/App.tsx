import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLauncher } from "./components/AppLauncher";
import { SchemaApprovalModal } from "./components/SchemaApprovalModal";
import { WorkingTreeConflictModal } from "./components/WorkingTreeConflictModal";
import { AppRuntimeView } from "./content/AppRuntimeView";
import { UseWorkspace } from "./layout/UseWorkspace";
import {
  approveSchemaRequest,
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
import { SystemRoom } from "./system/SystemRoom";
import "./styles/global.css";

type CoreStatus = "checking" | "connected" | "offline";
type ShellMode = "use" | "system";

interface StoredUseState {
  pinnedIds: string[];
  recentIds: string[];
  activeAppId: string | null;
}

const EMPTY_USE_STATE: StoredUseState = {
  pinnedIds: [],
  recentIds: [],
  activeAppId: null,
};

export function App() {
  const [mode, setMode] = useState<ShellMode>("use");
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [coreStatus, setCoreStatus] = useState<CoreStatus>("checking");
  const [coreError, setCoreError] = useState<string | null>(null);
  const [schemaRequest, setSchemaRequest] = useState<SchemaRequest | null>(null);
  const [workingTreeConflictOpen, setWorkingTreeConflictOpen] = useState(false);
  const [lamarckSession, setLamarckSession] = useState<LamarckSessionView>({ status: "signed_out" });
  const [identityBusy, setIdentityBusy] = useState(false);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [workspaceState, setWorkspaceState] = useState<StoredUseState>(EMPTY_USE_STATE);

  const uiApps = useMemo(() => apps.filter(isUiApp), [apps]);
  const activeApp = useMemo(
    () => uiApps.find((app) => app.id === workspaceState.activeAppId) ?? null,
    [uiApps, workspaceState.activeAppId],
  );

  useEffect(() => {
    let cancelled = false;
    void (window.lamarckHost?.getWorkspacePath() ?? Promise.resolve("browser"))
      .catch(() => "browser")
      .then((path) => {
        if (cancelled) return;
        const key = `lamarck.use-workspace.v1:${path || "browser"}`;
        setStorageKey(key);
        setWorkspaceState(readUseState(key));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    window.localStorage.setItem(storageKey, JSON.stringify(workspaceState));
  }, [storageKey, workspaceState]);

  const refreshApps = useCallback(async () => {
    try {
      const result = await listApps();
      setApps(result.apps);
      setCoreStatus("connected");
      setCoreError(null);
    } catch (error) {
      setCoreStatus("offline");
      setCoreError(error instanceof Error ? error.message : String(error));
    } finally {
      setAppsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshApps();
    const timer = window.setInterval(() => void refreshApps(), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshApps]);

  useEffect(() => {
    // An offline startup has no authoritative App inventory. Keep the user's
    // workspace state intact until Core has actually answered successfully.
    if (appsLoading || coreStatus !== "connected") return;
    const validIds = new Set(uiApps.map((app) => app.id));
    setWorkspaceState((current) => {
      const next = {
        pinnedIds: current.pinnedIds.filter((id) => validIds.has(id)),
        recentIds: current.recentIds.filter((id) => validIds.has(id)),
        activeAppId: current.activeAppId && validIds.has(current.activeAppId)
          ? current.activeAppId
          : null,
      };
      if (
        next.activeAppId === current.activeAppId
        && arraysEqual(next.pinnedIds, current.pinnedIds)
        && arraysEqual(next.recentIds, current.recentIds)
      ) return current;
      return next;
    });
  }, [appsLoading, coreStatus, uiApps]);

  useEffect(() => {
    if (coreStatus !== "connected") return;
    let cancelled = false;
    async function pollSchemaRequests() {
      try {
        const { requests } = await listSchemaRequests();
        if (!cancelled) {
          setSchemaRequest(requests.find((request) => request.status === "pending") ?? null);
        }
      } catch (error) {
        console.error("[shell] Schema request poll failed:", error);
      }
    }
    void pollSchemaRequests();
    const timer = window.setInterval(() => void pollSchemaRequests(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [coreStatus]);

  useEffect(() => {
    if (coreStatus !== "connected") return;
    let cancelled = false;
    async function pollIdentity() {
      try {
        const session = await getLamarckSession();
        if (!cancelled) setLamarckSession(session);
      } catch (error) {
        console.error("[shell] Identity session poll failed:", error);
        if (!cancelled) setLamarckSession({ status: "signed_out" });
      }
    }
    void pollIdentity();
    const timer = window.setInterval(() => void pollIdentity(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [coreStatus]);

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
    setWorkspaceState((current) => ({
      ...current,
      activeAppId: appId,
      recentIds: [appId, ...current.recentIds.filter((id) => id !== appId)].slice(0, 8),
    }));
    setLauncherOpen(false);
    setMode("use");
  }, []);

  const togglePin = useCallback((appId: string) => {
    setWorkspaceState((current) => ({
      ...current,
      pinnedIds: current.pinnedIds.includes(appId)
        ? current.pinnedIds.filter((id) => id !== appId)
        : [...current.pinnedIds, appId],
    }));
  }, []);

  const handleApproveSchema = useCallback(async (id: string, remember: boolean) => {
    await approveSchemaRequest(id, remember);
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

  const viewerOccluded = Boolean(schemaRequest) || workingTreeConflictOpen;
  const systemNeedsAttention = coreStatus === "offline" || viewerOccluded;

  return (
    <>
      {mode === "use" ? (
        <UseWorkspace
          apps={uiApps}
          activeApp={activeApp}
          pinnedIds={workspaceState.pinnedIds}
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
          appSurface={activeApp ? (
            <AppRuntimeView
              key={activeApp.id}
              appId={activeApp.id}
              appName={activeApp.name}
              hidden={viewerOccluded}
            />
          ) : null}
          coreStatus={coreStatus}
          systemNeedsAttention={systemNeedsAttention}
          onToggleLauncher={() => setLauncherOpen((open) => !open)}
          onOpenApp={openApp}
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
      <WorkingTreeConflictModal
        connected={coreStatus === "connected"}
        paused={Boolean(schemaRequest)}
        onVisibilityChange={setWorkingTreeConflictOpen}
      />
    </>
  );
}

function readUseState(key: string): StoredUseState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<StoredUseState> | null;
    if (!parsed || typeof parsed !== "object") return EMPTY_USE_STATE;
    return {
      pinnedIds: stringArray(parsed.pinnedIds),
      recentIds: stringArray(parsed.recentIds),
      activeAppId: typeof parsed.activeAppId === "string" ? parsed.activeAppId : null,
    };
  } catch {
    return EMPTY_USE_STATE;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
