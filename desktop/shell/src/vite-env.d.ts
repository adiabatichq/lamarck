/// <reference types="vite/client" />

declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

interface HostWorkspaceDescriptor {
  path: string;
  vaultId: string;
}

type HostWorkspaceState =
  | {
      status: "ready";
      workspace: HostWorkspaceDescriptor;
    }
  | {
      status: "setup";
      reason: "first-run" | "missing" | "invalid";
      suggestedPath: string;
      previousWorkspace?: {
        lastKnownPath: string;
        vaultId?: string;
      };
      detail?: string;
    };

type HostWorkspaceOpenResult =
  | {
      status: "ready";
      workspace: HostWorkspaceDescriptor;
    }
  | {
      status: "recovery-required";
      workspace: HostWorkspaceDescriptor;
    };

interface Window {
  lamarckHost?: {
    getCoreToken(): Promise<string>;
    getRecoveryCode(): Promise<string>;
    importRecoveryCode(recoveryCode: string): Promise<{ coreBaseUrl: string }>;
    getCoreBaseUrl(): Promise<string>;
    getCoreStartError(): Promise<string | null>;
    getCoreRuntimeState(): Promise<{
      generation: number;
      phase: "starting" | "ready" | "restarting" | "failed";
      error: string | null;
    }>;
    onCoreRuntimeState(callback: (state: {
      generation: number;
      phase: "starting" | "ready" | "restarting" | "failed";
      error: string | null;
    }) => void): () => void;
    retryCore(): Promise<{ coreBaseUrl: string }>;
    rotateCorePort(): Promise<{ coreBaseUrl: string }>;
    openExternal(url: string): Promise<void>;
    marketplaceReady(): Promise<{ ok: true }>;
    onMarketplaceHandoff(
      callback: (handoff: {
        kind: "app" | "connector";
        packageId: string;
      }) => void,
    ): () => void;
    getWorkspaceState(): Promise<HostWorkspaceState>;
    chooseWorkspacePath(purpose: "create" | "open"): Promise<{ path: string | null }>;
    createWorkspace(path: string): Promise<{
      status: "ready";
      workspace: HostWorkspaceDescriptor;
    }>;
    openWorkspace(path: string, recoveryCode?: string): Promise<HostWorkspaceOpenResult>;
    openWorkspaceFiles(application: "finder" | "obsidian"): Promise<{ ok: true }>;
    chooseVfsTransferPath(purpose: "import" | "export"): Promise<{ path: string | null }>;
    onOpenLauncher(callback: () => void): () => void;
    openAppViewer(appId: string): Promise<
      | { ok: true; viewerId: string }
      | {
          ok: false;
          error: {
            code:
              | "CAPSULE_RESTART_REQUIRED"
              | "APP_VIEWER_BUSY"
              | "APP_VIEWER_OPEN_FAILED";
            message: string;
            restartRequired: boolean;
          };
        }
    >;
    setAppViewerBounds(
      viewerId: string,
      bounds: { x: number; y: number; width: number; height: number },
    ): void;
    closeAppViewer(viewerId: string): Promise<{ ok: true }>;
    reloadAppRuntime(appId: string): Promise<{ active: boolean }>;
    archiveApp(appId: string): Promise<{ ok: true; id: string }>;
    createTerminal(): Promise<{ id: string }>;
    writeTerminal(id: string, data: string): void;
    resizeTerminal(id: string, cols: number, rows: number): void;
    disposeTerminal(id: string): Promise<{ ok: true }>;
    onTerminalData(callback: (payload: { id: string; data: string }) => void): () => void;
    onTerminalExit(callback: (payload: { id: string; code: number | null }) => void): () => void;
  };
}
