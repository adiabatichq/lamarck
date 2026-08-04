import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyMarketplacePackage,
  cancelMarketplacePackage,
  prepareMarketplacePackage,
  type MarketplacePackageKind,
  type MarketplacePreparedPackage,
} from "../lib/api";
import styles from "./MarketplaceHandoffController.module.css";

export interface MarketplaceHandoff {
  kind: MarketplacePackageKind;
  packageId: string;
}

type DialogState =
  | { phase: "preparing"; handoff: MarketplaceHandoff }
  | { phase: "confirm"; handoff: MarketplaceHandoff; prepared: MarketplacePreparedPackage }
  | { phase: "applying"; handoff: MarketplaceHandoff; prepared: MarketplacePreparedPackage }
  | { phase: "error"; handoff: MarketplaceHandoff; message: string };

/** A tiny FIFO owned by the single handoff controller. */
export class MarketplaceHandoffQueue {
  readonly #pending: MarketplaceHandoff[] = [];

  enqueue(handoff: MarketplaceHandoff): void {
    this.#pending.push(handoff);
  }

  take(): MarketplaceHandoff | undefined {
    return this.#pending.shift();
  }

  get length(): number {
    return this.#pending.length;
  }
}

interface MarketplaceApplyOperations {
  apply: typeof applyMarketplacePackage;
  cancel: typeof cancelMarketplacePackage;
}

const defaultApplyOperations: MarketplaceApplyOperations = {
  apply: applyMarketplacePackage,
  cancel: cancelMarketplacePackage,
};

const LOCAL_APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

export function validateMarketplaceAppLocalId(
  localId: string,
  conflictingId: string,
): string | null {
  if (localId.length === 0) return "Enter a local App ID.";
  if (!LOCAL_APP_ID_PATTERN.test(localId)) {
    return "Use lowercase letters, numbers, and hyphens in dot-separated segments.";
  }
  if (localId === conflictingId) {
    return "Choose a different ID. This local App ID is already in use.";
  }
  return null;
}

export function suggestedMarketplaceAppLocalId(packageId: string): string {
  return `${packageId}-copy`;
}

/**
 * Apply consumes the Core stage on both success and lifecycle failure. If a
 * transport failure leaves that ambiguous, cancellation is retried before the
 * UI offers a fresh resolve.
 */
export async function commitMarketplaceStage(
  prepared: MarketplacePreparedPackage,
  localId: string,
  operations: MarketplaceApplyOperations = defaultApplyOperations,
): ReturnType<typeof applyMarketplacePackage> {
  try {
    return await operations.apply(
      prepared.stageId,
      prepared.kind === "app" ? localId : undefined,
    );
  } catch (error) {
    await operations.cancel(prepared.stageId).catch(() => {});
    throw error;
  }
}

export function openAppliedAppBestEffort(
  appId: string,
  onAppliedApp: (appId: string) => void | Promise<void>,
  onError: (error: unknown) => void = (error) => {
    console.error("[lamarck] Marketplace App was created but could not be opened", error);
  },
): void {
  // Start from a resolved Promise so a synchronous callback throw is handled
  // the same as an asynchronous navigation failure. Installation is already
  // committed and must never be retried because navigation failed.
  void Promise.resolve()
    .then(() => onAppliedApp(appId))
    .catch(onError);
}

export function MarketplaceHandoffController({
  onAppliedApp,
  onVisibilityChange,
}: {
  onAppliedApp: (appId: string) => void | Promise<void>;
  onVisibilityChange?: (visible: boolean) => void;
}) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [localId, setLocalId] = useState("");
  const dialogRef = useRef<DialogState | null>(null);
  const queueRef = useRef(new MarketplaceHandoffQueue());
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const beginRef = useRef<(handoff: MarketplaceHandoff) => void>(() => {});

  const publishDialog = useCallback((next: DialogState | null) => {
    dialogRef.current = next;
    setDialog(next);
  }, []);

  const pump = useCallback(() => {
    if (busyRef.current || dialogRef.current !== null) return;
    const next = queueRef.current.take();
    if (next) beginRef.current(next);
  }, []);

  const begin = useCallback(async (handoff: MarketplaceHandoff) => {
    setLocalId(handoff.packageId);
    publishDialog({ phase: "preparing", handoff });
    try {
      const prepared = await prepareMarketplacePackage(handoff.kind, handoff.packageId);
      if (!mountedRef.current) {
        await cancelMarketplacePackage(prepared.stageId).catch(() => {});
        return;
      }
      if (prepared.kind === "app" && prepared.localIdConflict) {
        setLocalId(suggestedMarketplaceAppLocalId(prepared.packageId));
      }
      publishDialog({ phase: "confirm", handoff, prepared });
    } catch (error) {
      if (!mountedRef.current) return;
      publishDialog({
        phase: "error",
        handoff,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [publishDialog]);
  beginRef.current = (handoff) => { void begin(handoff); };

  useEffect(() => {
    const host = window.lamarckHost;
    if (!host) return;
    mountedRef.current = true;
    const unsubscribe = host.onMarketplaceHandoff((handoff) => {
      queueRef.current.enqueue(handoff);
      pump();
    });
    void host.marketplaceReady();
    return () => {
      mountedRef.current = false;
      unsubscribe();
      const current = dialogRef.current;
      if (current && "prepared" in current && current.phase !== "applying") {
        void cancelMarketplacePackage(current.prepared.stageId).catch(() => {});
      }
    };
  }, [pump]);

  useEffect(() => onVisibilityChange?.(dialog !== null), [dialog, onVisibilityChange]);

  const dismiss = useCallback(async () => {
    const current = dialogRef.current;
    if (current?.phase === "preparing" || current?.phase === "applying") return;
    const stageId = current && "prepared" in current ? current.prepared.stageId : null;
    busyRef.current = true;
    publishDialog(null);
    if (stageId) await cancelMarketplacePackage(stageId).catch(() => {});
    busyRef.current = false;
    pump();
  }, [publishDialog, pump]);

  const apply = useCallback(async () => {
    const current = dialogRef.current;
    if (current?.phase !== "confirm") return;
    const { handoff, prepared } = current;
    if (
      prepared.kind === "app"
      && prepared.localIdConflict
      && validateMarketplaceAppLocalId(localId, prepared.packageId) !== null
    ) {
      return;
    }
    busyRef.current = true;
    publishDialog({ phase: "applying", handoff, prepared });
    try {
      const result = await commitMarketplaceStage(prepared, localId);
      publishDialog(null);
      busyRef.current = false;
      pump();
      if (result.kind === "app") {
        openAppliedAppBestEffort(result.id, onAppliedApp);
      }
    } catch (error) {
      busyRef.current = false;
      publishDialog({
        phase: "error",
        handoff,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [localId, onAppliedApp, publishDialog, pump]);

  if (!dialog) return null;
  const prepared = "prepared" in dialog ? dialog.prepared : null;
  const appNeedsNewId = prepared?.kind === "app" && prepared.localIdConflict;
  const localIdError = appNeedsNewId
    ? validateMarketplaceAppLocalId(localId, prepared.packageId)
    : null;
  const actionLabel = prepared?.action === "update"
    ? "Update Connector"
    : prepared?.action === "already-installed"
      ? "Confirm Official"
      : prepared?.kind === "connector"
        ? "Install Connector"
        : "Create App";

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-labelledby="marketplace-title">
      <section className={styles.dialog}>
        <span className={styles.eyebrow}>Official Marketplace</span>
        <h2 id="marketplace-title">
          {prepared?.name ?? dialog.handoff.packageId}
        </h2>
        {dialog.phase === "preparing" && (
          <p aria-live="polite">Resolving, downloading, and verifying this package…</p>
        )}
        {dialog.phase === "error" && (
          <p className={styles.error} role="alert">{dialog.message}</p>
        )}
        {(dialog.phase === "confirm" || dialog.phase === "applying") && prepared && (
          <>
            <p>{prepared.description}</p>
            <dl className={styles.facts}>
              <div><dt>Kind</dt><dd>{prepared.kind === "app" ? "Editable App template" : "Managed Connector"}</dd></div>
              <div><dt>Package</dt><dd><code>{prepared.packageId}</code></dd></div>
              <div><dt>Origin</dt><dd>{prepared.origin}</dd></div>
            </dl>
            {prepared.kind === "app" && (
              <p>The verified template becomes an editable local copy. Marketplace does not manage later changes.</p>
            )}
            {prepared.kind === "connector" && prepared.action === "update" && (
              <p>Your existing Sources keep their credentials, settings, schedules, and sync state.</p>
            )}
            {prepared.kind === "connector" && prepared.action === "already-installed" && (
              <p>These exact package bytes are already installed. Confirm to record trust in this verified Official release.</p>
            )}
            {appNeedsNewId && (
              <label className={styles.field}>
                <span>A local App already uses this ID. Choose a new local ID.</span>
                <input
                  autoFocus
                  value={localId}
                  onChange={(event) => setLocalId(event.target.value)}
                  pattern="[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)*"
                  aria-invalid={localIdError !== null}
                  aria-describedby={localIdError ? "marketplace-local-id-error" : undefined}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {localIdError && (
                  <span id="marketplace-local-id-error" className={styles.fieldError} role="alert">
                    {localIdError}
                  </span>
                )}
              </label>
            )}
          </>
        )}
        <div className={styles.actions}>
          {dialog.phase === "error" ? (
            <button className={styles.primary} onClick={() => void begin(dialog.handoff)}>Try again</button>
          ) : prepared && dialog.phase !== "preparing" ? (
            <button
              className={styles.primary}
              disabled={dialog.phase === "applying" || localIdError !== null}
              onClick={() => void apply()}
            >
              {dialog.phase === "applying" ? "Applying…" : actionLabel}
            </button>
          ) : null}
          <button
            className={styles.secondary}
            disabled={dialog.phase === "preparing" || dialog.phase === "applying"}
            onClick={() => void dismiss()}
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
