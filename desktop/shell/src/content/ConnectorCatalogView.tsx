// ConnectorCatalogView is the discovery shelf. It can install packages, but
// installed Connector lifecycle belongs to the Source Console.

import { useCallback, useState } from "react";
import { useConnectors } from "../hooks/useConnectors";
import { installConnector, type AvailableConnectorView } from "../lib/api";
import styles from "./ConnectorsView.module.css";

export function ConnectorCatalogView({ onOpenConsole }: { onOpenConsole?: () => void }) {
  const { available, loading, error, refresh } = useConnectors();
  const [busy, setBusy] = useState<Record<string, "install">>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const install = useCallback(
    async (entry: AvailableConnectorView) => {
      setBusy((prev) => ({ ...prev, [entry.connectorId]: "install" }));
      setActionError(null);
      try {
        await installConnector(entry.connectorId);
        await refresh();
        return true;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy((prev) => {
          const next = { ...prev };
          delete next[entry.connectorId];
          return next;
        });
      }
    },
    [refresh],
  );

  return (
    <div className={styles.console}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>Connector Catalog</h1>
          <span className={styles.subtitle}>browse · install connectors</span>
        </div>
      </header>

      {(error || actionError) && (
        <div className={styles.errorStrip} role="alert">
          <span className={styles.errorGlyph}>▲</span>
          {actionError ?? error}
          {actionError && (
            <button className={styles.errorDismiss} onClick={() => setActionError(null)}>
              ✕
            </button>
          )}
        </div>
      )}

      <div className={styles.ledger}>
        {loading && available.length === 0 ? (
          <div className={styles.empty}>scanning bundled connectors…</div>
        ) : available.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyGlyph}>⌀</span>
            <span>nothing on the shelf</span>
            <span className={styles.emptyHint}>
              this build ships without bundled connectors
            </span>
          </div>
        ) : (
          available.map((entry, index) => (
            <CatalogCard
              key={entry.connectorId}
              entry={entry}
              index={index}
              busy={busy[entry.connectorId]}
              onInstall={() => install(entry)}
              onOpenConsole={onOpenConsole}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface CatalogCardProps {
  entry: AvailableConnectorView;
  index: number;
  busy?: "install";
  onInstall: () => Promise<boolean>;
  onOpenConsole?: () => void;
}

function CatalogCard({
  entry,
  index,
  busy,
  onInstall,
  onOpenConsole,
}: CatalogCardProps) {
  const cardClass = entry.updateAvailable
    ? styles.card_update
    : entry.installed
      ? styles.card_installed
      : entry.supported
        ? styles.card_available
        : `${styles.card_available} ${styles.card_unsupported}`;
  return (
    <article
      className={`${styles.card} ${cardClass}`}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <div className={styles.cardRail} />
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <span
            className={`${styles.stateBadge} ${
              entry.updateAvailable
                ? styles.tone_setup
                : entry.installed
                  ? styles.tone_ready
                  : styles.tone_available
            }`}
          >
            <span className={styles.stateDot} />
            {entry.updateAvailable ? "UPDATE AVAILABLE" : entry.installed ? "INSTALLED" : "AVAILABLE"}
          </span>
          <h2 className={styles.cardName}>{entry.name}</h2>
          <span className={styles.cardMeta}>
            {entry.mode}
            {entry.authType !== "none" && <span className={styles.cron}> · {entry.authType}</span>}
            <span className={styles.bundledSeal}>bundled</span>
          </span>
          <div className={styles.cardTopActions}>
            {!entry.supported && (
              <span className={styles.unsupportedNote}>not supported on this device</span>
            )}
            {entry.supported && !entry.installed && (
              <button
                className={styles.primaryBtn}
                disabled={Boolean(busy)}
                onClick={() => void onInstall()}
              >
                {busy === "install" ? "installing…" : "Install connector"}
              </button>
            )}
            {entry.installed
              && (onOpenConsole ? (
                <button className={styles.ghostBtn} onClick={onOpenConsole}>
                  Manage in Source Console
                </button>
              ) : (
                <span className={styles.installedNote}>Managed in Source Console</span>
              ))}
          </div>
        </div>
      </div>
    </article>
  );
}
