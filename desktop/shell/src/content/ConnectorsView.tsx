// ConnectorsView — the Source Console: connector integration management.
//
// Hierarchy mirrors the model: a connector package owns its integrations
// (source identities). One card per connector; integrations are rows inside
// it. Trust and platform availability are connector-level; setup, auth,
// permissions, and lifecycle actions are per integration.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnectors } from "../hooks/useConnectors";
import {
  approveConnector,
  checkConnectorRequirements,
  connectConnectorIntegration,
  createConnectorIntegration,
  disconnectConnectorIntegration,
  getConnectorAuthAttempt,
  pauseConnectorIntegration,
  removeConnector,
  removeConnectorIntegration,
  requestConnectorRequirement,
  restartConnectorIntegration,
  resumeConnectorIntegration,
  runConnectorIntegration,
  startConnectorConfigPanel,
  startConnectorAuth,
  stopConnectorConfigPanelSession,
  updateConnector,
  updateConnectorIntegration,
  type AvailableConnectorView,
  type ConnectorIntegrationView,
  type InstalledConnectorView,
  type ConnectorRequirementView,
} from "../lib/api";
import {
  SOURCE_LIFECYCLE_LABEL,
  relativeTime,
  setupNeeds,
  sourceHasAutomaticActivity,
  sourceLifecycle,
  sourceNeedsAttention,
  sourceNeedsSetup,
  trustView,
  type SourceLifecycle,
} from "../lib/connector-state";
import styles from "./ConnectorsView.module.css";

type Act = (key: string, label: string, fn: () => Promise<unknown>) => Promise<void>;
type AuthPendingAttempt = { attemptId: string };
type TrackAuthAttempt = (integrationId: string, attemptId: string) => void;
type DismissAuthAttempt = (integrationId: string) => void;
type ConfigPanelModalState = {
  sessionId: string;
  url: string;
  title: string;
};

const PAUSE_PRESETS = [
  { label: "15 minutes", durationMs: 15 * 60_000 },
  { label: "30 minutes", durationMs: 30 * 60_000 },
  { label: "1 hour", durationMs: 60 * 60_000 },
] as const;

export function ConnectorsView({ onOpenCatalog }: { onOpenCatalog?: () => void }) {
  const { sources, packages, available, loading, error, refresh } = useConnectors();
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [authPending, setAuthPending] = useState<Record<string, AuthPendingAttempt>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [configPanel, setConfigPanel] = useState<ConfigPanelModalState | null>(null);

  const act = useCallback<Act>(
    async (key, label, fn) => {
      setBusy((prev) => ({ ...prev, [key]: label }));
      setActionError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [refresh],
  );

  const trackAuthAttempt = useCallback<TrackAuthAttempt>((integrationId, attemptId) => {
    setAuthPending((prev) => ({ ...prev, [integrationId]: { attemptId } }));
  }, []);

  const dismissAuthAttempt = useCallback<DismissAuthAttempt>((integrationId) => {
    setAuthPending((prev) => clearAuthPendingAttempt(prev, integrationId));
  }, []);

  const openConfigPanel = useCallback(
    async (connector: ConnectorIntegrationView, panelId: string, label: string) => {
      await act(connector.id, "config-panel", async () => {
        if (configPanel) {
          await stopConnectorConfigPanelSession(configPanel.sessionId).catch(() => {});
          setConfigPanel(null);
        }
        const result = await startConnectorConfigPanel(connector.id, panelId);
        setConfigPanel({
          sessionId: result.sessionId,
          url: result.url,
          title: `${connector.name} · ${label}`,
        });
      });
    },
    [act, configPanel],
  );

  const closeConfigPanel = useCallback(async () => {
    const active = configPanel;
    if (!active) return;
    setConfigPanel(null);
    try {
      await stopConnectorConfigPanelSession(active.sessionId);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [configPanel, refresh]);

  useEffect(() => {
    return () => {
      if (configPanel) {
        void stopConnectorConfigPanelSession(configPanel.sessionId).catch(() => {});
      }
    };
  }, [configPanel]);

  useEffect(() => {
    const entries = Object.entries(authPending);
    if (entries.length === 0) return;

    let stopped = false;
    let polling = false;

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        await Promise.all(
          entries.map(async ([integrationId, pending]) => {
            try {
              const result = await getConnectorAuthAttempt(integrationId, pending.attemptId);
              if (stopped || result.status === "pending") return;

              setAuthPending((prev) =>
                clearAuthPendingAttempt(prev, integrationId, pending.attemptId),
              );

              if (result.status === "connected") {
                setActionError(null);
                await refresh();
                return;
              }

              setActionError(result.error ?? `Auth ${result.status}`);
            } catch (err) {
              if (stopped) return;
              setAuthPending((prev) =>
                clearAuthPendingAttempt(prev, integrationId, pending.attemptId),
              );
              setActionError(err instanceof Error ? err.message : String(err));
            }
          }),
        );
      } finally {
        polling = false;
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [authPending, refresh]);

  const groups = useMemo(() => {
    const byConnector = new Map<string, ConnectorIntegrationView[]>();
    const catalogByConnector = new Map(
      available.map((entry) => [entry.connectorId, entry]),
    );
    for (const c of sources) {
      const list = byConnector.get(c.connectorId) ?? [];
      list.push(c);
      byConnector.set(c.connectorId, list);
    }
    return packages.map((connector) => ({
      connector,
      integrations: byConnector.get(connector.connectorId) ?? [],
      catalogEntry: catalogByConnector.get(connector.connectorId),
    }));
  }, [sources, packages, available]);

  const counts = useMemo(() => {
    const tally: Record<SourceLifecycle | "setup", number> = {
      active: 0,
      paused: 0,
      setup: 0,
    };
    for (const c of sources) {
      tally[sourceLifecycle(c)] += 1;
      if (sourceNeedsSetup(c)) tally.setup += 1;
    }
    return tally;
  }, [sources]);

  return (
    <div className={styles.console}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>Source Console</h1>
          <span className={styles.subtitle}>connector runtime · this device</span>
        </div>
        <div className={styles.tally}>
          <TallyItem tone="active" label="active" count={counts.active} />
          <TallyItem tone="paused" label="paused" count={counts.paused} />
          <TallyItem tone="setup" label="needs setup" count={counts.setup} />
        </div>
        {onOpenCatalog && (
          <button className={styles.ghostBtn} onClick={onOpenCatalog}>
            Connector Catalog
          </button>
        )}
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
        {loading && packages.length === 0 ? (
          <div className={styles.empty}>scanning workspace connectors…</div>
        ) : groups.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyGlyph}>⌀</span>
            <span>no Connectors installed</span>
            {onOpenCatalog ? (
              <button className={styles.ghostBtn} onClick={onOpenCatalog}>
                Browse Connector Catalog
              </button>
            ) : (
              <span className={styles.emptyHint}>
                install a connector package into workspace/connectors/
              </span>
            )}
          </div>
        ) : (
          groups.map((group, index) => (
            <ConnectorCard
              key={group.connector.connectorId}
              connector={group.connector}
              integrations={group.integrations}
              catalogEntry={group.catalogEntry}
              index={index}
              busy={busy}
              authPending={authPending}
              onAct={act}
              onOpenConfigPanel={openConfigPanel}
              onTrackAuthAttempt={trackAuthAttempt}
              onDismissAuthAttempt={dismissAuthAttempt}
            />
          ))
        )}
      </div>
      {configPanel && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.configPanelModal}>
            <div className={styles.modalHeader}>
              <span className={styles.modalTitle}>{configPanel.title}</span>
              <button className={styles.ghostBtn} onClick={closeConfigPanel}>
                Close
              </button>
            </div>
            <iframe
              className={styles.configPanelFrame}
              title={configPanel.title}
              src={configPanel.url}
              sandbox="allow-forms allow-same-origin allow-scripts"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function TallyItem({
  tone,
  label,
  count,
}: {
  tone: SourceLifecycle | "setup";
  label: string;
  count: number;
}) {
  return (
    <span className={`${styles.tallyItem} ${count ? styles[`tone_${tone}`] : styles.tallyZero}`}>
      <span className={styles.tallyCount}>{count}</span>
      {label}
    </span>
  );
}

interface ConnectorCardProps {
  connector: InstalledConnectorView;
  integrations: ConnectorIntegrationView[];
  catalogEntry?: AvailableConnectorView;
  index: number;
  busy: Record<string, string>;
  authPending: Record<string, AuthPendingAttempt>;
  onAct: Act;
  onOpenConfigPanel: (connector: ConnectorIntegrationView, panelId: string, label: string) => Promise<void>;
  onTrackAuthAttempt: TrackAuthAttempt;
  onDismissAuthAttempt: DismissAuthAttempt;
}

function ConnectorCard({
  connector,
  integrations,
  catalogEntry,
  index,
  busy,
  authPending,
  onAct,
  onOpenConfigPanel,
  onTrackAuthAttempt,
  onDismissAuthAttempt,
}: ConnectorCardProps) {
  const connectorId = connector.connectorId;
  const updateAvailable = catalogEntry?.updateAvailable === true;
  const trust = trustView(connector);
  const trusted = trust === "official" || trust === "custom";
  const interactive = connector.supported && trust !== "broken";
  const ownedSourceScope = integrations.length === 1
    ? "its Source"
    : `all ${integrations.length} of its Sources`;
  const connectorCondition = !connector.supported
    ? "unsupported"
    : trust === "needs-approval"
      ? "quarantined"
      : trust === "broken"
        ? "broken"
        : "ready";

  const [panel, setPanel] = useState<"approve" | "update" | "remove" | "add" | null>(null);
  const [addKeyInput, setAddKeyInput] = useState("");

  useEffect(() => {
    if (panel === "update" && !updateAvailable) {
      setPanel(null);
    }
  }, [panel, updateAvailable]);

  return (
    <article
      className={`${styles.card} ${
        updateAvailable && connectorCondition === "ready"
          ? styles.card_update
          : styles[`card_${connectorCondition}`]
      }`}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <div className={styles.cardRail} />
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <span className={`${styles.stateBadge} ${
            updateAvailable ? styles.tone_setup : styles.tone_ready
          }`}>
            <span className={styles.stateDot} />
            {updateAvailable ? "UPDATE AVAILABLE" : "INSTALLED"}
          </span>
          <h2 className={styles.cardName}>{connector.name}</h2>
          <span className={styles.cardMeta}>
            {connector.mode}
            <span className={styles.cron}>
              · {integrations.length} source{integrations.length === 1 ? "" : "s"}
            </span>
            {trust === "official" && <span className={styles.officialSeal}>official</span>}
            {trust === "custom" && <span className={styles.customSeal}>custom</span>}
            {trust === "broken" && <span className={styles.brokenSeal}>missing</span>}
          </span>
          <div className={styles.cardTopActions}>
            {updateAvailable && panel !== "update" && (
              <button className={styles.primaryBtn} onClick={() => setPanel("update")}>
                Update connector…
              </button>
            )}
            {trust === "needs-approval" && panel !== "approve" && (
              <button className={styles.hazardBtn} onClick={() => setPanel("approve")}>
                Review &amp; Approve
              </button>
            )}
            {trusted
              && interactive
              && (connector.integrationsMode === "multiple" || integrations.length === 0)
              && panel !== "add" && (
              <button
                className={styles.ghostBtn}
                onClick={() => {
                  if (connector.integrationsMode === "singleton") {
                    void onAct(connectorId, "add", () => createConnectorIntegration(connectorId));
                  } else {
                    setPanel("add");
                  }
                }}
              >
                + Add source
              </button>
            )}
            {panel !== "remove" && (
              <button
                className={styles.ghostBtn}
                title="Remove connector package"
                onClick={() => setPanel("remove")}
              >
                Remove connector…
              </button>
            )}
          </div>
        </div>

        {panel === "update" && catalogEntry && (
          <div className={styles.confirmPanel}>
            <div className={styles.confirmText}>
              Update <strong>{connector.name}</strong> from{" "}
              <code>{shortHash(catalogEntry.installedHash ?? connector.packageHash)}</code>
              {" → "}<code>{shortHash(catalogEntry.catalogHash)}</code>?
              {integrations.length === 1 ? (
                <>
                  {" "}Its Source keeps its account, settings, schedule, pause policy, and sync
                  progress.
                </>
              ) : integrations.length > 1 ? (
                <>
                  {" "}All {integrations.length} Sources keep their accounts, settings, schedules,
                  pause policies, and sync progress.
                </>
              ) : (
                <> The installed package will be replaced; no Sources are configured yet.</>
              )}{" "}
              Active runs stop during the package switch, and validation failure restores the
              installed revision. A custom package may require approval again for its new hash.
            </div>
            <div className={styles.confirmActions}>
              <button
                className={styles.primaryBtn}
                disabled={Boolean(busy[connectorId])}
                onClick={() =>
                  onAct(connectorId, "update", async () => {
                    await updateConnector(connectorId);
                    setPanel(null);
                  })
                }
              >
                {busy[connectorId] === "update" ? "updating…" : "Update connector"}
              </button>
              <button className={styles.ghostBtn} onClick={() => setPanel(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {panel === "approve" && (
          <div className={styles.confirmPanel}>
            <div className={styles.confirmText}>
              Approving trusts <strong>this version of the connector</strong> to run inside your
              workspace. If the connector&apos;s code changes later, it is blocked again until you
              re-approve.
            </div>
            <div className={styles.confirmActions}>
              <button
                className={styles.hazardBtn}
                disabled={Boolean(busy[connectorId])}
                onClick={() =>
                  onAct(connectorId, "approve", async () => {
                    await approveConnector(connectorId);
                    setPanel(null);
                  })
                }
              >
                {busy[connectorId] === "approve" ? "approving…" : "Approve this version"}
              </button>
              <button className={styles.ghostBtn} onClick={() => setPanel(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {panel === "add" && connector.integrationsMode === "multiple" && (
          <form
            className={styles.confirmPanel}
            onSubmit={(event) => {
              event.preventDefault();
              onAct(connectorId, "add", async () => {
                await createConnectorIntegration(connectorId, addKeyInput.trim() || undefined);
                setAddKeyInput("");
                setPanel(null);
              });
            }}
          >
            <div className={styles.confirmText}>
              Add another <strong>{connector.name}</strong> Source with its own account, settings, and
              sync progress. You can name it now or finish that during setup.
            </div>
            <div className={styles.inlineForm}>
              <input
                className={styles.inlineInput}
                aria-label="Source name"
                placeholder="source name (optional), e.g. personal"
                value={addKeyInput}
                onChange={(event) => setAddKeyInput(event.target.value)}
              />
              <button
                className={styles.primaryBtn}
                disabled={Boolean(busy[connectorId])}
              >
                {busy[connectorId] === "add" ? "adding…" : "Add source"}
              </button>
              <button type="button" className={styles.ghostBtn} onClick={() => setPanel(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {panel === "remove" && (
          <div className={styles.confirmPanel}>
            <div className={styles.confirmText}>
              Remove the <strong>{connector.name}</strong> Connector?
              {integrations.length > 0 ? (
                <> This also removes {ownedSourceScope}, including account credentials, settings,
                schedules, and sync progress.</>
              ) : (
                <> Its installed package will be deleted.</>
              )}{" "}
              Previously collected events remain in your ledger.
            </div>
            <div className={styles.confirmActions}>
              <button
                className={styles.hazardBtn}
                disabled={Boolean(busy[connectorId])}
                onClick={() =>
                  onAct(connectorId, "remove", async () => {
                    await removeConnector(connectorId);
                    setPanel(null);
                  })
                }
              >
                {busy[connectorId] === "remove" ? "removing…" : "Remove connector"}
              </button>
              <button className={styles.ghostBtn} onClick={() => setPanel(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className={styles.integrationList}>
          {integrations.length === 0 ? (
            <div className={styles.emptySources}>
              No Sources added. The Connector is installed and idle.
            </div>
          ) : integrations.map((c) => (
            <IntegrationRow
              key={c.id}
              connector={c}
              trusted={trusted}
              interactive={interactive}
	              busy={busy}
	              pendingAuthAttempt={authPending[c.id]}
	              onAct={onAct}
	              onOpenConfigPanel={onOpenConfigPanel}
	              onTrackAuthAttempt={onTrackAuthAttempt}
              onDismissAuthAttempt={onDismissAuthAttempt}
            />
          ))}
        </div>
      </div>
    </article>
  );
}

interface IntegrationRowProps {
  connector: ConnectorIntegrationView;
  trusted: boolean;
  interactive: boolean;
  busy: Record<string, string>;
  pendingAuthAttempt?: AuthPendingAttempt;
  onAct: Act;
  onOpenConfigPanel: (connector: ConnectorIntegrationView, panelId: string, label: string) => Promise<void>;
  onTrackAuthAttempt: TrackAuthAttempt;
  onDismissAuthAttempt: DismissAuthAttempt;
}

function IntegrationRow({
  connector: c,
  trusted,
  interactive,
  busy,
  pendingAuthAttempt,
  onAct,
  onOpenConfigPanel,
  onTrackAuthAttempt,
  onDismissAuthAttempt,
}: IntegrationRowProps) {
  const state = sourceLifecycle(c);
  const needs = setupNeeds(c);
  const needsSetup = sourceNeedsSetup(c);
  const [tokenInput, setTokenInput] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [runsOpen, setRunsOpen] = useState(false);
  const [lifecyclePanel, setLifecyclePanel] = useState<"pause" | "disconnect" | "remove" | null>(null);
  const cardBusy = Boolean(busy[c.id]);
  const showSetup = trusted && interactive && needsSetup;
  const needsAttention = sourceNeedsAttention(c);
  const recentRuns = c.recentRuns ?? [];
  const configPanels = Object.entries(c.configPanels ?? {});
  const canRunNow = interactive
    && trusted
    && (state === "active" || state === "paused")
    && !needsSetup
    && (c.status !== "error" || state === "paused")
    && (c.mode === "manual" || c.mode === "poll");
  const canPause = interactive
    && trusted
    && state === "active"
    && sourceHasAutomaticActivity(c);
  const canResume = interactive && trusted && state === "paused";
  const canDisconnect = c.authType !== "none" && c.authReady;
  const sourceLabel = c.integrationKey ?? c.source ?? c.name;

  return (
    <div className={styles.integrationRow}>
      <div className={styles.rowTop}>
        <span className={`${styles.rowBadge} ${styles[`tone_${state}`]}`}>
          <span className={styles.stateDot} />
          {SOURCE_LIFECYCLE_LABEL[state]}
        </span>
        <span className={styles.sourceLine}>
          {c.source ?? `connector:${c.connectorId} — finish source setup`}
        </span>
        {c.status === "running" && <span className={styles.activityBadge}>RUNNING</span>}
        {needsSetup && <span className={styles.conditionBadge}>NEEDS SETUP</span>}
        {needsAttention && <span className={styles.conditionBadge}>NEEDS ATTENTION</span>}
        {!c.supported && <span className={styles.conditionBadge}>UNSUPPORTED</span>}
        {!trusted && <span className={styles.conditionBadge}>CONNECTOR BLOCKED</span>}
        <span className={styles.timestamps}>
          {state === "paused"
            ? c.resumeAt
              ? `resumes ${relativeTime(c.resumeAt)}`
              : "until resumed"
            : `last run ${relativeTime(c.lastRunAt)}`}
          {state === "active" && c.mode === "poll" && c.nextRunAt
            ? ` · next ${relativeTime(c.nextRunAt)}`
            : ""}
        </span>
        {state === "active" && c.status === "error" && !needsSetup && (
          <button
            className={styles.primaryBtn}
            disabled={cardBusy}
            onClick={() => onAct(c.id, "restart", () => restartConnectorIntegration(c.id))}
          >
            {busy[c.id] === "restart"
              ? "working…"
              : c.mode === "watch"
                ? "Restart"
                : c.mode === "poll"
                  ? "Retry now"
                  : "Clear error"}
          </button>
        )}
        {canRunNow && (
          <button
            className={styles.primaryBtn}
            title={
              state === "paused"
                ? "Run once without resuming automatic activity"
                : c.mode === "poll"
                ? "Run this connector now without waiting for its schedule"
                : "Run this connector now"
            }
            disabled={cardBusy || c.status === "running"}
            onClick={() => onAct(c.id, "run", () => runConnectorIntegration(c.id))}
          >
            {busy[c.id] === "run" || c.status === "running"
              ? "running…"
              : state === "paused"
                ? "Run once"
                : c.mode === "poll"
                ? "Run now"
                : "Run"}
          </button>
        )}
        {canPause && (
          <button
            className={styles.ghostBtn}
            disabled={cardBusy}
            aria-expanded={lifecyclePanel === "pause"}
            onClick={() => setLifecyclePanel((panel) => panel === "pause" ? null : "pause")}
          >
            Pause…
          </button>
        )}
        {canResume && (
          <button
            className={styles.primaryBtn}
            disabled={cardBusy}
            onClick={() => onAct(c.id, "resume", () => resumeConnectorIntegration(c.id))}
          >
            {busy[c.id] === "resume" ? "resuming…" : "Resume now"}
          </button>
        )}
        {canDisconnect && (
          <button
            className={styles.ghostBtn}
            disabled={cardBusy}
            aria-expanded={lifecyclePanel === "disconnect"}
            onClick={() => setLifecyclePanel((panel) => panel === "disconnect" ? null : "disconnect")}
          >
            Disconnect account…
          </button>
        )}
        <button
          className={styles.ghostBtn}
          disabled={cardBusy}
          aria-expanded={lifecyclePanel === "remove"}
          onClick={() => setLifecyclePanel((panel) => panel === "remove" ? null : "remove")}
        >
          Remove source…
        </button>
      </div>

      {lifecyclePanel === "pause" && (
        <div className={styles.lifecyclePanel} role="group" aria-label={`Pause ${sourceLabel}`}>
          <span className={styles.lifecyclePrompt}>
            Pause this source. Its account, settings, and sync progress stay intact.
          </span>
          <div className={styles.lifecycleActions}>
            {PAUSE_PRESETS.map((preset) => (
              <button
                key={preset.durationMs}
                type="button"
                className={styles.ghostBtn}
                disabled={cardBusy}
                onClick={() =>
                  onAct(c.id, "pause", async () => {
                    await pauseConnectorIntegration(c.id, preset.durationMs);
                    setLifecyclePanel(null);
                  })
                }
              >
                {preset.label}
              </button>
            ))}
            <button
              type="button"
              className={styles.ghostBtn}
              disabled={cardBusy}
              onClick={() =>
                onAct(c.id, "pause", async () => {
                  await pauseConnectorIntegration(c.id);
                  setLifecyclePanel(null);
                })
              }
            >
              Until I resume
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              disabled={cardBusy}
              onClick={() => setLifecyclePanel(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {lifecyclePanel === "remove" && (
        <div className={styles.lifecyclePanel}>
          <span className={styles.lifecyclePrompt}>
            Remove <strong>{sourceLabel}</strong>? Its account credentials, settings, schedule,
            and sync progress will be deleted. Previously collected events remain in your ledger.
          </span>
          <div className={styles.lifecycleActions}>
            <button
              type="button"
              className={styles.hazardBtn}
              disabled={cardBusy}
              onClick={() => onAct(c.id, "remove-source", () => removeConnectorIntegration(c.id))}
            >
              {busy[c.id] === "remove-source" ? "removing…" : "Remove source"}
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              disabled={cardBusy}
              onClick={() => setLifecyclePanel(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {lifecyclePanel === "disconnect" && (
        <div className={styles.lifecyclePanel}>
          <span className={styles.lifecyclePrompt}>
            Disconnect the account from <strong>{sourceLabel}</strong>? The credential will be
            deleted and this Source will need setup. Its settings, schedule, sync progress, pause
            policy, and previously collected events stay intact.
          </span>
          <div className={styles.lifecycleActions}>
            <button
              type="button"
              className={styles.hazardBtn}
              disabled={cardBusy}
              onClick={() =>
                onAct(c.id, "disconnect", async () => {
                  await disconnectConnectorIntegration(c.id);
                  setLifecyclePanel(null);
                })
              }
            >
              {busy[c.id] === "disconnect" ? "disconnecting…" : "Disconnect account"}
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              disabled={cardBusy}
              onClick={() => setLifecyclePanel(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {needsSetup && needs.length > 0 && (
        <div className={styles.needsLine}>
          needs <span className={styles.needsItems}>{needs.join(" · ")}</span>
        </div>
      )}

      {c.authAttention === "redirect_uri_changed" && (
        <div className={styles.lastError}>
          <span className={styles.errorGlyph}>▲</span>
          OAuth redirect URI changed. Existing tokens may keep working, but update the provider app before reconnecting this account.
        </div>
      )}

      {c.authAttention === "refresh_failed" && (
        <div className={styles.lastError}>
          <span className={styles.errorGlyph}>▲</span>
          OAuth refresh failed. Reconnect this account.
        </div>
      )}

      {c.warnings?.map((warning) => (
        <div key={warning.key} className={styles.warningBanner}>
          <span className={styles.errorGlyph}>▲</span>
          {warning.message}
        </div>
      ))}

      {showSetup && c.setupPending.includes("integration_key") && (
        <form
          className={styles.inlineForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!keyInput.trim()) return;
            onAct(c.id, "name", async () => {
              await updateConnectorIntegration(c.id, { integrationKey: keyInput.trim() });
              setKeyInput("");
            });
          }}
        >
          <input
            className={styles.inlineInput}
            placeholder="source name, e.g. work or macbook"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
          />
          <button className={styles.ghostBtn} disabled={cardBusy || !keyInput.trim()}>
            {busy[c.id] === "name" ? "saving…" : "Save"}
          </button>
        </form>
      )}

      {showSetup && c.setupPending.includes("auth") && (
        c.authType === "apiKey" ? (
          <form
            className={styles.inlineForm}
            onSubmit={(event) => {
              event.preventDefault();
              if (!tokenInput.trim()) return;
              onAct(c.id, "connect", async () => {
                await connectConnectorIntegration(c.id, tokenInput.trim());
                setTokenInput("");
              });
            }}
          >
            <input
              className={styles.inlineInput}
              type="password"
              placeholder="paste API key"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
            />
            <button className={styles.primaryBtn} disabled={cardBusy || !tokenInput.trim()}>
              {busy[c.id] === "connect" ? "connecting…" : "Connect"}
            </button>
          </form>
        ) : isBrowserAuthType(c.authType) ? (
          <form
            className={styles.oauthBox}
            onSubmit={(event) => {
              event.preventDefault();
              onAct(c.id, "auth", async () => {
                const started = await startConnectorAuth(c.id);
                await openAuthorizationUrl(started.authorizationUrl);
                onTrackAuthAttempt(c.id, started.attemptId);
              });
            }}
          >
            {c.oauthRedirectUri && (
              <div className={styles.oauthNote}>
                redirect <span className={styles.redirectUri}>{c.oauthRedirectUri}</span>
              </div>
            )}
            {pendingAuthAttempt && (
              <div className={styles.oauthNote}>authorization pending in browser</div>
            )}
            <button className={styles.primaryBtn} disabled={cardBusy}>
              {busy[c.id] === "auth"
                ? "opening…"
                : pendingAuthAttempt
                  ? "Try Again"
                  : "Connect Account"}
            </button>
            {pendingAuthAttempt && (
              <button
                type="button"
                className={styles.ghostBtn}
                disabled={cardBusy}
                onClick={() => onDismissAuthAttempt(c.id)}
              >
                Dismiss
              </button>
            )}
          </form>
        ) : (
          <div className={styles.oauthNote}>Unsupported auth type.</div>
        )
      )}

      {c.requirements.length > 0 && showSetup && (
        <div className={styles.requirements}>
          {c.requirements.map((req) => (
            <RequirementChip key={req.id} integrationId={c.id} req={req} busy={busy} onAct={onAct} />
          ))}
          <button
            className={styles.ghostBtn}
            disabled={cardBusy}
            onClick={() => onAct(c.id, "check", () => checkConnectorRequirements(c.id))}
          >
            {busy[c.id] === "check" ? "checking…" : "re-check all"}
          </button>
        </div>
      )}

      {c.lastError && (c.status === "error" || needsSetup) && (
        <div className={styles.lastError}>
          <span className={styles.errorGlyph}>▲</span>
          {c.lastError}
          {state === "active" && c.status === "error" && c.mode === "poll" && (
            <span className={styles.retryNote}>auto-retries at next schedule</span>
          )}
        </div>
      )}

	      <div className={styles.runHistory}>
        <button
          type="button"
          className={styles.runHistoryToggle}
          onClick={() => setRunsOpen((open) => !open)}
        >
          <span>{runsOpen ? "▾" : "▸"}</span>
          runtime
          <span className={styles.runHistoryCount}>{recentRuns.length} recent</span>
        </button>
        {runsOpen && (
          <div className={styles.runHistoryPanel}>
            {recentRuns.length === 0 ? (
              <div className={styles.runHistoryEmpty}>No runs recorded yet.</div>
            ) : (
              recentRuns.map((run) => (
                <div key={run.id} className={styles.runHistoryRow}>
                  <span className={`${styles.runStatus} ${styles[`run_${run.status}`]}`}>
                    {run.status}
                  </span>
                  <span className={styles.runTrigger}>{run.trigger}</span>
                  <span className={styles.runTime}>{relativeTime(run.startedAt)}</span>
                  <span className={styles.runDuration}>{formatDuration(run.durationMs)}</span>
                  {run.error && <span className={styles.runError}>{run.error}</span>}
                </div>
              ))
            )}
          </div>
        )}
	      </div>

	      {trusted && interactive && configPanels.length > 0 && (
	        <div className={styles.configPanelActions}>
	          {configPanels.map(([panelId, panel]) => (
	            <button
	              key={panelId}
	              className={styles.ghostBtn}
	              disabled={cardBusy}
	              title={panel.description}
	              onClick={() => onOpenConfigPanel(c, panelId, panel.label)}
	            >
	              {busy[c.id] === "config-panel" ? "opening…" : panel.label}
	            </button>
	          ))}
	        </div>
	      )}

	      {trusted && interactive && c.configSchema && Object.keys(c.configSchema).length > 0 && (
	        <ConfigForm connector={c} busy={busy} onAct={onAct} />
	      )}
    </div>
  );
}

// Schema-driven settings form: one input per declared config field, prefilled
// from the integration's stored override or the author default. Save writes the
// overrides; Reset clears them so the schema defaults apply again.
function buildConfigValues(
  schema: NonNullable<ConnectorIntegrationView["configSchema"]>,
  config: ConnectorIntegrationView["config"],
): Record<string, string | number | boolean> {
  const next: Record<string, string | number | boolean> = {};
  for (const [key, field] of Object.entries(schema)) {
    const current = config?.[key];
    const fallback = field.default ?? (field.type === "boolean" ? false : field.type === "number" ? 0 : "");
    next[key] = typeof current === field.type ? current as string | number | boolean : fallback;
  }
  return next;
}

function withPrimitiveConfigValues(
  config: ConnectorIntegrationView["config"],
  values: Record<string, string | number | boolean>,
): Record<string, unknown> {
  return {
    ...(isRecord(config) ? config : {}),
    ...values,
  };
}

function withoutPrimitiveConfigValues(
  config: ConnectorIntegrationView["config"],
  schema: NonNullable<ConnectorIntegrationView["configSchema"]>,
): Record<string, unknown> {
  const next = { ...(isRecord(config) ? config : {}) };
  for (const key of Object.keys(schema)) {
    delete next[key];
  }
  return next;
}

function ConfigForm({ connector: c, busy, onAct }: {
  connector: ConnectorIntegrationView;
  busy: Record<string, string>;
  onAct: Act;
}) {
  const schema = c.configSchema ?? {};
  const cardBusy = Boolean(busy[c.id]);

  // Key the re-sync on the *content* of the stored config (+ schema), not object
  // identity: useConnectors polls every 2s and hands us fresh refs each tick, so
  // keying on identity would revert an in-progress edit. This re-syncs only when
  // the stored values actually change (after Save/Reset).
  const storedKey = JSON.stringify([c.config ?? {}, schema]);
  const [values, setValues] = useState<Record<string, string | number | boolean>>(
    () => buildConfigValues(schema, c.config),
  );
  useEffect(() => {
    setValues(buildConfigValues(schema, c.config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  return (
    <form
      className={styles.configForm}
      onSubmit={(event) => {
	        event.preventDefault();
	        onAct(c.id, "config", () =>
	          updateConnectorIntegration(c.id, { config: withPrimitiveConfigValues(c.config, values) })
	        );
	      }}
    >
      {Object.entries(schema).map(([key, field]) => {
        const selectedOptionIndex = field.options?.findIndex((option) => option.value === values[key]) ?? -1;
        return (
          <label key={key} className={styles.configField}>
            <span className={styles.configLabel}>{field.label}</span>
            {field.options?.length ? (
              <select
                className={styles.inlineInput}
                required={field.required !== false}
                value={selectedOptionIndex >= 0 ? String(selectedOptionIndex) : ""}
                onChange={(event) => {
                  const option = field.options?.[Number(event.target.value)];
                  if (!option) return;
                  setValues((v) => ({ ...v, [key]: option.value }));
                }}
              >
                {selectedOptionIndex < 0 && <option value="">Select</option>}
                {field.options.map((option, index) => (
                  <option key={String(option.value)} value={String(index)}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "boolean" ? (
              <input
                type="checkbox"
                checked={Boolean(values[key])}
                onChange={(event) => setValues((v) => ({ ...v, [key]: event.target.checked }))}
              />
            ) : (
              <input
                className={styles.inlineInput}
                type={field.type === "number" ? "number" : "text"}
                required={field.required !== false}
                value={String(values[key] ?? "")}
                onChange={(event) =>
                  setValues((v) => ({
                    ...v,
                    [key]: field.type === "number" ? Number(event.target.value) : event.target.value,
                  }))
                }
              />
            )}
          </label>
        );
      })}
      <div className={styles.configActions}>
        <button className={styles.primaryBtn} disabled={cardBusy}>
          {busy[c.id] === "config" ? "saving…" : "Save settings"}
        </button>
        <button
          type="button"
          className={styles.ghostBtn}
          disabled={cardBusy}
	          title="Clear overrides and restore defaults"
	          onClick={() =>
	            onAct(c.id, "config", () =>
	              updateConnectorIntegration(c.id, { config: withoutPrimitiveConfigValues(c.config, schema) })
	            )
	          }
	        >
	          {busy[c.id] === "config" ? "…" : "Reset"}
	        </button>
	      </div>
	    </form>
	  );
	}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function openAuthorizationUrl(url: string): Promise<void> {
  if (window.lamarckHost?.openExternal) {
    await window.lamarckHost.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

function isBrowserAuthType(type: ConnectorIntegrationView["authType"]): boolean {
  return type === "oauth2-public" || type === "managedProvider";
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "running";
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function clearAuthPendingAttempt(
  attempts: Record<string, AuthPendingAttempt>,
  integrationId: string,
  attemptId?: string,
): Record<string, AuthPendingAttempt> {
  if (!attempts[integrationId]) return attempts;
  if (attemptId && attempts[integrationId]?.attemptId !== attemptId) return attempts;
  const next = { ...attempts };
  delete next[integrationId];
  return next;
}

function shortHash(hash: string | undefined): string {
  if (!hash) return "unknown";
  return hash.startsWith("sha256:") ? hash.slice(7, 19) : hash.slice(0, 12);
}

interface RequirementChipProps {
  integrationId: string;
  req: ConnectorRequirementView;
  busy: Record<string, string>;
  onAct: Act;
}

function RequirementChip({ integrationId, req, busy, onAct }: RequirementChipProps) {
  const busyKey = `${integrationId}:${req.id}`;
  const actionable = req.status !== "satisfied";
  return (
    <span
      className={`${styles.reqChip} ${styles[`req_${req.status}`]}`}
      title={req.message ?? (req.lastCheckedAt ? `checked ${relativeTime(req.lastCheckedAt)}` : "never checked")}
    >
      <span className={styles.reqDot} />
      {req.id}
      <span className={styles.reqStatus}>{req.status}</span>
      {actionable && (
        <button
          className={styles.reqAction}
          disabled={Boolean(busy[busyKey])}
          onClick={() =>
            onAct(busyKey, "grant", () =>
              req.status === "unknown"
                ? checkConnectorRequirements(integrationId)
                : requestConnectorRequirement(integrationId, req.id),
            )
          }
        >
          {busy[busyKey] ? "…" : req.status === "unknown" ? "check" : "grant"}
        </button>
      )}
    </span>
  );
}
