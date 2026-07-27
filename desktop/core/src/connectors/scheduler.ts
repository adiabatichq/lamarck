import type { ConnectorSupervisor } from "./supervisor";
import type { ConnectorIntegration, ConnectorRunHandle } from "./types";
import { nextCronRunAt } from "./schedule";
import { isIntegrationPaused } from "./state";

type ScheduledConnector = ConnectorIntegration & {
  mode: string;
  running: boolean;
  supported: boolean;
  packageTrust: string;
  source: string | undefined;
  setupPending?: string[];
};

export interface ConnectorSchedulerOptions {
  supervisor: ConnectorSupervisor;
  tickMs?: number;
  stopTimeoutMs?: number;
  watchReconcileRetryMs?: number;
  watchReconcileMaxRetryMs?: number;
  now?: () => number;
  onError?: (error: unknown, integration: ScheduledConnector) => void;
}

const DEFAULT_TICK_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_WATCH_RECONCILE_RETRY_MS = 1_000;
const DEFAULT_WATCH_RECONCILE_MAX_RETRY_MS = 60_000;
const RUNNABLE_TRUST = new Set(["official", "custom"]);

export class ConnectorScheduler {
  private supervisor: ConnectorSupervisor;
  private tickMs: number;
  private stopTimeoutMs: number;
  private watchReconcileRetryMs: number;
  private watchReconcileMaxRetryMs: number;
  private nextWatchReconcileRetryMs: number;
  private now: () => number;
  private onError?: (error: unknown, integration: ScheduledConnector) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickPromise: Promise<void> | undefined;
  private activeRuns = new Map<string, ConnectorRunHandle>();
  private watchReconcilePromise: Promise<void> | undefined;
  private watchReconcileRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchReconcileAllPending = false;
  private pendingWatchIntegrationIds = new Set<string>();
  private disposeRuntimeReconcileListener: (() => void) | undefined;
  private started = false;
  private stopped = false;

  constructor(opts: ConnectorSchedulerOptions) {
    this.supervisor = opts.supervisor;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.watchReconcileRetryMs = opts.watchReconcileRetryMs
      ?? DEFAULT_WATCH_RECONCILE_RETRY_MS;
    this.watchReconcileMaxRetryMs = Math.max(
      this.watchReconcileRetryMs,
      opts.watchReconcileMaxRetryMs ?? DEFAULT_WATCH_RECONCILE_MAX_RETRY_MS,
    );
    this.nextWatchReconcileRetryMs = this.watchReconcileRetryMs;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError;
  }

  async start(): Promise<void> {
    if (this.started || this.timer) return;
    this.stopped = false;
    this.started = true;
    this.subscribeRuntimeReconcileRequests();
    try {
      await this.tick();
    } catch (err) {
      this.started = false;
      this.cancelWatchReconcileRetry();
      this.resetWatchReconcileBackoff();
      this.unsubscribeRuntimeReconcileRequests();
      throw err;
    }
    if (this.stopped) {
      this.started = false;
      return;
    }
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error("[connectors] scheduler tick failed:", err);
      });
    }, this.tickMs);
  }

  async tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = (async () => {
      this.supervisor.resumeExpiredPauses(this.now());
      await this.reconcileWatchConnectors();
      await this.runDuePollConnectors();
    })().finally(() => {
      this.tickPromise = undefined;
    });
    return this.tickPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.unsubscribeRuntimeReconcileRequests();
    this.watchReconcileAllPending = false;
    this.pendingWatchIntegrationIds.clear();
    this.cancelWatchReconcileRetry();
    this.resetWatchReconcileBackoff();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    for (const handle of this.activeRuns.values()) {
      handle.abort();
    }
    const pending: Promise<unknown>[] = [...this.activeRuns.values()]
      .map((handle) => handle.promise.catch(() => {}));
    if (this.tickPromise) {
      pending.push(this.tickPromise.catch(() => {}));
    }
    if (this.watchReconcilePromise) {
      pending.push(this.watchReconcilePromise.catch(() => {}));
    }

    const finished = await waitWithTimeout(Promise.all(pending), this.stopTimeoutMs);
    if (!finished) {
      const stuck = [...this.activeRuns.keys()].join(", ");
      console.error(
        `[connectors] scheduler stop timed out after ${this.stopTimeoutMs}ms; abandoning runs: ${stuck}`,
      );
    }
    this.activeRuns.clear();
  }

  private async startWatchConnectors(
    targetIntegrationIds?: ReadonlySet<string>,
  ): Promise<void> {
    for (const integration of (await this.supervisor.list()) as ScheduledConnector[]) {
      if (this.stopped) return;
      if (targetIntegrationIds && !targetIntegrationIds.has(integration.id)) continue;
      if (integration.mode !== "watch") continue;
      if (!canSchedule(integration, this.now())) continue;
      if (integration.running || this.activeRuns.has(integration.id) || integration.status !== "idle") continue;

      try {
        const handle = this.supervisor.start(integration.id, { trigger: "watch" });
        this.activeRuns.set(integration.id, handle);
        handle.promise
          .catch((err) => this.reportError(err, integration))
          .finally(() => this.activeRuns.delete(integration.id));
      } catch (err) {
        this.reportError(err, integration);
      }
    }
  }

  private async runDuePollConnectors(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const due = ((await this.supervisor.list()) as ScheduledConnector[])
      .filter((integration) => this.isDuePollIntegration(integration, now));

    await Promise.all(due.map((integration) => this.runPollIntegration(integration)));
  }

  private isDuePollIntegration(integration: ScheduledConnector, now: number): boolean {
    if (integration.mode !== "poll") return false;
    if (!canSchedule(integration, now)) return false;
    if (!integration.scheduleCron) return false;
    if (integration.running || this.activeRuns.has(integration.id)) return false;
    return integration.nextRunAt === undefined || integration.nextRunAt <= now;
  }

  private async runPollIntegration(integration: ScheduledConnector): Promise<void> {
    let nextRunAt: number;
    try {
      nextRunAt = nextCronRunAt(integration.scheduleCron!, this.now());
    } catch (err) {
      this.reportError(err, integration);
      return;
    }

    try {
      const handle = this.supervisor.start(integration.id, { trigger: "schedule" });
      this.activeRuns.set(integration.id, handle);
      await handle.promise;
    } catch (err) {
      this.reportError(err, integration);
    } finally {
      this.activeRuns.delete(integration.id);
      try {
        this.supervisor.updateIntegration(integration.id, { nextRunAt });
      } catch (err) {
        this.reportError(err, integration);
      }
    }
  }

  private reportError(err: unknown, integration: ScheduledConnector): void {
    if (this.onError) {
      this.onError(err, integration);
      return;
    }
    console.error(`[connectors] ${integration.connectorId} scheduler error:`, err);
  }

  private reconcileWatchConnectors(instanceId?: string): Promise<void> {
    // A fresh scheduler tick or runtime notification supersedes a pending
    // backoff and gets an immediate attempt.
    this.cancelWatchReconcileRetry();
    if (instanceId === undefined) {
      this.watchReconcileAllPending = true;
      this.pendingWatchIntegrationIds.clear();
    } else if (!this.watchReconcileAllPending) {
      this.pendingWatchIntegrationIds.add(instanceId);
    }
    return this.ensureWatchReconcile();
  }

  private ensureWatchReconcile(): Promise<void> {
    if (this.watchReconcilePromise) return this.watchReconcilePromise;

    const promise = this.drainWatchReconciles();
    this.watchReconcilePromise = promise;
    promise.then(
      () => this.finishWatchReconcile(promise),
      () => this.finishWatchReconcile(promise),
    );
    return promise;
  }

  private async drainWatchReconciles(): Promise<void> {
    while (!this.stopped) {
      const reconcileAll = this.watchReconcileAllPending;
      const targetIntegrationIds = new Set(this.pendingWatchIntegrationIds);
      if (!reconcileAll && targetIntegrationIds.size === 0) return;

      this.watchReconcileAllPending = false;
      this.pendingWatchIntegrationIds.clear();
      try {
        await this.startWatchConnectors(reconcileAll ? undefined : targetIntegrationIds);
        this.resetWatchReconcileBackoff();
      } catch (err) {
        if (!this.stopped) {
          if (reconcileAll) {
            this.watchReconcileAllPending = true;
            this.pendingWatchIntegrationIds.clear();
          } else if (!this.watchReconcileAllPending) {
            for (const instanceId of targetIntegrationIds) {
              this.pendingWatchIntegrationIds.add(instanceId);
            }
          }
          this.scheduleWatchReconcileRetry();
        }
        throw err;
      }
    }
  }

  private finishWatchReconcile(promise: Promise<void>): void {
    if (this.watchReconcilePromise !== promise) return;
    this.watchReconcilePromise = undefined;
    if (
      this.stopped
      || this.watchReconcileRetryTimer
      || (!this.watchReconcileAllPending && this.pendingWatchIntegrationIds.size === 0)
    ) {
      return;
    }
    void this.ensureWatchReconcile().catch((err) => {
      console.error("[connectors] watch reconciliation failed:", err);
    });
  }

  private queueWatchReconcile(instanceId: string): void {
    if (!this.started || this.stopped) return;
    void this.reconcileWatchConnectors(instanceId).catch((err) => {
      console.error("[connectors] watch reconciliation failed:", err);
    });
  }

  private subscribeRuntimeReconcileRequests(): void {
    if (this.disposeRuntimeReconcileListener) return;
    this.disposeRuntimeReconcileListener = this.supervisor.onRuntimeReconcileRequested(
      (instanceId) => {
        this.queueWatchReconcile(instanceId);
      },
    );
  }

  private unsubscribeRuntimeReconcileRequests(): void {
    this.disposeRuntimeReconcileListener?.();
    this.disposeRuntimeReconcileListener = undefined;
  }

  private scheduleWatchReconcileRetry(): void {
    if (this.stopped || !this.started || this.watchReconcileRetryTimer) return;
    const retryMs = this.nextWatchReconcileRetryMs;
    this.nextWatchReconcileRetryMs = Math.min(
      retryMs * 2,
      this.watchReconcileMaxRetryMs,
    );
    this.watchReconcileRetryTimer = setTimeout(() => {
      this.watchReconcileRetryTimer = undefined;
      if (this.stopped || !this.started) return;
      void this.ensureWatchReconcile().catch((err) => {
        console.error("[connectors] watch reconciliation failed:", err);
      });
    }, retryMs);
  }

  private cancelWatchReconcileRetry(): void {
    if (!this.watchReconcileRetryTimer) return;
    clearTimeout(this.watchReconcileRetryTimer);
    this.watchReconcileRetryTimer = undefined;
  }

  private resetWatchReconcileBackoff(): void {
    this.nextWatchReconcileRetryMs = this.watchReconcileRetryMs;
  }
}

async function waitWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function canSchedule(integration: ScheduledConnector, now: number): boolean {
  return !isIntegrationPaused(integration, now)
    && integration.setupStatus === "ready"
    && (integration.setupPending?.length ?? 0) === 0
    && integration.supported
    && integration.source !== undefined
    && RUNNABLE_TRUST.has(integration.packageTrust);
}
