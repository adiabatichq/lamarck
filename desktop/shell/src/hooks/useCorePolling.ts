import { useCallback, useEffect, useRef } from "react";
import { clearCoreBaseUrlCache } from "../lib/api";
import { createReadPoller, type ReadPoller } from "../lib/read-poller";

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
    const recover = () => {
      clearCoreBaseUrlCache();
      poller.restart();
    };
    const host = window.lamarckHost;
    const unsubscribeState = host?.onCoreRuntimeState(recover);
    const unsubscribeResume = host?.onCoreResume?.(recover);
    void poller.refresh().catch(reportError);
    return () => {
      current.current = null;
      unsubscribeState?.();
      unsubscribeResume?.();
      poller.dispose();
    };
  }, [read, intervalMs, enabled]);

  return useCallback(() => current.current?.refresh().catch(reportError) ?? Promise.resolve(), []);
}
