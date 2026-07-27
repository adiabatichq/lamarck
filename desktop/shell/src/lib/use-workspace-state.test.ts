import { describe, expect, test } from "vitest";
import {
  closeUseApp,
  EMPTY_USE_STATE,
  loadUseState,
  openUseApp,
  readUseState,
  reconcileUseState,
  toggleUseAppPin,
  type UseWorkspaceStorage,
  useWorkspaceStateKey,
} from "./use-workspace-state";

class MemoryStorage implements UseWorkspaceStorage {
  readonly values = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) {
      this.values.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
}

describe("vault-scoped Use workspace state", () => {
  test("builds the v1 key directly from the Workspace vault ID", () => {
    expect(useWorkspaceStateKey("vault-a")).toBe("lamarck.use-workspace.v1:vault-a");
  });

  test("normalizes stored fields without sharing the empty state object", () => {
    const storage = new MemoryStorage({
      key: JSON.stringify({
        pinnedIds: ["mail", 42, "notes"],
        recentIds: "not-an-array",
        activeAppId: false,
      }),
    });

    expect(readUseState(storage, "key")).toEqual({
      pinnedIds: ["mail", "notes"],
      openIds: [],
      recentIds: [],
      activeAppId: null,
    });
    const missing = readUseState(storage, "missing");
    expect(missing).toEqual(EMPTY_USE_STATE);
    expect(missing).not.toBe(EMPTY_USE_STATE);
  });

  test("returns empty state when the vault-scoped value is malformed", () => {
    const vaultId = "vault-a";
    const storage = new MemoryStorage({
      [useWorkspaceStateKey(vaultId)]: "{broken",
    });

    expect(loadUseState(storage, vaultId)).toEqual(EMPTY_USE_STATE);
    expect(storage.values.get(useWorkspaceStateKey(vaultId))).toBe("{broken");
  });

  test("keeps state isolated between vault IDs", () => {
    const storage = new MemoryStorage({
      [useWorkspaceStateKey("vault-a")]: JSON.stringify({
        pinnedIds: ["mail"],
        openIds: ["mail"],
        recentIds: [],
        activeAppId: "mail",
      }),
      [useWorkspaceStateKey("vault-b")]: JSON.stringify({
        pinnedIds: ["notes"],
        openIds: ["notes"],
        recentIds: ["notes"],
        activeAppId: "notes",
      }),
    });

    expect(loadUseState(storage, "vault-a")).toEqual({
      pinnedIds: ["mail"],
      openIds: ["mail"],
      recentIds: [],
      activeAppId: "mail",
    });
    expect(loadUseState(storage, "vault-b")).toEqual({
      pinnedIds: ["notes"],
      openIds: ["notes"],
      recentIds: ["notes"],
      activeAppId: "notes",
    });
  });

  test("migrates the former active-only state into an open App", () => {
    const storage = new MemoryStorage({
      key: JSON.stringify({
        pinnedIds: ["mail", "mail"],
        recentIds: ["mail"],
        activeAppId: "mail",
      }),
    });

    expect(readUseState(storage, "key")).toEqual({
      pinnedIds: ["mail"],
      openIds: ["mail"],
      recentIds: ["mail"],
      activeAppId: "mail",
    });
  });

  test("keeps open Apps alive while switching and retains a closed pin", () => {
    const initial = {
      pinnedIds: ["mail"],
      openIds: ["mail"],
      recentIds: ["mail"],
      activeAppId: "mail",
    };
    const withNotes = openUseApp(initial, "notes");

    expect(withNotes).toEqual({
      pinnedIds: ["mail"],
      openIds: ["mail", "notes"],
      recentIds: ["notes", "mail"],
      activeAppId: "notes",
    });
    expect(closeUseApp(withNotes, "mail")).toEqual({
      pinnedIds: ["mail"],
      openIds: ["notes"],
      recentIds: ["notes", "mail"],
      activeAppId: "notes",
    });
  });

  test("returns to the most recently used open App when closing the active one", () => {
    const state = openUseApp(openUseApp({
      pinnedIds: [],
      openIds: ["mail"],
      recentIds: ["mail"],
      activeAppId: "mail",
    }, "notes"), "tasks");
    const switched = openUseApp(state, "notes");

    expect(closeUseApp(switched, "notes").activeAppId).toBe("tasks");
  });

  test("moves Apps between pinned and open-only rail sections without closing them", () => {
    const state = {
      pinnedIds: [],
      openIds: ["mail"],
      recentIds: ["mail"],
      activeAppId: "mail",
    };

    expect(toggleUseAppPin(state, "mail")).toEqual({
      ...state,
      pinnedIds: ["mail"],
    });
  });

  test("reconciles every App reference and chooses a surviving active App", () => {
    const state = {
      pinnedIds: ["removed", "mail"],
      openIds: ["removed", "mail"],
      recentIds: ["removed", "mail"],
      activeAppId: "removed",
    };

    expect(reconcileUseState(state, new Set(["mail"]))).toEqual({
      pinnedIds: ["mail"],
      openIds: ["mail"],
      recentIds: ["mail"],
      activeAppId: "mail",
    });
  });
});
