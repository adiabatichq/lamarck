/** Trusted Shell/Host management state, never an App SDK contract. */
export interface AppActiveJob {
  readonly runId: string;
  readonly jobId: string;
  readonly triggerId: string | null;
  readonly state: "starting" | "running" | "stopping" | "cleanup-failed";
  readonly cleanupError: string | null;
}

export interface AppRuntimeAggregate {
  readonly appId: string;
  readonly runningWorkloads: number;
  readonly latestFailure: string | null;
  readonly ui: "closed" | "starting" | "running" | "stopping";
  readonly stopping: boolean;
  readonly jobs: readonly AppActiveJob[];
}
