import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Dev-only host shim: in the browser (vite dev) there is no Electron preload,
// so stand in for window.lamarckHost and point the shell at a standalone
// core. URL/tokens come from VITE_ env vars with localhost dev defaults.
// Electron and production builds provide the real host and skip this branch.
if (import.meta.env.DEV && !window.lamarckHost) {
  const base = import.meta.env.VITE_LAMARCK_CORE_URL ?? "http://localhost:3000";
  const coreToken = import.meta.env.VITE_LAMARCK_CORE_TOKEN ?? "devtoken";
  window.lamarckHost = {
    getCoreToken: async () => coreToken,
    getRecoveryCode: async () => "",
    importRecoveryCode: async () => ({ coreBaseUrl: base }),
    getCoreBaseUrl: async () => base,
    getCoreStartError: async () => null,
    getCoreRuntimeState: async () => ({ generation: 0, phase: "ready", error: null }),
    onCoreRuntimeState: () => () => {},
    retryCore: async () => ({ coreBaseUrl: base }),
    rotateCorePort: async () => ({ coreBaseUrl: base }),
    openExternal: async (url: string) => {
      window.open(url, "_blank", "noopener");
    },
    marketplaceReady: async () => ({ ok: true as const }),
    onMarketplaceHandoff: () => () => {},
    getWorkspaceState: async () => ({
      status: "ready" as const,
      workspace: { path: "browser", vaultId: "browser" },
    }),
    chooseWorkspacePath: async () => ({ path: null }),
    createWorkspace: async (path: string) => ({
      status: "ready" as const,
      workspace: { path, vaultId: "browser" },
    }),
    openWorkspace: async (path: string) => ({
      status: "ready" as const,
      workspace: { path, vaultId: "browser" },
    }),
    openWorkspaceFiles: async () => ({ ok: true as const }),
    chooseVfsTransferPath: async () => ({ path: null }),
    onOpenLauncher: () => () => {},
    openAppViewer: async () => ({
      ok: false as const,
      error: {
        code: "APP_VIEWER_OPEN_FAILED" as const,
        message: "App Capsules are available only in the Lamarck desktop Host.",
        restartRequired: false,
      },
    }),
    setAppViewerBounds: () => {},
    closeAppViewer: async () => ({ ok: true as const }),
    reloadAppRuntime: async () => ({ active: false }),
    getAppRuntimeStates: async () => [],
    archiveApp: async (appId: string) => {
      const response = await fetch(`${base}/api/apps/${encodeURIComponent(appId)}/archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${coreToken}` },
      });
      if (!response.ok) throw new Error(`Core returned ${response.status}`);
      return await response.json() as { ok: true; id: string };
    },
    createTerminal: async () => {
      throw new Error("lamarckHost.createTerminal is unavailable in browser dev");
    },
    writeTerminal: () => {},
    resizeTerminal: () => {},
    disposeTerminal: async () => ({ ok: true as const }),
    onTerminalData: () => () => {},
    onTerminalExit: () => () => {},
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
