import { useCallback, useEffect, useRef } from "react";
import { subscribeCoreRuntime } from "../lib/api";

function reportError(error: unknown): void {
  console.error("[shell] Core poll failed:", error);
}

export function useCorePolling(
  read: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  enabled = true,
): () => Promise<void> {
  const current = useRef<ReadPoller | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const poller = createReadPoller(read, intervalMs, reportError);
    current.current = poller;
    const unsubscribe = subscribeCoreRuntime(() => poller.restart());
    void poller.refresh().catch(reportError);
    return () => {
      current.current = null;
      unsubscribe();
      poller.dispose();
    };
  }, [read, intervalMs, enabled]);

  return useCallback(() => current.current?.refresh().catch(reportError) ?? Promise.resolve(), []);
}

export interface ReadPoller {
  refresh(): Promise<void>;
  restart(): void;
  dispose(): void;
}

// One read at a time, with the interval measured from completion. A wake or
// runtime change cancels the old read and coalesces into one fresh read.
export function createReadPoller(
  read: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  onError: (error: unknown) => void,
): ReadPoller {
  let disposed = false;
  let pending: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restartRequested = false;
  let failures = 0;

  const backgroundRefresh = () => { void refresh().catch(onError); };
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    const current = new AbortController();
    controller = current;
    pending = Promise.resolve().then(() => {
      if (!current.signal.aborted) return read(current.signal);
    }).then(() => {
      if (!current.signal.aborted) failures = 0;
    }, (error: unknown) => {
      if (current.signal.aborted) return;
      failures = Math.min(failures + 1, 10);
      throw error;
    }).finally(() => {
      pending = null;
      controller = null;
      if (disposed) return;
      if (restartRequested) {
        restartRequested = false;
        backgroundRefresh();
      } else {
        const delay = Math.min(intervalMs * 2 ** failures, Math.max(intervalMs, 30_000));
        timer = setTimeout(backgroundRefresh, delay);
      }
    });
    return pending;
  }

  return {
    refresh,
    restart() {
      if (disposed) return;
      failures = 0;
      if (pending) {
        restartRequested = true;
        controller?.abort();
      } else {
        backgroundRefresh();
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}
