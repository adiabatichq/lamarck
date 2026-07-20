/// <reference types="vite/client" />

declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

interface Window {
  lamarckHost?: {
    getCoreToken(): Promise<string>;
    getRecoveryCode(): Promise<string>;
    importRecoveryCode(recoveryCode: string): Promise<{ coreBaseUrl: string }>;
    getCoreBaseUrl(): Promise<string>;
    getCoreStartError(): Promise<string | null>;
    retryCore(): Promise<{ coreBaseUrl: string }>;
    rotateCorePort(): Promise<{ coreBaseUrl: string }>;
    openExternal(url: string): Promise<void>;
    getWorkspacePath(): Promise<string>;
    chooseWorkspacePath(): Promise<{ path: string | null }>;
    setWorkspacePath(path: string): Promise<{ path: string }>;
    onOpenLauncher(callback: () => void): () => void;
    openAppViewer(appId: string): Promise<{ viewerId: string }>;
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
