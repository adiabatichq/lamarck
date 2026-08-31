import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { WorkspacePanel } from "../components/WorkspacePanel";
import { ActivityView } from "../content/ActivityView";
import { ConnectorsView } from "../content/ConnectorsView";
import { TableView } from "../content/TableView";
import {
  addD1HistoryExclusion,
  inspectDataSchema,
  listConnectors,
  listD1HistoryExclusions,
  query,
  removeD1HistoryExclusion,
  vfsCommand,
  type AppInfo,
  type ConnectorSourceView,
  type DataSchemaSnapshot,
  type D1HistoryExclusion,
  type InstalledConnectorView,
  type LamarckSessionView,
} from "../lib/api";
import styles from "./SystemRoom.module.css";
import { AppsManager } from "./AppsManager";

type SystemSection = "shape" | "sources" | "apps" | "data" | "timeline" | "workspace";

interface RecentEvent {
  id: string;
  source: string;
  type: string;
  started_at: number;
}

interface SystemSnapshot {
  sources: ConnectorSourceView[];
  packages: InstalledConnectorView[];
  tables: DataSchemaSnapshot["tables"];
  eventCount: number;
  recentEvents: RecentEvent[];
}

const EMPTY_SNAPSHOT: SystemSnapshot = {
  sources: [],
  packages: [],
  tables: [],
  eventCount: 0,
  recentEvents: [],
};

interface SystemRoomProps {
  apps: AppInfo[];
  coreStatus: "checking" | "connected" | "offline";
  coreError: string | null;
  schemaRequestPending: boolean;
  lamarckSession: LamarckSessionView;
  identityBusy: boolean;
  onReturnToUse: () => void;
  onOpenApp: (appId: string) => void;
  onCoreChanged: () => void | Promise<void>;
  onIdentitySignIn: () => void;
  onIdentitySignOut: () => void;
}

export function SystemRoom({
  apps,
  coreStatus,
  coreError,
  schemaRequestPending,
  lamarckSession,
  identityBusy,
  onReturnToUse,
  onOpenApp,
  onCoreChanged,
  onIdentitySignIn,
  onIdentitySignOut,
}: SystemRoomProps) {
  const [section, setSection] = useState<SystemSection>("shape");
  const [snapshot, setSnapshot] = useState<SystemSnapshot>(EMPTY_SNAPSHOT);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (coreStatus !== "connected") return;
    setRefreshing(true);
    const results = await Promise.allSettled([
      listConnectors(),
      inspectDataSchema(),
      query("SELECT COUNT(*) AS count FROM events"),
      query(
        "SELECT id, source, type, started_at FROM events ORDER BY started_at DESC, id DESC LIMIT 6",
      ),
    ]);

    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));

    setSnapshot((current) => {
      const connectors = results[0].status === "fulfilled" ? results[0].value : null;
      const schema = results[1].status === "fulfilled" ? results[1].value : null;
      const countResult = results[2].status === "fulfilled" ? results[2].value.rows[0] as { count?: number } : null;
      const eventRows = results[3].status === "fulfilled" ? results[3].value.rows as RecentEvent[] : current.recentEvents;
      return {
        sources: connectors?.sources ?? current.sources,
        packages: connectors?.packages ?? current.packages,
        tables: schema
          ? schema.tables.filter((table) => table.name !== "events")
          : current.tables,
        eventCount: Number(countResult?.count ?? current.eventCount),
        recentEvents: eventRows,
      };
    });
    setSnapshotError(failures[0] ?? null);
    setRefreshing(false);
  }, [coreStatus]);

  useEffect(() => {
    void refresh();
    if (coreStatus !== "connected") return;
    const timer = window.setInterval(() => void refresh(), 12_000);
    return () => window.clearInterval(timer);
  }, [coreStatus, refresh]);

  useEffect(() => {
    setSelectedTable(null);
    if (section !== "timeline") setSelectedEventId(null);
  }, [section]);

  const attentionCount = useMemo(() => {
    const sourceAttention = snapshot.sources.filter(sourceNeedsAttention).length;
    return sourceAttention + (schemaRequestPending ? 1 : 0) + (coreStatus === "offline" ? 1 : 0);
  }, [coreStatus, schemaRequestPending, snapshot.sources]);

  const inspectEvent = useCallback((eventId: string) => {
    setSelectedEventId(eventId);
    setSection("timeline");
  }, []);

  const title = SECTION_LABELS[section];

  return (
    <div className={styles.room}>
      <header className={styles.titleBar}>
        <button type="button" className={styles.back} onClick={onReturnToUse}>
          <BackIcon />
          <span>Use</span>
        </button>
        <div className={styles.titlePath}>
          <span>System</span>
          <i>/</i>
          <strong>{title}</strong>
        </div>
        <div className={styles.runtimeState}>
          <span className={`${styles.runtimeDot} ${styles[coreStatus]}`} />
          {coreStatus === "connected" ? "Core connected" : coreStatus === "checking" ? "Connecting" : "Core offline"}
        </div>
      </header>

      <aside className={styles.sidebar}>
        <div className={styles.systemBrand}>
          <span className={styles.systemSigil}><SystemIcon /></span>
          <div>
            <span>Lamarck</span>
            <strong>System</strong>
          </div>
        </div>

        <nav className={styles.navigation} aria-label="System">
          {PRIMARY_SECTIONS.map((item, index) => (
            <button
              type="button"
              key={item.id}
              className={`${styles.navItem} ${section === item.id ? styles.navItemActive : ""}`}
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? "page" : undefined}
            >
              <span className={styles.navIndex}>0{index + 1}</span>
              <item.icon />
              <span>{item.label}</span>
              {item.id === "shape" && attentionCount > 0 && (
                <i className={styles.navAttention}>{attentionCount}</i>
              )}
            </button>
          ))}
        </nav>

        <div className={styles.sidebarBottom}>
          <button
            type="button"
            className={`${styles.navItem} ${section === "workspace" ? styles.navItemActive : ""}`}
            onClick={() => setSection("workspace")}
            aria-current={section === "workspace" ? "page" : undefined}
          >
            <span className={styles.navIndex}>06</span>
            <WorkspaceIcon />
            <span>Workspace</span>
          </button>
          <div className={styles.systemFoot}>
            <span>Local control plane</span>
            <span>v0.1</span>
          </div>
        </div>
      </aside>

      <main className={styles.content}>
        {section === "shape" && (
          <SystemOverview
            apps={apps}
            snapshot={snapshot}
            coreStatus={coreStatus}
            coreError={coreError ?? snapshotError}
            attentionCount={attentionCount}
            refreshing={refreshing}
            onRefresh={refresh}
            onNavigate={setSection}
            onInspectEvent={inspectEvent}
          />
        )}
        {section === "sources" && (
          <div className={styles.fullSurface}>
            <ConnectorsView />
          </div>
        )}
        {section === "apps" && (
          <AppsManager
            seedApps={apps}
            onOpenApp={onOpenApp}
            onInventoryChanged={onCoreChanged}
          />
        )}
        {section === "data" && (
          <SystemData
            tables={snapshot.tables}
            selectedTable={selectedTable}
            onSelectTable={setSelectedTable}
            onCloseInspector={() => setSelectedTable(null)}
          />
        )}
        {section === "timeline" && (
          <div className={styles.fullSurface}>
            <ActivityView key={coreStatus} initialEventId={selectedEventId} />
          </div>
        )}
        {section === "workspace" && (
          <SystemWorkspace
            coreStatus={coreStatus}
            lamarckSession={lamarckSession}
            identityBusy={identityBusy}
            onCoreChanged={onCoreChanged}
            onIdentitySignIn={onIdentitySignIn}
            onIdentitySignOut={onIdentitySignOut}
          />
        )}
      </main>
    </div>
  );
}

const SECTION_LABELS: Record<SystemSection, string> = {
  shape: "Shape",
  sources: "Sources",
  apps: "Apps",
  data: "Data",
  timeline: "Timeline",
  workspace: "Workspace",
};

const PRIMARY_SECTIONS: Array<{
  id: Exclude<SystemSection, "workspace">;
  label: string;
  icon: () => ReactElement;
}> = [
  { id: "shape", label: "Overview", icon: ShapeIcon },
  { id: "sources", label: "Sources", icon: SourcesIcon },
  { id: "apps", label: "Apps", icon: AppsIcon },
  { id: "data", label: "Data", icon: DataIcon },
  { id: "timeline", label: "Timeline", icon: TimelineIcon },
];

function SystemOverview({
  apps,
  snapshot,
  coreStatus,
  coreError,
  attentionCount,
  refreshing,
  onRefresh,
  onNavigate,
  onInspectEvent,
}: {
  apps: AppInfo[];
  snapshot: SystemSnapshot;
  coreStatus: "checking" | "connected" | "offline";
  coreError: string | null;
  attentionCount: number;
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
  onNavigate: (section: SystemSection) => void;
  onInspectEvent: (eventId: string) => void;
}) {
  const uiApps = apps.filter((app) => Boolean(app.runtime?.ui)).length;
  const sourceAttention = snapshot.sources.filter(sourceNeedsAttention);

  return (
    <div className={styles.overview}>
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.overline}>Observe before changing</span>
          <h1>System shape</h1>
          <p>The current substrate, its independent parts, and the places that need a human decision.</p>
        </div>
        <button type="button" className={styles.refresh} onClick={onRefresh} disabled={refreshing || coreStatus !== "connected"}>
          <RefreshIcon />
          {refreshing ? "Reading" : "Refresh"}
        </button>
      </header>

      {coreError && (
        <div className={styles.alertStrip}>
          <span>!</span>
          <div><strong>System signal unavailable</strong><p>{coreError}</p></div>
          <button type="button" onClick={() => onNavigate("workspace")}>Workspace</button>
        </div>
      )}

      <section className={styles.signalGrid}>
        <Signal label="Sources" value={snapshot.sources.length} detail={`${sourceAttention.length} need attention`} tone={sourceAttention.length ? "amber" : "mint"} onClick={() => onNavigate("sources")} />
        <Signal label="Apps" value={apps.length} detail={`${uiApps} openable interfaces`} tone="cyan" onClick={() => onNavigate("apps")} />
        <Signal label="Files" value="Open" detail="D1 filesystem authority" tone="neutral" onClick={() => onNavigate("data")} />
        <Signal label="Tables" value={snapshot.tables.length} detail="D2 current models" tone="neutral" onClick={() => onNavigate("data")} />
      </section>

      <section className={styles.shapePanel}>
        <div className={styles.panelHeading}>
          <div><span>Structure</span><strong>One data substrate, many interfaces</strong></div>
          <span className={`${styles.liveLabel} ${styles[coreStatus]}`}><i /> {coreStatus === "connected" ? "Observed now" : coreStatus}</span>
        </div>

        <div className={styles.shapeDiagram}>
          <button type="button" className={`${styles.shapeNode} ${styles.sourceNode}`} onClick={() => onNavigate("sources")}>
            <span>Input</span><strong>Sources</strong><i>{snapshot.sources.length}</i>
          </button>
          <div className={styles.flowArrow}><span>write evidence</span><i /></div>
          <button type="button" className={`${styles.shapeNode} ${styles.timelineNode}`} onClick={() => onNavigate("timeline")}>
            <span>D0 · Continuity</span><strong>Timeline</strong><i>{formatCompact(snapshot.eventCount)}</i>
          </button>
          <div className={styles.substrateBracket} aria-hidden="true"><span>data.db</span></div>
          <button type="button" className={`${styles.shapeNode} ${styles.fileNode}`} onClick={() => onNavigate("data")}>
            <span>D1 · Filesystem</span><strong>Files</strong><i>local</i>
          </button>
          <button type="button" className={`${styles.shapeNode} ${styles.tableNode}`} onClick={() => onNavigate("data")}>
            <span>D2 · Current</span><strong>Tables</strong><i>{snapshot.tables.length}</i>
          </button>
          <div className={styles.systemInterface}><span>@lamarck/system</span></div>
          <button type="button" className={`${styles.shapeNode} ${styles.appNode}`} onClick={() => onNavigate("apps")}>
            <span>Interpretation</span><strong>Apps</strong><i>{apps.length}</i>
          </button>
        </div>
      </section>

      <div className={styles.lowerGrid}>
        <section className={styles.attentionPanel}>
          <div className={styles.panelHeading}>
            <div><span>Authority</span><strong>Needs you</strong></div>
            <b>{attentionCount}</b>
          </div>
          {attentionCount === 0 ? (
            <div className={styles.quietState}><i>✓</i><span>No approval or repair is waiting.</span></div>
          ) : (
            <div className={styles.attentionList}>
              {coreStatus === "offline" && <AttentionItem title="Core is offline" detail="Open Workspace to retry or inspect recovery." onClick={() => onNavigate("workspace")} />}
              {sourceAttention.slice(0, 4).map((sourceRecord) => (
                <AttentionItem key={sourceRecord.id} title={sourceRecord.name} detail={sourceAttentionText(sourceRecord)} onClick={() => onNavigate("sources")} />
              ))}
            </div>
          )}
        </section>

        <section className={styles.eventPanel}>
          <div className={styles.panelHeading}>
            <div><span>Activity</span><strong>Recent raw events</strong></div>
            <button type="button" onClick={() => onNavigate("timeline")}>Inspect all <span>→</span></button>
          </div>
          {snapshot.recentEvents.length === 0 ? (
            <div className={styles.quietState}><i>○</i><span>No events have been recorded.</span></div>
          ) : (
            <div className={styles.recentEvents}>
              {snapshot.recentEvents.map((event) => (
                <button type="button" key={event.id} onClick={() => onInspectEvent(event.id)}>
                  <span className={styles.eventPulse} />
                  <strong>{event.type}</strong>
                  <span>{event.source}</span>
                  <time>{relativeTime(event.started_at)}</time>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Signal({
  label,
  value,
  detail,
  tone,
  onClick,
}: {
  label: string;
  value: number | string;
  detail: string;
  tone: "mint" | "cyan" | "amber" | "neutral";
  onClick: () => void;
}) {
  return (
    <button type="button" className={`${styles.signal} ${styles[`signal_${tone}`]}`} onClick={onClick}>
      <span>{label}</span>
      <strong>{typeof value === "number" ? formatCompact(value) : value}</strong>
      <i>{detail}</i>
      <b aria-hidden="true">↗</b>
    </button>
  );
}

function AttentionItem({ title, detail, onClick }: { title: string; detail: string; onClick: () => void }) {
  return <button type="button" onClick={onClick}><i>!</i><span><strong>{title}</strong><small>{detail}</small></span><b>→</b></button>;
}

function SystemData({
  tables,
  selectedTable,
  onSelectTable,
  onCloseInspector,
}: {
  tables: DataSchemaSnapshot["tables"];
  selectedTable: string | null;
  onSelectTable: (name: string) => void;
  onCloseInspector: () => void;
}) {
  if (selectedTable) {
    return (
      <div className={styles.inspectorPage}>
        <button type="button" className={styles.surfaceBack} onClick={onCloseInspector}><BackIcon /> Data</button>
        <div className={styles.surfaceFill}><TableView tableName={selectedTable} /></div>
      </div>
    );
  }
  return (
    <div className={styles.dataPage}>
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.overline}>Durable substrate</span>
          <h1>Data</h1>
          <p>Open filesystem-authoritative D1 files and inspect promoted D2 Tables.</p>
        </div>
      </header>
      <div className={styles.dataColumns}>
        <section className={styles.dataLedger}>
          <div className={styles.panelHeading}><div><span>D1</span><strong>Files</strong></div><b>local</b></div>
          <FilesPanel />
        </section>
        <section className={styles.dataLedger}>
          <div className={styles.panelHeading}><div><span>D2</span><strong>Tables</strong></div><b>{tables.length}</b></div>
          <div className={styles.dataList}>
            {tables.length === 0 ? <div className={styles.inventoryEmpty}>No promoted Tables.</div> : tables.map((table) => (
              <button type="button" key={table.name} onClick={() => onSelectTable(table.name)}>
                <TableIcon /><span><strong>{table.name}</strong><small>{table.columns.length} columns</small></span><b>→</b>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function FilesPanel() {
  const [path, setPath] = useState("");
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const readMarkdown = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setContent(null);
    try {
      if (!path.toLowerCase().endsWith(".md")) throw new Error("Enter a real .md file path.");
      const result = await vfsCommand(`cat -- ${quoteVfsWord(path)}`);
      if (!result.success) throw new Error(decodeBase64Text(result.stderrBase64) || "Could not read file");
      setContent(decodeBase64Text(result.stdoutBase64));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [path]);

  const transfer = useCallback(async (kind: "import" | "export") => {
    setError(null);
    setNotice(null);
    const chosen = await window.lamarckHost?.chooseVfsTransferPath(kind);
    if (!chosen?.path) return;
    const d1Path = window.prompt(
      kind === "import" ? "D1 destination path" : "D1 source path",
      path,
    );
    if (!d1Path) return;
    const command = kind === "import"
      ? `import -- ${quoteVfsWord(chosen.path)} ${quoteVfsWord(d1Path)}`
      : `export -- ${quoteVfsWord(d1Path)} ${quoteVfsWord(chosen.path)}`;
    const result = await vfsCommand(command);
    if (!result.success) throw new Error(decodeBase64Text(result.stderrBase64) || `${kind} failed`);
    setNotice(kind === "import" ? `Imported to ${d1Path}` : `Exported ${d1Path}`);
  }, [path]);

  const openFiles = useCallback(async (target: "finder" | "obsidian") => {
    setError(null);
    setNotice(null);
    try {
      await window.lamarckHost?.openWorkspaceFiles(target);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const excludeFocused = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      await addD1HistoryExclusion(path);
      setNotice(`${path} is excluded from future D0 history.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [path]);

  return (
    <div className={styles.filesPanel}>
      <section className={styles.filesRootCard}>
        <div className={styles.filesRootRail} aria-hidden="true"><i /><span>files/</span></div>
        <div>
          <span className={styles.filesEyebrow}>Workspace authority</span>
          <h2>Your files stay ordinary.</h2>
          <p>Browse and edit them in Finder or Obsidian. Lamarck observes the resulting changes.</p>
        </div>
        <div className={styles.fileActions}>
          <button type="button" onClick={() => void openFiles("finder")}>Open in Finder</button>
          <button type="button" onClick={() => void openFiles("obsidian")}>Open in Obsidian</button>
          <span />
          <button type="button" className={styles.quietAction} onClick={() => void transfer("import").catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))}>Import…</button>
          <button type="button" className={styles.quietAction} onClick={() => void transfer("export").catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))}>Export…</button>
        </div>
      </section>
      <section className={styles.markdownFocus}>
        <div className={styles.focusHeading}>
          <div><span>Focused Markdown</span><strong>Read a real D1 path</strong></div>
          {content !== null && <small>{new TextEncoder().encode(content).byteLength.toLocaleString()} bytes</small>}
        </div>
        <div className={styles.pathComposer}>
          <span>files/</span>
          <input
            aria-label="Markdown path"
            value={path}
            onChange={(event) => { setPath(event.target.value); setContent(null); setNotice(null); }}
            placeholder="notes/today.md"
            onKeyDown={(event) => { if (event.key === "Enter") void readMarkdown(); }}
          />
          <button type="button" disabled={busy || !path} onClick={() => void readMarkdown()}>{busy ? "Reading…" : "View file"}</button>
        </div>
        <div className={styles.focusTools}>
          <button
            type="button"
            disabled={content === null}
            onClick={() => void excludeFocused()}
          >
            Exclude from D0 history
          </button>
          <span>Stops future evidence for this exact path. It does not hide or lock the file.</span>
        </div>
        {error && <div className={styles.inspectorError}>{error}</div>}
        {notice && <div className={styles.inspectorNotice}>{notice}</div>}
        {content !== null
          ? <pre className={styles.markdownPreview}>{content}</pre>
          : <div className={styles.markdownEmpty}>Enter an explicit <code>.md</code> path to inspect its exact text.</div>}
      </section>
    </div>
  );
}

function SystemWorkspace({
  coreStatus,
  lamarckSession,
  identityBusy,
  onCoreChanged,
  onIdentitySignIn,
  onIdentitySignOut,
}: {
  coreStatus: "checking" | "connected" | "offline";
  lamarckSession: LamarckSessionView;
  identityBusy: boolean;
  onCoreChanged: () => void | Promise<void>;
  onIdentitySignIn: () => void;
  onIdentitySignOut: () => void;
}) {
  const signedIn = lamarckSession.status === "signed_in";
  return (
    <div className={styles.workspacePage}>
      <header className={styles.pageHeader}>
        <div><span className={styles.overline}>Local control plane</span><h1>Workspace</h1><p>Runtime recovery, workspace location, and Lamarck identity.</p></div>
      </header>
      <div className={styles.workspaceColumns}>
        <div className={styles.workspacePanelWrap}><WorkspacePanel coreStatus={coreStatus} onCoreChanged={onCoreChanged} /></div>
        <section className={styles.identityPanel}>
          <span className={styles.panelKicker}>Cloud identity</span>
          <div className={styles.identityStatus}><i className={signedIn ? styles.identityOnline : ""} /><span><strong>{signedIn ? "Signed in" : lamarckSession.status === "expired" ? "Session expired" : "Not signed in"}</strong><small>{signedIn ? lamarckSession.userId ?? "Lamarck account" : "Local use remains available."}</small></span></div>
          <button type="button" disabled={identityBusy} onClick={signedIn ? onIdentitySignOut : onIdentitySignIn}>{identityBusy ? "Working…" : signedIn ? "Sign out" : "Sign in"}</button>
          <p>Identity is separate from your local data and App permissions.</p>
        </section>
      </div>
      <HistoryExclusionSettings />
    </div>
  );
}

function HistoryExclusionSettings() {
  const [rules, setRules] = useState<D1HistoryExclusion[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const result = await listD1HistoryExclusions();
    setRules(result.exclusions);
  }, []);
  useEffect(() => {
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [refresh]);
  const add = useCallback(async () => {
    setError(null);
    try {
      await addD1HistoryExclusion(draft);
      setDraft("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [draft, refresh]);
  const remove = useCallback(async (rule: D1HistoryExclusion) => {
    await removeD1HistoryExclusion(`${rule.path}${rule.prefix ? "/" : ""}`);
    await refresh();
  }, [refresh]);

  return (
    <section className={`${styles.identityPanel} ${styles.historyPanel}`}>
      <span className={styles.panelKicker}>D1 history policy</span>
      <h2>Exclude from D0 history</h2>
      <p>Enter an exact file path, or end a directory path with <code>/</code> to create a prefix rule.</p>
      <div className={styles.ruleComposer}>
        <span>files/</span>
        <input aria-label="History exclusion path" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="private/" />
        <button type="button" disabled={!draft} onClick={() => void add()}>Add rule</button>
      </div>
      {error && <div className={styles.inspectorError}>{error}</div>}
      <div className={`${styles.dataList} ${styles.ruleList}`}>
        {rules.length === 0 ? <span className={styles.ruleEmpty}>No paths are excluded.</span> : rules.map((rule) => (
          <button type="button" key={`${rule.path}:${rule.prefix}`} onClick={() => void remove(rule)}>
            <span><strong>{rule.path}{rule.prefix ? "/" : ""}</strong><small>{rule.prefix ? "Prefix" : "Exact path"}</small></span>
            <b>Remove</b>
          </button>
        ))}
      </div>
    </section>
  );
}

function sourceNeedsAttention(sourceRecord: ConnectorSourceView): boolean {
  return sourceRecord.status === "error"
    || sourceRecord.setupStatus === "setup"
    || sourceRecord.setupPending.length > 0
    || sourceRecord.ownership === "device-unknown"
    || sourceRecord.identityStatus === "conflict"
    || sourceRecord.identityStatus === "changed"
    || sourceRecord.identityStatus === "error"
    || Boolean(sourceRecord.authAttention)
    || Boolean(sourceRecord.warnings?.length);
}

function sourceAttentionText(sourceRecord: ConnectorSourceView): string {
  if (sourceRecord.ownership === "device-unknown") {
    return sourceRecord.ownershipReason ?? "This device cannot be identified";
  }
  if (sourceRecord.identityStatus === "conflict") return "Source identity already belongs to another Source";
  if (sourceRecord.identityStatus === "changed") return "Connected account no longer matches this Source";
  if (sourceRecord.identityStatus === "error") return sourceRecord.lastError ?? "Source identity could not be resolved";
  if (sourceRecord.identityStatus === "unresolved") return "Source identity has not been resolved";
  if (sourceRecord.status === "error") return sourceRecord.lastError ?? "Runtime error";
  if (sourceRecord.authAttention) return "Authentication needs attention";
  if (sourceRecord.setupPending.length > 0) return `Setup pending: ${sourceRecord.setupPending.join(", ")}`;
  if (sourceRecord.warnings?.length) return sourceRecord.warnings[0].message;
  return "Review Source state";
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value > 999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function quoteVfsWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function decodeBase64Text(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function relativeTime(epoch: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - epoch) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function icon(paths: ReactElement) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths}</svg>;
}

function BackIcon() { return icon(<path d="m14.5 6-6 6 6 6M9 12h10" />); }
function RefreshIcon() { return icon(<><path d="M19 8a7.5 7.5 0 1 0 .2 7.6" /><path d="M19 3v5h-5" /></>); }
function SystemIcon() { return icon(<><path d="M12 3.5 19 7.6v8.8l-7 4.1-7-4.1V7.6l7-4.1Z" /><circle cx="12" cy="12" r="2.6" /><path d="M12 3.8V9.4M5.2 7.8l4.4 2.7M18.8 7.8l-4.4 2.7M12 14.6v5.6" /></>); }
function ShapeIcon() { return icon(<><circle cx="6" cy="6" r="2.3" /><circle cx="18" cy="7" r="2.3" /><circle cx="12" cy="18" r="2.3" /><path d="m8 7 7.8-.2M7.5 8l3.4 7.8M16.5 9l-3.2 6.8" /></>); }
function SourcesIcon() { return icon(<><path d="M8 4v5M16 4v5M6 9h12v3a6 6 0 0 1-12 0V9Z" /><path d="M12 18v3" /></>); }
function AppsIcon() { return icon(<><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>); }
function DataIcon() { return icon(<><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>); }
function TimelineIcon() { return icon(<><path d="M5 4v16" /><circle cx="5" cy="8" r="2" /><circle cx="5" cy="16" r="2" /><path d="M9 8h10M9 16h7" /></>); }
function WorkspaceIcon() { return icon(<><path d="M4 7.5h6l1.5-2H20v13H4v-11Z" /><path d="M4 9h16" /></>); }
function TableIcon() { return icon(<><rect x="3.5" y="4" width="17" height="16" rx="1" /><path d="M3.5 9h17M9 9v11M15 9v11" /></>); }
