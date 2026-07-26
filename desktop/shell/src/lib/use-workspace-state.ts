export interface StoredUseState {
  pinnedIds: string[];
  recentIds: string[];
  activeAppId: string | null;
}

export interface UseWorkspaceStorage {
  getItem(key: string): string | null;
}

export const EMPTY_USE_STATE: StoredUseState = {
  pinnedIds: [],
  recentIds: [],
  activeAppId: null,
};

const USE_WORKSPACE_V1_PREFIX = "lamarck.use-workspace.v1:";

export function useWorkspaceStateKey(vaultId: string): string {
  return `${USE_WORKSPACE_V1_PREFIX}${vaultId}`;
}

export function readUseState(
  storage: Pick<UseWorkspaceStorage, "getItem">,
  key: string,
): StoredUseState {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return emptyUseState();
  }
  return parseUseState(raw)?.state ?? emptyUseState();
}

export function loadUseState(
  storage: UseWorkspaceStorage,
  vaultId: string,
): StoredUseState {
  return readUseState(storage, useWorkspaceStateKey(vaultId));
}

function parseUseState(raw: string | null): { state: StoredUseState } | null {
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const state = parsed as Partial<StoredUseState>;
    return {
      state: {
        pinnedIds: stringArray(state.pinnedIds),
        recentIds: stringArray(state.recentIds),
        activeAppId: typeof state.activeAppId === "string" ? state.activeAppId : null,
      },
    };
  } catch {
    return null;
  }
}

function emptyUseState(): StoredUseState {
  return {
    pinnedIds: [],
    recentIds: [],
    activeAppId: null,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
