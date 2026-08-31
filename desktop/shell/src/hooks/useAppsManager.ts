import { useCallback, useEffect, useRef, useState } from "react";
import {
  listApps,
  listAppVersions,
  rebuildAppVersionHistory,
  restoreAppVersion,
  type AppInfo,
  type AppVersionRecordV1,
} from "../lib/api";

export interface AppRuntimeView {
  readonly appId: string;
  readonly runningWorkloads: number;
  readonly latestFailure: string | null;
}

export interface AppHistoryView {
  readonly versions: readonly AppVersionRecordV1[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_HISTORY: AppHistoryView = Object.freeze({
  versions: Object.freeze([]),
  nextCursor: null,
  loading: false,
  error: null,
});

export function useAppsManager(
  seedApps: readonly AppInfo[],
  onInventoryChanged: () => void | Promise<void>,
  pollMs = 5_000,
) {
  const [apps, setApps] = useState<readonly AppInfo[]>(seedApps);
  const [runtimeByApp, setRuntimeByApp] = useState<ReadonlyMap<string, AppRuntimeView>>(new Map());
  const [selectedAppId, setSelectedAppId] = useState<string | null>(seedApps[0]?.id ?? null);
  const [histories, setHistories] = useState<ReadonlyMap<string, AppHistoryView>>(new Map());
  const [busyByApp, setBusyByApp] = useState<ReadonlyMap<string, "restore" | "rebuild">>(new Map());
  const [loading, setLoading] = useState(seedApps.length === 0);
  const [error, setError] = useState<string | null>(null);
  const historiesRef = useRef(histories);
  const aliveRef = useRef(true);

  useEffect(() => { historiesRef.current = histories; }, [histories]);
  useEffect(() => {
    setApps(seedApps);
    setSelectedAppId((current) => (
      current && seedApps.some((app) => app.id === current)
        ? current
        : seedApps[0]?.id ?? null
    ));
  }, [seedApps]);

  const refresh = useCallback(async () => {
    try {
      const [inventory, runtime] = await Promise.all([
        listApps(),
        window.lamarckHost?.getAppRuntimeStates() ?? Promise.resolve([]),
      ]);
      if (!aliveRef.current) return;
      setApps(inventory.apps);
      setRuntimeByApp(new Map(runtime.map((state) => [state.appId, state])));
      setSelectedAppId((current) => (
        current && inventory.apps.some((app) => app.id === current)
          ? current
          : inventory.apps[0]?.id ?? null
      ));
      setError(null);
    } catch (cause) {
      if (aliveRef.current) setError(errorMessage(cause));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async (appId: string, append = false) => {
    const existing = historiesRef.current.get(appId) ?? EMPTY_HISTORY;
    if (existing.loading || (append && existing.nextCursor === null)) return;
    const pending: AppHistoryView = {
      ...existing,
      ...(append ? {} : { versions: Object.freeze([]), nextCursor: null }),
      loading: true,
      error: null,
    };
    setHistories((current) => withMapValue(current, appId, pending));
    historiesRef.current = withMapValue(historiesRef.current, appId, pending);
    try {
      const page = await listAppVersions(appId, {
        ...(append && existing.nextCursor ? { cursor: existing.nextCursor } : {}),
        limit: 30,
      });
      if (!aliveRef.current) return;
      const next: AppHistoryView = Object.freeze({
        versions: Object.freeze(append ? [...existing.versions, ...page.versions] : page.versions),
        nextCursor: page.nextCursor,
        loading: false,
        error: null,
      });
      setHistories((current) => withMapValue(current, appId, next));
      historiesRef.current = withMapValue(historiesRef.current, appId, next);
    } catch (cause) {
      if (!aliveRef.current) return;
      const failed: AppHistoryView = Object.freeze({
        ...existing,
        loading: false,
        error: errorMessage(cause),
      });
      setHistories((current) => withMapValue(current, appId, failed));
      historiesRef.current = withMapValue(historiesRef.current, appId, failed);
    }
  }, []);

  const mutate = useCallback(async (
    appId: string,
    action: "restore" | "rebuild",
    operation: () => Promise<unknown>,
  ) => {
    setBusyByApp((current) => withMapValue(current, appId, action));
    try {
      await operation();
      await Promise.all([refresh(), onInventoryChanged()]);
      await loadHistory(appId, false);
    } finally {
      if (aliveRef.current) {
        setBusyByApp((current) => {
          const next = new Map(current);
          next.delete(appId);
          return next;
        });
      }
    }
  }, [loadHistory, onInventoryChanged, refresh]);

  const restore = useCallback((appId: string, version: string) => (
    mutate(appId, "restore", () => restoreAppVersion(appId, version))
  ), [mutate]);

  const rebuild = useCallback((appId: string) => (
    mutate(appId, "rebuild", () => rebuildAppVersionHistory(appId))
  ), [mutate]);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [pollMs, refresh]);

  const selected = apps.find((app) => app.id === selectedAppId) ?? null;
  useEffect(() => {
    if (!selected || selected.versionHealth.status === "unavailable") return;
    void loadHistory(selected.id, false);
  }, [loadHistory, selected?.id, selected?.version, selected?.versionHealth.status]);

  return {
    apps,
    selected,
    select: setSelectedAppId,
    runtimeByApp,
    history: selected ? histories.get(selected.id) ?? EMPTY_HISTORY : EMPTY_HISTORY,
    busy: selected ? busyByApp.get(selected.id) ?? null : null,
    loading,
    error,
    refresh,
    loadMore: selected ? () => loadHistory(selected.id, true) : async () => {},
    restore,
    rebuild,
  };
}

function withMapValue<K, V>(source: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(source);
  next.set(key, value);
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
