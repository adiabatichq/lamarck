import { describe, expect, test } from "vitest";
import {
  createSupervisorState,
  StateTransitionError,
  transitionSupervisor,
  type SupervisorEvent,
  type SupervisorState,
} from "../src/state/supervisor-state";

const BOOT_ID = "B".repeat(22);
const SESSION_ID = "S".repeat(43);
const APP_HANDLE = "A".repeat(22);
const WORKLOAD_HANDLE = "W".repeat(22);
const OTHER_APP_HANDLE = "C".repeat(22);
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const ARTIFACT_DIGEST = `sha256:${"b".repeat(64)}`;

describe("pure Capsule supervisor state machine", () => {
  test("requires SDK attachment before starting a UI workload", () => {
    let state = readyApp();
    const beforePrepare = state;
    state = apply(state, {
      type: "workload.prepare",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
      workloadKind: "ui",
      launchSpec: uiLaunchSpec(),
    });
    expect(beforePrepare.apps[APP_HANDLE]?.workloads).toEqual({});
    expect(state.apps[APP_HANDLE]?.workloads[WORKLOAD_HANDLE]?.status).toBe("awaiting-sdk");

    expect(() => apply(state, {
      type: "workload.start",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
    })).toThrowError(
      expect.objectContaining<Partial<StateTransitionError>>({ code: "CAPSULE_STATE_CONFLICT" }),
    );

    state = apply(state, {
      type: "workload.sdk-attached",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
    });
    state = apply(state, {
      type: "workload.start",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
    });
    state = apply(state, {
      type: "workload.started",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
    });
    state = apply(state, {
      type: "workload.ready",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
    });
    expect(state.apps[APP_HANDLE]?.workloads[WORKLOAD_HANDLE]?.status).toBe("ready");
  });

  test("does not let service readiness impersonate UI readiness", () => {
    let state = readyApp();
    state = apply(state, {
      type: "workload.prepare",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
      workloadKind: "service",
      launchSpec: serviceLaunchSpec(),
    });
    state = apply(state, {
      type: "workload.sdk-attached",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
    });
    state = apply(state, {
      type: "workload.start",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
    });
    state = apply(state, {
      type: "workload.started",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
    });
    expect(() => apply(state, {
      type: "workload.ready",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
    })).toThrowError(/Only a UI workload/);
  });

  test("makes App handles idempotent only for identical preparation", () => {
    const initial = initialized();
    const prepared = apply(initial, appPrepare());
    expect(apply(prepared, appPrepare())).toBe(prepared);
    expect(() => apply(prepared, {
      ...appPrepare(),
      artifactDigest: `sha256:${"c".repeat(64)}`,
    })).toThrowError(/cannot be reused/);
  });

  test("rejects overlapping App UID or GID namespace ranges", () => {
    const first = apply(initialized(), appPrepare());
    expect(() => apply(first, {
      ...appPrepare(),
      appHandle: OTHER_APP_HANDLE,
      mappedHostUid: 165_535,
      mappedHostGid: 400_000,
    })).toThrowError(/UID range overlaps/);
    expect(() => apply(first, {
      ...appPrepare(),
      appHandle: OTHER_APP_HANDLE,
      mappedHostUid: 400_000,
      mappedHostGid: 265_535,
    })).toThrowError(/GID range overlaps/);
    expect(() => apply(first, {
      ...appPrepare(),
      appHandle: OTHER_APP_HANDLE,
      mappedHostUid: 165_536,
      mappedHostGid: 265_536,
    })).not.toThrow();
  });

  test("treats workload prepare as idempotent only for the identical launch spec", () => {
    let state = readyApp();
    const prepare: Extract<SupervisorEvent, { type: "workload.prepare" }> = {
      type: "workload.prepare",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
      workloadKind: "ui",
      launchSpec: uiLaunchSpec(),
    };
    state = apply(state, prepare);
    expect(apply(state, prepare)).toBe(state);
    expect(() => apply(state, {
      ...prepare,
      launchSpec: { ...uiLaunchSpec(), argv: ["node", "attacker.mjs"] },
    })).toThrowError(/cannot be reused/);
    expect(() => apply(state, {
      ...prepare,
      launchSpec: { ...uiLaunchSpec(), sdkTicket: "U".repeat(43) },
    })).toThrowError(/cannot be reused/);
  });

  test("session loss enters fail-closed state and stops every active workload", () => {
    let state = readyRunningUi();
    state = apply(state, { type: "session.lost", reason: "control transport closed" });
    expect(state.status).toBe("faulted");
    expect(state.sessionId).toBeUndefined();
    expect(state.fault).toBe("control transport closed");
    expect(state.apps[APP_HANDLE]?.status).toBe("stopping");
    expect(state.apps[APP_HANDLE]?.workloads[WORKLOAD_HANDLE]?.status).toBe("stopping");
  });

  test("will not mark an App stopped before every process tree exits", () => {
    let state = readyRunningUi();
    state = apply(state, { type: "app.stop", appHandle: APP_HANDLE });
    expect(() => apply(state, { type: "app.stopped", appHandle: APP_HANDLE })).toThrowError(
      /has not exited/,
    );
    state = apply(state, {
      type: "workload.exited",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
      exitCode: null,
      signal: "SIGKILL",
    });
    state = apply(state, { type: "app.stopped", appHandle: APP_HANDLE });
    expect(state.apps[APP_HANDLE]).toBeUndefined();
  });

  test("retires an authoritatively stopped App so its namespace can be reused", () => {
    let state = apply(initialized(), appPrepare());
    state = apply(state, { type: "app.prepared", appHandle: APP_HANDLE });
    state = apply(state, { type: "app.stop", appHandle: APP_HANDLE });
    state = apply(state, { type: "app.stopped", appHandle: APP_HANDLE });

    expect(() => apply(state, {
      ...appPrepare(),
      appHandle: OTHER_APP_HANDLE,
    })).not.toThrow();
  });
});

function initial(): SupervisorState {
  return createSupervisorState({ bootId: BOOT_ID, imageDigest: IMAGE_DIGEST });
}

function initialized(): SupervisorState {
  return apply(initial(), { type: "session.initialize", sessionId: SESSION_ID });
}

function readyApp(): SupervisorState {
  let state = apply(initialized(), appPrepare());
  state = apply(state, { type: "app.prepared", appHandle: APP_HANDLE });
  return state;
}

function readyRunningUi(): SupervisorState {
  let state = readyApp();
  for (const event of [
    {
      type: "workload.prepare",
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
      workloadKind: "ui",
      launchSpec: uiLaunchSpec(),
    },
    { type: "workload.sdk-attached", appHandle: APP_HANDLE, workloadHandle: WORKLOAD_HANDLE },
    { type: "workload.start", appHandle: APP_HANDLE, workloadHandle: WORKLOAD_HANDLE },
    { type: "workload.started", appHandle: APP_HANDLE, workloadHandle: WORKLOAD_HANDLE },
    { type: "workload.ready", appHandle: APP_HANDLE, workloadHandle: WORKLOAD_HANDLE },
  ] as SupervisorEvent[]) {
    state = apply(state, event);
  }
  return state;
}

function appPrepare(): Extract<SupervisorEvent, { type: "app.prepare" }> {
  return {
    type: "app.prepare",
    appHandle: APP_HANDLE,
    artifactDigest: ARTIFACT_DIGEST,
    mappedHostUid: 100_000,
    mappedHostGid: 200_000,
  };
}

function apply(state: SupervisorState, event: SupervisorEvent): SupervisorState {
  return transitionSupervisor(state, event);
}

function uiLaunchSpec() {
  return {
    argv: ["npm", "run", "start"],
    cwd: "/app",
    environment: { NODE_ENV: "production" },
    sdkTicket: "T".repeat(43),
    uiPort: 3_000,
  };
}

function serviceLaunchSpec() {
  return {
    argv: ["node", "service.mjs"],
    cwd: "/app",
    environment: {},
    sdkTicket: "T".repeat(43),
  };
}
