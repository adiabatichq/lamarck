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
  now?: () => number;
  onError?: (error: unknown, integration: ScheduledConnector) => void;
}

const DEFAULT_TICK_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const RUNNABLE_TRUST = new Set(["official", "custom"]);

export class ConnectorScheduler {
  private supervisor: ConnectorSupervisor;
  private tickMs: number;
  private stopTimeoutMs: number;
  private now: () => number;
  private onError?: (error: unknown, integration: ScheduledConnector) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickPromise: Promise<void> | undefined;
  private activeRuns = new Map<string, ConnectorRunHandle>();
  private stopped = false;

  constructor(opts: ConnectorSchedulerOptions) {
    this.supervisor = opts.supervisor;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    await this.tick();
    if (this.stopped) return;
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
      await this.startWatchConnectors();
      await this.runDuePollConnectors();
    })().finally(() => {
      this.tickPromise = undefined;
    });
    return this.tickPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
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

    const finished = await waitWithTimeout(Promise.all(pending), this.stopTimeoutMs);
    if (!finished) {
      const stuck = [...this.activeRuns.keys()].join(", ");
      console.error(
        `[connectors] scheduler stop timed out after ${this.stopTimeoutMs}ms; abandoning runs: ${stuck}`,
      );
    }
    this.activeRuns.clear();
  }

  private async startWatchConnectors(): Promise<void> {
    for (const integration of (await this.supervisor.list()) as ScheduledConnector[]) {
      if (this.stopped) return;
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
