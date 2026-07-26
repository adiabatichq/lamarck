import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";

const PRELOAD_SOURCE = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");

interface WorkspacePreloadHost {
  getWorkspaceState(): Promise<unknown>;
  chooseWorkspacePath(purpose: "create" | "open"): Promise<unknown>;
  createWorkspace(
    path: string,
    options: { includeStarterApps: boolean },
  ): Promise<unknown>;
  openWorkspace(path: string, recoveryCode?: string): Promise<unknown>;
}

function loadPreload(ipcInvoke: ReturnType<typeof vi.fn>): WorkspacePreloadHost {
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
          on: vi.fn(),
          removeListener: vi.fn(),
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
  test("keeps inspection separate from Create and Open mutations", async () => {
    const ipcInvoke = vi.fn(async () => ({ ok: true }));
    const host = loadPreload(ipcInvoke);

    await host.getWorkspaceState();
    await host.chooseWorkspacePath("create");
    await host.chooseWorkspacePath("open");
    await host.createWorkspace("/Users/person/New Lamarck", {
      includeStarterApps: false,
    });
    await host.openWorkspace("/Volumes/Data/Lamarck");
    await host.openWorkspace("/Volumes/Data/Lamarck", "recovery-code");

    expect(ipcInvoke.mock.calls).toEqual([
      ["workspace:getState"],
      ["workspace:choose", "create"],
      ["workspace:choose", "open"],
      [
        "workspace:create",
        {
          path: "/Users/person/New Lamarck",
          includeStarterApps: false,
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
    ]);
  });
});
