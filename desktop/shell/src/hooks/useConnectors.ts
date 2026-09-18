// useConnectors — polls installed Connector packages and Sources while mounted.

import { useState, useCallback } from "react";
import { useCorePolling } from "./useCorePolling";
import {
  listConnectors,
  type ConnectorSourceView,
  type InstalledConnectorView,
} from "../lib/api";

export function useConnectors(pollMs = 2000) {
  const [sources, setSources] = useState<ConnectorSourceView[]>([]);
  const [packages, setPackages] = useState<InstalledConnectorView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async (signal: AbortSignal) => {
    try {
      const { sources, packages } = await listConnectors(signal);
      if (signal.aborted) return;
      setSources(sources);
      setPackages(packages);
      setError(null);
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  const refresh = useCorePolling(read, pollMs);

  return { sources, packages, loading, error, refresh };
}
