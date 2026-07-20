const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lamarckHost", {
  getCoreToken: () => ipcRenderer.invoke("auth:getCoreToken"),
  getRecoveryCode: () => ipcRenderer.invoke("auth:getRecoveryCode"),
  importRecoveryCode: (recoveryCode) => ipcRenderer.invoke("auth:importRecoveryCode", recoveryCode),
  getCoreBaseUrl: () => ipcRenderer.invoke("core:getBaseUrl"),
  getCoreStartError: () => ipcRenderer.invoke("core:getStartError"),
  retryCore: () => ipcRenderer.invoke("core:retry"),
  rotateCorePort: () => ipcRenderer.invoke("core:rotatePort"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  getWorkspacePath: () => ipcRenderer.invoke("workspace:get"),
  chooseWorkspacePath: () => ipcRenderer.invoke("workspace:choose"),
  setWorkspacePath: (path) => ipcRenderer.invoke("workspace:set", path),
  onOpenLauncher: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("shell:open-launcher", listener);
    return () => ipcRenderer.removeListener("shell:open-launcher", listener);
  },
  openAppViewer: (appId) => ipcRenderer.invoke("app-viewer:open", appId),
  setAppViewerBounds: (viewerId, bounds) => ipcRenderer.send("app-viewer:bounds", { viewerId, bounds }),
  closeAppViewer: (viewerId) => ipcRenderer.invoke("app-viewer:close", viewerId),
  reloadAppRuntime: (appId) => ipcRenderer.invoke("app-runtime:reload", appId),
  archiveApp: (appId) => ipcRenderer.invoke("app-runtime:archive", appId),
  createTerminal: () => ipcRenderer.invoke("terminal:create"),
  writeTerminal: (id, data) => ipcRenderer.send("terminal:input", { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send("terminal:resize", { id, cols, rows }),
  disposeTerminal: (id) => ipcRenderer.invoke("terminal:dispose", id),
  onTerminalData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  },
});
