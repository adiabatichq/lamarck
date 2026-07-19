import { createHash } from "node:crypto";
import type { WorkloadKind, WorkloadPrepareBody } from "../protocol/types";

export type SupervisorStatus =
  | "waiting-initialize"
  | "ready"
  | "draining"
  | "stopped"
  | "faulted";

export type AppStatus = "preparing" | "ready" | "stopping" | "stopped" | "faulted";

export type WorkloadStatus =
  | "awaiting-sdk"
  | "prepared"
  | "starting"
  | "running"
  | "ready"
  | "stopping"
  | "exited"
  | "faulted";

export interface WorkloadState {
  readonly handle: string;
  readonly kind: WorkloadKind;
  readonly launchSpecFingerprint: string;
  readonly status: WorkloadStatus;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly fault?: string;
}

export type WorkloadLaunchSpec = Pick<
  WorkloadPrepareBody,
  "argv" | "cwd" | "environment" | "sdkTicket" | "logsTicket" | "uiPort"
>;

export interface AppState {
  readonly handle: string;
  readonly artifactDigest: string;
  readonly mappedHostUid: number;
  readonly mappedHostGid: number;
  readonly status: AppStatus;
  readonly workloads: Readonly<Record<string, WorkloadState>>;
  readonly fault?: string;
}

export interface SupervisorState {
  readonly bootId: string;
  readonly imageDigest: string;
  readonly sessionId?: string;
  readonly status: SupervisorStatus;
  readonly apps: Readonly<Record<string, AppState>>;
  readonly fault?: string;
}

export type SupervisorEvent =
  | { type: "session.initialize"; sessionId: string }
  | {
    type: "app.prepare";
    appHandle: string;
    artifactDigest: string;
    mappedHostUid: number;
    mappedHostGid: number;
  }
  | { type: "app.prepared"; appHandle: string }
  | { type: "app.stop"; appHandle: string }
  | { type: "app.stopped"; appHandle: string }
  | { type: "app.faulted"; appHandle: string; reason: string }
  | {
    type: "workload.prepare";
    appHandle: string;
    workloadHandle: string;
    workloadKind: WorkloadKind;
    launchSpec: WorkloadLaunchSpec;
  }
  | { type: "workload.sdk-attached"; appHandle: string; workloadHandle: string }
  | { type: "workload.start"; appHandle: string; workloadHandle: string }
  | { type: "workload.started"; appHandle: string; workloadHandle: string }
  | { type: "workload.ready"; appHandle: string; workloadHandle: string }
  | { type: "workload.stop"; appHandle: string; workloadHandle: string }
  | {
    type: "workload.exited";
    appHandle: string;
    workloadHandle: string;
    exitCode: number | null;
    signal: string | null;
  }
  | { type: "workload.faulted"; appHandle: string; workloadHandle: string; reason: string }
  | { type: "vm.drain" }
  | { type: "session.lost"; reason: string }
  | { type: "vm.stopped" };

export class StateTransitionError extends Error {
  readonly code = "CAPSULE_STATE_CONFLICT";
  readonly eventType: SupervisorEvent["type"];

  constructor(eventType: SupervisorEvent["type"], message: string) {
    super(`${eventType}: ${message}`);
    this.name = "StateTransitionError";
    this.eventType = eventType;
  }
}

export function createSupervisorState(options: {
  bootId: string;
  imageDigest: string;
}): SupervisorState {
  return {
    bootId: options.bootId,
    imageDigest: options.imageDigest,
    status: "waiting-initialize",
    apps: {},
  };
}

/** Pure transition function. It never mutates the input state or nested records. */
export function transitionSupervisor(
  state: SupervisorState,
  event: SupervisorEvent,
): SupervisorState {
  switch (event.type) {
    case "session.initialize": {
      requireStatus(state, event, ["waiting-initialize"]);
      return { ...state, status: "ready", sessionId: event.sessionId };
    }

    case "app.prepare": {
      requireStatus(state, event, ["ready"]);
      const existing = state.apps[event.appHandle];
      if (existing) {
        if (
          (existing.status === "preparing" || existing.status === "ready")
          && existing.artifactDigest === event.artifactDigest
          && existing.mappedHostUid === event.mappedHostUid
          && existing.mappedHostGid === event.mappedHostGid
        ) {
          return state;
        }
        conflict(event, `App handle ${event.appHandle} cannot be reused`);
      }
      for (const app of Object.values(state.apps)) {
        if (rangesOverlap(event.mappedHostUid, app.mappedHostUid)) {
          conflict(event, `UID range overlaps App ${app.handle}`);
        }
        if (rangesOverlap(event.mappedHostGid, app.mappedHostGid)) {
          conflict(event, `GID range overlaps App ${app.handle}`);
        }
      }
      const app: AppState = {
        handle: event.appHandle,
        artifactDigest: event.artifactDigest,
        mappedHostUid: event.mappedHostUid,
        mappedHostGid: event.mappedHostGid,
        status: "preparing",
        workloads: {},
      };
      return withApp(state, app);
    }

    case "app.prepared": {
      const app = requireApp(state, event, event.appHandle);
      requireAppStatus(app, event, ["preparing"]);
      return withApp(state, { ...app, status: "ready" });
    }

    case "workload.prepare": {
      requireStatus(state, event, ["ready"]);
      const app = requireApp(state, event, event.appHandle);
      requireAppStatus(app, event, ["ready"]);
      const existing = app.workloads[event.workloadHandle];
      const launchSpecFingerprint = fingerprintWorkloadLaunchSpec(event.launchSpec);
      if (existing) {
        if (
          (existing.status === "awaiting-sdk" || existing.status === "prepared")
          && existing.kind === event.workloadKind
          && existing.launchSpecFingerprint === launchSpecFingerprint
        ) {
          return state;
        }
        conflict(event, `Workload handle ${event.workloadHandle} cannot be reused`);
      }
      return withWorkload(state, app, {
        handle: event.workloadHandle,
        kind: event.workloadKind,
        launchSpecFingerprint,
        status: "awaiting-sdk",
      });
    }

    case "workload.sdk-attached": {
      const { app, workload } = requireWorkload(state, event, event.appHandle, event.workloadHandle);
      requireWorkloadStatus(workload, event, ["awaiting-sdk"]);
      return withWorkload(state, app, { ...workload, status: "prepared" });
    }

    case "workload.start": {
      requireStatus(state, event, ["ready"]);
      const { app, workload } = requireWorkload(state, event, event.appHandle, event.workloadHandle);
      requireAppStatus(app, event, ["ready"]);
      requireWorkloadStatus(workload, event, ["prepared"]);
      return withWorkload(state, app, { ...workload, status: "starting" });
    }

    case "workload.started": {
      const { app, workload } = requireWorkload(state, event, event.appHandle, event.workloadHandle);
      requireWorkloadStatus(workload, event, ["starting"]);
      return withWorkload(state, app, { ...workload, status: "running" });
    }

    case "workload.ready": {
      const { app, workload } = requireWorkload(state, event, event.appHandle, event.workloadHandle);
      if (workload.kind !== "ui") conflict(event, "Only a UI workload has viewer readiness");
      requireWorkloadStatus(workload, event, ["running"]);
      return withWorkload(state, app, { ...workload, status: "ready" });
    }

    case "workload.stop": {
      const { app, workload } = requireWorkload(state, event, event.appHandle, event.workloadHandle);
      if (workload.status === "stopping" || isTerminalWorkload(workload.status)) return state;
      return withWorkload(state, app, { ...workload, status: "stopping" });
    }

    case "workload.exited": {
      const { app, workload } = requireWorkload(state, event, event.appHandle, event.workloadHandle);
      requireWorkloadStatus(workload, event, ["starting", "running", "ready", "stopping"]);
      return withWorkload(state, app, {
        ...workload,
        status: "exited",
        exitCode: event.exitCode,
        signal: event.signal,
      });
    }

    case "workload.faulted": {
      const { app, workload } = requireWorkload(state, event, event.appHandle, event.workloadHandle);
      if (isTerminalWorkload(workload.status)) return state;
      return withWorkload(state, app, {
        ...workload,
        status: "faulted",
        fault: event.reason,
      });
    }

    case "app.stop": {
      const app = requireApp(state, event, event.appHandle);
      if (app.status === "stopping" || app.status === "stopped") return state;
      return withApp(state, stopApp(app));
    }

    case "app.stopped": {
      const app = requireApp(state, event, event.appHandle);
      requireAppStatus(app, event, ["stopping"]);
      const active = Object.values(app.workloads).find(
        (workload) => !isTerminalWorkload(workload.status),
      );
      if (active) conflict(event, `Workload ${active.handle} has not exited`);
      // `app.stopped` is emitted only after the Guest resource manager has
      // proved the aggregate cgroup empty and removed the App's netns, mounts,
      // and scratch volume. Retire the active record at that authority point.
      // Keeping stopped Apps here would retain their UID/GID ranges forever,
      // even though the Host is then allowed to reuse a released range.
      return withoutApp(state, app.handle);
    }

    case "app.faulted": {
      const app = requireApp(state, event, event.appHandle);
      if (app.status === "stopped") return state;
      const stopped = stopApp(app);
      return withApp(state, { ...stopped, status: "faulted", fault: event.reason });
    }

    case "vm.drain": {
      if (state.status === "draining") return state;
      requireStatus(state, event, ["ready"]);
      return {
        ...state,
        status: "draining",
        apps: mapApps(state.apps, stopApp),
      };
    }

    case "session.lost": {
      if (state.status === "stopped") return state;
      return {
        ...state,
        sessionId: undefined,
        status: "faulted",
        fault: event.reason,
        apps: mapApps(state.apps, stopApp),
      };
    }

    case "vm.stopped": {
      requireStatus(state, event, ["draining", "faulted"]);
      const active = Object.values(state.apps).find((app) => app.status !== "stopped");
      if (active) conflict(event, `App ${active.handle} has not stopped`);
      return { ...state, status: "stopped" };
    }
  }
}

export function fingerprintWorkloadLaunchSpec(spec: WorkloadLaunchSpec): string {
  const environment = Object.entries(spec.environment)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const canonical = JSON.stringify({
    argv: spec.argv,
    cwd: spec.cwd,
    environment,
    sdkTicket: spec.sdkTicket,
    ...(spec.logsTicket === undefined ? {} : { logsTicket: spec.logsTicket }),
    ...(spec.uiPort === undefined ? {} : { uiPort: spec.uiPort }),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function rangesOverlap(leftBase: number, rightBase: number): boolean {
  const rangeSize = 65_536;
  return leftBase < rightBase + rangeSize && rightBase < leftBase + rangeSize;
}

function stopApp(app: AppState): AppState {
  if (app.status === "stopped") return app;
  const workloads: Record<string, WorkloadState> = {};
  for (const [handle, workload] of Object.entries(app.workloads)) {
    workloads[handle] = isTerminalWorkload(workload.status)
      ? workload
      : { ...workload, status: "stopping" };
  }
  return { ...app, status: "stopping", workloads };
}

function mapApps(
  apps: Readonly<Record<string, AppState>>,
  transform: (app: AppState) => AppState,
): Readonly<Record<string, AppState>> {
  const next: Record<string, AppState> = {};
  for (const [handle, app] of Object.entries(apps)) next[handle] = transform(app);
  return next;
}

function withApp(state: SupervisorState, app: AppState): SupervisorState {
  return { ...state, apps: { ...state.apps, [app.handle]: app } };
}

function withoutApp(state: SupervisorState, appHandle: string): SupervisorState {
  const apps = { ...state.apps };
  delete apps[appHandle];
  return { ...state, apps };
}

function withWorkload(
  state: SupervisorState,
  app: AppState,
  workload: WorkloadState,
): SupervisorState {
  return withApp(state, {
    ...app,
    workloads: { ...app.workloads, [workload.handle]: workload },
  });
}

function requireApp(
  state: SupervisorState,
  event: SupervisorEvent,
  appHandle: string,
): AppState {
  const app = state.apps[appHandle];
  if (!app) conflict(event, `Unknown App handle ${appHandle}`);
  return app;
}

function requireWorkload(
  state: SupervisorState,
  event: SupervisorEvent,
  appHandle: string,
  workloadHandle: string,
): { app: AppState; workload: WorkloadState } {
  const app = requireApp(state, event, appHandle);
  const workload = app.workloads[workloadHandle];
  if (!workload) conflict(event, `Unknown workload handle ${workloadHandle}`);
  return { app, workload };
}

function requireStatus(
  state: SupervisorState,
  event: SupervisorEvent,
  allowed: readonly SupervisorStatus[],
): void {
  if (!allowed.includes(state.status)) {
    conflict(event, `Supervisor is ${state.status}; expected ${allowed.join(" or ")}`);
  }
}

function requireAppStatus(
  app: AppState,
  event: SupervisorEvent,
  allowed: readonly AppStatus[],
): void {
  if (!allowed.includes(app.status)) {
    conflict(event, `App ${app.handle} is ${app.status}; expected ${allowed.join(" or ")}`);
  }
}

function requireWorkloadStatus(
  workload: WorkloadState,
  event: SupervisorEvent,
  allowed: readonly WorkloadStatus[],
): void {
  if (!allowed.includes(workload.status)) {
    conflict(
      event,
      `Workload ${workload.handle} is ${workload.status}; expected ${allowed.join(" or ")}`,
    );
  }
}

function isTerminalWorkload(status: WorkloadStatus): boolean {
  return status === "exited" || status === "faulted";
}

function conflict(event: SupervisorEvent, message: string): never {
  throw new StateTransitionError(event.type, message);
}
