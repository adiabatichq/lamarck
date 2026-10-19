/** Trusted Shell/Host management state, never an App SDK contract. */
export interface AppActiveJob {
  readonly runId: string;
  readonly jobId: string;
  readonly triggerId: string | null;
  readonly state: "starting" | "running" | "stopping" | "cleanup-failed";
  readonly cleanupError: string | null;
}

export interface AppServiceState {
  readonly serviceId: string;
  /** Null is reserved for an unavailable policy response. */
  readonly enabled: boolean | null;
  readonly state: "unconfigured" | "disabled" | "starting" | "running" | "stopping" | "backoff" | "cleanup-failed" | "stopped";
  readonly executionId: string | null;
  readonly restartAt: number | null;
  readonly failure: string | null;
}

export interface AppWorkloadDiagnostic {
  readonly appId: string;
  readonly kind: "service" | "job";
  readonly workloadId: string;
  readonly executionId: string;
  readonly version: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly failure: string | null;
  readonly output: string;
  readonly droppedBytes: number;
}

export interface AppRuntimeAggregate {
  readonly appId: string;
  readonly enabled?: boolean;
  readonly runningWorkloads: number;
  readonly latestFailure: string | null;
  readonly ui: "closed" | "starting" | "running" | "stopping";
  readonly stopping: boolean;
  readonly jobs: readonly AppActiveJob[];
  readonly services?: readonly AppServiceState[];
}
