// ConnectorCatalogView keeps Connector and Source ownership visible: install
// the package first, then explicitly add zero or more Sources on top of it.

import { useCallback, useState } from "react";
import { useConnectors } from "../hooks/useConnectors";
import {
  createConnectorIntegration,
  installConnector,
  removeConnector,
  updateConnector,
  type AvailableConnectorView,
} from "../lib/api";
import styles from "./ConnectorsView.module.css";

export function ConnectorCatalogView() {
  const { sources, available, loading, error, refresh } = useConnectors();
  const [busy, setBusy] = useState<Record<string, "install" | "update" | "add" | "remove">>({});
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

  const addSource = useCallback(
    async (entry: AvailableConnectorView, integrationKey?: string) => {
      setBusy((prev) => ({ ...prev, [entry.connectorId]: "add" }));
      setActionError(null);
      try {
        if (!entry.installed) {
          throw new Error(`Install ${entry.name} before adding a source`);
        }
        await createConnectorIntegration(entry.connectorId, integrationKey);
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

  const update = useCallback(
    async (entry: AvailableConnectorView) => {
      setBusy((prev) => ({ ...prev, [entry.connectorId]: "update" }));
      setActionError(null);
      try {
        await updateConnector(entry.connectorId);
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

  const removeInstalledConnector = useCallback(
    async (entry: AvailableConnectorView) => {
      setBusy((prev) => ({ ...prev, [entry.connectorId]: "remove" }));
      setActionError(null);
      try {
        await removeConnector(entry.connectorId);
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
          <span className={styles.subtitle}>install a connector · add sources</span>
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
              sourceCount={sources.filter((source) => source.connectorId === entry.connectorId).length}
              onInstall={() => install(entry)}
              onUpdate={() => update(entry)}
              onAddSource={(integrationKey) => addSource(entry, integrationKey)}
              onRemoveConnector={() => removeInstalledConnector(entry)}
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
  busy?: "install" | "update" | "add" | "remove";
  sourceCount: number;
  onInstall: () => Promise<boolean>;
  onUpdate: () => Promise<boolean>;
  onAddSource: (integrationKey?: string) => Promise<boolean>;
  onRemoveConnector: () => Promise<boolean>;
}

function CatalogCard({
  entry,
  index,
  busy,
  sourceCount,
  onInstall,
  onUpdate,
  onAddSource,
  onRemoveConnector,
}: CatalogCardProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [sourceName, setSourceName] = useState("");
  const sourceExists = sourceCount > 0;
  const canAdd = entry.integrationsMode === "multiple" || !sourceExists;
  const ownedSourceScope = sourceCount === 1 ? "its source" : `all ${sourceCount} of its sources`;
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
            {sourceCount > 0 && (
              <span className={styles.cron}> · {sourceCount} source{sourceCount === 1 ? "" : "s"}</span>
            )}
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
            {entry.installed && entry.updateAvailable && (
              <button
                className={styles.primaryBtn}
                disabled={Boolean(busy)}
                aria-expanded={updateOpen}
                onClick={() => {
                  setAddOpen(false);
                  setRemoveOpen(false);
                  setUpdateOpen((open) => !open);
                }}
              >
                {busy === "update" ? "updating…" : "Update connector…"}
              </button>
            )}
            {entry.supported && entry.installed && canAdd ? (
              <button
                className={entry.updateAvailable ? styles.ghostBtn : styles.primaryBtn}
                disabled={Boolean(busy)}
                aria-expanded={entry.integrationsMode === "multiple" ? addOpen : undefined}
                onClick={() => {
                  if (entry.integrationsMode === "multiple") {
                    setUpdateOpen(false);
                    setRemoveOpen(false);
                    setAddOpen((open) => !open);
                    return;
                  }
                  void onAddSource();
                }}
              >
                {busy === "add" ? "adding…" : sourceExists ? "Add another source" : "Add source"}
              </button>
            ) : entry.installed && entry.supported ? (
              <span className={styles.installedNote}>source added</span>
            ) : null}
            {entry.installed && (
              <button
                className={styles.ghostBtn}
                disabled={Boolean(busy)}
                aria-expanded={removeOpen}
                onClick={() => {
                  setUpdateOpen(false);
                  setAddOpen(false);
                  setRemoveOpen((open) => !open);
                }}
              >
                Remove connector…
              </button>
            )}
          </div>
        </div>
        {updateOpen && entry.updateAvailable && entry.installed && (
          <div className={styles.confirmPanel}>
            <div className={styles.confirmText}>
              Update <strong>{entry.name}</strong> from <code>{shortHash(entry.installedHash)}</code>
              {" → "}<code>{shortHash(entry.catalogHash)}</code>? Sources, accounts, settings,
              schedules, pause policy, and sync progress stay intact. Active runs stop during the
              package switch; validation failure restores the installed revision. A custom package
              may require approval again for its new hash.
            </div>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={Boolean(busy)}
                onClick={() => {
                  void onUpdate().then((updated) => {
                    if (updated) setUpdateOpen(false);
                  });
                }}
              >
                {busy === "update" ? "updating…" : "Update connector"}
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                disabled={Boolean(busy)}
                onClick={() => setUpdateOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {addOpen && entry.integrationsMode === "multiple" && (
          <form
            className={styles.confirmPanel}
            onSubmit={(event) => {
              event.preventDefault();
              void onAddSource(sourceName.trim() || undefined).then((added) => {
                if (!added) return;
                setSourceName("");
                setAddOpen(false);
              });
            }}
          >
            <div className={styles.confirmText}>
              Add a source with its own account, settings, and sync progress. You can name it now or
              finish that during setup.
            </div>
            <div className={styles.inlineForm}>
              <input
                className={styles.inlineInput}
                aria-label="Source name"
                placeholder="source name (optional), e.g. work"
                value={sourceName}
                onChange={(event) => setSourceName(event.target.value)}
              />
              <button className={styles.primaryBtn} disabled={Boolean(busy)}>
                {busy === "add" ? "adding…" : "Add source"}
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                disabled={Boolean(busy)}
                onClick={() => setAddOpen(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {removeOpen && entry.installed && (
          <div className={styles.confirmPanel}>
            <div className={styles.confirmText}>
              {sourceCount > 0 ? (
                <>
                  Remove the <strong>{entry.name}</strong> connector and {ownedSourceScope}? Their
                  account credentials, settings, schedules, and sync progress will be deleted.
                  Previously collected events remain in your ledger.
                </>
              ) : (
                <>
                  Remove the <strong>{entry.name}</strong> connector? Its installed package will be
                  deleted. Previously collected events remain in your ledger.
                </>
              )}
            </div>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.hazardBtn}
                disabled={Boolean(busy)}
                onClick={() => {
                  void onRemoveConnector().then((removed) => {
                    if (removed) setRemoveOpen(false);
                  });
                }}
              >
                {busy === "remove" ? "removing…" : "Remove connector"}
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                disabled={Boolean(busy)}
                onClick={() => setRemoveOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function shortHash(hash: string | undefined): string {
  if (!hash) return "unknown";
  return hash.startsWith("sha256:") ? hash.slice(7, 19) : hash.slice(0, 12);
}
