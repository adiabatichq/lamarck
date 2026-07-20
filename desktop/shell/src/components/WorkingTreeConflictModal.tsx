import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getWorkingTreeConflict,
  listWorkingTreeConflicts,
  resolveWorkingTreeConflict,
  type WorkingTreeConflict,
  type WorkingTreeConflictResolution,
  type WorkingTreeConflictSide,
  type WorkingTreeConflictSummary,
} from "../lib/api";
import styles from "./WorkingTreeConflictModal.module.css";

const POLL_INTERVAL_MS = 1_500;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PORTABLE_PATH_CHARS = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

interface WorkingTreeConflictModalProps {
  connected: boolean;
  paused?: boolean;
  onVisibilityChange?: (visible: boolean) => void;
}

function conflictKey(conflict: Pick<WorkingTreeConflictSummary, "docId" | "expectedVersion">): string {
  return `${conflict.docId}\u0000${conflict.expectedVersion}`;
}

function deriveLocalCopyId(docId: string): string {
  const separator = docId.lastIndexOf("/");
  const folder = separator === -1 ? "" : docId.slice(0, separator + 1);
  const name = separator === -1 ? docId : docId.slice(separator + 1);
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
  return `${folder}${name}-local-${stamp}`;
}

function validateNewDocId(value: string, originalId: string): string | null {
  if (!value || value.trim() !== value) return "Enter a document ID without surrounding spaces.";
  if (value === originalId) return "The local copy needs a different document ID.";
  if (value.startsWith("/") || value.includes("\\") || CONTROL_CHARS.test(value)) {
    return "Use a relative document ID with forward slashes.";
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return "Document ID path segments cannot be empty, . or ...";
  }
  if (
    new TextEncoder().encode(value).byteLength > 768
    || parts.some((part) =>
      PORTABLE_PATH_CHARS.test(part)
      || part.endsWith(" ")
      || part.endsWith(".")
      || WINDOWS_RESERVED_NAME.test(part)
      || new TextEncoder().encode(part).byteLength > 240
    )
  ) {
    return "Use a portable file name without reserved characters or overlong segments.";
  }
  return null;
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 10) : "no hash";
}

function ConflictSide({
  label,
  detail,
}: {
  label: string;
  detail: WorkingTreeConflictSide;
}) {
  return (
    <section className={styles.side}>
      <header className={styles.sideHeader}>
        <span>{label}</span>
        <span className={detail.exists ? styles.present : styles.deleted}>
          {detail.error
            ? "Unreadable or unsafe"
            : detail.exists ? `Present · ${shortHash(detail.hash)}` : "Deleted"}
        </span>
      </header>
      {detail.error ? (
        <div className={styles.missing}>
          <span aria-hidden="true">!</span>
          {detail.error}
        </div>
      ) : detail.exists ? (
        <pre className={styles.content}>{detail.content ?? ""}</pre>
      ) : (
        <div className={styles.missing}>
          <span aria-hidden="true">∅</span>
          This side deleted the document.
        </div>
      )}
    </section>
  );
}

export function WorkingTreeConflictModal({
  connected,
  paused = false,
  onVisibilityChange,
}: WorkingTreeConflictModalProps) {
  const [conflicts, setConflicts] = useState<WorkingTreeConflictSummary[]>([]);
  const [detail, setDetail] = useState<WorkingTreeConflict | null>(null);
  const [snoozed, setSnoozed] = useState<Set<string>>(() => new Set());
  const [newId, setNewId] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const conflictRequest = useRef(0);
  const detailRequest = useRef(0);

  const refreshConflicts = useCallback(async () => {
    if (!connected || paused) return;
    const request = ++conflictRequest.current;
    try {
      const result = await listWorkingTreeConflicts();
      if (request !== conflictRequest.current) return;
      setConflicts(result.conflicts);
      setPollError(null);

      const liveKeys = new Set(result.conflicts.map(conflictKey));
      setSnoozed((current) => {
        const next = new Set([...current].filter((key) => liveKeys.has(key)));
        if (next.size === current.size && [...next].every((key) => current.has(key))) {
          return current;
        }
        return next;
      });
    } catch (error) {
      if (request !== conflictRequest.current) return;
      setPollError(`Could not refresh Working Tree conflicts: ${errorMessage(error)}`);
    }
  }, [connected, paused]);

  useEffect(() => {
    if (!connected) {
      conflictRequest.current++;
      detailRequest.current++;
      setConflicts([]);
      setDetail(null);
      setPollError(null);
      setActionError(null);
      return;
    }
    if (paused) {
      conflictRequest.current++;
      detailRequest.current++;
      return;
    }

    void refreshConflicts();
    const timer = window.setInterval(() => void refreshConflicts(), POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      conflictRequest.current++;
    };
  }, [connected, paused, refreshConflicts]);

  const pending = useMemo(
    () => conflicts.filter((conflict) => !snoozed.has(conflictKey(conflict))),
    [conflicts, snoozed],
  );
  const active = pending[0] ?? null;
  const activeKey = active ? conflictKey(active) : null;

  useEffect(() => {
    onVisibilityChange?.(Boolean(connected && !paused && active));
    return () => onVisibilityChange?.(false);
  }, [active, connected, onVisibilityChange, paused]);

  useEffect(() => {
    setDetail(null);
    setActionError(null);
    setNewId(active ? deriveLocalCopyId(active.docId) : "");

    if (!active || !connected || paused) {
      setLoadingDetail(false);
      detailRequest.current++;
      return;
    }

    const request = ++detailRequest.current;
    setLoadingDetail(true);
    void getWorkingTreeConflict(active.docId).then(({ conflict }) => {
      if (request !== detailRequest.current) return;
      if (conflict.expectedVersion !== active.expectedVersion) {
        setDetail(null);
        void refreshConflicts();
        return;
      }
      setDetail(conflict);
    }).catch((error) => {
      if (request !== detailRequest.current) return;
      if (errorStatus(error) === 404 || errorStatus(error) === 409) {
        void refreshConflicts();
        return;
      }
      setActionError(`Could not load this conflict: ${errorMessage(error)}`);
    }).finally(() => {
      if (request === detailRequest.current) setLoadingDetail(false);
    });

    return () => {
      detailRequest.current++;
    };
  }, [activeKey, connected, paused, refreshConflicts]);

  const bothSidesExist = detail?.database.exists === true && detail.file.exists === true;
  const newIdError = active && bothSidesExist ? validateNewDocId(newId, active.docId) : null;

  const resolve = useCallback(async (resolution: WorkingTreeConflictResolution) => {
    if (!active || !detail || busy) return;
    if (resolution === "keep-both" && (!bothSidesExist || newIdError)) return;

    setBusy(true);
    setActionError(null);
    try {
      await resolveWorkingTreeConflict(active.docId, {
        resolution,
        expectedVersion: active.expectedVersion,
        ...(resolution === "keep-both" ? { newId } : {}),
      });
      setDetail(null);
      await refreshConflicts();
    } catch (error) {
      if (errorStatus(error) === 409) {
        setDetail(null);
        setActionError("This document changed again. The comparison has been refreshed.");
        await refreshConflicts();
      } else {
        setActionError(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }, [active, bothSidesExist, busy, detail, newId, newIdError, refreshConflicts]);

  const resolveLater = useCallback(() => {
    if (!active) return;
    setSnoozed((current) => new Set(current).add(conflictKey(active)));
    setDetail(null);
    setActionError(null);
  }, [active]);

  if (!connected || paused || !active) return null;

  return (
    <div className={styles.backdrop}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="working-tree-conflict-title"
      >
        <header className={styles.header}>
          <div>
            <div className={styles.overline}>Working Tree · {conflicts.length} unresolved</div>
            <h2 id="working-tree-conflict-title">Choose which version to keep</h2>
            <p className={styles.docId}>{active.docId}.md</p>
          </div>
          <button
            className={styles.later}
            type="button"
            disabled={busy}
            onClick={resolveLater}
          >
            Later
          </button>
        </header>

        <div className={styles.intro}>
          The database and editable file both changed since their last confirmed match.
          Nothing is overwritten until you choose.
        </div>

        <div className={styles.comparison} aria-busy={loadingDetail}>
          {detail ? (
            <>
              <ConflictSide label="Database" detail={detail.database} />
              <ConflictSide label="Local file" detail={detail.file} />
            </>
          ) : (
            <div className={styles.loading}>
              {loadingDetail ? "Loading both versions…" : "Comparison unavailable."}
            </div>
          )}
        </div>

        <div className={styles.keepBoth}>
          <label htmlFor="working-tree-conflict-new-id">Keep local copy as</label>
          <input
            id="working-tree-conflict-new-id"
            value={newId}
            disabled={busy || !bothSidesExist}
            spellCheck={false}
            onChange={(event) => setNewId(event.currentTarget.value)}
          />
          <span>
            {bothSidesExist
              ? "The database version keeps the original ID."
              : "Keep Both is available only when both sides still contain a document."}
          </span>
          {newIdError && <span className={styles.inputError}>{newIdError}</span>}
        </div>

        {(actionError || pollError || active.error) && (
          <div className={styles.error} role="alert">
            {actionError ?? pollError ?? active.error}
          </div>
        )}

        <footer className={styles.footer}>
          <button
            className={styles.action}
            type="button"
            disabled={busy || !detail}
            onClick={() => void resolve("use-database")}
          >
            <strong>Use Database</strong>
            <span>Restore the file from canonical D1</span>
          </button>
          <button
            className={styles.action}
            type="button"
            disabled={busy || !detail || Boolean(detail.file.error)}
            onClick={() => void resolve("use-file")}
          >
            <strong>Use Local File</strong>
            <span>Commit this file through Guard</span>
          </button>
          <button
            className={`${styles.action} ${styles.keepAction}`}
            type="button"
            disabled={busy || !detail || !bothSidesExist || newIdError !== null}
            onClick={() => void resolve("keep-both")}
          >
            <strong>Keep Both</strong>
            <span>Save the local version under a new ID</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
