import { setTimeout as delay } from "node:timers/promises";
import { CapsuleDiagnostics } from "./diagnostics";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import type {
  CapsuleBackend,
  CapsuleBackendStatus,
  CapsuleUiLostEvent,
  CapsuleUiSpec,
  CapsuleUiInstance,
  CapsuleJobSpec,
  CapsuleServiceSpec,
} from "./backend";
import { CapsuleRestartRequiredError, isCapsuleRestartRequiredError } from "./backend";
import type { AppActiveJob, AppRuntimeAggregate, AppServiceState, AppWorkloadDiagnostic } from "../../shared/app-runtime";
export type { AppRuntimeAggregate } from "../../shared/app-runtime";
import {
  APP_MANIFEST_DIGEST_PATTERN,
  type AppManifestDigest,
} from "../../../capsule/src/app-manifest-authority";
import { PACKAGE_ID_PATTERN } from "../package-id";

const STOP_ALL_QUIESCENCE_TIMEOUT_MS = 20_000;

interface PreparedActivation {
  mode: "normal" | "exp";
  schemaVersion: 1;
  activationId: string;
  activationSequence: number;
  appId: string;
  workload: "ui" | `job:${string}` | `service:${string}`;
  version: string;
  manifestDigest: AppManifestDigest;
  packageDigest: `sha256:${string}`;
  immutablePackagePath: string;
  manifest: {
    runtime: {
      ui?: { command: string[]; port: number };
      jobs?: Record<string, { command: string[] }>;
      services?: Record<string, { command: string[] }>;
    };
    permissions: {
      writes: {
        files: string[];
        tables: string[];
      };
    };
  };
}

interface IssuedCapability {
  mode: "normal" | "exp";
  capability: string;
  channelId: string;
  activationId: string;
  appCommit: string;
  manifestDigest: AppManifestDigest;
  packageDigest: `sha256:${string}`;
}

export interface OpenedAppViewer {
  readonly mode: "normal" | "exp";
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
  readonly mode: "normal" | "exp";
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
  readonly mode: "normal" | "exp";
  readonly startupDeadlineMs?: number;
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

interface BackgroundOperation {
  kind: "job" | "service";
  version: string | null;
  runningAt: number | null;
  appId: string;
  workloadId: string;
  triggerId: string | null;
  state: AppActiveJob["state"];
  cleanupError: string | null;
  boundaryCleanupError: string | null;
  cleanupChannelId: string | null;
  cleanupActivationId: string | null;
  startupObservation?: Promise<void>;
  cancellation?: Promise<unknown>;
  controller: AbortController;
  task: Promise<void>;
}

interface ServicePolicy {
  enabled: boolean;
  revision: number;
  restartBaseMs: number;
  restartMaxMs: number;
  crashCount: number;
  restartAt: number | null;
  lastError: string | null;
  cleanupFailed: boolean;
}
interface ServiceDesired {
  appId: string;
  serviceId: string;
  version: string | null;
  appEnabled?: boolean;
  policy: ServicePolicy | null;
  observationPending?: boolean;
}

interface AppRuntimeFailure {
  message: string;
  recoverableCleanup: boolean;
  workloadKey?: string;
  previous?: AppRuntimeFailure;
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
  startupDeadlineMs?: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  instanceId?: string;
  committedInstanceId?: string;
  committedViewer?: StoredViewer;
  candidateLost?: CapsuleUiLostEvent;
  previousLost?: CapsuleUiLostEvent;
  commitContractViolated: boolean;
  preparationCommitting?: boolean;
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
  bindSystemSender(senderId: string, binding: IssuedCapability & { appId: string }): void;
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
  readonly #workloads = new Map<string, BackgroundOperation>();
  readonly #diagnostics: CapsuleDiagnostics;
  readonly #servicePolicies = new Map<string, ServiceDesired>();
  #serviceGeneration = 0;
  #cleanBoundaryConfirmed = false;
  readonly #serviceObservations = new Map<string, Promise<void>>();
  readonly #appEnablement = new Map<string, boolean>();
  readonly #appBlocked = new Set<string>();
  readonly #appModes = new Map<string, "normal" | "exp">();
  readonly #modeChanges = new Set<string>();
  readonly #appSettingOperations = new Map<string, Promise<void>>();
  readonly #appSettingEpochs = new Map<string, number>();
  readonly #serviceChanges = new Map<string, number>();
  readonly #serviceManagement = new Map<Promise<void>, string>();
  readonly #serviceAppEpochs = new Map<string, number>();
  #serviceHostEpoch = 0;
  #serviceLoop: { controller: AbortController; task: Promise<void> } | null = null;
  #serviceReconciliation: Promise<void> | null = null;
  readonly #viewers = new Map<string, StoredViewer>();
  readonly #openingApps = new Set<string>();
  readonly #openingOperations = new Map<string, OpeningViewerOperation>();
  readonly #rebuildOperations = new Map<string, Promise<unknown>>();
  readonly #pendingUiOperations = new Map<string, PendingUiOperation>();
  readonly #stopOperations = new Map<string, Promise<void>>();
  readonly #retireOperations = new Map<string, Promise<void>>();
  readonly #uiCleanupOperations = new Map<Promise<void>, string>();
  readonly #latestFailureByApp = new Map<string, AppRuntimeFailure>();
  readonly #stoppingApps = new Set<string>();
  #stoppingAll = false;
  #stopAllOperation: Promise<void> | null = null;
  #terminalFailure: CapsuleRestartRequiredError | null = null;
  #controlPlaneRequests = new AbortController();
  #controlPlaneLost = false;
  #generation = 0;
  #jobAvailabilityCache: { available: boolean; checkedAt: number } | null = null;
  #jobAvailabilityProbe: Promise<boolean> | null = null;

  constructor(options: CapsuleManagerOptions) {
    this.#backend = options.backend;
    this.#diagnostics = new CapsuleDiagnostics([options.coreToken]);
    this.#coreBaseUrl = options.coreBaseUrl;
    this.#coreToken = options.coreToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#bindSystemSender = options.bindSystemSender;
    this.#unbindSystemSender = options.unbindSystemSender;
    this.#onBackendBoundaryLost = options.onBackendBoundaryLost;
    this.#onUiLost = options.onUiLost;
    this.#backend.setBoundaryLostHandler?.((error) => {
      this.#cleanBoundaryConfirmed = false;
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
    for (const job of this.#workloads.values()) appIds.add(job.appId);
    for (const id of this.#openingOperations.keys()) appIds.add(id);
    for (const id of this.#stoppingApps) appIds.add(id);
    for (const id of this.#uiCleanupOperations.values()) appIds.add(id);
    for (const policy of this.#servicePolicies.values()) appIds.add(policy.appId);
    for (const appId of this.#appEnablement.keys()) appIds.add(appId);
    for (const appId of this.#appModes.keys()) appIds.add(appId);
    return Object.freeze([...appIds].sort().map((appId) => Object.freeze({
      appId,
      ...(this.#appEnablement.has(appId) ? { enabled: this.#appEnablement.get(appId)! } : {}),
      ...(this.#appModes.has(appId) ? { mode: this.#appModes.get(appId)! } : {}),
      modeChangeAllowed: this.#canChangeMode(appId),
      runningWorkloads: [...this.#viewers.values()]
        .filter((viewer) => viewer.appId === appId).length + [...this.#workloads.values()].filter(job => job.appId === appId).length,
      latestFailure: this.#latestFailureByApp.get(appId)?.message ?? null,
      ui: this.#stoppingApps.has(appId) || [...this.#uiCleanupOperations.values()].includes(appId) ? "stopping" as const
        : [...this.#viewers.values()].some(viewer => viewer.appId === appId) ? "running" as const
        : this.#openingOperations.has(appId) ? "starting" as const : "closed" as const,
      stopping: this.#stoppingApps.has(appId) || this.#stoppingAll,
      jobs: Object.freeze([...this.#workloads].filter(([, job]) => job.appId === appId && job.kind === "job").map(([runId, job]) => Object.freeze({
        runId, jobId: job.workloadId, triggerId: job.triggerId, state: job.state, cleanupError: job.cleanupError,
      }))),
      ...(this.#serviceStates(appId).length ? { services: this.#serviceStates(appId) } : {}),
    })));
  }

  async jobAvailability(): Promise<boolean> {
    return this.#backgroundAvailability("job");
  }

  async #backgroundAvailability(kind: "job" | "service"): Promise<boolean> {
    if (this.#stoppingAll || this.#terminalFailure || !(kind === "job" ? this.#backend.runJob : this.#backend.runService)) return false;
    // A cold backend status probe can launch a helper. Heartbeats must not
    // launch one every 500 ms; actual job admission still checks the boundary.
    if (!this.#jobAvailabilityCache || Date.now() - this.#jobAvailabilityCache.checkedAt >= 30_000) {
      this.#jobAvailabilityProbe ??= Promise.resolve().then(() => this.#backend.status())
        .then(status => status.available, () => false)
        .then(available => { this.#jobAvailabilityCache = { available, checkedAt: Date.now() }; return available; })
        .finally(() => { this.#jobAvailabilityProbe = null; });
      await this.#jobAvailabilityProbe;
    }
    return !this.#stoppingAll && !this.#terminalFailure && !!this.#jobAvailabilityCache?.available;
  }

  runJob(runId: string, appId: string, jobId: string, requestSignal: AbortSignal, triggerId?: string): Promise<void> {
    return this.#runBackground("job", runId, appId, jobId, requestSignal, triggerId);
  }

  #runBackground(kind: "job" | "service", runId: string, appId: string, jobId: string, requestSignal: AbortSignal, triggerId?: string, predecessor?: BackgroundOperation): Promise<void> {
    if (!PACKAGE_ID_PATTERN.test(appId) || !/^[a-z0-9][a-z0-9-]*$/.test(jobId) || !runId || this.#workloads.has(runId)) return Promise.reject(new Error("Invalid or duplicate job dispatch"));
    if (this.#modeChanges.has(appId)) return Promise.reject(new Error("App execution mode is changing"));
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, requestSignal]);
    const entry: BackgroundOperation = {
      kind, version: null, runningAt: null, appId, workloadId: jobId, triggerId: triggerId ?? null, controller, state: "starting",
      cleanupError: null, boundaryCleanupError: null, cleanupChannelId: null,
      cleanupActivationId: null, task: Promise.resolve(),
    };
    this.#diagnostics.begin(appId, kind, jobId, runId);
    let diagnosticFailure: unknown = null;
    const stopping = () => { if (!entry.cleanupError) entry.state = "stopping"; };
    signal.addEventListener("abort", stopping, { once: true });
    if (signal.aborted) stopping();
    const current = () => { signal.throwIfAborted(); if (this.#terminalFailure) throw this.#terminalFailure; if (this.#stoppingAll || this.#stoppingApps.has(appId) || this.#appBlocked.has(appId) || this.#modeChanges.has(appId) || this.#appEnablement.get(appId) === false) throw new Error("App Capsule is stopping or disabled"); };
    const task = Promise.resolve().then(async () => {
      let activation: PreparedActivation | undefined, issued: IssuedCapability | undefined;
      const sender = `capsule_${kind}_${randomBytes(24).toString("base64url")}`;
      try {
        current();
        if (!await this.#backgroundAvailability(kind)) throw new Error(`App ${kind} Capsule backend is unavailable`);
        current();
        activation = await this.#prepareActivation(appId, `${kind}:${jobId}`, id => { entry.cleanupActivationId = id; });
        entry.version = activation.version;
        entry.cleanupActivationId = activation.activationId;
        this.#diagnostics.bind(runId, activation.version, [activation.activationId, sender]); current();
        const job = (kind === "job" ? activation.manifest.runtime.jobs : activation.manifest.runtime.services)?.[jobId];
        if (!job || !Array.isArray(job.command) || !job.command.length || job.command.some(arg => typeof arg !== "string")) throw new Error("App does not declare this job");
        issued = await this.#issueCapability(activation, kind === "job" ? runId : undefined, id => { entry.cleanupChannelId = id; });
        this.#diagnostics.bind(runId, activation.version, [issued.capability, issued.channelId, activation.activationId, sender]);
        entry.cleanupChannelId = issued.channelId; current();
        this.#bindSystemSender(sender, { ...issued, appId }); current();
        const spec: CapsuleJobSpec | CapsuleServiceSpec = {
          mode: issued.mode, appId, ...(kind === "job" ? { jobId } : { serviceId: jobId }), activationId: activation.activationId, activationSequence: activation.activationSequence,
          version: activation.version, manifestDigest: activation.manifestDigest, packageDigest: activation.packageDigest,
          packageDir: activation.immutablePackagePath, command: [...job.command],
          writeTables: [...activation.manifest.permissions.writes.tables],
          fileGrants: [`apps/${appId}/`, ...activation.manifest.permissions.writes.files], sdkSenderId: sender,
        };
        const onState = (state: "running" | "stopping") => {
          entry.state = signal.aborted ? "stopping" : state;
          if (state === "running" && !signal.aborted) {
            entry.runningAt = Date.now();
            if (kind === "service") entry.startupObservation = this.#serviceStarted(appId, jobId, runId);
          }
        };
        const output = (chunk: Uint8Array) => this.#diagnostics.append(runId, chunk);
        if ("jobId" in spec) await this.#backend.runJob!(spec, signal, onState, output);
        else await this.#backend.runService!(spec, signal, onState, output, predecessor ? async () => {
          current();
          predecessor.controller.abort(new Error("Service activation replaced"));
          await predecessor.task;
          if (predecessor.cleanupError) throw new Error(predecessor.cleanupError);
          current();
        } : undefined);
        current();
        if (kind === "service") throw new Error("Service exited unexpectedly");
      } catch (error) {
        diagnosticFailure = error;
        if (isCapsuleRestartRequiredError(error)) {
          entry.state = "cleanup-failed";
          entry.cleanupError = entry.boundaryCleanupError = this.#diagnostics.sanitize(runId, errorMessage(error)).slice(0, 4000);
        }
        const safe = this.#diagnostics.sanitize(runId, errorMessage(error)).slice(0, 4000);
        if (!signal.aborted || entry.cleanupError) this.#recordFailure(appId, new Error(safe), false, `${kind}:${jobId}`);
        if (safe !== errorMessage(error)) throw new Error(safe);
        throw error;
      }
      finally {
        stopping();
        this.#unbindSystemSender(sender);
        await entry.startupObservation?.catch(() => {});
        try { await this.#cleanupWorkloadAuthority(entry); }
        catch (error) { diagnosticFailure = error; throw error; }
        finally { this.#diagnostics.finish(runId, diagnosticFailure); }
      }
    }).finally(async () => {
      // Completion reporting must follow the shared Core cancellation intent,
      // including a fast job whose teardown finishes before the HTTP reply.
      await entry.cancellation?.catch(() => {});
      signal.removeEventListener("abort", stopping);
      if (kind === "job" && !entry.cleanupError) this.#workloads.delete(runId);
    });
    entry.task = task;
    this.#workloads.set(runId, entry);
    return task;
  }

  /** Trusted Host startup; the same operation registry owns every process. */
  startServices(): void {
    if (this.#serviceLoop) throw new Error("Service reconciliation is already running");
    this.#serviceGeneration++;
    const controller = new AbortController();
    const task = Promise.resolve().then(async () => {
      while (!controller.signal.aborted) {
        try { await this.reconcileServices(); } catch { /* Keep the last known policy; never admit from a failed read. */ }
        try { await delay(1500, undefined, { signal: controller.signal }); } catch { break; }
      }
    });
    this.#serviceLoop = { controller, task };
  }

  /** Host viewer resources share the workload cleanup gate, including failed retirement. */
  trackViewerCleanup(appId: string, operation: Promise<unknown>): Promise<void> {
    const task = operation.then(() => {
      this.#uiCleanupOperations.delete(task);
    }, error => {
      // Keep failed Host cleanup owned until the Host is restarted. A process
      // stop alone cannot prove that a renderer/gateway/storage cleanup finished.
      this.#recordFailure(appId, error, true, "ui");
      throw error;
    });
    this.#uiCleanupOperations.set(task, appId);
    void task.catch(() => {});
    return task;
  }

  #canChangeMode(appId: string): boolean {
    let failure = this.#latestFailureByApp.get(appId);
    while (failure) { if (failure.recoverableCleanup) return false; failure = failure.previous; }
    return !this.#stoppingAll && !this.#terminalFailure && !this.#controlPlaneLost
      && !this.#modeChanges.has(appId) && !this.#appSettingOperations.has(appId)
      && !this.#openingOperations.has(appId) && !this.#openingApps.has(appId)
      && ![...this.#uiCleanupOperations.values()].includes(appId)
      && ![...this.#serviceManagement.values()].includes(appId)
      && !this.#rebuildOperations.has(appId) && !this.#stopOperations.has(appId)
      && !this.#retireOperations.has(appId) && !this.#stoppingApps.has(appId)
      && ![...this.#viewers.values(), ...this.#pendingUiOperations.values(), ...this.#workloads.values()].some(value => value.appId === appId)
      && ![...this.#servicePolicies.values()].some(value => value.appId === appId && (value.policy?.cleanupFailed || value.observationPending))
      && ![...this.#serviceChanges.keys()].some(key => key.startsWith(`${appId}:`));
  }

  async setAppMode(appId: string, mode: "normal" | "exp"): Promise<{ appId: string; mode: "normal" | "exp" }> {
    if (!PACKAGE_ID_PATTERN.test(appId) || (mode !== "normal" && mode !== "exp")) throw new Error("Invalid App execution mode");
    if (!this.#canChangeMode(appId)) throw new AppControlPlaneError("APP_MODE_REQUIRES_STOP", "Stop the App and resolve workload cleanup before changing Experiment mode.");
    // Synchronous fence before the first await; admission checks this same set.
    this.#modeChanges.add(appId);
    this.#serviceGeneration++;
    try {
      const response = await this.#hostRequest(`/api/app-runtime/apps/${encodeURIComponent(appId)}/mode`, {
        method: "POST", body: JSON.stringify({ mode }), signal: AbortSignal.timeout(5000),
      });
      const result = await response.json() as { appId: string; mode: "normal" | "exp" };
      if (result.appId !== appId || result.mode !== mode) throw new Error("App execution mode was not acknowledged");
      this.#appModes.set(appId, mode);
      return result;
    } finally { this.#modeChanges.delete(appId); }
  }

  /** Persisted Host admission, with a synchronous fence for every launch path. */
  setAppEnabled(appId: string, enabled: boolean): Promise<void> {
    if (this.#modeChanges.has(appId)) return Promise.reject(new Error("App execution mode is changing"));
    if (typeof appId !== "string" || !PACKAGE_ID_PATTERN.test(appId) || typeof enabled !== "boolean") return Promise.reject(new Error("Invalid App setting"));
    const epoch = (this.#appSettingEpochs.get(appId) ?? 0) + 1;
    this.#appSettingEpochs.set(appId, epoch);
    const hostEpoch = this.#serviceHostEpoch;
    this.#serviceGeneration++;
    if (!enabled) this.#appBlocked.add(appId);
    const stop = !enabled ? this.stopApp(appId) : undefined;
    void stop?.catch(() => {});
    const previous = this.#appSettingOperations.get(appId);
    const current = () => {
      if (hostEpoch !== this.#serviceHostEpoch || epoch !== this.#appSettingEpochs.get(appId) || this.#stoppingAll || this.#terminalFailure) throw new Error("App enablement change was cancelled");
    };
    const task = Promise.resolve(previous).catch(() => {}).then(async () => {
      current();
      if (enabled && (this.#appBlocked.has(appId) || this.#modeChanges.has(appId) || this.#appEnablement.get(appId) === false)) await this.stopApp(appId);
      current();
      const setting = this.#hostRequest(`/api/app-runtime/apps/${encodeURIComponent(appId)}/enablement`, {
        method: "POST", signal: AbortSignal.timeout(5000), body: JSON.stringify({ enabled }),
      }).then(async response => {
        const body = await response.json() as { enabled: boolean };
        if (body.enabled !== enabled) throw new Error("App enablement was not acknowledged");
        this.#appEnablement.set(appId, enabled);
      });
      const results = await Promise.allSettled([setting, stop]);
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "App enablement or workload cleanup was not confirmed");
      current();
      if (enabled) this.#appBlocked.delete(appId);
    }).catch(error => { this.#recordFailure(appId, error, true); throw error; }).finally(() => {
      if (this.#appSettingOperations.get(appId) === task) this.#appSettingOperations.delete(appId);
    });
    this.#appSettingOperations.set(appId, task);
    return task.then(async () => {
      await this.#serviceReconciliation?.catch(() => {});
      current();
      await this.reconcileServices();
    });
  }

  reconcileServices(): Promise<void> {
    if (this.#stoppingAll || this.#terminalFailure) return Promise.resolve();
    if (this.#serviceReconciliation) return this.#serviceReconciliation;
    const generation = this.#serviceGeneration;
    const task = this.#reconcileServices(generation).finally(() => {
      if (this.#serviceReconciliation === task) this.#serviceReconciliation = null;
    });
    this.#serviceReconciliation = task;
    return task;
  }

  async #reconcileServices(generation: number): Promise<void> {
    const response = await this.#hostRequest("/api/app-runtime/services", { signal: AbortSignal.timeout(5000) });
    const body = await response.json() as { apps?: { appId: string; enabled: boolean; mode: "normal" | "exp" }[]; services: ServiceDesired[] };
    if (!Array.isArray(body.services)) throw new Error("Invalid Service policy response");
    if (generation !== this.#serviceGeneration || this.#stoppingAll) return;
    for (const app of body.apps ?? []) {
      if (!PACKAGE_ID_PATTERN.test(app.appId) || typeof app.enabled !== "boolean") throw new Error("Invalid App enablement response");
      if (this.#appSettingOperations.has(app.appId)) continue;
      const previous = this.#appEnablement.get(app.appId);
      if (app.mode !== "normal" && app.mode !== "exp") throw new Error("App execution policy is unavailable");
      this.#appModes.set(app.appId, app.mode);
      this.#appEnablement.set(app.appId, app.enabled);
      if (!app.enabled && (previous !== false || [...this.#workloads.values()].some(value => value.appId === app.appId) || [...this.#viewers.values()].some(value => value.appId === app.appId) || this.#openingOperations.has(app.appId))) {
        void this.stopApp(app.appId).catch(() => {});
        return;
      }
    }
    const desired = new Map(body.services.map(value => {
      if (!PACKAGE_ID_PATTERN.test(value.appId) || !/^[a-z0-9][a-z0-9-]*$/.test(value.serviceId)) throw new Error("Invalid Service identity");
      return [serviceKey(value.appId, value.serviceId), value] as const;
    }));
    for (const [id, service] of this.#servicePolicies) {
      if (desired.has(id)) continue;
      const owned = this.#serviceOperation(service);
      for (const operation of this.#workloads.values()) if (operation.kind === "service" && operation.appId === service.appId && operation.workloadId === service.serviceId) operation.controller.abort(new Error("Service declaration retired"));
      if (!owned) { this.#servicePolicies.delete(id); }
    }
    for (const [id, saved] of desired) {
      if (generation !== this.#serviceGeneration || this.#stoppingAll) return;
      const previous = this.#servicePolicies.get(id);
      // An unacknowledged observation must be saved before another attempt.
      const service = previous?.policy?.revision === saved.policy?.revision && previous?.observationPending
        ? { ...previous, version: saved.version, appEnabled: saved.appEnabled } : saved;
      this.#servicePolicies.set(id, service);
      const owned = this.#serviceOperation(service);
      if (service.observationPending) {
        await this.#observeService(service);
        if (generation !== this.#serviceGeneration) return;
      }
      if (this.#serviceChanges.has(id)) continue;
      if (!service.policy?.enabled || service.appEnabled === false || this.#appEnablement.get(service.appId) === false || this.#appBlocked.has(service.appId) || this.#modeChanges.has(service.appId) || this.#stoppingApps.has(service.appId)) {
        for (const operation of this.#workloads.values()) if (operation.kind === "service" && operation.appId === service.appId && operation.workloadId === service.serviceId) operation.controller.abort(new Error("Service disabled"));
        continue;
      }
      if ((service.policy.restartAt ?? 0) > Date.now()) continue;
      if (owned) {
        const operation = owned[1];
        const matching = [...this.#workloads.values()].filter(value => value.kind === "service" && value.appId === service.appId && value.workloadId === service.serviceId);
        if (matching.length === 1 && operation.state === "running" && !operation.cleanupError && operation.version && service.version && operation.version !== service.version) {
          this.#launchService(service, operation);
        }
        continue;
      }
      if (service.policy.cleanupFailed) {
        if (!this.#cleanBoundaryConfirmed) {
          if (!this.#backend.confirmCleanBoundary) continue;
          await this.#backend.confirmCleanBoundary();
          if (generation !== this.#serviceGeneration || this.#stoppingAll || this.#terminalFailure) return;
        }
        // A current owner, including failed channel/activation cleanup, is
        // never discharged by a clean-boundary proof for an older Host.
        if (this.#serviceOperation(service)) continue;
        service.policy = { ...service.policy, cleanupFailed: false };
        service.observationPending = true;
        await this.#observeService(service);
        if (generation !== this.#serviceGeneration) return;
      }
      this.#launchService(service);
    }
  }

  #serviceOperation(service: Pick<ServiceDesired, "appId" | "serviceId">): [string, BackgroundOperation] | undefined {
    return [...this.#workloads].reverse().find(([, operation]) => operation.kind === "service" && operation.appId === service.appId && operation.workloadId === service.serviceId);
  }

  #launchService(service: ServiceDesired, predecessor?: BackgroundOperation): void {
    const executionId = `service_${randomBytes(24).toString("base64url")}`;
    const task = this.#runBackground("service", executionId, service.appId, service.serviceId, new AbortController().signal, undefined, predecessor);
    const operation = this.#workloads.get(executionId)!;
    const settled = task.catch(() => {}).then(async () => {
      const current = this.#servicePolicies.get(serviceKey(service.appId, service.serviceId));
      if (current?.policy?.revision !== service.policy?.revision || !service.policy) return;
      if (!operation.controller.signal.aborted || operation.cleanupError) {
        const diagnostic = this.#diagnostics.read(service.appId).find(value => value.executionId === executionId);
        const count = operation.runningAt !== null && Date.now() - operation.runningAt >= 60_000 ? 1 : service.policy.crashCount + 1;
        service.policy = { ...service.policy, crashCount: count,
          restartAt: Date.now() + Math.min(service.policy.restartMaxMs, service.policy.restartBaseMs * 2 ** Math.min(count - 1, 16)),
          lastError: diagnostic?.failure ?? "Service exited unexpectedly", cleanupFailed: !!operation.cleanupError || !!predecessor?.cleanupError };
        service.observationPending = true;
        this.#servicePolicies.set(serviceKey(service.appId, service.serviceId), service);
        if (!this.#stoppingAll && !this.#controlPlaneLost) await this.#observeService(service);
      }
    });
    // Stop/retirement joins outcome persistence as well as process cleanup.
    operation.task = settled.finally(() => {
      if (!operation.cleanupError) this.#workloads.delete(executionId);
    });
    void operation.task.catch(() => {});
  }

  #serviceStarted(appId: string, serviceId: string, executionId: string): Promise<void> {
    const service = this.#servicePolicies.get(serviceKey(appId, serviceId));
    if (!service?.policy || this.#serviceOperation(service)?.[0] !== executionId || service.policy.cleanupFailed) return Promise.resolve();
    const cleanupUnresolved = [...this.#workloads.values()].some(value => value.kind === "service" && value.appId === appId && value.workloadId === serviceId && value.cleanupError);
    // Startup, not enablement, clears the active error. Crash count and backoff
    // policy retain their existing stable-run reset semantics.
    service.policy = { ...service.policy, lastError: null };
    service.observationPending = true;
    const prune = (failure?: AppRuntimeFailure): AppRuntimeFailure | undefined => {
      if (!failure) return;
      const previous = prune(failure.previous);
      if (failure.workloadKey === `service:${serviceId}` && (!failure.recoverableCleanup || !cleanupUnresolved)) return previous;
      return { ...failure, previous };
    };
    const current = prune(this.#latestFailureByApp.get(appId));
    if (current) this.#latestFailureByApp.set(appId, current); else this.#latestFailureByApp.delete(appId);
    const observation = this.#observeService(service);
    void observation.catch(() => {});
    return observation;
  }

  #observeService(service: ServiceDesired): Promise<void> {
    const key = serviceKey(service.appId, service.serviceId), policy = service.policy!;
    const previous = this.#serviceObservations.get(key);
    const task = Promise.resolve(previous).catch(() => {}).then(() => this.#persistServiceObservation(service, policy)).finally(() => {
      if (this.#serviceObservations.get(key) === task) this.#serviceObservations.delete(key);
    });
    this.#serviceObservations.set(key, task);
    return task;
  }

  async #persistServiceObservation(service: ServiceDesired, policy: ServicePolicy): Promise<void> {
    const response = await this.#hostRequest(servicePath(service.appId, service.serviceId), {
      method: "POST", signal: AbortSignal.timeout(5000), body: JSON.stringify({ operation: "observe", revision: policy.revision,
        crashCount: policy.crashCount, restartAt: policy.restartAt, lastError: policy.lastError, cleanupFailed: policy.cleanupFailed }),
    }, true);
    if (response.status === 404) { if (service.policy === policy) service.observationPending = false; return; }
    const body = await response.json() as { accepted: boolean };
    // A concurrent policy edit supersedes this observation; refresh before launch.
    if (!body.accepted) throw new Error("Service policy changed before observation was saved");
    if (service.policy === policy) service.observationPending = false;
  }

  /** Shell-only enablement, with a synchronous fence before network I/O. */
  setServiceEnabled(appId: string, serviceId: string, enabled: boolean): Promise<void> {
    if (typeof appId !== "string" || typeof serviceId !== "string" || !PACKAGE_ID_PATTERN.test(appId) || !/^[a-z0-9][a-z0-9-]*$/.test(serviceId) || typeof enabled !== "boolean") return Promise.reject(new Error("Invalid Service setting"));
    this.#serviceGeneration++;
    const task = this.#manageService(appId, current => this.#setServiceEnabled(appId, serviceId, enabled, current));
    if (!enabled) for (const value of this.#workloads.values()) if (value.kind === "service" && value.appId === appId && value.workloadId === serviceId) value.controller.abort(new Error("Service disabled"));
    return task;
  }

  #manageService(appId: string, operation: (current: () => void) => Promise<void>): Promise<void> {
    const hostEpoch = this.#serviceHostEpoch, appEpoch = this.#serviceAppEpochs.get(appId);
    const current = () => {
      if (hostEpoch !== this.#serviceHostEpoch || appEpoch !== this.#serviceAppEpochs.get(appId) || this.#stoppingAll || this.#stoppingApps.has(appId) || this.#terminalFailure) throw new Error("Service management was cancelled");
    };
    const task = Promise.resolve().then(() => { current(); return operation(current); }).finally(() => this.#serviceManagement.delete(task));
    this.#serviceManagement.set(task, appId);
    return task;
  }

  async #setServiceEnabled(appId: string, serviceId: string, enabled: boolean, current: () => void): Promise<void> {
    if (typeof appId !== "string" || typeof serviceId !== "string" || !PACKAGE_ID_PATTERN.test(appId) || !/^[a-z0-9][a-z0-9-]*$/.test(serviceId) || typeof enabled !== "boolean") throw new Error("Invalid Service setting");
    this.#serviceGeneration++;
    const key = serviceKey(appId, serviceId);
    this.#serviceChanges.set(key, (this.#serviceChanges.get(key) ?? 0) + 1);
    try {
      const owned = [...this.#workloads].filter(([, value]) => value.kind === "service" && value.appId === appId && value.workloadId === serviceId);
      if (!enabled) for (const [, operation] of owned) operation.controller.abort(new Error("Service disabled"));
      const response = await this.#hostRequest(servicePath(appId, serviceId), { method: "POST", signal: AbortSignal.timeout(5000), body: JSON.stringify({ operation: "enablement", enabled }) });
      current();
      const { policy } = await response.json() as { policy: ServicePolicy };
      current();
      const desired = { appId, serviceId, version: null, policy } as ServiceDesired;
      this.#servicePolicies.set(serviceKey(appId, serviceId), desired);
      if (!enabled) {
        try {
          for (const [id, operation] of owned) {
            await operation.task.catch(() => {});
            await this.#cleanupWorkloadAuthority(operation);
            if (operation.boundaryCleanupError) throw new Error(operation.boundaryCleanupError);
            this.#workloads.delete(id);
          }
          // A successful exact cleanup can discharge a prior authority failure;
          // an old persisted boundary failure without a live owner cannot.
          if (owned.length || !policy.cleanupFailed) {
            desired.policy = { ...policy, cleanupFailed: false, restartAt: null };
            desired.observationPending = true;
            await this.#observeService(desired);
          }
        } catch (error) {
          if (owned.some(([, operation]) => operation.cleanupError)) {
            desired.policy = { ...policy, cleanupFailed: true, lastError: "Service cleanup was not confirmed", restartAt: null };
            desired.observationPending = true;
            await this.#observeService(desired).catch(() => {});
          }
          throw error;
        }
      }
    } finally {
      const count = this.#serviceChanges.get(key)! - 1;
      if (count) this.#serviceChanges.set(key, count); else this.#serviceChanges.delete(key);
    }
    current();
    await this.#serviceReconciliation?.catch(() => {});
    current();
    await this.reconcileServices();
  }

  #serviceStates(appId: string): readonly AppServiceState[] {
    return [...this.#servicePolicies.values()].filter(service => service.appId === appId).map(service => {
      const owned = this.#serviceOperation(service);
      const policy = service.policy;
      return Object.freeze({ serviceId: service.serviceId, enabled: policy?.enabled ?? null,
        state: owned ? owned[1].state : policy?.cleanupFailed ? "cleanup-failed" : policy?.enabled ? service.appEnabled === false || this.#appEnablement.get(appId) === false || this.#appBlocked.has(appId) || this.#modeChanges.has(appId) ? "stopped" : "backoff" : policy ? "disabled" : "unconfigured",
        executionId: owned?.[0] ?? null, restartAt: policy?.restartAt ?? null, failure: owned?.[1].cleanupError ?? policy?.lastError ?? null,
      });
    });
  }

  /** Authorization is enforced by the trusted Shell IPC caller. */
  workloadDiagnostics(appId: string, executionId?: string): readonly AppWorkloadDiagnostic[] {
    if (typeof appId !== "string" || !PACKAGE_ID_PATTERN.test(appId) || (executionId !== undefined && (typeof executionId !== "string" || !executionId || executionId.length > 128))) throw new Error("Invalid diagnostic identity");
    return this.#diagnostics.read(appId, executionId);
  }

  async #cleanupWorkloadAuthority(job: BackgroundOperation, appChannelsRevoked = false): Promise<void> {
    // Only a post-quiescence App revocation can discharge a failed channel
    // DELETE. Activation release has its own idempotent acknowledgement.
    if (appChannelsRevoked || this.#controlPlaneLost) job.cleanupChannelId = null;
    if (this.#controlPlaneLost) job.cleanupActivationId = null;
    job.cleanupError = job.boundaryCleanupError;
    job.state = job.cleanupError ? "cleanup-failed" : "stopping";
    const results = await Promise.allSettled([
      ...(job.cleanupChannelId ? [this.#revokeCapability(job.cleanupChannelId).then(() => { job.cleanupChannelId = null; })] : []),
      ...(job.cleanupActivationId ? [this.#releaseActivation(job.cleanupActivationId).then(() => { job.cleanupActivationId = null; })] : []),
    ]);
    if (this.#controlPlaneLost) {
      job.cleanupChannelId = null;
      job.cleanupActivationId = null;
      return;
    }
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) {
      const error = new AggregateError(failures, `${job.kind === "service" ? "Service" : "Job"} authority cleanup failed; stop was not confirmed`);
      job.state = "cleanup-failed";
      job.cleanupError = job.boundaryCleanupError ?? error.message;
      if (!job.boundaryCleanupError) this.#recordFailure(job.appId, error, true, `${job.kind}:${job.workloadId}`);
      throw error;
    }
  }

  async #cleanupRetainedWorkloads(appId: string, appChannelsRevoked: boolean): Promise<unknown[]> {
    const results = await Promise.allSettled([...this.#workloads].filter(([, job]) => job.appId === appId).map(async ([runId, job]) => {
      await this.#cleanupWorkloadAuthority(job, appChannelsRevoked);
      // HTTP cleanup cannot prove containment of an unconfirmed VM stop.
      if (job.boundaryCleanupError) throw new Error(job.boundaryCleanupError);
      if (job.kind === "service" && !this.#controlPlaneLost) {
        const desired = this.#servicePolicies.get(serviceKey(job.appId, job.workloadId));
        if (desired?.policy?.cleanupFailed) {
          desired.policy = { ...desired.policy, cleanupFailed: false, restartAt: null };
          desired.observationPending = true;
          await this.#observeService(desired);
        }
      }
      this.#workloads.delete(runId);
    }));
    return results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  }

  /** Stops exactly one owned invocation and joins its existing teardown. */
  async stopJob(appId: string, runId: string): Promise<{ active: boolean }> {
    if (typeof appId !== "string" || !PACKAGE_ID_PATTERN.test(appId) || typeof runId !== "string" || !runId || runId.length > 64) throw new Error("Invalid job identity");
    const job = this.#workloads.get(runId);
    if (!job) return { active: false };
    if (job.appId !== appId || job.kind !== "job") throw new Error("Job does not belong to this App");
    const appTeardown = this.#stopOperations.get(appId) ?? this.#stopAllOperation;
    if (appTeardown) {
      await appTeardown;
      return { active: true };
    }
    if (job.cleanupError) throw new Error(job.cleanupError);
    // Use Trigger's existing cancellation to revoke input and record intent;
    // the same Host AbortController provides prompt, exact execution stop.
    const cancellation = this.#requestJobCancellation(runId, job);
    job.controller.abort(new Error("Job stopped by user"));
    const [cancelResult] = await Promise.allSettled([cancellation, job.task]);
    if (job.cleanupError) throw new Error(job.cleanupError);
    if (cancelResult.status === "rejected") throw cancelResult.reason;
    return { active: true };
  }

  #requestJobCancellation(runId: string, job: BackgroundOperation): Promise<unknown> {
    return job.cancellation ??= job.kind === "job" && job.triggerId && !this.#controlPlaneLost ? this.#hostRequest("/api/triggers/manage", {
      method: "POST", body: JSON.stringify({ operation: "trigger.cancel", input: { runId } }),
    }) : Promise.resolve();
  }

  async closeAppUi(appId: string): Promise<void> {
    if (typeof appId !== "string" || !PACKAGE_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    const opening = this.#openingOperations.get(appId);
    const previous = this.#pendingUiOperations.get(appId)?.previousViewer;
    const viewers = new Map([...this.#viewers.values(), ...(previous ? [previous] : [])]
      .filter(viewer => viewer.appId === appId).map(viewer => [viewer.viewerId, viewer]));
    const tasks = [
      ...(opening ? [this.#cancelOpeningOperation(opening, new Error("UI closed by user"))] : []),
      ...[...viewers.values()].map(viewer => this.closeViewer(viewer.viewerId, viewer.owner)),
    ];
    const results = await Promise.allSettled(tasks);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "UI cleanup failed");
  }

  async openViewer(
    appId: string,
    ownerValue: AppViewerOwner,
    verifyPreparedViewer: VerifyPreparedViewer,
    signal?: AbortSignal,
  ): Promise<OpenedAppViewer> {
    signal?.throwIfAborted();
    if (this.#terminalFailure) throw this.#terminalFailure;
    if (!PACKAGE_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    const owner = validatedViewerOwner(ownerValue);
    if (
      this.#stoppingAll
      || this.#appBlocked.has(appId) || this.#modeChanges.has(appId) || this.#appEnablement.get(appId) === false
      || this.#openingApps.has(appId)
      || this.#rebuildOperations.has(appId)
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
    const cancel = () => { void this.#cancelOpeningOperation(tracked,
      new Error("App opening was cancelled")).catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
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
      // Keep the App fenced through final capability revocation, including a
      // cancellation racing with the successful commit.
      signal?.removeEventListener("abort", cancel);
      try { await tracked.cancellation; } finally {
        if (this.#openingOperations.get(appId) === tracked) {
          this.#openingOperations.delete(appId);
        }
        this.#openingApps.delete(appId);
      }
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
      this.#bindSystemSender(runtimeSenderId, { ...runtimeIssued, appId });
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
      const prepared = await this.#backend.prepareUi(
        createUiSpec(appId, activation, ui, runtimeSenderId), undefined, { signal: pending.abortController.signal },
      );
      pending.preparationId = prepared.preparationId;
      pending.startupDeadlineMs = prepared.startupDeadlineMs;
      pending.instanceId = prepared.instanceId;
      this.#assertPendingUiCurrent(pending, "launch");

      const browserIssued = await this.#issueCapability(activation);
      pending.browserIssued = browserIssued;
      this.#assertPendingUiCurrent(pending, "launch");

      await withAbortSignal(verifyPreparedViewer(this.#preparedViewerBinding(pending)), pending.abortController.signal);
      // Do not insert another await between this authority check and commit.
      // It is the final Host-side admission decision for this candidate.
      this.#assertPendingUiCurrent(pending, "launch");
      pending.preparationCommitting = true;
      let instance: CapsuleUiInstance;
      try { instance = await this.#backend.commitPreparedUi(prepared.preparationId); }
      finally { pending.preparationCommitting = false; }
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
        mode: browserIssued.mode,
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
    const viewer = this.#viewers.get(viewerId) ?? [...this.#pendingUiOperations.values()]
      .find(pending => pending.previousViewer?.viewerId === viewerId)?.previousViewer;
    if (!viewer || !sameViewerOwner(viewer.owner, owner)) return false;
    const cleanup = Promise.withResolvers<void>();
    this.#uiCleanupOperations.set(cleanup.promise, viewer.appId);
    try {
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
        pending?.previousDetached ? this.#backend.stopAppUi(viewer.appId) : this.#backend.stopUi(viewer.instanceId),
        Promise.all([
          this.#revokeCapability(viewer.channelId),
          this.#revokeCapability(viewer.runtimeChannelId),
        ]),
      ]);
      if (stopResult.status === "rejected") {
        this.#recordFailure(viewer.appId, stopResult.reason, true, "ui");
        const causes = [stopResult.reason];
        if (revokeResult.status === "rejected") causes.push(revokeResult.reason);
        await this.#collapseBackendBoundary(causes);
      }
      if (revokeResult.status === "rejected") {
        this.#recordFailure(viewer.appId, revokeResult.reason, true, "ui");
        throw revokeResult.reason;
      }
      return true;
    } finally {
      cleanup.resolve(); this.#uiCleanupOperations.delete(cleanup.promise);
    }
  }

  async closeOwner(ownerValue: AppViewerOwner): Promise<void> {
    const owner = validatedViewerOwner(ownerValue);
    const reason = new Error("App viewer owner renderer was replaced");
    const openings = [...this.#openingOperations.values()]
      .filter((opening) => sameViewerOwner(opening.owner, owner));
    const cancelledOpenings = openings.map((opening) => (
      this.#cancelOpeningOperation(opening, reason)
    ));
    const ownedViewers = [...this.#viewers.values(), ...[...this.#pendingUiOperations.values()].flatMap(pending => pending.previousViewer ? [pending.previousViewer] : [])];
    const ids = [...new Set(ownedViewers.filter(viewer => sameViewerOwner(viewer.owner, owner)).map(viewer => viewer.viewerId))];
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
      // the backend preparation. Cancel UI work whose preparation id has not
      // returned yet; independently running jobs retain their own lifetime.
      backendStop = this.#backend.stopAppUi(opening.appId);
    } catch (error) {
      backendStop = Promise.reject(error);
    }
    const initialRevocation = this.#controlPlaneLost
      ? Promise.resolve()
      : this.#revokeAppCapabilities(opening.appId, "ui");
    void (async () => {
      const [, backendResult, revokeResult] = await Promise.allSettled([
        opening.operation,
        backendStop,
        initialRevocation,
      ]);
      const finalRevokeResult = this.#controlPlaneLost
        ? ({ status: "fulfilled", value: undefined } as PromiseFulfilledResult<void>)
        : (await Promise.allSettled([
          this.#revokeAppCapabilities(opening.appId, "ui"),
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
    retirePreviousViewer?: () => void,
  ): Promise<ReloadedApp> {
    if (this.#terminalFailure) throw this.#terminalFailure;
    if (!PACKAGE_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    if (this.#stoppingAll || this.#stoppingApps.has(appId) || this.#appBlocked.has(appId) || this.#modeChanges.has(appId) || this.#appEnablement.get(appId) === false) {
      throw new Error(`App "${appId}" is stopping`);
    }
    const existing = this.#rebuildOperations.get(appId);
    if (existing) return await existing as ReloadedApp;
    const activeViewer = [...this.#viewers.values()].find((viewer) => viewer.appId === appId);
    if (!activeViewer) return { active: false, browserBindings: [] };
    const operation = this.#reloadApp(
      activeViewer,
      this.#generation,
      verifyPreparedViewer,
      publishReloadedViewer,
      retirePreviousViewer,
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
    retirePreviousViewer?: () => void,
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
      this.#bindSystemSender(runtimeSenderId, { ...runtimeIssued, appId: viewer.appId });
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
      const prepared = await this.#backend.prepareUi(
        createUiSpec(viewer.appId, activation, ui, runtimeSenderId), viewer.instanceId, {
          signal: pending.abortController.signal,
          onHandoff: async deadline => {
            this.#assertPendingUiCurrent(pending, "reload");
            pending.startupDeadlineMs = deadline;
            pending.deadlineTimer = setTimeout(() => {
              const error = new Error("UI handoff timed out after 15 seconds");
              this.#recordFailure(pending.appId, error);
              this.#cancelPendingUiOperation(pending, error);
            }, Math.max(1, deadline - performance.now()));
            pending.deadlineTimer.unref();
            pending.previousDetached = true;
            this.#viewers.delete(viewer.viewerId);
            this.#unbindSystemSender(viewer.runtimeSenderId);
            this.#queuePendingRevocation(pending, viewer.channelId);
            this.#queuePendingRevocation(pending, viewer.runtimeChannelId);
            retirePreviousViewer?.();
            await Promise.all(pending.cleanupTasks);
            if (pending.cleanupFailures.length) throw new Error("Previous UI authority cleanup failed");
            this.#assertPendingUiCurrent(pending, "reload");
          },
        },
      );
      pending.preparationId = prepared.preparationId;
      pending.startupDeadlineMs = prepared.startupDeadlineMs;
      pending.instanceId = prepared.instanceId;
      this.#assertPendingUiCurrent(pending, "reload");

      await withAbortSignal(verifyPreparedViewer(this.#preparedViewerBinding(pending)), pending.abortController.signal);
      // The old UI is already stopped and its browser generation retired.
      // Adopt only this verified candidate before the shared handoff deadline.
      this.#assertPendingUiCurrent(pending, "reload");
      pending.preparationCommitting = true;
      let replacement: CapsuleUiInstance;
      try { replacement = await this.#backend.commitPreparedUi(prepared.preparationId); }
      finally { pending.preparationCommitting = false; }
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
        mode: browserIssued.mode,
        runtimeChannelId: runtimeIssued.channelId,
        runtimeSenderId,
      });
      const browserBinding: ReloadedBrowserBinding = Object.freeze({
        viewerId: viewer.viewerId,
        instanceId: replacement.instanceId,
        channelId: browserIssued.channelId,
        capability: browserIssued.capability,
        mode: browserIssued.mode,
      });
      pending.committedViewer = updated;
      this.#viewers.set(viewer.viewerId, updated);
      // Publish the verified hidden renderer synchronously. The previous
      // browser generation was retired when handoff began.
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
    if (typeof appId !== "string" || !PACKAGE_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    // Internal lifecycle stop; persistent enablement is controlled separately.
    this.#serviceAppEpochs.set(appId, (this.#serviceAppEpochs.get(appId) ?? 0) + 1);
    this.#serviceGeneration++;
    if (this.#stopAllOperation) return this.#stopAllOperation;
    if (this.#terminalFailure) return Promise.reject(this.#terminalFailure);
    const existing = this.#stopOperations.get(appId);
    if (existing) return existing;
    for (const [runId, job] of this.#workloads) if (job.appId === appId) {
      void this.#requestJobCancellation(runId, job).catch(() => {});
      job.controller.abort(new Error("App stopped"));
    }
    const ownsFence = !this.#stoppingApps.has(appId);
    if (ownsFence) this.#stoppingApps.add(appId);
    const pending = this.#pendingUiOperations.get(appId);
    if (pending) {
      this.#cancelPendingUiOperation(
        pending,
        new Error(`App Capsule operation was cancelled while stopping "${appId}"`),
      );
    }
    let tracked: Promise<void>;
    tracked = this.#stopApp(appId).catch(error => {
      this.#recordFailure(appId, error, true);
      throw error;
    }).finally(() => {
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
      ...[...this.#uiCleanupOperations].filter(([, owner]) => owner === appId).map(([task]) => task),
      ...[...this.#serviceManagement].filter(([, owner]) => owner === appId).map(([task]) => task),
      ...[...this.#workloads.values()].filter(job => job.appId === appId).map(job => job.task),
    ].filter((operation): operation is Promise<unknown> => operation !== undefined);
    const viewers = [...this.#viewers.values()].filter((viewer) => viewer.appId === appId);
    for (const viewer of viewers) {
      this.#viewers.delete(viewer.viewerId);
      this.#unbindSystemSender(viewer.runtimeSenderId);
    }
    // stopApp is the backend cancellation source for a preparation whose
    // prepareUi() has not returned an abortable preparation id yet.
    const [backendResult, , ...cancellationResults] = await Promise.allSettled([
      this.#backend.stopApp(appId),
      this.#revokeAppCapabilities(appId),
      ...[...this.#workloads.values()].filter(job => job.appId === appId).map(job => job.cancellation),
    ]);
    await Promise.allSettled(pending);
    const [finalRevocation] = await Promise.allSettled([
      this.#revokeAppCapabilities(appId),
    ]);
    const failures = [backendResult, ...cancellationResults, finalRevocation]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    failures.push(...await this.#cleanupRetainedWorkloads(appId, finalRevocation.status === "fulfilled"));
    if (failures.length > 0) throw new AggregateError(failures, `Could not stop App "${appId}"`);
    this.#clearCleanupFailure(appId);
  }

  /** Establishes a synchronous fence which remains held across Core archive. */
  beginAppRetirement(appId: string): void {
    this.#serviceGeneration++;
    this.#serviceAppEpochs.set(appId, (this.#serviceAppEpochs.get(appId) ?? 0) + 1);
    if (this.#terminalFailure) throw this.#terminalFailure;
    if (!PACKAGE_ID_PATTERN.test(appId)) throw new Error("Invalid App id");
    if (this.#stoppingAll) throw new Error("App Capsule is stopping");
    if (this.#stoppingApps.has(appId)) throw new Error(`App "${appId}" is stopping`);
    this.#stoppingApps.add(appId);
    for (const job of this.#workloads.values()) if (job.appId === appId) job.controller.abort(new Error("App retired"));
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
      ...[...this.#workloads.values()].filter(job => job.appId === appId).map(job => job.task),
      ...[...this.#serviceManagement].filter(([, owner]) => owner === appId).map(([task]) => task),
      this.#openingOperations.get(appId)?.operation,
      this.#rebuildOperations.get(appId),
      ...[...this.#uiCleanupOperations].filter(([, owner]) => owner === appId).map(([task]) => task),
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
    const [, backendResult] = await Promise.allSettled([revoke, backend]);
    await Promise.allSettled(pending);
    const [finalRevocation] = await Promise.allSettled([this.#revokeAppCapabilities(appId)]);
    const failures = [finalRevocation, backendResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    failures.push(...await this.#cleanupRetainedWorkloads(appId, finalRevocation.status === "fulfilled"));
    if (failures.length > 0) {
      throw new AggregateError(failures, `Could not retire App "${appId}"`);
    }
    this.#clearCleanupFailure(appId);
    this.#appEnablement.delete(appId); this.#appBlocked.delete(appId); this.#appModes.delete(appId);
    for (const [key, service] of this.#servicePolicies) if (service.appId === appId) {
      this.#servicePolicies.delete(key);
    }
  }

  stopAll(options: StopAllOptions = {}): Promise<void> {
    this.#serviceGeneration++;
    this.#serviceHostEpoch++;
    this.#serviceLoop?.controller.abort(new Error("Host stopped"));
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
    for (const job of this.#workloads.values()) job.controller.abort(new Error("Host stopped"));
    this.#generation += 1;

    try {
      const pending = [
        ...[...this.#workloads.values()].map(job => job.task),
        ...(this.#serviceLoop ? [this.#serviceLoop.task] : []),
        ...(this.#serviceReconciliation ? [this.#serviceReconciliation] : []),
        ...this.#serviceManagement.keys(),
        ...this.#appSettingOperations.values(),
        ...[...this.#openingOperations.values()].map((opening) => opening.operation),
        ...this.#rebuildOperations.values(),
        ...this.#stopOperations.values(),
        ...this.#retireOperations.values(),
        ...this.#uiCleanupOperations.keys(),
      ];
      const pendingUi = [...this.#pendingUiOperations.values()];
      const viewers = [...this.#viewers.values()];
      const affectedApps = new Set([
        ...this.#appEnablement.keys(),
        ...this.#appSettingOperations.keys(),
        ...[...this.#workloads.values()].map(job => job.appId),
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
        const jobCleanup = await Promise.all([...affectedApps].map((appId, index) => this.#cleanupRetainedWorkloads(
          appId, this.#controlPlaneLost || finalRevocations[index]?.status === "fulfilled",
        )));
        failures.push(...jobCleanup.flat());
        if (failures.length > 0) {
          throw new AggregateError(failures, "Could not fully stop App Capsules");
        }
        for (const appId of affectedApps) this.#clearCleanupFailure(appId);
      })();
      void withDeadline(
        teardown,
        STOP_ALL_QUIESCENCE_TIMEOUT_MS,
        "App Capsule shutdown did not quiesce before its deadline",
      ).then(
        () => {
          if (this.#stopAllOperation === shared) this.#stopAllOperation = null;
          this.#stoppingAll = false;
          this.#serviceLoop = null;
          this.#cleanBoundaryConfirmed = true;
          this.#servicePolicies.clear();
          this.#appEnablement.clear(); this.#appBlocked.clear(); this.#appModes.clear();
          this.#diagnostics.clear();
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
    for (const job of this.#workloads.values()) job.controller.abort(new Error("Capsule boundary lost"));
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
    const pending = this.#pendingUiOperations.get(event.appId);
    if (pending?.previousDetached && pending.previousViewer?.instanceId === event.instanceId) return;
    this.#recordFailure(event.appId, event.error);
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
        this.#uiCleanupOperations.delete(settlement);
      });
    this.#uiCleanupOperations.set(settlement, viewer.appId);
    void settlement.catch(() => {});
  }

  #recordFailure(appId: string, error: unknown, recoverableCleanup = false, workloadKey?: string): void {
    if (
      error instanceof AppControlPlaneError
      && (error.code === "APP_PACKAGE_INVALID" || error.code === "APP_VERSION_HISTORY_UNAVAILABLE")
    ) return;
    const latest = this.#latestFailureByApp.get(appId);
    const preserve = (value: AppRuntimeFailure | undefined, remaining = 63): AppRuntimeFailure | undefined => {
      if (!value || remaining === 0) return;
      const previous = preserve(value.previous, remaining - 1);
      if (value.recoverableCleanup === recoverableCleanup && value.workloadKey === workloadKey) return previous;
      return { ...value, previous };
    };
    let unresolved = latest;
    let retainsCleanup = false;
    while (unresolved) {
      if (unresolved.recoverableCleanup) { retainsCleanup = true; break; }
      unresolved = unresolved.previous;
    }
    this.#latestFailureByApp.set(appId, {
      message: error instanceof Error ? error.message : String(error),
      recoverableCleanup,
      workloadKey,
      // Replace only this workload's matching failure type. Cleanup retries
      // preserve execution errors and other workloads' unresolved cleanup.
      ...(recoverableCleanup || workloadKey || retainsCleanup ? { previous: preserve(latest) } : {}),
    });
  }

  #clearCleanupFailure(appId: string): void {
    // Called only after confirmed App-wide cleanup; every retained cleanup
    // failure for this App is now resolved, while execution failures remain.
    const prune = (failure?: AppRuntimeFailure): AppRuntimeFailure | undefined => {
      if (!failure) return;
      const previous = prune(failure.previous);
      return failure.recoverableCleanup ? previous : { ...failure, previous };
    };
    const latest = prune(this.#latestFailureByApp.get(appId));
    if (latest) this.#latestFailureByApp.set(appId, latest);
    else this.#latestFailureByApp.delete(appId);
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
    if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
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
      || pending.preparationCommitting
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
      startupDeadlineMs: pending.startupDeadlineMs,
      appId: pending.appId,
      instanceId,
      channelId: browserIssued.channelId,
      capability: browserIssued.capability,
      mode: browserIssued.mode,
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
      || this.#stoppingApps.has(opening.appId)
      || this.#appBlocked.has(opening.appId) || this.#modeChanges.has(opening.appId) || this.#appEnablement.get(opening.appId) === false
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
    if (this.#viewers.get(viewer.viewerId) !== viewer || this.#appBlocked.has(viewer.appId) || this.#modeChanges.has(viewer.appId) || this.#appEnablement.get(viewer.appId) === false) {
      throw new Error(`App Capsule ${operation} was cancelled`);
    }
  }

  #assertPendingUiCurrent(
    pending: PendingUiOperation,
    operation: "launch" | "reload",
  ): void {
    pending.abortController.signal.throwIfAborted();
    if (pending.startupDeadlineMs !== undefined && performance.now() >= pending.startupDeadlineMs) throw new Error("Runtime startup budget exhausted");
    if (pending.candidateLost) throw pending.candidateLost.error;
    if (pending.previousLost) throw pending.previousLost.error;
    this.#assertGenerationCurrent(pending.generation, operation);
    if (
      this.#pendingUiOperations.get(pending.appId) !== pending
      || pending.abortController.signal.aborted
      || this.#stoppingApps.has(pending.appId)
      || this.#appBlocked.has(pending.appId) || this.#modeChanges.has(pending.appId) || this.#appEnablement.get(pending.appId) === false
    ) {
      throw new Error(`App Capsule ${operation} was cancelled`);
    }
    if (
      pending.previousViewer
      && !pending.previousDetached
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
    if (pending.preparationCommitted || pending.previousDetached) {
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
      // Handoff retires the old process before candidate startup. Failure must
      // remove its browser surface even when the candidate was never committed.
      const previous = pending.previousViewer;
      const committed = pending.committedViewer;
      const current = this.#viewers.get(pending.viewerId);
      if (
        previous
        && (pending.previousDetached || current === previous || (committed !== undefined && current === committed))
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
      this.#recordFailure(pending.appId, failure, true, "ui");
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
    this.#recordFailure(viewer.appId, cause, true, "ui");

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

  async #prepareActivation(appId: string, workload: PreparedActivation["workload"] = "ui", onAllocated?: (id: string) => void): Promise<PreparedActivation> {
    const response = await this.#hostRequest(
      `/api/apps/${encodeURIComponent(appId)}/activation/prepare`,
      { method: "POST", body: JSON.stringify({ workload }) },
    );
    const body = await response.json() as { activation?: Partial<PreparedActivation> };
    const activation = body.activation;
    if (/^activation_[A-Za-z0-9_-]{32}$/.test(activation?.activationId ?? "")) onAllocated?.(activation!.activationId!);
    if (
      (activation?.mode !== "normal" && activation?.mode !== "exp")
      || activation?.schemaVersion !== 1
      || activation.appId !== appId
      || activation.workload !== workload
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

  async #issueCapability(activation: PreparedActivation, jobRunId?: string, onAllocated?: (id: string) => void): Promise<IssuedCapability> {
    const response = await this.#hostRequest("/api/app-runtime/channels", {
      method: "POST",
      body: JSON.stringify({
        appId: activation.appId,
        workload: activation.workload,
        activationId: activation.activationId,
        ...(jobRunId === undefined ? {} : { jobRunId }),
      }),
    });
    const issued = await response.json() as Partial<IssuedCapability>;
    if (typeof issued.channelId === "string" && issued.channelId.length > 0 && issued.channelId.length <= 256) onAllocated?.(issued.channelId);
    if (
      issued.mode !== activation.mode
      || typeof issued.capability !== "string"
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
    // App-wide revocation may win this race. Core's channel DELETE returns
    // 404 after an already-closed channel has drained, so teardown succeeded.
    await this.#hostRequest(`/api/app-runtime/channels/${encodeURIComponent(channelId)}`, {
      method: "DELETE",
    }, true);
  }

  async #revokeAppCapabilities(appId: string, workload?: "ui"): Promise<void> {
    await this.#hostRequest(`/api/app-runtime/apps/${encodeURIComponent(appId)}/channels${workload === "ui" ? "?workload=ui" : ""}`, {
      method: "DELETE",
    });
  }

  async #hostRequest(path: string, init: RequestInit = {}, allowNotFound = false): Promise<Response> {
    const controlPlane = this.#controlPlaneRequests.signal;
    if (controlPlane.aborted) throw controlPlane.reason;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.#coreToken}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await withAbortSignal(
      this.#fetch(`${this.#coreBaseUrl()}${path}`, {
        ...init,
        headers,
        signal: init.signal ? AbortSignal.any([controlPlane, init.signal]) : controlPlane,
      }),
      controlPlane,
    );
    if (response.ok || (allowNotFound && response.status === 404)) return response;
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
      this.#coreToken ? message.split(this.#coreToken).join("[redacted]") : message,
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

function createUiSpec(
  appId: string,
  activation: PreparedActivation,
  ui: NonNullable<PreparedActivation["manifest"]["runtime"]["ui"]>,
  runtimeSenderId: string,
): CapsuleUiSpec {
  return {
    appId,
    mode: activation.mode,
    activationId: activation.activationId,
    activationSequence: activation.activationSequence,
    version: activation.version,
    manifestDigest: activation.manifestDigest,
    packageDigest: activation.packageDigest,
    packageDir: activation.immutablePackagePath,
    command: [...ui.command],
    port: ui.port,
    writeTables: [...activation.manifest.permissions.writes.tables],
    fileGrants: [
      `apps/${appId}/`,
      ...activation.manifest.permissions.writes.files,
    ],
    sdkSenderId: runtimeSenderId,
  };
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

function serviceKey(appId: string, serviceId: string): string { return `${appId}:${serviceId}`; }
function servicePath(appId: string, serviceId: string): string { return `/api/app-runtime/services/${encodeURIComponent(appId)}/${encodeURIComponent(serviceId)}`; }
