import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import type {
  CapsuleBackend,
  CapsuleBackendStatus,
  CapsuleUiLostEvent,
} from "./backend";
import { CapsuleRestartRequiredError } from "./backend";
import {
  APP_MANIFEST_DIGEST_PATTERN,
  type AppManifestDigest,
} from "../../../capsule/src/app-manifest-authority";
import { PACKAGE_ID_PATTERN } from "../package-id";

const STOP_ALL_QUIESCENCE_TIMEOUT_MS = 20_000;

interface PreparedActivation {
  schemaVersion: 1;
  activationId: string;
  activationSequence: number;
  appId: string;
  workload: "ui";
  version: string;
  manifestDigest: AppManifestDigest;
  packageDigest: `sha256:${string}`;
  immutablePackagePath: string;
  manifest: {
    runtime: {
      ui?: { command: string[]; port: number };
    };
  };
}

interface IssuedCapability {
  capability: string;
  channelId: string;
  activationId: string;
  appCommit: string;
  manifestDigest: AppManifestDigest;
  packageDigest: `sha256:${string}`;
}

export interface OpenedAppViewer {
  viewerId: string;
  appId: string;
  instanceId: string;
  channelId: string;
  /** Main-process only. Never serialize this object into App or Shell code. */
  capability: string;
}

export interface AppViewerOwner {
  readonly webContentsId: number;
  readonly rendererGeneration: number;
}

export class AppViewerBusyError extends Error {
  readonly code = "APP_VIEWER_BUSY";

  constructor(appId: string) {
    super(`App "${appId}" already has an active viewer`);
    this.name = "AppViewerBusyError";
  }
}

export interface ReloadedBrowserBinding {
  readonly viewerId: string;
  readonly instanceId: string;
  readonly channelId: string;
  /** Main-process only. It must never be returned across IPC. */
  readonly capability: string;
}

/**
 * A Host-private candidate binding. It exists only while Main proves that the
 * generation-specific gateway and hidden renderer can load the App document.
 * The candidate is deliberately absent from #viewers until verification and
 * the backend's atomic commit both succeed.
 */
export interface PreparedViewerBinding {
  readonly viewerId: string;
  readonly appId: string;
  readonly instanceId: string;
  readonly channelId: string;
  /** Main-process only. It must never be returned across IPC. */
  readonly capability: string;
  /** Aborted synchronously when App/Host teardown fences this preparation. */
  readonly signal: AbortSignal;
  /** Opens a stream to this exact unpublished candidate generation. */
  openUiStream(): Promise<Duplex>;
  /** Fails if the candidate or its prior viewer is no longer authoritative. */
  assertCurrent(): void;
  /** Rejects the preparation when its hidden renderer loses health. */
  invalidate(error: Error): void;
}

export type VerifyPreparedViewer = (binding: PreparedViewerBinding) => Promise<void>;
export interface ReloadedViewerPublication {
  /** Best-effort retirement work which starts only after the new renderer is visible. */
  readonly cleanup?: Promise<void>;
}
export type PublishReloadedViewer = (
  binding: ReloadedBrowserBinding,
) => ReloadedViewerPublication | void;

export interface ReloadedApp {
  readonly active: boolean;
  readonly browserBindings: readonly ReloadedBrowserBinding[];
}

export interface AppRuntimeAggregate {
  readonly appId: string;
  readonly runningWorkloads: number;
  readonly latestFailure: string | null;
}

interface StoredViewer extends OpenedAppViewer {
  owner: AppViewerOwner;
  runtimeChannelId: string;
  runtimeSenderId: string;
}

interface OpeningViewerContext {
  readonly appId: string;
  readonly owner: AppViewerOwner;
  readonly abortController: AbortController;
}

interface OpeningViewerOperation extends OpeningViewerContext {
  readonly operation: Promise<OpenedAppViewer>;
  cancellation: Promise<void> | null;
}

interface PendingUiOperation {
  readonly appId: string;
  readonly runtimeIssued: IssuedCapability;
  readonly runtimeSenderId: string;
  readonly previousViewer?: StoredViewer;
  readonly cleanupTasks: Promise<void>[];
  readonly cleanupFailures: PendingCleanupFailure[];
  readonly queuedRevocations: Set<string>;
  browserIssued?: IssuedCapability;
  viewerId: string;
  generation: number;
  preparationId?: string;
  instanceId?: string;
  committedInstanceId?: string;
  committedViewer?: StoredViewer;
  candidateLost?: CapsuleUiLostEvent;
  previousLost?: CapsuleUiLostEvent;
  commitContractViolated: boolean;
  preparationCommitted: boolean;
  preparationAbortStarted: boolean;
  readonly abortController: AbortController;
  runtimeUnbound: boolean;
  previousDetached: boolean;
}

interface PendingCleanupFailure {
  readonly error: unknown;
  readonly controlPlane: boolean;
}

export interface StopAllOptions {
  /**
   * Core authority is already gone or is being terminated. Local bindings and
   * the backend still fail closed, but remote channel deletion is no longer a
   * meaningful confirmation because those channels live only in the old Core.
   */
  readonly controlPlaneLost?: boolean;
}

export interface CapsuleManagerOptions {
  backend: CapsuleBackend;
  workspacePath: () => string;
  coreBaseUrl: () => string;
  coreToken: string;
  fetch?: typeof globalThis.fetch;
  bindSystemSender(senderId: string, binding: IssuedCapability): void;
  unbindSystemSender(senderId: string): void;
  onBackendBoundaryLost?(error: unknown): void;
  onUiLost?(event: CapsuleUiLostEvent & { viewerId: string }): void | Promise<void>;
}

/**
 * Host control-plane coordinator. It validates the manifest in Core, asks Core
 * for a launch-bound capability, and never gives the raw capability to the
 * Guest or renderer. Electron WebContents ownership is enforced by callers
 * through the owner renderer lease on every operation.
 */
export class CapsuleManager {
  readonly #backend: CapsuleBackend;
  readonly #coreBaseUrl: () => string;
  readonly #coreToken: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #bindSystemSender: CapsuleManagerOptions["bindSystemSender"];
  readonly #unbindSystemSender: CapsuleManagerOptions["unbindSystemSender"];
  readonly #onBackendBoundaryLost: ((error: unknown) => void) | undefined;
  readonly #onUiLost: CapsuleManagerOptions["onUiLost"];
  readonly #viewers = new Map<string, StoredViewer>();
  readonly #openingApps = new Set<string>();
  readonly #openingOperations = new Map<string, OpeningViewerOperation>();
  readonly #rebuildOperations = new Map<string, Promise<unknown>>();
  readonly #pendingUiOperations = new Map<string, PendingUiOperation>();
  readonly #stopOperations = new Map<string, Promise<void>>();
  readonly #retireOperations = new Map<string, Promise<void>>();
  readonly #unexpectedUiLossOperations = new Set<Promise<void>>();
  readonly #latestFailureByApp = new Map<string, string>();
  readonly #stoppingApps = new Set<string>();
  #stoppingAll = false;
  #stopAllOperation: Promise<void> | null = null;
  #terminalFailure: CapsuleRestartRequiredError | null = null;
  #controlPlaneRequests = new AbortController();
  #controlPlaneLost = false;
  #generation = 0;

  constructor(options: CapsuleManagerOptions) {
    this.#backend = options.backend;
    this.#coreBaseUrl = options.coreBaseUrl;
    this.#coreToken = options.coreToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#bindSystemSender = options.bindSystemSender;
    this.#unbindSystemSender = options.unbindSystemSender;
    this.#onBackendBoundaryLost = options.onBackendBoundaryLost;
    this.#onUiLost = options.onUiLost;
    this.#backend.setBoundaryLostHandler?.((error) => {
      // The Guest can disappear while no foreground API call is pending. The
      // manager, not the backend, owns Core capability revocation and viewers.
      void this.#collapseBackendBoundary([error]).catch(() => {});
    });
    this.#backend.setUiLostHandler?.((event) => {
      this.#handleUnexpectedUiLoss(event);
    });
  }

  status(): Promise<CapsuleBackendStatus> {
    if (this.#terminalFailure) {
      return Promise.resolve({
        available: false,
        backend: "quarantined",
        reason: this.#terminalFailure.message,
        restartRequired: true,
      });
    }
    return this.#backend.status();
  }

  appRuntimeStates(): readonly AppRuntimeAggregate[] {
    const appIds = new Set<string>(this.#latestFailureByApp.keys());
    for (const viewer of this.#viewers.values()) appIds.add(viewer.appId);
    return Object.freeze([...appIds].sort().map((appId) => Object.freeze({
      appId,
      runningWorkloads: [...this.#viewers.values()]
        .filter((viewer) => viewer.appId === appId).length,
      latestFailure: this.#latestFailureByApp.get(appId) ?? null,
    })));
  }

  async openViewer(
    appId: string,
    ownerValue: AppViewerOwner,
    verifyPreparedViewer: VerifyPreparedViewer,
  ): Promise<OpenedAppViewer> {
    if (this.#terminalFailure) throw this.#terminalFailure;
    if (!PACKAGE_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    const owner = validatedViewerOwner(ownerValue);
    if (
      this.#stoppingAll
      || this.#openingApps.has(appId)
      || this.#stoppingApps.has(appId)
      || [...this.#viewers.values()].some((viewer) => viewer.appId === appId)
    ) {
      throw new AppViewerBusyError(appId);
    }
    this.#openingApps.add(appId);
    const generation = this.#generation;
    const opening: OpeningViewerContext = {
      appId,
      owner,
      abortController: new AbortController(),
    };
    let resolveOpening!: (viewer: OpenedAppViewer) => void;
    let rejectOpening!: (error: unknown) => void;
    const operation = new Promise<OpenedAppViewer>((resolve, reject) => {
      resolveOpening = resolve;
      rejectOpening = reject;
    });
    const tracked: OpeningViewerOperation = {
      ...opening,
      operation,
      cancellation: null,
    };
    // Register ownership before invoking backend or Core code. Lifecycle
    // replacement can therefore cancel even a synchronously reentrant launch.
    this.#openingOperations.set(appId, tracked);
    void this.#openViewer(
      appId,
      opening,
      generation,
      verifyPreparedViewer,
    ).then(resolveOpening, rejectOpening);
    try {
      const viewer = await operation;
      this.#latestFailureByApp.delete(appId);
      return viewer;
    } catch (error) {
      if (!isExpectedCancellation(error)) this.#recordFailure(appId, error);
      throw error;
    } finally {
      if (this.#openingOperations.get(appId) === tracked) {
        this.#openingOperations.delete(appId);
      }
      this.#openingApps.delete(appId);
    }
  }

  async #openViewer(
    appId: string,
    opening: OpeningViewerContext,
    generation: number,
    verifyPreparedViewer: VerifyPreparedViewer,
  ): Promise<OpenedAppViewer> {
    const status = await this.#backend.status();
    this.#assertOpeningCurrent(opening, generation);
    if (!status.available) {
      const message = `App Capsule unavailable: ${status.reason ?? status.backend}`;
      if (status.restartRequired) throw new CapsuleRestartRequiredError(message);
      throw new Error(message);
    }

    const activation = await this.#prepareActivation(appId);
    try {
    this.#assertOpeningCurrent(opening, generation);
    const ui = activation.manifest.runtime.ui;
    if (!ui) throw new Error(`App "${appId}" does not declare a UI workload`);
    const runtimeIssued = await this.#issueCapability(activation);
    try {
      this.#assertOpeningCurrent(opening, generation);
    } catch (error) {
      await this.#revokeCapability(runtimeIssued.channelId).catch(() => {});
      throw error;
    }
    const runtimeSenderId = `capsule_${randomBytes(24).toString("base64url")}`;
    try {
      this.#bindSystemSender(runtimeSenderId, runtimeIssued);
    } catch (error) {
      await this.#revokeCapability(runtimeIssued.channelId).catch(() => {});
      throw error;
    }
    try {
      this.#assertOpeningCurrent(opening, generation);
    } catch (error) {
      this.#unbindSystemSender(runtimeSenderId);
      await this.#revokeCapability(runtimeIssued.channelId).catch(() => {});
      throw error;
    }

    const viewerId = `viewer_${randomBytes(16).toString("base64url")}`;
    const pending = this.#beginPendingUiOperation({
      appId,
      runtimeIssued,
      runtimeSenderId,
      viewerId,
      generation,
    }, opening.abortController);
    try {
      this.#assertPendingUiCurrent(pending, "launch");
      const prepared = await this.#backend.prepareUi({
        appId,
        activationId: activation.activationId,
        activationSequence: activation.activationSequence,
        version: activation.version,
        manifestDigest: activation.manifestDigest,
        packageDigest: activation.packageDigest,
        packageDir: activation.immutablePackagePath,
        command: [...ui.command],
        port: ui.port,
        sdkSenderId: runtimeSenderId,
      });
      pending.preparationId = prepared.preparationId;
      pending.instanceId = prepared.instanceId;
      this.#assertPendingUiCurrent(pending, "launch");

      const browserIssued = await this.#issueCapability(activation);
      pending.browserIssued = browserIssued;
      this.#assertPendingUiCurrent(pending, "launch");

      await verifyPreparedViewer(this.#preparedViewerBinding(pending));
      // Do not insert another await between this authority check and commit.
      // It is the final Host-side admission decision for this candidate.
      this.#assertPendingUiCurrent(pending, "launch");
      const instance = await this.#backend.commitPreparedUi(prepared.preparationId);
      pending.preparationCommitted = true;
      pending.committedInstanceId = instance.instanceId;
      this.#assertPendingUiCurrent(pending, "launch");
      if (instance.instanceId !== prepared.instanceId) {
        pending.commitContractViolated = true;
        throw new Error("App Capsule committed a different prepared UI instance");
      }
      const viewer: StoredViewer = Object.freeze({
        viewerId,
        appId,
        instanceId: instance.instanceId,
        channelId: browserIssued.channelId,
        capability: browserIssued.capability,
        owner: opening.owner,
        runtimeChannelId: runtimeIssued.channelId,
        runtimeSenderId,
      });
      this.#viewers.set(viewer.viewerId, viewer);
      this.#finishPendingUiOperation(pending);
      return viewer;
    } catch (error) {
      return await this.#failPendingUiOperation(pending, error);
    }
    } finally {
      await this.#releaseActivation(activation.activationId).catch(() => {});
    }
  }

  getViewer(viewerId: string, owner: AppViewerOwner): OpenedAppViewer | null {
    const viewer = this.#viewers.get(viewerId);
    return viewer && sameViewerOwner(viewer.owner, owner) ? viewer : null;
  }

  openViewerStream(viewerId: string): Promise<Duplex> {
    const viewer = this.#viewers.get(viewerId);
    if (!viewer) throw new Error("App viewer is no longer active");
    return this.#backend.openUiStream(viewer.instanceId);
  }

  async closeViewer(viewerId: string, owner: AppViewerOwner): Promise<boolean> {
    const viewer = this.#viewers.get(viewerId);
    if (!viewer || !sameViewerOwner(viewer.owner, owner)) return false;
    this.#viewers.delete(viewerId);
    const pending = this.#pendingUiOperations.get(viewer.appId);
    if (pending?.previousViewer === viewer || pending?.committedViewer === viewer) {
      this.#cancelPendingUiOperation(
        pending,
        new Error("App Capsule reload was cancelled because its viewer closed"),
      );
    }
    this.#unbindSystemSender(viewer.runtimeSenderId);
    const [stopResult, revokeResult] = await Promise.allSettled([
      this.#backend.stopUi(viewer.instanceId),
      Promise.all([
        this.#revokeCapability(viewer.channelId),
        this.#revokeCapability(viewer.runtimeChannelId),
      ]),
    ]);
    if (stopResult.status === "rejected") {
      const causes = [stopResult.reason];
      if (revokeResult.status === "rejected") causes.push(revokeResult.reason);
      await this.#collapseBackendBoundary(causes);
    }
    if (revokeResult.status === "rejected") throw revokeResult.reason;
    return true;
  }

  async closeOwner(ownerValue: AppViewerOwner): Promise<void> {
    const owner = validatedViewerOwner(ownerValue);
    const reason = new Error("App viewer owner renderer was replaced");
    const openings = [...this.#openingOperations.values()]
      .filter((opening) => sameViewerOwner(opening.owner, owner));
    const cancelledOpenings = openings.map((opening) => (
      this.#cancelOpeningOperation(opening, reason)
    ));
    const ids = [...this.#viewers.values()]
      .filter((viewer) => sameViewerOwner(viewer.owner, owner))
      .map((viewer) => viewer.viewerId);
    const closedViewers = ids.map((id) => this.closeViewer(id, owner));
    const results = await Promise.allSettled([...cancelledOpenings, ...closedViewers]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "App viewer owner cleanup failed");
    }
  }

  #cancelOpeningOperation(
    opening: OpeningViewerOperation,
    reason: Error,
  ): Promise<void> {
    if (opening.cancellation) return opening.cancellation;
    let resolveCancellation!: () => void;
    let rejectCancellation!: (error: unknown) => void;
    const shared = new Promise<void>((resolve, reject) => {
      resolveCancellation = resolve;
      rejectCancellation = reject;
    });
    // Publish the shared settlement before calling backend or Core code, so a
    // synchronous reentrant owner close joins this cancellation.
    opening.cancellation = shared;
    if (!opening.abortController.signal.aborted) {
      opening.abortController.abort(reason);
    }
    const pending = this.#pendingUiOperations.get(opening.appId);
    if (pending?.abortController === opening.abortController) {
      this.#cancelPendingUiOperation(pending, reason);
    }

    let backendStop: Promise<void>;
    try {
      // A first launch has no committed instance whose stopUi() could abort
      // the backend preparation. Stop this App identity to cancel work that
      // has not returned a preparation id yet.
      backendStop = this.#backend.stopApp(opening.appId);
    } catch (error) {
      backendStop = Promise.reject(error);
    }
    const initialRevocation = this.#controlPlaneLost
      ? Promise.resolve()
      : this.#revokeAppCapabilities(opening.appId);
    void (async () => {
      const [, backendResult, revokeResult] = await Promise.allSettled([
        opening.operation,
        backendStop,
        initialRevocation,
      ]);
      const finalRevokeResult = this.#controlPlaneLost
        ? ({ status: "fulfilled", value: undefined } as PromiseFulfilledResult<void>)
        : (await Promise.allSettled([
          this.#revokeAppCapabilities(opening.appId),
        ]))[0]!;
      const failures = [
        backendResult,
        ...(this.#controlPlaneLost ? [] : [revokeResult, finalRevokeResult]),
      ]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0 && !this.#stoppingAll) {
        await this.#collapseBackendBoundary(failures);
      }
    })().then(resolveCancellation, rejectCancellation);
    return shared;
  }

  async reloadApp(
    appId: string,
    verifyPreparedViewer: VerifyPreparedViewer,
    publishReloadedViewer: PublishReloadedViewer,
  ): Promise<ReloadedApp> {
    if (this.#terminalFailure) throw this.#terminalFailure;
    if (!PACKAGE_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    if (this.#stoppingAll || this.#stoppingApps.has(appId)) {
      throw new Error(`App "${appId}" is stopping`);
    }
    const activeViewer = [...this.#viewers.values()].find((viewer) => viewer.appId === appId);
    if (!activeViewer) return { active: false, browserBindings: [] };
    const existing = this.#rebuildOperations.get(appId);
    if (existing) {
      return await existing as ReloadedApp;
    }
    const operation = this.#reloadApp(
      activeViewer,
      this.#generation,
      verifyPreparedViewer,
      publishReloadedViewer,
    );
    this.#rebuildOperations.set(appId, operation);
    try {
      const result = await operation;
      if (result.active) this.#latestFailureByApp.delete(appId);
      return result;
    } catch (error) {
      if (!isExpectedCancellation(error)) this.#recordFailure(appId, error);
      throw error;
    } finally {
      if (this.#rebuildOperations.get(appId) === operation) {
        this.#rebuildOperations.delete(appId);
      }
    }
  }

  async #reloadApp(
    viewer: StoredViewer,
    generation: number,
    verifyPreparedViewer: VerifyPreparedViewer,
    publishReloadedViewer: PublishReloadedViewer,
  ): Promise<ReloadedApp> {
    const activation = await this.#prepareActivation(viewer.appId);
    try {
    this.#assertViewerCurrent(viewer, generation, "reload");
    const ui = activation.manifest.runtime.ui;
    if (!ui) throw new Error(`App "${viewer.appId}" does not declare a UI workload`);
    const runtimeIssued = await this.#issueCapability(activation);
    if (generation !== this.#generation || this.#viewers.get(viewer.viewerId) !== viewer) {
      await this.#revokeCapability(runtimeIssued.channelId).catch(() => {});
      throw new Error("App Capsule reload was cancelled");
    }
    const browserIssued = await this.#issueCapability(activation).catch(async (error) => {
      await this.#revokeCapability(runtimeIssued.channelId).catch(() => {});
      throw error;
    });
    if (generation !== this.#generation || this.#viewers.get(viewer.viewerId) !== viewer) {
      await Promise.allSettled([
        this.#revokeCapability(runtimeIssued.channelId),
        this.#revokeCapability(browserIssued.channelId),
      ]);
      throw new Error("App Capsule reload was cancelled");
    }
    const runtimeSenderId = `capsule_${randomBytes(24).toString("base64url")}`;
    try {
      this.#bindSystemSender(runtimeSenderId, runtimeIssued);
    } catch (error) {
      await Promise.allSettled([
        this.#revokeCapability(runtimeIssued.channelId),
        this.#revokeCapability(browserIssued.channelId),
      ]);
      throw error;
    }
    if (generation !== this.#generation || this.#viewers.get(viewer.viewerId) !== viewer) {
      this.#unbindSystemSender(runtimeSenderId);
      await Promise.allSettled([
        this.#revokeCapability(runtimeIssued.channelId),
        this.#revokeCapability(browserIssued.channelId),
      ]);
      throw new Error("App Capsule reload was cancelled");
    }

    const pending = this.#beginPendingUiOperation({
      appId: viewer.appId,
      runtimeIssued,
      runtimeSenderId,
      browserIssued,
      previousViewer: viewer,
      viewerId: viewer.viewerId,
      generation,
    });
    try {
      this.#assertPendingUiCurrent(pending, "reload");
      const prepared = await this.#backend.prepareUi({
        appId: viewer.appId,
        activationId: activation.activationId,
        activationSequence: activation.activationSequence,
        version: activation.version,
        manifestDigest: activation.manifestDigest,
        packageDigest: activation.packageDigest,
        packageDir: activation.immutablePackagePath,
        command: [...ui.command],
        port: ui.port,
        sdkSenderId: runtimeSenderId,
      }, viewer.instanceId);
      pending.preparationId = prepared.preparationId;
      pending.instanceId = prepared.instanceId;
      this.#assertPendingUiCurrent(pending, "reload");

      await verifyPreparedViewer(this.#preparedViewerBinding(pending));
      // The prior viewer and its capabilities remain authoritative through
      // verification. This is the last check before the backend atomically
      // adopts the candidate and retires the prior workload.
      this.#assertPendingUiCurrent(pending, "reload");
      const replacement = await this.#backend.commitPreparedUi(prepared.preparationId);
      pending.preparationCommitted = true;
      pending.committedInstanceId = replacement.instanceId;
      this.#assertPendingUiCurrent(pending, "reload");
      if (replacement.instanceId !== prepared.instanceId) {
        pending.commitContractViolated = true;
        throw new Error("App Capsule committed a different prepared UI instance");
      }

      const updated: StoredViewer = Object.freeze({
        ...viewer,
        instanceId: replacement.instanceId,
        channelId: browserIssued.channelId,
        capability: browserIssued.capability,
        runtimeChannelId: runtimeIssued.channelId,
        runtimeSenderId,
      });
      const browserBinding: ReloadedBrowserBinding = Object.freeze({
        viewerId: viewer.viewerId,
        instanceId: replacement.instanceId,
        channelId: browserIssued.channelId,
        capability: browserIssued.capability,
      });
      pending.committedViewer = updated;
      this.#viewers.set(viewer.viewerId, updated);
      // The old workload is already terminal after the backend commit. Hand
      // the verified hidden renderer to Main before any Core network I/O, so
      // the visible last-known-good document cannot spend that interval
      // talking to a retired runtime.
      this.#unbindSystemSender(viewer.runtimeSenderId);
      const publication = publishReloadedViewer(browserBinding);
      if (
        publication
        && typeof (publication as unknown as { then?: unknown }).then === "function"
      ) {
        throw new Error("Reloaded App viewer publication must complete synchronously");
      }
      const publicationCleanup = publication?.cleanup;
      this.#assertPendingUiCurrent(pending, "reload");
      this.#finishPendingUiOperation(pending);
      // Renderer/session retirement is reconstructable best-effort cleanup.
      // It begins after synchronous visual cutover but must never hold the
      // authoritative reload or global shutdown fence indefinitely.
      void publicationCleanup?.catch(() => {});
      const revoked = await Promise.allSettled([
        this.#revokeCapability(viewer.channelId),
        this.#revokeCapability(viewer.runtimeChannelId),
      ]);
      const failures = revoked
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) return await this.#collapseBackendBoundary(failures);
      if (this.#viewers.get(viewer.viewerId) !== updated) {
        throw new Error("App Capsule replacement stopped before Host publication completed");
      }
      return {
        active: true,
        browserBindings: [browserBinding],
      };
    } catch (error) {
      // Once the replacement is in #viewers it is an active generation. Any
      // unexpected loss is synchronously detached and settled by
      // #handleUnexpectedUiLoss; issuing duplicate revocations here would
      // turn an idempotent teardown into a false boundary-loss signal.
      if (this.#pendingUiOperations.get(pending.appId) !== pending) throw error;
      return await this.#failPendingUiOperation(
        pending,
        error,
      );
    }
    } finally {
      await this.#releaseActivation(activation.activationId).catch(() => {});
    }
  }

  stopApp(appId: string): Promise<void> {
    if (!PACKAGE_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    if (this.#stopAllOperation) return this.#stopAllOperation;
    if (this.#terminalFailure) return Promise.reject(this.#terminalFailure);
    const existing = this.#stopOperations.get(appId);
    if (existing) return existing;
    const ownsFence = !this.#stoppingApps.has(appId);
    if (ownsFence) this.#stoppingApps.add(appId);
    this.#generation += 1;
    const pending = this.#pendingUiOperations.get(appId);
    if (pending) {
      this.#cancelPendingUiOperation(
        pending,
        new Error(`App Capsule operation was cancelled while stopping "${appId}"`),
      );
    }
    let tracked: Promise<void>;
    tracked = this.#stopApp(appId).finally(() => {
      if (ownsFence) this.#stoppingApps.delete(appId);
      if (this.#stopOperations.get(appId) === tracked) this.#stopOperations.delete(appId);
    });
    this.#stopOperations.set(appId, tracked);
    return tracked;
  }

  async #stopApp(appId: string): Promise<void> {
    const pending = [
      this.#openingOperations.get(appId)?.operation,
      this.#rebuildOperations.get(appId),
    ].filter((operation): operation is Promise<unknown> => operation !== undefined);
    const viewers = [...this.#viewers.values()].filter((viewer) => viewer.appId === appId);
    for (const viewer of viewers) {
      this.#viewers.delete(viewer.viewerId);
      this.#unbindSystemSender(viewer.runtimeSenderId);
    }
    // stopApp is the backend cancellation source for a preparation whose
    // prepareUi() has not returned an abortable preparation id yet.
    const results = await Promise.allSettled([
      this.#backend.stopApp(appId),
      this.#revokeAppCapabilities(appId),
    ]);
    await Promise.allSettled(pending);
    const finalRevocation = await Promise.allSettled([
      this.#revokeAppCapabilities(appId),
    ]);
    const failures = results
      .concat(finalRevocation)
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, `Could not stop App "${appId}"`);
  }

  /** Establishes a synchronous fence which remains held across Core archive. */
  beginAppRetirement(appId: string): void {
    if (this.#terminalFailure) throw this.#terminalFailure;
    if (!PACKAGE_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    if (this.#stoppingAll) throw new Error("App Capsule is stopping");
    if (this.#stoppingApps.has(appId)) throw new Error(`App "${appId}" is stopping`);
    this.#stoppingApps.add(appId);
    this.#generation += 1;
    const pending = this.#pendingUiOperations.get(appId);
    if (pending) {
      this.#cancelPendingUiOperation(
        pending,
        new Error(`App Capsule operation was cancelled while retiring "${appId}"`),
      );
    }
  }

  /** Releases the fence after Core either commits or rejects the archive. */
  finishAppRetirement(appId: string): void {
    this.#stoppingApps.delete(appId);
  }

  retireApp(appId: string): Promise<void> {
    if (!PACKAGE_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    if (this.#terminalFailure) return Promise.reject(this.#terminalFailure);
    if (this.#stoppingAll) {
      return Promise.reject(new Error("App Capsule is stopping"));
    }
    if (!this.#stoppingApps.has(appId)) {
      throw new Error(`App "${appId}" retirement fence is not active`);
    }
    const existing = this.#retireOperations.get(appId);
    if (existing) return existing;
    let tracked: Promise<void>;
    tracked = this.#retireApp(appId).finally(() => {
      if (this.#retireOperations.get(appId) === tracked) this.#retireOperations.delete(appId);
    });
    this.#retireOperations.set(appId, tracked);
    return tracked;
  }

  async #retireApp(appId: string): Promise<void> {
    const pending = [
      this.#openingOperations.get(appId)?.operation,
      this.#rebuildOperations.get(appId),
      this.#stopOperations.get(appId),
    ].filter((operation): operation is Promise<unknown> => operation !== undefined);
    const viewers = [...this.#viewers.values()].filter((viewer) => viewer.appId === appId);
    for (const viewer of viewers) {
      this.#viewers.delete(viewer.viewerId);
      this.#unbindSystemSender(viewer.runtimeSenderId);
    }

    // Start both fail-closed actions immediately. retireApp() synchronously
    // aborts queued/in-flight backend launches before it returns its promise;
    // Core revocation concurrently cuts off any already issued Host channel.
    // The retirement fence remains held until both and every cancelled launch
    // have settled.
    const revoke = this.#revokeAppCapabilities(appId);
    const backend = this.#backend.retireApp(appId);
    const [revokeResult, backendResult] = await Promise.allSettled([revoke, backend]);
    await Promise.allSettled(pending);
    const failures = [revokeResult, backendResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Could not retire App "${appId}"`);
    }
  }

  stopAll(options: StopAllOptions = {}): Promise<void> {
    if (options.controlPlaneLost && !this.#controlPlaneLost) {
      this.#controlPlaneLost = true;
      this.#controlPlaneRequests.abort(new ControlPlaneLostError());
    }
    if (this.#stopAllOperation) return this.#stopAllOperation;
    let resolveStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    const shared = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    // Publish the shared operation before invoking any external cleanup hook;
    // a synchronous reentrant stop must join this teardown, not start another.
    this.#stopAllOperation = shared;
    this.#stoppingAll = true;
    this.#generation += 1;

    try {
      const pending = [
        ...[...this.#openingOperations.values()].map((opening) => opening.operation),
        ...this.#rebuildOperations.values(),
        ...this.#stopOperations.values(),
        ...this.#retireOperations.values(),
        ...this.#unexpectedUiLossOperations,
      ];
      const pendingUi = [...this.#pendingUiOperations.values()];
      const viewers = [...this.#viewers.values()];
      const affectedApps = new Set([
        ...this.#openingOperations.keys(),
        ...this.#rebuildOperations.keys(),
        ...this.#stopOperations.keys(),
        ...this.#retireOperations.keys(),
        ...this.#stoppingApps,
        ...pendingUi.map((operation) => operation.appId),
        ...viewers.map((viewer) => viewer.appId),
      ]);
      this.#viewers.clear();
      for (const viewer of viewers) this.#unbindSystemSender(viewer.runtimeSenderId);
      for (const operation of pendingUi) {
        this.#cancelPendingUiOperation(
          operation,
          new Error("App Capsule operation was cancelled during Host shutdown"),
        );
        if (!operation.runtimeUnbound) {
          operation.runtimeUnbound = true;
          this.#unbindSystemSender(operation.runtimeSenderId);
        }
        if (operation.previousViewer) operation.previousDetached = true;
      }

      // stopAll() is the cancellation source for backend launches. Invoke it
      // before awaiting manager operations, otherwise an in-flight launch can
      // leave shutdown waiting for the very cancellation it has not issued yet.
      let backendStop: Promise<void>;
      try {
        backendStop = this.#backend.stopAll();
      } catch (error) {
        backendStop = Promise.reject(error);
      }
      const revocations = this.#controlPlaneLost
        ? []
        : [...affectedApps].map((appId) => this.#revokeAppCapabilities(appId));

      const teardown = (async () => {
        const [backendResult] = await Promise.allSettled([backendStop, ...revocations]);
        // Keep the global fence until every operation cancelled by the backend
        // has observed that cancellation and completed its own Host cleanup.
        await Promise.allSettled(pending);
        // Capability issuance already in flight at the first revoke can commit
        // afterward. Revoke each affected App again only after issuance and
        // launch cleanup have quiesced.
        const finalRevocations = this.#controlPlaneLost
          ? []
          : await Promise.allSettled(
            [...affectedApps].map((appId) => this.#revokeAppCapabilities(appId)),
          );
        const failures = [
          backendResult,
          ...(this.#controlPlaneLost ? [] : finalRevocations),
        ]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Could not fully stop App Capsules");
        }
      })();
      void withDeadline(
        teardown,
        STOP_ALL_QUIESCENCE_TIMEOUT_MS,
        "App Capsule shutdown did not quiesce before its deadline",
      ).then(
        () => {
          if (this.#stopAllOperation === shared) this.#stopAllOperation = null;
          this.#stoppingAll = false;
          this.#controlPlaneRequests = new AbortController();
          this.#controlPlaneLost = false;
          resolveStop();
        },
        (error) => {
          const terminal = error instanceof CapsuleRestartRequiredError
            ? error
            : new CapsuleRestartRequiredError(
              "App Capsule shutdown was not confirmed; restart Lamarck before using Apps again",
              { cause: error },
            );
          this.#terminalFailure ??= terminal;
          // Keep the shared rejected operation and global admission fence.
          // An abandoned async continuation may still settle, so this Manager
          // must never admit a new generation in the same Host process.
          rejectStop(this.#terminalFailure);
        },
      );
    } catch (error) {
      const terminal = error instanceof CapsuleRestartRequiredError
        ? error
        : new CapsuleRestartRequiredError(
          "App Capsule shutdown was not confirmed; restart Lamarck before using Apps again",
          { cause: error },
        );
      this.#terminalFailure ??= terminal;
      rejectStop(this.#terminalFailure);
    }
    return shared;
  }

  async #collapseBackendBoundary(causes: unknown[]): Promise<never> {
    this.#generation += 1;
    for (const pending of this.#pendingUiOperations.values()) {
      this.#cancelPendingUiOperation(
        pending,
        new Error("App Capsule backend boundary was lost"),
      );
    }
    const remaining = [...this.#viewers.values()];
    for (const viewer of remaining) this.#recordFailure(viewer.appId, causes[0]);
    this.#viewers.clear();
    for (const viewer of remaining) this.#unbindSystemSender(viewer.runtimeSenderId);
    try {
      this.#onBackendBoundaryLost?.(causes[0]);
    } catch (error) {
      causes.push(error);
    }
    const results = await Promise.allSettled([
      this.#backend.stopAll(),
      ...remaining.flatMap((viewer) => [
        this.#revokeCapability(viewer.channelId),
        this.#revokeCapability(viewer.runtimeChannelId),
      ]),
    ]);
    causes.push(...results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason));
    const primary = errorMessage(causes[0]);
    throw new AggregateError(
      causes,
      primary
        ? `App Capsule backend boundary was lost: ${primary}`
        : "App Capsule backend boundary was lost",
    );
  }

  #handleUnexpectedUiLoss(event: CapsuleUiLostEvent): void {
    this.#recordFailure(event.appId, event.error);
    const pending = this.#pendingUiOperations.get(event.appId);
    if (pending) {
      if (
        pending.previousViewer
        && event.instanceId === pending.previousViewer.instanceId
      ) {
        this.#generation += 1;
        this.#markPendingPreviousUiLost(pending, event);
      } else {
        this.#markPendingCandidateUiLost(pending, event);
      }
      return;
    }

    const viewer = [...this.#viewers.values()]
      .find((candidate) => candidate.instanceId === event.instanceId);
    if (!viewer || viewer.appId !== event.appId) return;

    this.#generation += 1;
    this.#viewers.delete(viewer.viewerId);
    this.#unbindSystemSender(viewer.runtimeSenderId);
    let hostCleanup: void | Promise<void>;
    try {
      hostCleanup = this.#onUiLost?.({ ...event, viewerId: viewer.viewerId });
    } catch (error) {
      hostCleanup = Promise.reject(error);
    }
    let settlement: Promise<void>;
    settlement = this.#settleUnexpectedUiLoss(viewer, event.error, hostCleanup)
      .finally(() => {
        this.#unexpectedUiLossOperations.delete(settlement);
      });
    this.#unexpectedUiLossOperations.add(settlement);
    void settlement.catch(() => {});
  }

  #recordFailure(appId: string, error: unknown): void {
    if (
      error instanceof AppControlPlaneError
      && (error.code === "APP_PACKAGE_INVALID" || error.code === "APP_VERSION_HISTORY_UNAVAILABLE")
    ) return;
    this.#latestFailureByApp.set(
      appId,
      error instanceof Error ? error.message : String(error),
    );
  }

  #beginPendingUiOperation(
    operation: Omit<PendingUiOperation,
      "cleanupTasks" | "cleanupFailures" | "queuedRevocations"
      | "commitContractViolated" | "preparationCommitted" | "preparationAbortStarted"
      | "abortController" | "runtimeUnbound" | "previousDetached">,
    abortController = new AbortController(),
  ): PendingUiOperation {
    if (this.#pendingUiOperations.has(operation.appId)) {
      throw new Error(`App "${operation.appId}" already has a pending UI operation`);
    }
    const pending: PendingUiOperation = {
      ...operation,
      cleanupTasks: [],
      cleanupFailures: [],
      queuedRevocations: new Set(),
      commitContractViolated: false,
      preparationCommitted: false,
      preparationAbortStarted: false,
      abortController,
      runtimeUnbound: false,
      previousDetached: false,
    };
    this.#pendingUiOperations.set(operation.appId, pending);
    return pending;
  }

  #finishPendingUiOperation(pending: PendingUiOperation): void {
    if (this.#pendingUiOperations.get(pending.appId) === pending) {
      this.#pendingUiOperations.delete(pending.appId);
    }
  }

  #markPendingCandidateUiLost(
    pending: PendingUiOperation,
    event: CapsuleUiLostEvent,
  ): void {
    if (pending.candidateLost) return;
    pending.candidateLost = event;
    this.#cancelPendingUiOperation(pending, event.error);
  }

  #markPendingPreviousUiLost(
    pending: PendingUiOperation,
    event: CapsuleUiLostEvent,
  ): void {
    if (pending.previousLost) return;
    pending.previousLost = event;
    this.#cancelPendingUiOperation(pending, event.error);
    const previous = pending.previousViewer;
    if (
      previous
      && !pending.previousDetached
      && this.#viewers.get(previous.viewerId) === previous
    ) {
      pending.previousDetached = true;
      this.#viewers.delete(previous.viewerId);
      this.#unbindSystemSender(previous.runtimeSenderId);
      let hostCleanup: void | Promise<void>;
      try {
        hostCleanup = this.#onUiLost?.({ ...event, viewerId: previous.viewerId });
      } catch (error) {
        hostCleanup = Promise.reject(error);
      }
      this.#trackPendingCleanup(pending, Promise.resolve(hostCleanup));
      this.#queuePendingRevocation(pending, previous.channelId);
      this.#queuePendingRevocation(pending, previous.runtimeChannelId);
    }
  }

  #queuePendingRevocation(pending: PendingUiOperation, channelId: string): void {
    if (pending.queuedRevocations.has(channelId)) return;
    pending.queuedRevocations.add(channelId);
    if (this.#controlPlaneLost) return;
    this.#trackPendingCleanup(pending, this.#revokeCapability(channelId), true);
  }

  #trackPendingCleanup(
    pending: PendingUiOperation,
    operation: Promise<unknown>,
    controlPlane = false,
  ): void {
    const tracked = operation.then(
      () => {},
      (error) => { pending.cleanupFailures.push({ error, controlPlane }); },
    );
    pending.cleanupTasks.push(tracked);
  }

  #requestPendingPreparationAbort(pending: PendingUiOperation): void {
    if (
      pending.preparationAbortStarted
      || pending.preparationCommitted
      || !pending.preparationId
    ) {
      return;
    }
    pending.preparationAbortStarted = true;
    let abort: Promise<void>;
    try {
      abort = this.#backend.abortPreparedUi(pending.preparationId);
    } catch (error) {
      abort = Promise.reject(error);
    }
    this.#trackPendingCleanup(
      pending,
      abort,
    );
  }

  #cancelPendingUiOperation(pending: PendingUiOperation, reason: Error): void {
    if (!pending.abortController.signal.aborted) {
      pending.abortController.abort(reason);
    }
    if (!pending.runtimeUnbound) {
      pending.runtimeUnbound = true;
      this.#unbindSystemSender(pending.runtimeSenderId);
    }
    this.#queuePendingRevocation(pending, pending.runtimeIssued.channelId);
    if (pending.browserIssued) {
      this.#queuePendingRevocation(pending, pending.browserIssued.channelId);
    }
    this.#requestPendingPreparationAbort(pending);
  }

  #preparedViewerBinding(pending: PendingUiOperation): PreparedViewerBinding {
    const { browserIssued, instanceId } = pending;
    if (!browserIssued || !instanceId) {
      throw new Error("App Capsule candidate is not ready for Host verification");
    }
    const assertCurrent = () => this.#assertPendingUiCurrent(
      pending,
      pending.previousViewer ? "reload" : "launch",
    );
    const assertStreamAuthority = () => {
      if (
        this.#pendingUiOperations.get(pending.appId) === pending
        && !pending.abortController.signal.aborted
      ) {
        assertCurrent();
        return;
      }
      const committed = this.#viewers.get(pending.viewerId);
      if (
        committed
        && committed.appId === pending.appId
        && committed.instanceId === instanceId
        && committed.channelId === browserIssued.channelId
        && committed.capability === browserIssued.capability
      ) {
        return;
      }
      assertCurrent();
      throw new Error("App viewer stream authority is no longer current");
    };
    return Object.freeze({
      viewerId: pending.viewerId,
      appId: pending.appId,
      instanceId,
      channelId: browserIssued.channelId,
      capability: browserIssued.capability,
      signal: pending.abortController.signal,
      openUiStream: async (): Promise<Duplex> => {
        assertStreamAuthority();
        const stream = await this.#backend.openUiStream(instanceId);
        try {
          assertStreamAuthority();
          return stream;
        } catch (error) {
          stream.destroy();
          throw error;
        }
      },
      assertCurrent,
      invalidate: (error: Error): void => {
        this.#cancelPendingUiOperation(pending, error);
      },
    });
  }

  #assertGenerationCurrent(generation: number, operation: "launch" | "reload"): void {
    if (generation !== this.#generation || this.#stoppingAll) {
      throw new Error(`App Capsule ${operation} was cancelled`);
    }
  }

  #assertOpeningCurrent(
    opening: OpeningViewerContext,
    generation: number,
  ): void {
    this.#assertGenerationCurrent(generation, "launch");
    if (
      opening.abortController.signal.aborted
      || this.#openingOperations.get(opening.appId)?.abortController
        !== opening.abortController
    ) {
      throw new Error("App Capsule launch was cancelled");
    }
  }

  #assertViewerCurrent(
    viewer: StoredViewer,
    generation: number,
    operation: "reload",
  ): void {
    this.#assertGenerationCurrent(generation, operation);
    if (this.#viewers.get(viewer.viewerId) !== viewer) {
      throw new Error(`App Capsule ${operation} was cancelled`);
    }
  }

  #assertPendingUiCurrent(
    pending: PendingUiOperation,
    operation: "launch" | "reload",
  ): void {
    if (pending.candidateLost) throw pending.candidateLost.error;
    if (pending.previousLost) throw pending.previousLost.error;
    this.#assertGenerationCurrent(pending.generation, operation);
    if (
      this.#pendingUiOperations.get(pending.appId) !== pending
      || pending.abortController.signal.aborted
      || this.#stoppingApps.has(pending.appId)
    ) {
      throw new Error(`App Capsule ${operation} was cancelled`);
    }
    if (
      pending.previousViewer
      && this.#viewers.get(pending.previousViewer.viewerId) !== pending.previousViewer
      && this.#viewers.get(pending.previousViewer.viewerId) !== pending.committedViewer
    ) {
      throw new Error("App Capsule reload was cancelled");
    }
  }

  async #failPendingUiOperation(
    pending: PendingUiOperation,
    cause: unknown,
  ): Promise<never> {
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    this.#cancelPendingUiOperation(
      pending,
      failure,
    );
    if (pending.preparationCommitted) {
      const committedInstanceId = pending.committedInstanceId ?? pending.instanceId;
      if (committedInstanceId) {
        let stop: Promise<void>;
        try {
          stop = this.#backend.stopUi(committedInstanceId);
        } catch (error) {
          stop = Promise.reject(error);
        }
        this.#trackPendingCleanup(pending, stop);
      }
      // commitPreparedUi is the irreversible runtime boundary: a replacement
      // has retired its prior workload. If Host publication then fails, the
      // old StoredViewer must not continue claiming that dead generation.
      const previous = pending.previousViewer;
      const committed = pending.committedViewer;
      const current = this.#viewers.get(pending.viewerId);
      if (
        previous
        && !pending.previousDetached
        && (current === previous || (committed !== undefined && current === committed))
      ) {
        pending.previousDetached = true;
        this.#viewers.delete(previous.viewerId);
        this.#unbindSystemSender(previous.runtimeSenderId);
        let hostCleanup: void | Promise<void>;
        try {
          hostCleanup = this.#onUiLost?.({
            instanceId: committed?.instanceId ?? previous.instanceId,
            appId: previous.appId,
            error: failure,
            viewerId: previous.viewerId,
          });
        } catch (error) {
          hostCleanup = Promise.reject(error);
        }
        this.#trackPendingCleanup(pending, Promise.resolve(hostCleanup));
        this.#queuePendingRevocation(pending, previous.channelId);
        this.#queuePendingRevocation(pending, previous.runtimeChannelId);
      }
    }
    this.#queuePendingRevocation(pending, pending.runtimeIssued.channelId);
    if (pending.browserIssued) {
      this.#queuePendingRevocation(pending, pending.browserIssued.channelId);
    }
    let settledCleanupCount = 0;
    while (settledCleanupCount < pending.cleanupTasks.length) {
      const batch = pending.cleanupTasks.slice(settledCleanupCount);
      settledCleanupCount += batch.length;
      await Promise.all(batch);
    }
    this.#finishPendingUiOperation(pending);

    const cleanupFailures = pending.cleanupFailures
      .filter((failure) => !failure.controlPlane || !this.#controlPlaneLost)
      .map((failure) => failure.error);
    if (cleanupFailures.length > 0 || pending.commitContractViolated) {
      if (!this.#controlPlaneLost) {
        const appWide = await Promise.allSettled([
          this.#revokeAppCapabilities(pending.appId),
        ]);
        if (!this.#controlPlaneLost) {
          cleanupFailures.push(...appWide
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason));
        }
      }
      return await this.#collapseBackendBoundary([
        pending.candidateLost?.error ?? pending.previousLost?.error ?? failure,
        ...cleanupFailures,
      ]);
    }
    throw failure;
  }

  async #settleUnexpectedUiLoss(
    viewer: StoredViewer,
    cause: Error,
    hostCleanup: void | Promise<void>,
  ): Promise<void> {
    const results = await Promise.allSettled([
      Promise.resolve(hostCleanup),
      this.#revokeCapability(viewer.channelId),
      this.#revokeCapability(viewer.runtimeChannelId),
    ]);
    const hostFailures = results.slice(0, 1)
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    const controlPlaneFailures = this.#controlPlaneLost
      ? []
      : results.slice(1)
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
    const failures = [...hostFailures, ...controlPlaneFailures];
    if (failures.length === 0) return;

    if (!this.#controlPlaneLost) {
      const appWideRevoke = await Promise.allSettled([
        this.#revokeAppCapabilities(viewer.appId),
      ]);
      if (!this.#controlPlaneLost) {
        failures.push(...appWideRevoke
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason));
      }
    }
    await this.#collapseBackendBoundary([cause, ...failures]);
  }

  async #prepareActivation(appId: string): Promise<PreparedActivation> {
    const response = await this.#hostRequest(
      `/api/apps/${encodeURIComponent(appId)}/activation/prepare`,
      { method: "POST", body: JSON.stringify({ workload: "ui" }) },
    );
    const body = await response.json() as { activation?: Partial<PreparedActivation> };
    const activation = body.activation;
    if (
      activation?.schemaVersion !== 1
      || activation.appId !== appId
      || activation.workload !== "ui"
      || !/^activation_[A-Za-z0-9_-]{32}$/.test(activation.activationId ?? "")
      || !Number.isSafeInteger(activation.activationSequence)
      || (activation.activationSequence ?? 0) < 1
      || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(activation.version ?? "")
      || !APP_MANIFEST_DIGEST_PATTERN.test(activation.manifestDigest ?? "")
      || !APP_MANIFEST_DIGEST_PATTERN.test(activation.packageDigest ?? "")
      || typeof activation.immutablePackagePath !== "string"
      || !activation.manifest
      || typeof activation.manifest !== "object"
    ) {
      throw new Error("Core returned an invalid App activation record");
    }
    return activation as PreparedActivation;
  }

  async #issueCapability(activation: PreparedActivation): Promise<IssuedCapability> {
    const response = await this.#hostRequest("/api/app-runtime/channels", {
      method: "POST",
      body: JSON.stringify({
        appId: activation.appId,
        workload: activation.workload,
        activationId: activation.activationId,
      }),
    });
    const issued = await response.json() as Partial<IssuedCapability>;
    if (
      typeof issued.capability !== "string"
      || typeof issued.channelId !== "string"
      || issued.activationId !== activation.activationId
      || issued.appCommit !== activation.version
      || issued.manifestDigest !== activation.manifestDigest
      || issued.packageDigest !== activation.packageDigest
    ) {
      throw new Error("Core returned a capability for a different App activation");
    }
    return issued as IssuedCapability;
  }

  async #releaseActivation(activationId: string): Promise<void> {
    await this.#hostRequest(`/api/apps/activation/${encodeURIComponent(activationId)}`, {
      method: "DELETE",
    });
  }

  async #revokeCapability(channelId: string): Promise<void> {
    await this.#hostRequest(`/api/app-runtime/channels/${encodeURIComponent(channelId)}`, {
      method: "DELETE",
    });
  }

  async #revokeAppCapabilities(appId: string): Promise<void> {
    await this.#hostRequest(`/api/app-runtime/apps/${encodeURIComponent(appId)}/channels`, {
      method: "DELETE",
    });
  }

  async #hostRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const controlPlane = this.#controlPlaneRequests.signal;
    if (controlPlane.aborted) throw controlPlane.reason;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.#coreToken}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await withAbortSignal(
      this.#fetch(`${this.#coreBaseUrl()}${path}`, {
        ...init,
        headers,
        signal: controlPlane,
      }),
      controlPlane,
    );
    if (response.ok) return response;
    const body = await response.json().catch(() => ({})) as {
      error?: string | { code?: unknown; message?: unknown };
    };
    const message = typeof body.error === "string"
      ? body.error
      : body.error && typeof body.error.message === "string"
        ? body.error.message
        : `Core returned HTTP ${response.status}`;
    throw new AppControlPlaneError(
      body.error && typeof body.error === "object" && typeof body.error.code === "string"
        ? body.error.code
        : "APP_CONTROL_PLANE_ERROR",
      message,
    );
  }
}

class AppControlPlaneError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AppControlPlaneError";
  }
}

class ControlPlaneLostError extends Error {
  constructor() {
    super("Core control plane is unavailable");
    this.name = "ControlPlaneLostError";
  }
}

function validatedViewerOwner(owner: AppViewerOwner): AppViewerOwner {
  if (
    !owner
    || !Number.isSafeInteger(owner.webContentsId)
    || owner.webContentsId < 1
    || !Number.isSafeInteger(owner.rendererGeneration)
    || owner.rendererGeneration < 0
  ) {
    throw new Error("Invalid App viewer owner");
  }
  return Object.freeze({
    webContentsId: owner.webContentsId,
    rendererGeneration: owner.rendererGeneration,
  });
}

function sameViewerOwner(left: AppViewerOwner, right: AppViewerOwner): boolean {
  return left.webContentsId === right.webContentsId
    && left.rendererGeneration === right.rendererGeneration;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : error === undefined ? "" : String(error);
}

function isExpectedCancellation(error: unknown): boolean {
  if (error instanceof ControlPlaneLostError) return true;
  const message = errorMessage(error).toLowerCase();
  return message.includes("cancelled") || message.includes("is stopping");
}

async function withAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
