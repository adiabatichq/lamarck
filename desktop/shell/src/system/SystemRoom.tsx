import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { AppMark } from "../components/AppMark";
import { WorkspacePanel } from "../components/WorkspacePanel";
import { ActivityView } from "../content/ActivityView";
import { ConnectorCatalogView } from "../content/ConnectorCatalogView";
import { ConnectorsView } from "../content/ConnectorsView";
import { TableView } from "../content/TableView";
import { appWorkloads } from "../lib/app-visual";
import {
  getDoc,
  inspectDataSchema,
  listConnectors,
  listDocs,
  query,
  type AppInfo,
  type ConnectorIntegrationView,
  type DataSchemaSnapshot,
  type Doc,
  type InstalledConnectorView,
  type LamarckSessionView,
} from "../lib/api";
import styles from "./SystemRoom.module.css";

type SystemSection = "shape" | "sources" | "apps" | "data" | "timeline" | "workspace";

interface RecentEvent {
  id: string;
  source: string;
  type: string;
  started_at: number;
}

interface SystemSnapshot {
  sources: ConnectorIntegrationView[];
  packages: InstalledConnectorView[];
  docs: Doc[];
  tables: DataSchemaSnapshot["tables"];
  eventCount: number;
  recentEvents: RecentEvent[];
}

const EMPTY_SNAPSHOT: SystemSnapshot = {
  sources: [],
  packages: [],
  docs: [],
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
  const [showConnectorCatalog, setShowConnectorCatalog] = useState(false);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (coreStatus !== "connected") return;
    setRefreshing(true);
    const results = await Promise.allSettled([
      listConnectors(),
      listDocs(),
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
      const docs = results[1].status === "fulfilled" ? results[1].value.rows : current.docs;
      const schema = results[2].status === "fulfilled" ? results[2].value : null;
      const countResult = results[3].status === "fulfilled" ? results[3].value.rows[0] as { count?: number } : null;
      const eventRows = results[4].status === "fulfilled" ? results[4].value.rows as RecentEvent[] : current.recentEvents;
      return {
        sources: connectors?.sources ?? current.sources,
        packages: connectors?.packages ?? current.packages,
        docs,
        tables: schema
          ? schema.tables.filter((table) => table.name !== "docs" && table.name !== "events")
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
    setShowConnectorCatalog(false);
    setSelectedTable(null);
    setSelectedDocId(null);
    if (section !== "timeline") setSelectedEventId(null);
  }, [section]);

  const attentionCount = useMemo(() => {
    const sourceAttention = snapshot.sources.filter(sourceNeedsAttention).length;
    return sourceAttention + (schemaRequestPending ? 1 : 0) + (coreStatus === "offline" ? 1 : 0);
  }, [coreStatus, schemaRequestPending, snapshot.sources]);

  const openDocument = useCallback((docId: string) => {
    setSection("data");
    setSelectedTable(null);
    setSelectedDocId(docId);
  }, []);

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
            {showConnectorCatalog ? (
              <div className={styles.catalogSurface}>
                <button type="button" className={styles.surfaceBack} onClick={() => setShowConnectorCatalog(false)}>
                  <BackIcon /> Source console
                </button>
                <div className={styles.surfaceFill}>
                  <ConnectorCatalogView onOpenConsole={() => setShowConnectorCatalog(false)} />
                </div>
              </div>
            ) : (
              <ConnectorsView onOpenCatalog={() => setShowConnectorCatalog(true)} />
            )}
          </div>
        )}
        {section === "apps" && (
          <SystemApps apps={apps} onOpenApp={onOpenApp} />
        )}
        {section === "data" && (
          <SystemData
            docs={snapshot.docs}
            tables={snapshot.tables}
            selectedTable={selectedTable}
            selectedDocId={selectedDocId}
            onSelectTable={(name) => {
              setSelectedDocId(null);
              setSelectedTable(name);
            }}
            onSelectDoc={(id) => {
              setSelectedTable(null);
              setSelectedDocId(id);
            }}
            onCloseInspector={() => {
              setSelectedDocId(null);
              setSelectedTable(null);
            }}
          />
        )}
        {section === "timeline" && (
          <div className={styles.fullSurface}>
            <ActivityView key={coreStatus} initialEventId={selectedEventId} onOpenDoc={openDocument} />
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
  const uiApps = apps.filter((app) => Boolean(app.runtime.ui)).length;
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
        <Signal label="Documents" value={snapshot.docs.length} detail="D1 durable objects" tone="neutral" onClick={() => onNavigate("data")} />
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
          <button type="button" className={`${styles.shapeNode} ${styles.documentNode}`} onClick={() => onNavigate("data")}>
            <span>D1 · Durable</span><strong>Documents</strong><i>{snapshot.docs.length}</i>
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
              {sourceAttention.slice(0, 4).map((source) => (
                <AttentionItem key={source.id} title={source.name} detail={sourceAttentionText(source)} onClick={() => onNavigate("sources")} />
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
  value: number;
  detail: string;
  tone: "mint" | "cyan" | "amber" | "neutral";
  onClick: () => void;
}) {
  return (
    <button type="button" className={`${styles.signal} ${styles[`signal_${tone}`]}`} onClick={onClick}>
      <span>{label}</span>
      <strong>{formatCompact(value)}</strong>
      <i>{detail}</i>
      <b aria-hidden="true">↗</b>
    </button>
  );
}

function AttentionItem({ title, detail, onClick }: { title: string; detail: string; onClick: () => void }) {
  return <button type="button" onClick={onClick}><i>!</i><span><strong>{title}</strong><small>{detail}</small></span><b>→</b></button>;
}

function SystemApps({ apps, onOpenApp }: { apps: AppInfo[]; onOpenApp: (appId: string) => void }) {
  return (
    <div className={styles.inventoryPage}>
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.overline}>Installed system shape</span>
          <h1>Apps</h1>
          <p>Every registered App, including background workloads that do not appear in Use.</p>
        </div>
        <span className={styles.inventoryCount}>{apps.length.toString().padStart(2, "0")}</span>
      </header>
      <div className={styles.inventoryTable}>
        <div className={styles.inventoryHeader}><span>App</span><span>Workloads</span><span>Data grants</span><span>Use</span></div>
        {apps.length === 0 ? (
          <div className={styles.inventoryEmpty}>No registered Apps in this workspace.</div>
        ) : apps.map((app, index) => (
          <div key={app.id} className={styles.inventoryRow} style={{ animationDelay: `${index * 24}ms` }}>
            <div className={styles.inventoryIdentity}>
              <AppMark appId={app.id} name={app.name} size="medium" />
              <span><strong>{app.name}</strong><small>{app.id}</small></span>
            </div>
            <div className={styles.badges}>{appWorkloads(app).map((workload) => <span key={workload}>{workload}</span>)}</div>
            <div className={styles.grants}>
              <span><b>{app.permissions.writes.docs.length}</b> docs</span>
              <span><b>{app.permissions.writes.tables.length}</b> tables</span>
            </div>
            <div>
              {app.runtime.ui ? (
                <button type="button" className={styles.openApp} onClick={() => onOpenApp(app.id)}>Open <span>↗</span></button>
              ) : <span className={styles.headless}>Background only</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SystemData({
  docs,
  tables,
  selectedTable,
  selectedDocId,
  onSelectTable,
  onSelectDoc,
  onCloseInspector,
}: {
  docs: Doc[];
  tables: DataSchemaSnapshot["tables"];
  selectedTable: string | null;
  selectedDocId: string | null;
  onSelectTable: (name: string) => void;
  onSelectDoc: (id: string) => void;
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
  if (selectedDocId) {
    return <DocumentInspector docId={selectedDocId} onBack={onCloseInspector} />;
  }

  return (
    <div className={styles.dataPage}>
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.overline}>Durable substrate</span>
          <h1>Data</h1>
          <p>Raw inspection of Documents and promoted Tables. Daily discovery belongs to Apps.</p>
        </div>
      </header>
      <div className={styles.dataColumns}>
        <section className={styles.dataLedger}>
          <div className={styles.panelHeading}><div><span>D1</span><strong>Documents</strong></div><b>{docs.length}</b></div>
          <div className={styles.dataList}>
            {docs.length === 0 ? <div className={styles.inventoryEmpty}>No Documents.</div> : docs.map((doc) => (
              <button type="button" key={doc.id} onClick={() => onSelectDoc(doc.id)}>
                <DocumentIcon /><span><strong>{doc.id}</strong><small>Updated {formatDate(doc.updated_at)}</small></span><b>→</b>
              </button>
            ))}
          </div>
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

function DocumentInspector({ docId, onBack }: { docId: string; onBack: () => void }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    void getDoc(docId).then((result) => {
      if (!cancelled) setDoc(result);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [docId]);
  return (
    <div className={styles.documentInspector}>
      <button type="button" className={styles.surfaceBack} onClick={onBack}><BackIcon /> Data</button>
      <header><span>D1 / Document</span><h1>{docId}</h1>{doc && <p>Updated {formatDate(doc.updated_at)} · created {formatDate(doc.created_at)}</p>}</header>
      {error ? <div className={styles.inspectorError}>{error}</div> : doc ? (
        <div className={styles.documentBody}>
          <section><span>Content</span><pre>{doc.content}</pre></section>
          <section><span>Metadata</span><pre>{JSON.stringify(doc.metadata ?? {}, null, 2)}</pre></section>
        </div>
      ) : <div className={styles.inspectorLoading}>Reading Document…</div>}
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
    </div>
  );
}

function sourceNeedsAttention(source: ConnectorIntegrationView): boolean {
  return source.status === "error"
    || source.setupStatus === "setup"
    || source.setupPending.length > 0
    || Boolean(source.authAttention)
    || Boolean(source.warnings?.length);
}

function sourceAttentionText(source: ConnectorIntegrationView): string {
  if (source.status === "error") return source.lastError ?? "Runtime error";
  if (source.authAttention) return "Authentication needs attention";
  if (source.setupPending.length > 0) return `Setup pending: ${source.setupPending.join(", ")}`;
  if (source.warnings?.length) return source.warnings[0].message;
  return "Review Source state";
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value > 999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
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
function DocumentIcon() { return icon(<><path d="M6 3h8l4 4v14H6V3Z" /><path d="M14 3v5h4M9 12h6M9 16h6" /></>); }
function TableIcon() { return icon(<><rect x="3.5" y="4" width="17" height="16" rx="1" /><path d="M3.5 9h17M9 9v11M15 9v11" /></>); }
