import { describe, expect, test } from "vitest";
import {
  EMPTY_USE_STATE,
  loadUseState,
  readUseState,
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
        recentIds: [],
        activeAppId: "mail",
      }),
      [useWorkspaceStateKey("vault-b")]: JSON.stringify({
        pinnedIds: ["notes"],
        recentIds: ["notes"],
        activeAppId: "notes",
      }),
    });

    expect(loadUseState(storage, "vault-a")).toEqual({
      pinnedIds: ["mail"],
      recentIds: [],
      activeAppId: "mail",
    });
    expect(loadUseState(storage, "vault-b")).toEqual({
      pinnedIds: ["notes"],
      recentIds: ["notes"],
      activeAppId: "notes",
    });
  });

});
