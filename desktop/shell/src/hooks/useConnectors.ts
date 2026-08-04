// useConnectors — polls installed Connector packages and Sources while mounted.

import { useState, useEffect, useCallback, useRef } from "react";
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
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const { sources, packages } = await listConnectors();
      if (!aliveRef.current) return;
      setSources(sources);
      setPackages(packages);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    const id = window.setInterval(refresh, pollMs);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, [refresh, pollMs]);

  return { sources, packages, loading, error, refresh };
}
