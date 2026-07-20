import type { Session } from "electron";

const DISPOSABLE_STORAGE_TYPES = [
  "cookies",
  "serviceworkers",
  "cachestorage",
  "indexdb",
  "localstorage",
  "filesystem",
] as const;

/**
 * App browser storage is convenience cache only. Clear both origin storage and
 * Chromium's HTTP cache before first use and again at teardown so a crash or a
 * reused Electron session cannot turn it into hidden durable App state.
 */
export async function clearDisposableAppViewerStorage(
  viewerSession: Pick<Session, "clearStorageData" | "clearCache">,
): Promise<void> {
  await Promise.all([
    viewerSession.clearStorageData({ storages: [...DISPOSABLE_STORAGE_TYPES] }),
    viewerSession.clearCache(),
  ]);
}

export const DISPOSABLE_APP_VIEWER_STORAGE_TYPES = DISPOSABLE_STORAGE_TYPES;
