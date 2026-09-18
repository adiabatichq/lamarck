import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";

const PRELOAD_SOURCE = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");

interface WorkspacePreloadHost {
  onCoreResume(callback: () => void): () => void;
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
  test("delivers wake notifications without exposing IPC objects and removes subscriptions", () => {
    const events = new EventEmitter();
    const host = loadPreload(vi.fn(), events);
    const resume = vi.fn();
    const unsubscribe = host.onCoreResume(resume);
    events.emit("core:resume", { sender: "private" });
    expect(resume.mock.calls).toEqual([[]]);
    unsubscribe();
    events.emit("core:resume", { sender: "private" });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(events.listenerCount("core:resume")).toBe(0);
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
