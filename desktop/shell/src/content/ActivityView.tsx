// ActivityView — full-page timeline of D0 events with diff view for doc writes.

import { useState, useEffect, useCallback, useRef, type FormEvent } from "react";
import * as api from "../lib/api";
import styles from "./ActivityView.module.css";

interface EventRow {
  id: string;
  schema_version: string;
  source: string;
  producer_ref: string;
  type: string;
  external_id: string | null;
  started_at: number;
  ended_at: number | null;
  payload: string;
  created_at: number;
}

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

// Simple line-level diff: returns array of { type: "same"|"add"|"del", text }
interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

function computeDiff(before: string, after: string): DiffLine[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");

  // LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "same", text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "add", text: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: "del", text: oldLines[i - 1] });
      i--;
    }
  }

  return result.reverse();
}

function parsePayload(payload: string): JsonValue {
  try { return JSON.parse(payload) as JsonValue; } catch { return payload; }
}

function formatRawEvent(event: EventRow): string {
  return JSON.stringify({
    ...event,
    payload: parsePayload(event.payload),
  }, null, 2);
}

function typeColor(type: string): string {
  if (type.includes("write") || type.includes("insert")) return "#007acc";
  if (type.includes("delete") || type.includes("demote")) return "#e06c75";
  if (type.includes("promote") || type.includes("create")) return "#98c379";
  if (type.includes("update")) return "#d19a66";
  return "#999";
}

const CONTEXT_LINES = 3;
const EVENT_PAGE_SIZE = 200;

interface EventCursor {
  startedAt: number;
  id: string;
}

interface EventFilters {
  query: string;
  source: string;
  type: string;
  range: "" | "24h" | "7d" | "30d";
}

const EMPTY_FILTERS: EventFilters = { query: "", source: "", type: "", range: "" };

// Filter diff to only show changed lines ± context, with separators
function withContext(lines: DiffLine[]): (DiffLine | "sep")[] {
  const changed = new Set<number>();
  lines.forEach((line, i) => {
    if (line.type !== "same") changed.add(i);
  });

  // Mark lines within context range of a change
  const visible = new Set<number>();
  for (const idx of changed) {
    for (let j = Math.max(0, idx - CONTEXT_LINES); j <= Math.min(lines.length - 1, idx + CONTEXT_LINES); j++) {
      visible.add(j);
    }
  }

  const result: (DiffLine | "sep")[] = [];
  let lastShown = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!visible.has(i)) continue;
    if (lastShown !== -1 && i - lastShown > 1) result.push("sep");
    result.push(lines[i]);
    lastShown = i;
  }
  return result;
}

// Compute line numbers for old/new sides
function lineNumbers(lines: DiffLine[]): { oldNum: number | null; newNum: number | null }[] {
  let oldLine = 1, newLine = 1;
  return lines.map((line) => {
    if (line.type === "same") return { oldNum: oldLine++, newNum: newLine++ };
    if (line.type === "del") return { oldNum: oldLine++, newNum: null };
    return { oldNum: null, newNum: newLine++ };
  });
}

function DiffBlock({ before, after }: { before: string | null; after: string }) {
  if (before === null) {
    // New doc — show first few lines as additions
    const lines = after.split("\n");
    const shown = lines.slice(0, 10);
    return (
      <div className={styles.diffBlock}>
        {shown.map((line, i) => (
          <div key={i} className={styles.diffAdd}>
            <span className={styles.diffLineNum}>{i + 1}</span>
            <span className={styles.diffSign}>+</span>
            <span>{line || "\u00A0"}</span>
          </div>
        ))}
        {lines.length > 10 && (
          <div className={styles.diffSep}>··· {lines.length - 10} more lines</div>
        )}
      </div>
    );
  }

  if (before === after) {
    return <div className={styles.diffEmpty}>No changes</div>;
  }

  const allLines = computeDiff(before, after);
  const nums = lineNumbers(allLines);
  const filtered = withContext(allLines);

  // Map filtered back to line numbers
  let allIdx = 0;
  return (
    <div className={styles.diffBlock}>
      {filtered.map((item, i) => {
        if (item === "sep") {
          return <div key={`sep-${i}`} className={styles.diffSep}>···</div>;
        }
        // Find this line's index in allLines to get line numbers
        while (allIdx < allLines.length && allLines[allIdx] !== item) allIdx++;
        const num = nums[allIdx] || { oldNum: null, newNum: null };
        allIdx++;
        return (
          <div
            key={i}
            className={
              item.type === "add" ? styles.diffAdd :
              item.type === "del" ? styles.diffDel :
              styles.diffSame
            }
          >
            <span className={styles.diffLineNum}>
              {item.type === "del" ? (num.oldNum ?? "") : (num.newNum ?? "")}
            </span>
            <span className={styles.diffSign}>
              {item.type === "add" ? "+" : item.type === "del" ? "-" : " "}
            </span>
            <span>{item.text || "\u00A0"}</span>
          </div>
        );
      })}
    </div>
  );
}

function PatchBlock({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <div className={styles.diffBlock}>
      {lines.map((line, i) => {
        const className =
          line.startsWith("@@") ? styles.diffSep :
          line.startsWith("+") && !line.startsWith("+++") ? styles.diffAdd :
          line.startsWith("-") && !line.startsWith("---") ? styles.diffDel :
          styles.diffSame;
        return (
          <div key={i} className={className}>
            <span className={styles.diffSign}>
              {line.startsWith("@@") ? "@" : line[0] === "+" || line[0] === "-" ? line[0] : " "}
            </span>
            <span>{line || "\u00A0"}</span>
          </div>
        );
      })}
    </div>
  );
}

function PayloadDetail({ type, payload, onOpenDoc }: { type: string; payload: JsonValue; onOpenDoc?: (docId: string) => void }) {
  if (!isJsonObject(payload)) {
    return <pre className={styles.sqlBlock}>{JSON.stringify(payload, null, 2)}</pre>;
  }

  // d1.write — new events store a git-style patch.
  if (type === "d1.write" && typeof payload.patch === "string") {
    const docId = payload.doc_id as string;
    return (
      <div>
        <div className={styles.detailMeta}>
          <span
            className={onOpenDoc ? styles.docLink : undefined}
            onClick={onOpenDoc ? (e) => { e.stopPropagation(); onOpenDoc(docId); } : undefined}
          >
            {docId}
          </span>
          <span>{payload.bytes as number} bytes</span>
        </div>
        <PatchBlock patch={payload.patch} />
      </div>
    );
  }

  // d1.write / d1.delete — show diff
  if ((type === "d1.write" || type === "d1.delete") && ("before" in payload || "after" in payload || "content" in payload)) {
    const before = (payload.before ?? (type === "d1.delete" ? payload.content : null)) as string | null;
    const after = (payload.after ?? (type === "d1.delete" ? "" : payload.content ?? "")) as string;
    const docId = payload.doc_id as string;
    return (
      <div>
        <div className={styles.detailMeta}>
          <span
            className={onOpenDoc ? styles.docLink : undefined}
            onClick={onOpenDoc ? (e) => { e.stopPropagation(); onOpenDoc(docId); } : undefined}
          >
            {docId}
          </span>
          <span>{payload.bytes as number} bytes</span>
        </div>
        <DiffBlock before={before} after={after} />
      </div>
    );
  }

  // d2 / ddl — show SQL + params
  if (payload.sql) {
    return (
      <div>
        {typeof payload.table === "string" && (
          <div className={styles.detailMeta}>
            <span>table: {payload.table}</span>
          </div>
        )}
        <pre className={styles.sqlBlock}>{payload.sql as string}</pre>
        {Array.isArray(payload.params) && payload.params.length > 0 && (
          <div className={styles.paramsList}>
            params: [{payload.params.map((p: unknown) => JSON.stringify(p)).join(", ")}]
          </div>
        )}
      </div>
    );
  }

  // Generic fallback — key-value table
  return (
    <table className={styles.payloadTable}>
      <tbody>
        {Object.entries(payload).map(([k, v]) => (
          <tr key={k}>
            <td className={styles.detailKey}>{k}</td>
            <td className={styles.detailVal}>
              {typeof v === "object" ? JSON.stringify(v, null, 2) : String(v ?? "null")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface ActivityViewProps {
  onOpenDoc?: (docId: string) => void;
  initialEventId?: string | null;
}

export function ActivityView({ onOpenDoc, initialEventId = null }: ActivityViewProps) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterDraft, setFilterDraft] = useState<EventFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<EventFilters>(EMPTY_FILTERS);
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);
  const [typeOptions, setTypeOptions] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const fetchPage = useCallback(async (cursor?: EventCursor): Promise<{ rows: EventRow[]; hasMore: boolean }> => {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    const textQuery = filters.query.trim();

    if (textQuery) {
      const needle = `%${textQuery}%`;
      clauses.push("(id LIKE ? OR source LIKE ? OR type LIKE ? OR payload LIKE ?)");
      params.push(needle, needle, needle, needle);
    }
    if (filters.source) {
      clauses.push("source = ?");
      params.push(filters.source);
    }
    if (filters.type) {
      clauses.push("type = ?");
      params.push(filters.type);
    }
    if (filters.range) {
      const rangeMs = filters.range === "24h"
        ? 24 * 60 * 60 * 1_000
        : filters.range === "7d"
          ? 7 * 24 * 60 * 60 * 1_000
          : 30 * 24 * 60 * 60 * 1_000;
      clauses.push("started_at >= ?");
      params.push(Date.now() - rangeMs);
    }
    if (cursor) {
      clauses.push("(started_at < ? OR (started_at = ? AND id < ?))");
      params.push(cursor.startedAt, cursor.startedAt, cursor.id);
    }

    params.push(EVENT_PAGE_SIZE + 1);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await api.query(
      `SELECT id, schema_version, source, producer_ref, type, external_id, started_at, ended_at, payload, created_at
       FROM events
       ${where}
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
      params,
    );
    const rows = result.rows as EventRow[];
    return {
      rows: rows.slice(0, EVENT_PAGE_SIZE),
      hasMore: rows.length > EVENT_PAGE_SIZE,
    };
  }, [filters]);

  const refreshFilterOptions = useCallback(async () => {
    try {
      const [sources, types] = await Promise.all([
        api.query("SELECT DISTINCT source FROM events WHERE source <> '' ORDER BY source"),
        api.query("SELECT DISTINCT type FROM events WHERE type <> '' ORDER BY type"),
      ]);
      setSourceOptions(sources.rows
        .map((row) => (row as { source?: unknown }).source)
        .filter((source): source is string => typeof source === "string"));
      setTypeOptions(types.rows
        .map((row) => (row as { type?: unknown }).type)
        .filter((type): type is string => typeof type === "string"));
    } catch {
      // Event loading reports runtime failures. Missing facets should not hide raw rows.
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage();
      setEvents(page.rows);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (loadingMore || loading || !hasMore || events.length === 0) return;
    const last = events[events.length - 1];
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchPage({ startedAt: last.started_at, id: last.id });
      setEvents((prev) => {
        const seen = new Set(prev.map((event) => event.id));
        return [...prev, ...page.rows.filter((event) => !seen.has(event.id))];
      });
      setHasMore(page.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [events, fetchPage, hasMore, loading, loadingMore]);

  useEffect(() => {
    void refresh();
    void refreshFilterOptions();
  }, [refresh, refreshFilterOptions]);

  useEffect(() => {
    if (initialEventId && events.some((event) => event.id === initialEventId)) {
      setExpandedId(initialEventId);
    }
  }, [events, initialEventId]);

  useEffect(() => {
    const root = listRef.current;
    const target = loadMoreRef.current;
    if (!root || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { root, rootMargin: "320px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMore]);

  function formatTime(epoch: number): string {
    return new Date(epoch).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function relativeTime(epoch: number): string {
    const diff = Math.floor((Date.now() - epoch) / 1000);
    if (diff < 5) return "just now";
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function previewText(type: string, payload: JsonValue): string {
    if (!isJsonObject(payload)) return "";
    if (payload.doc_id) return `${payload.doc_id}`;
    if (payload.table) return `${payload.table}`;
    return "";
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setExpandedId(null);
    setFilters({
      query: filterDraft.query.trim(),
      source: filterDraft.source,
      type: filterDraft.type,
      range: filterDraft.range,
    });
  }

  function clearFilters() {
    setExpandedId(null);
    setFilterDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  }

  const filtersActive = Boolean(filters.query || filters.source || filters.type || filters.range);

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <span className={styles.title}>Timeline</span>
        <span className={styles.meta}>
          {loading ? "Querying events" : `${events.length} events loaded${hasMore ? " · scroll for more" : ""}`}
        </span>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => {
            void refresh();
            void refreshFilterOptions();
          }}
          title="Refresh"
          aria-label="Refresh events"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.527 1.225.527 1.924a4.008 4.008 0 0 1-4.5 3.969l.008-.047L6.3 13.499l.093.009A5.993 5.993 0 0 0 14.255 7.5a5.965 5.965 0 0 0-.804-1.891zM8 2.5a5.981 5.981 0 0 0-4.255 1.778l-.451-.312.579.939.804 1.891 1.068-.812.076-.094A4.007 4.007 0 0 1 10.5 4.031l-.008.047L11.7 2.501l-.093-.009A5.961 5.961 0 0 0 8 2.5z" />
          </svg>
        </button>
      </div>
      <form className={styles.filters} onSubmit={applyFilters}>
        <label className={styles.filterField}>
          <span>Query</span>
          <input
            type="search"
            value={filterDraft.query}
            onChange={(event) => setFilterDraft((current) => ({ ...current, query: event.target.value }))}
            placeholder="id, source, type, or raw payload"
            aria-label="Query events"
          />
        </label>
        <label className={styles.filterField}>
          <span>Source</span>
          <select
            value={filterDraft.source}
            onChange={(event) => setFilterDraft((current) => ({ ...current, source: event.target.value }))}
            aria-label="Filter by source"
          >
            <option value="">All sources</option>
            {sourceOptions.map((source) => <option key={source} value={source}>{source}</option>)}
          </select>
        </label>
        <label className={styles.filterField}>
          <span>Type</span>
          <select
            value={filterDraft.type}
            onChange={(event) => setFilterDraft((current) => ({ ...current, type: event.target.value }))}
            aria-label="Filter by event type"
          >
            <option value="">All types</option>
            {typeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label className={styles.filterField}>
          <span>When</span>
          <select
            value={filterDraft.range}
            onChange={(event) => setFilterDraft((current) => ({
              ...current,
              range: event.target.value as EventFilters["range"],
            }))}
            aria-label="Filter by event time"
          >
            <option value="">Any time</option>
            <option value="24h">Past 24 hours</option>
            <option value="7d">Past 7 days</option>
            <option value="30d">Past 30 days</option>
          </select>
        </label>
        <div className={styles.filterActions}>
          <button type="submit" className={styles.queryButton}>Run query</button>
          {filtersActive && <button type="button" className={styles.clearButton} onClick={clearFilters}>Clear</button>}
        </div>
      </form>
      <div className={styles.list} ref={listRef}>
        {error && <div className={styles.error}>{error}</div>}
        {events.length === 0 ? (
          <div className={styles.empty}>{loading ? "Querying raw events…" : filtersActive ? "No events match this query." : "No activity recorded yet."}</div>
        ) : (
          <>
            {events.map((evt) => {
              const isOpen = expandedId === evt.id;
              const payload = parsePayload(evt.payload);
              const preview = previewText(evt.type, payload);
              return (
                <div
                  key={evt.id}
                  className={`${styles.event} ${isOpen ? styles.eventOpen : ""}`}
                >
                  <button
                    type="button"
                    className={styles.eventRow}
                    onClick={() => setExpandedId(isOpen ? null : evt.id)}
                    aria-expanded={isOpen}
                  >
                    <span className={styles.dot} style={{ background: typeColor(evt.type) }} />
                    <span className={styles.eventType}>{evt.type}</span>
                    {preview && <span className={styles.eventTarget}>{preview}</span>}
                    <span className={styles.eventSource}>{evt.source}</span>
                    <span className={styles.eventTime} title={formatTime(evt.started_at)}>
                      {relativeTime(evt.started_at)}
                    </span>
                  </button>
                  {isOpen && (
                    <div className={styles.detail}>
                      <div className={styles.detailHeader}>
                        <span>{evt.id}</span>
                        <span>{formatTime(evt.started_at)}</span>
                      </div>
                      <PayloadDetail type={evt.type} payload={payload} onOpenDoc={onOpenDoc} />
                      <details className={styles.rawEvent} onClick={(event) => event.stopPropagation()}>
                        <summary>Raw event</summary>
                        <pre>{formatRawEvent(evt)}</pre>
                      </details>
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={loadMoreRef} className={styles.loadMore}>
              {loadingMore ? "Loading more..." : hasMore ? "Scroll to load more" : "End of activity log"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
