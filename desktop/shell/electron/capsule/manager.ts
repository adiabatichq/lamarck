import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import type {
  CapsuleBackend,
  CapsuleBackendStatus,
  CapsuleUiLostEvent,
} from "./backend";

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface AppInfo {
  id: string;
  runtime: {
    ui?: { command: string[]; port: number };
    services?: Record<string, { command: string[] }>;
    jobs?: Record<string, { command: string[] }>;
  };
}

interface IssuedCapability {
  capability: string;
  channelId: string;
}

export interface OpenedAppViewer {
  viewerId: string;
  appId: string;
  instanceId: string;
  channelId: string;
  /** Main-process only. Never serialize this object into App or Shell code. */
  capability: string;
}

export interface ReloadedBrowserBinding {
  readonly viewerId: string;
  readonly channelId: string;
  /** Main-process only. It must never be returned across IPC. */
  readonly capability: string;
}

export interface ReloadedApp {
  readonly active: boolean;
  readonly browserBindings: readonly ReloadedBrowserBinding[];
}

interface StoredViewer extends OpenedAppViewer {
  ownerWebContentsId: number;
  runtimeChannelId: string;
  runtimeSenderId: string;
}

interface PendingUiOperation {
  readonly appId: string;
  readonly runtimeIssued: IssuedCapability;
  readonly runtimeSenderId: string;
  readonly previousViewer?: StoredViewer;
  readonly cleanupTasks: Promise<void>[];
  readonly cleanupFailures: unknown[];
  readonly queuedRevocations: Set<string>;
  browserIssued?: IssuedCapability;
  instanceId?: string;
  lost?: CapsuleUiLostEvent;
  runtimeUnbound: boolean;
  previousDetached: boolean;
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
 * through the owner id on every operation.
 */
export class CapsuleManager {
  readonly #backend: CapsuleBackend;
  readonly #workspacePath: () => string;
  readonly #coreBaseUrl: () => string;
  readonly #coreToken: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #bindSystemSender: CapsuleManagerOptions["bindSystemSender"];
  readonly #unbindSystemSender: CapsuleManagerOptions["unbindSystemSender"];
  readonly #onBackendBoundaryLost: ((error: unknown) => void) | undefined;
  readonly #onUiLost: CapsuleManagerOptions["onUiLost"];
  readonly #viewers = new Map<string, StoredViewer>();
  readonly #openingApps = new Set<string>();
  readonly #openingOperations = new Map<string, Promise<unknown>>();
  readonly #rebuildOperations = new Map<string, Promise<unknown>>();
  readonly #pendingUiOperations = new Map<string, PendingUiOperation>();
  readonly #stopOperations = new Map<string, Promise<void>>();
  readonly #stoppingApps = new Set<string>();
  #stoppingAll = false;
  #generation = 0;

  constructor(options: CapsuleManagerOptions) {
    this.#backend = options.backend;
    this.#workspacePath = options.workspacePath;
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
    return this.#backend.status();
  }

  async openViewer(appId: string, ownerWebContentsId: number): Promise<OpenedAppViewer> {
    if (!APP_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    if (
      this.#stoppingAll
      || this.#openingApps.has(appId)
      || this.#stoppingApps.has(appId)
      || [...this.#viewers.values()].some((viewer) => viewer.appId === appId)
    ) {
      throw new Error(`App "${appId}" already has an active viewer`);
    }
    this.#openingApps.add(appId);
    const generation = this.#generation;
    const operation = this.#openViewer(appId, ownerWebContentsId, generation);
    this.#openingOperations.set(appId, operation);
    try {
      return await operation;
    } finally {
      if (this.#openingOperations.get(appId) === operation) {
        this.#openingOperations.delete(appId);
      }
      this.#openingApps.delete(appId);
    }
  }

  async #openViewer(
    appId: string,
    ownerWebContentsId: number,
    generation: number,
  ): Promise<OpenedAppViewer> {
    const status = await this.#backend.status();
    if (!status.available) {
      throw new Error(`App Capsule unavailable: ${status.reason ?? status.backend}`);
    }

    const app = await this.#loadApp(appId);
    this.#assertSupportedRuntime(app);
    if (!app.runtime.ui) throw new Error(`App "${appId}" does not declare a UI workload`);
    const runtimeIssued = await this.#issueCapability(appId, "ui");
    const runtimeSenderId = `capsule_${randomBytes(24).toString("base64url")}`;
    try {
      this.#bindSystemSender(runtimeSenderId, runtimeIssued);
    } catch (error) {
      await this.#revokeCapability(runtimeIssued.channelId).catch(() => {});
      throw error;
    }
    if (generation !== this.#generation) {
      this.#unbindSystemSender(runtimeSenderId);
      await this.#revokeCapability(runtimeIssued.channelId).catch(() => {});
      throw new Error("App Capsule launch was cancelled");
    }

    let browserIssued: IssuedCapability | null = null;
    let instanceId: string | null = null;
    const pending = this.#beginPendingUiOperation({
      appId,
      runtimeIssued,
      runtimeSenderId,
    });
    try {
      const instance = await this.#backend.startUi({
        appId,
        packageDir: join(this.#workspacePath(), "apps", appId),
        command: [...app.runtime.ui.command],
        port: app.runtime.ui.port,
        sdkSenderId: runtimeSenderId,
      });
      instanceId = instance.instanceId;
      pending.instanceId = instance.instanceId;
      if (pending.lost) throw pending.lost.error;
      if (generation !== this.#generation) {
        throw new Error("App Capsule launch was cancelled");
      }
      browserIssued = await this.#issueCapability(appId, "ui");
      pending.browserIssued = browserIssued;
      // The backend loss callback can mutate this record while the capability
      // request is awaiting even though TypeScript cannot observe that alias.
      const lostAfterCapability = pending.lost as CapsuleUiLostEvent | undefined;
      if (lostAfterCapability) throw lostAfterCapability.error;
      if (generation !== this.#generation) {
        throw new Error("App Capsule launch was cancelled");
      }
      const viewer: StoredViewer = Object.freeze({
        viewerId: `viewer_${randomBytes(16).toString("base64url")}`,
        appId,
        instanceId: instance.instanceId,
        channelId: browserIssued.channelId,
        capability: browserIssued.capability,
        ownerWebContentsId,
        runtimeChannelId: runtimeIssued.channelId,
        runtimeSenderId,
      });
      this.#viewers.set(viewer.viewerId, viewer);
      this.#finishPendingUiOperation(pending);
      return viewer;
    } catch (error) {
      return await this.#failPendingUiOperation(pending, instanceId, error);
    }
  }

  getViewer(viewerId: string, ownerWebContentsId: number): OpenedAppViewer | null {
    const viewer = this.#viewers.get(viewerId);
    return viewer?.ownerWebContentsId === ownerWebContentsId ? viewer : null;
  }

  openViewerStream(viewerId: string): Promise<Duplex> {
    const viewer = this.#viewers.get(viewerId);
    if (!viewer) throw new Error("App viewer is no longer active");
    return this.#backend.openUiStream(viewer.instanceId);
  }

  async closeViewer(viewerId: string, ownerWebContentsId: number): Promise<boolean> {
    const viewer = this.#viewers.get(viewerId);
    if (!viewer || viewer.ownerWebContentsId !== ownerWebContentsId) return false;
    this.#viewers.delete(viewerId);
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

  async closeOwner(ownerWebContentsId: number): Promise<void> {
    const ids = [...this.#viewers.values()]
      .filter((viewer) => viewer.ownerWebContentsId === ownerWebContentsId)
      .map((viewer) => viewer.viewerId);
    await Promise.all(ids.map((id) => this.closeViewer(id, ownerWebContentsId)));
  }

  async reloadApp(appId: string): Promise<ReloadedApp> {
    if (!APP_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    if (this.#stoppingAll || this.#stoppingApps.has(appId)) {
      throw new Error(`App "${appId}" is stopping`);
    }
    const activeViewer = [...this.#viewers.values()].find((viewer) => viewer.appId === appId);
    if (!activeViewer) return { active: false, browserBindings: [] };
    const existing = this.#rebuildOperations.get(appId);
    if (existing) {
      return await existing as ReloadedApp;
    }
    const operation = this.#reloadApp(activeViewer, this.#generation);
    this.#rebuildOperations.set(appId, operation);
    try {
      return await operation;
    } finally {
      if (this.#rebuildOperations.get(appId) === operation) {
        this.#rebuildOperations.delete(appId);
      }
    }
  }

  async #reloadApp(viewer: StoredViewer, generation: number): Promise<ReloadedApp> {
    const app = await this.#loadApp(viewer.appId);
    this.#assertSupportedRuntime(app);
    if (!app.runtime.ui) throw new Error(`App "${viewer.appId}" does not declare a UI workload`);
    const runtimeIssued = await this.#issueCapability(viewer.appId, "ui");
    const browserIssued = await this.#issueCapability(viewer.appId, "ui").catch(async (error) => {
      await this.#revokeCapability(runtimeIssued.channelId).catch(() => {});
      throw error;
    });
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

    let replacement: { instanceId: string } | undefined;
    const pending = this.#beginPendingUiOperation({
      appId: viewer.appId,
      runtimeIssued,
      runtimeSenderId,
      browserIssued,
      previousViewer: viewer,
    });
    try {
      if (generation !== this.#generation || this.#viewers.get(viewer.viewerId) !== viewer) {
        throw new Error("App Capsule reload was cancelled");
      }
      replacement = await this.#backend.replaceUi(viewer.instanceId, {
        appId: viewer.appId,
        packageDir: join(this.#workspacePath(), "apps", viewer.appId),
        command: [...app.runtime.ui.command],
        port: app.runtime.ui.port,
        sdkSenderId: runtimeSenderId,
      });
      pending.instanceId = replacement.instanceId;
      if (pending.lost) throw pending.lost.error;
      if (generation !== this.#generation || this.#viewers.get(viewer.viewerId) !== viewer) {
        throw new Error("App Capsule reload was cancelled");
      }

      const updated: StoredViewer = Object.freeze({
        ...viewer,
        instanceId: replacement.instanceId,
        channelId: browserIssued.channelId,
        capability: browserIssued.capability,
        runtimeChannelId: runtimeIssued.channelId,
        runtimeSenderId,
      });
      this.#viewers.set(viewer.viewerId, updated);
      this.#finishPendingUiOperation(pending);
      this.#unbindSystemSender(viewer.runtimeSenderId);
      const revoked = await Promise.allSettled([
        this.#revokeCapability(viewer.channelId),
        this.#revokeCapability(viewer.runtimeChannelId),
      ]);
      const failures = revoked
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) return await this.#collapseBackendBoundary(failures);
      if (generation !== this.#generation || this.#viewers.get(viewer.viewerId) !== updated) {
        throw new Error("App Capsule replacement stopped before Host publication completed");
      }
      return {
        active: true,
        browserBindings: [{
          viewerId: viewer.viewerId,
          channelId: browserIssued.channelId,
          capability: browserIssued.capability,
        }],
      };
    } catch (error) {
      // Once the replacement is in #viewers it is an active generation. Any
      // unexpected loss is synchronously detached and settled by
      // #handleUnexpectedUiLoss; issuing duplicate revocations here would
      // turn an idempotent teardown into a false boundary-loss signal.
      if (this.#pendingUiOperations.get(pending.appId) !== pending) throw error;
      return await this.#failPendingUiOperation(
        pending,
        replacement?.instanceId ?? null,
        error,
      );
    }
  }

  stopApp(appId: string): Promise<void> {
    if (!APP_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    const existing = this.#stopOperations.get(appId);
    if (existing) return existing;
    this.#stoppingApps.add(appId);
    this.#generation += 1;
    let tracked: Promise<void>;
    tracked = this.#stopApp(appId).finally(() => {
      this.#stoppingApps.delete(appId);
      if (this.#stopOperations.get(appId) === tracked) this.#stopOperations.delete(appId);
    });
    this.#stopOperations.set(appId, tracked);
    return tracked;
  }

  async #stopApp(appId: string): Promise<void> {
    const pending = [
      this.#openingOperations.get(appId),
      this.#rebuildOperations.get(appId),
    ].filter((operation): operation is Promise<unknown> => operation !== undefined);
    await Promise.allSettled(pending);
    const viewers = [...this.#viewers.values()].filter((viewer) => viewer.appId === appId);
    for (const viewer of viewers) {
      this.#viewers.delete(viewer.viewerId);
      this.#unbindSystemSender(viewer.runtimeSenderId);
    }
    const results = await Promise.allSettled([
      this.#backend.stopApp(appId),
      this.#revokeAppCapabilities(appId),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, `Could not stop App "${appId}"`);
  }

  async stopAll(): Promise<void> {
    if (this.#stoppingAll) return;
    this.#stoppingAll = true;
    this.#generation += 1;
    try {
      await Promise.allSettled([
        ...this.#openingOperations.values(),
        ...this.#rebuildOperations.values(),
        ...this.#stopOperations.values(),
      ]);
      const viewers = [...this.#viewers.values()];
      this.#viewers.clear();
      for (const viewer of viewers) this.#unbindSystemSender(viewer.runtimeSenderId);
      const results = await Promise.allSettled([
        this.#backend.stopAll(),
        ...viewers.flatMap((viewer) => [
          this.#revokeCapability(viewer.channelId),
          this.#revokeCapability(viewer.runtimeChannelId),
        ]),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "Could not fully stop App Capsules");
    } finally {
      this.#stoppingAll = false;
    }
  }

  async #collapseBackendBoundary(causes: unknown[]): Promise<never> {
    this.#generation += 1;
    const remaining = [...this.#viewers.values()];
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
    throw new AggregateError(causes, "App Capsule backend boundary was lost");
  }

  #handleUnexpectedUiLoss(event: CapsuleUiLostEvent): void {
    const pending = this.#pendingUiOperations.get(event.appId);
    if (pending) {
      this.#generation += 1;
      this.#markPendingUiLost(pending, event);
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
    void this.#settleUnexpectedUiLoss(viewer, event.error, hostCleanup).catch(() => {});
  }

  #beginPendingUiOperation(
    operation: Omit<PendingUiOperation,
      "cleanupTasks" | "cleanupFailures" | "queuedRevocations"
      | "runtimeUnbound" | "previousDetached">,
  ): PendingUiOperation {
    if (this.#pendingUiOperations.has(operation.appId)) {
      throw new Error(`App "${operation.appId}" already has a pending UI operation`);
    }
    const pending: PendingUiOperation = {
      ...operation,
      cleanupTasks: [],
      cleanupFailures: [],
      queuedRevocations: new Set(),
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

  #markPendingUiLost(pending: PendingUiOperation, event: CapsuleUiLostEvent): void {
    if (pending.lost) return;
    pending.lost = event;
    if (!pending.runtimeUnbound) {
      pending.runtimeUnbound = true;
      this.#unbindSystemSender(pending.runtimeSenderId);
    }
    this.#queuePendingRevocation(pending, pending.runtimeIssued.channelId);
    if (pending.browserIssued) {
      this.#queuePendingRevocation(pending, pending.browserIssued.channelId);
    }

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
    this.#trackPendingCleanup(pending, this.#revokeCapability(channelId));
  }

  #trackPendingCleanup(pending: PendingUiOperation, operation: Promise<unknown>): void {
    const tracked = operation.then(
      () => {},
      (error) => { pending.cleanupFailures.push(error); },
    );
    pending.cleanupTasks.push(tracked);
  }

  async #failPendingUiOperation(
    pending: PendingUiOperation,
    instanceId: string | null,
    cause: unknown,
  ): Promise<never> {
    if (!pending.runtimeUnbound) {
      pending.runtimeUnbound = true;
      this.#unbindSystemSender(pending.runtimeSenderId);
    }
    if (instanceId) {
      this.#trackPendingCleanup(pending, this.#backend.stopUi(instanceId));
    }
    this.#queuePendingRevocation(pending, pending.runtimeIssued.channelId);
    if (pending.browserIssued) {
      this.#queuePendingRevocation(pending, pending.browserIssued.channelId);
    }
    await Promise.all(pending.cleanupTasks);
    this.#finishPendingUiOperation(pending);

    if (pending.lost && pending.cleanupFailures.length > 0) {
      const appWide = await Promise.allSettled([
        this.#revokeAppCapabilities(pending.appId),
      ]);
      pending.cleanupFailures.push(...appWide
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason));
      return await this.#collapseBackendBoundary([
        pending.lost.error,
        ...pending.cleanupFailures,
      ]);
    }
    throw cause;
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
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 0) return;

    const appWideRevoke = await Promise.allSettled([
      this.#revokeAppCapabilities(viewer.appId),
    ]);
    failures.push(...appWideRevoke
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason));
    await this.#collapseBackendBoundary([cause, ...failures]);
  }

  #assertSupportedRuntime(app: AppInfo): void {
    const services = Object.keys(app.runtime.services ?? {});
    const jobs = Object.keys(app.runtime.jobs ?? {});
    if (services.length === 0 && jobs.length === 0) return;
    const declarations = [
      ...(services.length > 0 ? [`services (${services.join(", ")})`] : []),
      ...(jobs.length > 0 ? [`jobs (${jobs.join(", ")})`] : []),
    ].join(" and ");
    throw new Error(
      `App "${app.id}" declares ${declarations}, but this Host only supports UI workloads`,
    );
  }

  async #loadApp(appId: string): Promise<AppInfo> {
    const response = await this.#hostRequest("/api/apps");
    const body = await response.json() as { apps?: AppInfo[] };
    const app = body.apps?.find((candidate) => candidate.id === appId);
    if (!app) throw new Error(`App not found: ${appId}`);
    return app;
  }

  async #issueCapability(appId: string, workload: "ui"): Promise<IssuedCapability> {
    const response = await this.#hostRequest("/api/app-runtime/channels", {
      method: "POST",
      body: JSON.stringify({ appId, workload }),
    });
    return await response.json() as IssuedCapability;
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
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.#coreToken}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await this.#fetch(`${this.#coreBaseUrl()}${path}`, { ...init, headers });
    if (response.ok) return response;
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Core returned HTTP ${response.status}`);
  }
}
