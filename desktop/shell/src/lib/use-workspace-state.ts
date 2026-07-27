export interface StoredUseState {
  pinnedIds: string[];
  openIds: string[];
  recentIds: string[];
  activeAppId: string | null;
}

export interface UseWorkspaceStorage {
  getItem(key: string): string | null;
}

export const EMPTY_USE_STATE: StoredUseState = {
  pinnedIds: [],
  openIds: [],
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
    const activeAppId = typeof state.activeAppId === "string" ? state.activeAppId : null;
    const openIds = stringArray(state.openIds);
    // v1 originally persisted only the active App. Treat it as the first open
    // App when reading that older shape so upgrades do not close the user's
    // current workspace.
    if (activeAppId && !openIds.includes(activeAppId)) openIds.push(activeAppId);
    return {
      state: {
        pinnedIds: stringArray(state.pinnedIds),
        openIds,
        recentIds: stringArray(state.recentIds),
        activeAppId: activeAppId ?? openIds[0] ?? null,
      },
    };
  } catch {
    return null;
  }
}

function emptyUseState(): StoredUseState {
  return {
    pinnedIds: [],
    openIds: [],
    recentIds: [],
    activeAppId: null,
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string"))];
}

export function openUseApp(state: StoredUseState, appId: string): StoredUseState {
  const openIds = state.openIds.includes(appId)
    ? state.openIds
    : [...state.openIds, appId];
  const recentIds = [
    appId,
    ...state.recentIds.filter((id) => id !== appId),
  ].slice(0, 8);
  if (
    state.activeAppId === appId
    && openIds === state.openIds
    && arraysEqual(recentIds, state.recentIds)
  ) return state;
  return {
    ...state,
    openIds,
    recentIds,
    activeAppId: appId,
  };
}

export function closeUseApp(state: StoredUseState, appId: string): StoredUseState {
  if (!state.openIds.includes(appId)) return state;
  const openIds = state.openIds.filter((id) => id !== appId);
  const activeAppId = state.activeAppId === appId
    ? state.recentIds.find((id) => openIds.includes(id)) ?? openIds[0] ?? null
    : state.activeAppId;
  return {
    ...state,
    openIds,
    activeAppId,
  };
}

export function toggleUseAppPin(state: StoredUseState, appId: string): StoredUseState {
  return {
    ...state,
    pinnedIds: state.pinnedIds.includes(appId)
      ? state.pinnedIds.filter((id) => id !== appId)
      : [...state.pinnedIds, appId],
  };
}

export function reconcileUseState(
  state: StoredUseState,
  validIds: ReadonlySet<string>,
): StoredUseState {
  const pinnedIds = state.pinnedIds.filter((id) => validIds.has(id));
  const openIds = state.openIds.filter((id) => validIds.has(id));
  const recentIds = state.recentIds.filter((id) => validIds.has(id));
  const activeAppId = state.activeAppId
    && validIds.has(state.activeAppId)
    && openIds.includes(state.activeAppId)
    ? state.activeAppId
    : recentIds.find((id) => openIds.includes(id)) ?? openIds[0] ?? null;
  if (
    activeAppId === state.activeAppId
    && arraysEqual(pinnedIds, state.pinnedIds)
    && arraysEqual(openIds, state.openIds)
    && arraysEqual(recentIds, state.recentIds)
  ) return state;
  return {
    pinnedIds,
    openIds,
    recentIds,
    activeAppId,
  };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
