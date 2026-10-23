import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";

const PRELOAD_SOURCE = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");

interface WorkspacePreloadHost {
  resetSystemSettings(workspace: { path: string; vaultId: string }): Promise<{ reset: boolean }>;
  setAppServiceEnabled(appId: string, serviceId: string, enabled: boolean): Promise<unknown>;
  getAppWorkloadDiagnostics(appId: string, executionId?: string): Promise<unknown>;
  stopAppJob(appId: string, runId: string): Promise<unknown>;
  closeAppUi(appId: string): Promise<unknown>;
  setAppEnabled(appId: string, enabled: boolean): Promise<unknown>;
  onCoreRuntimeState(callback: (state: unknown) => void): () => void;
  getWorkspaceState(): Promise<unknown>;
  chooseWorkspacePath(purpose: "create" | "open"): Promise<unknown>;
  createWorkspace(path: string): Promise<unknown>;
  openWorkspace(path: string, recoveryCode?: string): Promise<unknown>;
  openWorkspaceFiles(application: "finder" | "obsidian"): Promise<unknown>;
}

function loadPreload(ipcInvoke: ReturnType<typeof vi.fn>, events = new EventEmitter()): WorkspacePreloadHost {
  let exposed: unknown;
  runInNewContext(PRELOAD_SOURCE, {
    require(id: string) {
      if (id !== "electron") throw new Error(`Unexpected preload require: ${id}`);
      return {
        contextBridge: {
          exposeInMainWorld(name: string, value: unknown) {
            if (name !== "lamarckHost") throw new Error(`Unexpected global: ${name}`);
            exposed = value;
          },
        },
        ipcRenderer: {
          invoke: ipcInvoke,
          on: events.on.bind(events),
          removeListener: events.removeListener.bind(events),
          send: vi.fn(),
        },
      };
    },
  }, { filename: "preload.cjs" });
  if (!exposed || typeof exposed !== "object") {
    throw new Error("Preload did not expose the Lamarck Host");
  }
  return exposed as WorkspacePreloadHost;
}

describe("Shell Workspace preload contract", () => {
  test("resets only the explicitly identified Workspace through Shell IPC", async () => {
    const invoke = vi.fn(async () => ({ reset: false }));
    const host = loadPreload(invoke);
    const workspace = { path: "/workspace", vaultId: "vault-a" };
    expect(await host.resetSystemSettings(workspace)).toEqual({ reset: false });
    expect(invoke.mock.calls).toEqual([["workspace:resetSystemSettings", workspace]]);
    const appPreload = readFileSync(new URL("./app-preload.ts", import.meta.url), "utf8");
    expect(appPreload).not.toContain("workspace:resetSystemSettings");
  });
  test("exposes Service enablement and exact diagnostic reads only through Shell IPC", async () => {
    const invoke = vi.fn(async () => ({})); const host = loadPreload(invoke);
    await host.setAppServiceEnabled("notes", "indexer", false);
    await host.setAppEnabled("notes", false);
    await host.getAppWorkloadDiagnostics("notes", "run-a");
    expect(invoke.mock.calls).toEqual([["app-runtime:service-enablement", "notes", "indexer", false], ["app-runtime:app-enablement", "notes", false], ["app-runtime:diagnostics", "notes", "run-a"]]);
    const appPreload = readFileSync(new URL("./app-preload.ts", import.meta.url), "utf8");
    expect(appPreload).not.toMatch(/app-runtime:(diagnostics|service-enablement|app-enablement)/);
  });

  test("dispatches exact job, UI-only and whole-App management through distinct Host IPC", async () => {
    const invoke = vi.fn(async () => ({ ok: true })); const host = loadPreload(invoke);
    await host.stopAppJob("notes", "run-a"); await host.closeAppUi("notes"); await host.setAppEnabled("notes", false);
    expect(invoke.mock.calls).toEqual([["app-runtime:stop-job", "notes", "run-a"], ["app-runtime:close-ui", "notes"], ["app-runtime:app-enablement", "notes", false]]);
  });
  test("delivers wake notifications without exposing IPC objects and removes subscriptions", () => {
    const events = new EventEmitter();
    const host = loadPreload(vi.fn(), events);
    const resume = vi.fn();
    const unsubscribe = host.onCoreRuntimeState(resume);
    events.emit("core:runtimeState", { sender: "private" }, { phase: "ready", generation: 1 });
    expect(resume.mock.calls).toEqual([[{ phase: "ready", generation: 1 }]]);
    unsubscribe();
    events.emit("core:runtimeState", { sender: "private" }, { phase: "ready", generation: 1 });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(events.listenerCount("core:runtimeState")).toBe(0);
  });
  test("keeps inspection separate from Create and Open mutations", async () => {
    const ipcInvoke = vi.fn(async () => ({ ok: true }));
    const host = loadPreload(ipcInvoke);

    await host.getWorkspaceState();
    await host.chooseWorkspacePath("create");
    await host.chooseWorkspacePath("open");
    await host.createWorkspace("/Users/person/New Lamarck");
    await host.openWorkspace("/Volumes/Data/Lamarck");
    await host.openWorkspace("/Volumes/Data/Lamarck", "recovery-code");
    await host.openWorkspaceFiles("finder");
    await host.openWorkspaceFiles("obsidian");

    expect(ipcInvoke.mock.calls).toEqual([
      ["workspace:getState"],
      ["workspace:choose", "create"],
      ["workspace:choose", "open"],
      [
        "workspace:create",
        {
          path: "/Users/person/New Lamarck",
        },
      ],
      [
        "workspace:open",
        {
          path: "/Volumes/Data/Lamarck",
        },
      ],
      [
        "workspace:open",
        {
          path: "/Volumes/Data/Lamarck",
          recoveryCode: "recovery-code",
        },
      ],
      ["workspace:openFiles", "finder"],
      ["workspace:openFiles", "obsidian"],
    ]);
  });
});
