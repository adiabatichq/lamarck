import { expect, test, vi } from "vitest";
import { CapsuleManager } from "./manager";
import { CapsuleRestartRequiredError, UnavailableCapsuleBackend, type CapsuleServiceSpec } from "./backend";

const VERSION = "a".repeat(40), DIGEST = `sha256:${"b".repeat(64)}`, ACTIVATION = `activation_${"c".repeat(32)}`;
function harness({ ui = false }: { ui?: boolean } = {}) {
  let policy = { enabled: true, revision: 1, restartBaseMs: 1000, restartMaxMs: 60000, crashCount: 0, restartAt: null as number | null, lastError: null as string | null, cleanupFailed: false };
  let present = true, version = VERSION, failAuthority = false, failObserve = false, appEnabled = true, cleanBoundary = false;
  let settingReply: Promise<void> | null = null;
  let boundaryLost: ((error: unknown) => void) | undefined;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const cleanup = new Map<number, Promise<void>>();
  const attempts: { signal: AbortSignal; exit: ReturnType<typeof Promise.withResolvers<void>>; spec: CapsuleServiceSpec }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input), body = JSON.parse(String(init?.body ?? "{}")); calls.push({ url, body });
    if (url.endsWith("/services")) return Response.json({ apps: present ? [{ appId: "notes", enabled: appEnabled, mode: "normal" }] : [], services: present ? [{ appId: "notes", serviceId: "indexer", version, policy, appEnabled }] : [] });
    if (url.endsWith("/apps/notes/enablement")) { appEnabled = body.enabled; await settingReply; return Response.json({ enabled: appEnabled }); }
    if (url.endsWith("/services/notes/indexer")) {
      if (body.operation === "observe") {
        if (failObserve) throw new Error("observation not acknowledged");
        if (body.revision !== policy.revision) return Response.json({ accepted: false });
        policy = { ...policy, crashCount: body.crashCount, restartAt: body.restartAt, lastError: body.lastError, cleanupFailed: body.cleanupFailed };
        return Response.json({ accepted: true });
      }
      policy = { ...policy, enabled: body.enabled, revision: policy.revision + 1, restartAt: body.enabled ? null : policy.restartAt }; await settingReply; return Response.json({ policy });
    }
    if (url.endsWith("/activation/prepare")) return Response.json({ activation: {
      schemaVersion: 1, activationId: ACTIVATION, activationSequence: 1, appId: "notes", workload: body.workload, mode: "normal",
      version, manifestDigest: DIGEST, packageDigest: DIGEST, immutablePackagePath: "/immutable/notes",
      manifest: { runtime: { ...(ui ? { ui: { command: ["node", "ui.js"], port: 3000 } } : {}), services: { indexer: { command: ["node", "indexer.js"] } }, jobs: { inbox: { command: ["node", "inbox.js"] } } }, permissions: { writes: { files: [], tables: [] } } },
    } });
    if (url.endsWith("/channels") && init?.method === "POST") return Response.json({ mode: "normal", capability: "private-channel-secret", channelId: "channel-a", activationId: ACTIVATION, appCommit: version, manifestDigest: DIGEST, packageDigest: DIGEST });
    if (failAuthority && url.endsWith("/channels/channel-a")) return Response.json({ error: "retirement failed" }, { status: 500 });
    return Response.json({ ok: true });
  };
  const runService = vi.fn(async (spec: CapsuleServiceSpec, signal: AbortSignal, onState?: (state: "running" | "stopping") => void, output?: (bytes: Uint8Array) => void, beforeStart?: () => Promise<void>) => {
    const index = attempts.length, exit = Promise.withResolvers<void>(); void exit.promise.catch(() => {});
    attempts.push({ signal, exit, spec }); await beforeStart?.(); signal.throwIfAborted();
    onState?.("running"); output?.(Buffer.from("watching\n"));
    const abort = () => exit.reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
    try { if (signal.aborted) abort(); await exit.promise; }
    finally { signal.removeEventListener("abort", abort); onState?.("stopping"); await cleanup.get(index); }
  });
  const confirmCleanBoundary = vi.fn(async () => { if (!cleanBoundary) throw new Error("VM cleanup is unconfirmed"); });
  const backend = Object.assign(new UnavailableCapsuleBackend(), { confirmCleanBoundary, status: async () => ({ available: true, backend: "fixture" }), runService,
    setBoundaryLostHandler(handler: (error: unknown) => void) { boundaryLost = handler; } });
  const freshManager = () => new CapsuleManager({ backend, workspacePath: () => "/isolated", coreBaseUrl: () => "http://core", coreToken: "host-secret", fetch, bindSystemSender() {}, unbindSystemSender() {} });
  const manager = freshManager();
  return { manager, freshManager, backend, attempts, runService, cleanup, calls, fetch, confirmCleanBoundary,
    loseBoundary() { boundaryLost!(new Error("injected Capsule boundary loss")); },
    cleanBoundary(value: boolean) { cleanBoundary = value; },
    get appEnabled() { return appEnabled; },
    appEnabledExternally(value: boolean) { appEnabled = value; },
    get policy() { return policy; }, due() { policy.restartAt = 0; },
    holdSettingReply(reply: Promise<void>) { settingReply = reply; },
    retire() { present = false; }, replace() { version = "f".repeat(40); },
    failAuthority(value: boolean) { failAuthority = value; }, failObserve(value: boolean) { failObserve = value; } };
}

test("enabled Services reconcile once, need no UI port, and survive Close UI", async () => {
  const h = harness();
  try {
    await Promise.all([h.manager.reconcileServices(), h.manager.reconcileServices()]);
    await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.reconcileServices(); await h.manager.closeAppUi("notes");
    expect(h.runService).toHaveBeenCalledOnce(); expect(h.attempts[0].signal.aborted).toBe(false);
    expect(h.attempts[0].spec).toMatchObject({ appId: "notes", serviceId: "indexer", activationId: ACTIVATION, version: VERSION });
    expect(h.attempts[0].spec).not.toHaveProperty("port");
    expect(h.manager.appRuntimeStates()[0]).toMatchObject({ ui: "closed", jobs: [], services: [{ enabled: true, state: "running" }] });
    expect(h.calls.find(c => c.url.endsWith("/channels") && c.body.workload)?.body).not.toHaveProperty("jobRunId");
    await h.manager.setAppEnabled("notes", false);
    expect(h.policy.enabled).toBe(true);
    expect(h.manager.appRuntimeStates()[0].services?.[0].state).toBe("stopped");
    await h.manager.reconcileServices(); expect(h.attempts).toHaveLength(1);
  } finally { await h.manager.stopAll(); }
});

test("closing a live UI preserves its running Service through pending and failed viewer cleanup", async () => {
  const h = harness({ ui: true }), stopped = Promise.withResolvers<void>();
  Object.assign(h.backend, {
    async prepareUi() { return { preparationId: "prepared-ui", instanceId: "instance-ui" }; },
    async commitPreparedUi() { return { instanceId: "instance-ui" }; },
  });
  const stopUi = vi.spyOn(h.backend, "stopUi").mockReturnValue(stopped.promise);
  let closing: Promise<void> | undefined;
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.openViewer("notes", { webContentsId: 7, rendererGeneration: 1 }, async () => {});
    const executionId = h.manager.appRuntimeStates()[0].services![0].executionId;
    closing = h.manager.closeAppUi("notes");
    expect(stopUi).toHaveBeenCalledWith("instance-ui");
    expect(h.manager.appRuntimeStates()[0].ui).toBe("stopping");
    for (let i = 0; i < 3; i++) await h.manager.reconcileServices();
    expect(h.attempts[0].signal.aborted).toBe(false);
    expect(h.manager.appRuntimeStates()[0].services?.[0]).toMatchObject({ state: "running", executionId });
    expect(h.runService).toHaveBeenCalledOnce();
    await expect(h.manager.openViewer("notes", { webContentsId: 7, rendererGeneration: 1 }, async () => {})).rejects.toThrow();
    stopped.resolve(); await closing;
    await h.manager.reconcileServices();
    expect(h.attempts[0].signal.aborted).toBe(false);
    expect(h.runService).toHaveBeenCalledOnce();
    await h.manager.trackViewerCleanup("notes", Promise.reject(new Error("retired viewer cleanup failed"))).catch(() => {});
    await h.manager.reconcileServices();
    expect(h.attempts[0].signal.aborted).toBe(false);
    expect(h.manager.appRuntimeStates()[0]).toMatchObject({ latestFailure: "retired viewer cleanup failed", services: [{ state: "running", executionId }] });
    expect(h.runService).toHaveBeenCalledOnce();
  } finally { stopped.resolve(); await closing; await h.manager.stopAll().catch(() => {}); }
});

test("crash restart waits for confirmed cleanup and saved backoff", async () => {
  const h = harness(), gate = Promise.withResolvers<void>(); h.cleanup.set(0, gate.promise);
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.attempts[0].exit.reject(new Error("exit 7")); await h.manager.reconcileServices();
    expect(h.attempts).toHaveLength(1); expect(h.policy.crashCount).toBe(0);
    gate.resolve(); await vi.waitFor(() => expect(h.policy.crashCount).toBe(1));
    expect(h.policy.lastError).toBe("exit 7"); expect(h.policy.restartAt).toBeGreaterThan(Date.now());
    await h.manager.reconcileServices(); expect(h.attempts).toHaveLength(1);
    h.due(); await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
    expect(h.manager.workloadDiagnostics("notes")).toHaveLength(2);
    expect(h.manager.workloadDiagnostics("notes").find(value => value.failure === "exit 7")?.endedAt).not.toBeNull();
  } finally { gate.resolve(); await h.manager.stopAll(); }
});

test("unacknowledged observations cannot admit another Service attempt", async () => {
  const h = harness();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.failObserve(true); h.attempts[0].exit.reject(new Error("crash"));
    await vi.waitFor(() => expect(h.manager.appRuntimeStates()[0].services?.[0].state).toBe("backoff"));
    await expect(h.manager.reconcileServices()).rejects.toThrow("acknowledged"); expect(h.attempts).toHaveLength(1);
    h.failObserve(false); await h.manager.reconcileServices(); expect(h.policy.crashCount).toBe(1);
  } finally { await h.manager.stopAll(); }
});

test.each(["disable", "retire", "shutdown", "app-disable"] as const)("%s fences scheduled Service restarts", async action => {
  const h = harness();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.attempts[0].exit.reject(new Error("crash")); await vi.waitFor(() => expect(h.policy.crashCount).toBe(1));
    if (action === "app-disable") await h.manager.setAppEnabled("notes", false);
    if (action === "disable") await h.manager.setServiceEnabled("notes", "indexer", false);
    if (action === "retire") { h.manager.beginAppRetirement("notes"); h.retire(); await h.manager.retireApp("notes"); h.manager.finishAppRetirement("notes"); }
    if (action === "shutdown") { await h.manager.stopAll(); h.retire(); }
    h.due(); await h.manager.reconcileServices(); expect(h.attempts).toHaveLength(1);
  } finally { await h.manager.stopAll(); }
});

test("failed authority cleanup stays visible and blocks replacement", async () => {
  const h = harness();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.failAuthority(true); h.attempts[0].exit.reject(new Error("crash")); await vi.waitFor(() => expect(h.policy.cleanupFailed).toBe(true));
    h.due(); await h.manager.reconcileServices(); expect(h.attempts).toHaveLength(1);
    expect(h.manager.appRuntimeStates()[0].services?.[0].state).toBe("cleanup-failed");
    h.failAuthority(false); await h.manager.setServiceEnabled("notes", "indexer", false);
    expect(h.manager.appRuntimeStates()[0].services?.[0].enabled).toBe(false);
  } finally { h.failAuthority(false); await h.manager.stopAll(); }
});

test("unconfirmed boundary cleanup cannot be cleared by HTTP revocation", async () => {
  const h = harness();
  h.cleanBoundary(true);
  h.runService.mockImplementation(async () => { throw new CapsuleRestartRequiredError("VM stop unconfirmed"); });
  await h.manager.reconcileServices();
  await vi.waitFor(() => expect(h.policy.cleanupFailed).toBe(true));
  await expect(h.manager.setServiceEnabled("notes", "indexer", false)).rejects.toThrow("unconfirmed");
  await h.manager.setServiceEnabled("notes", "indexer", true);
  await h.manager.reconcileServices();
  expect(h.runService).toHaveBeenCalledOnce();
  expect(h.confirmCleanBoundary).not.toHaveBeenCalled();
  expect(h.policy.cleanupFailed).toBe(true);
  await expect(h.manager.stopAll()).rejects.toThrow();
});

test("replacement joins predecessor cleanup before its process can start", async () => {
  const h = harness(), gate = Promise.withResolvers<void>(); h.cleanup.set(0, gate.promise);
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.replace(); await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
    expect(h.attempts[0].signal.aborted).toBe(true); expect(h.manager.workloadDiagnostics("notes")[0].output).toBe("");
    await h.manager.reconcileServices(); expect(h.attempts).toHaveLength(2);
    gate.resolve(); await vi.waitFor(() => expect(h.manager.workloadDiagnostics("notes")[0].output).toBe("watching\n"));
  } finally { gate.resolve(); await h.manager.stopAll(); }
});

test("finished diagnostics remain readable only for the exact owning App", async () => {
  const h = harness();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    const run = h.manager.workloadDiagnostics("notes")[0];
    expect(() => h.manager.workloadDiagnostics("other", run.executionId)).toThrow("unavailable");
    expect(h.manager.workloadDiagnostics("other")).toEqual([]);
    await h.manager.setServiceEnabled("notes", "indexer", false);
    expect(h.manager.workloadDiagnostics("notes", run.executionId)[0].endedAt).not.toBeNull();
  } finally { await h.manager.stopAll(); }
});

test("Host reconciliation restores persisted enablement after a confirmed shutdown", async () => {
  const h = harness();
  try {
    h.manager.startServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.stopAll(); expect(h.policy.enabled).toBe(true); expect(h.attempts[0].signal.aborted).toBe(true);
    h.manager.startServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
    await h.manager.reconcileServices(); expect(h.attempts).toHaveLength(2);
  } finally { await h.manager.stopAll(); }
});

test("disablement during activation replacement cancels both generations before restart admission", async () => {
  const h = harness(), gate = Promise.withResolvers<void>(); h.cleanup.set(0, gate.promise);
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.replace(); await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
    const disable = h.manager.setServiceEnabled("notes", "indexer", false);
    expect(h.attempts.every(attempt => attempt.signal.aborted)).toBe(true);
    gate.resolve(); await disable; await h.manager.reconcileServices();
    expect(h.attempts).toHaveLength(2); expect(h.policy.enabled).toBe(false);
    expect(h.manager.workloadDiagnostics("notes")[0].output).toBe("");
  } finally { gate.resolve(); await h.manager.stopAll(); }
});

test("App disablement preserves Service choices; re-enable restores only eligible Services and never creates Jobs", async () => {
  const h = harness();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.setAppEnabled("notes", false); expect(h.policy.enabled).toBe(true);
    await h.manager.setServiceEnabled("notes", "indexer", false);
    await h.manager.setAppEnabled("notes", true); await h.manager.reconcileServices();
    expect(h.attempts).toHaveLength(1); expect(h.policy.enabled).toBe(false);
    await h.manager.setServiceEnabled("notes", "indexer", true);
    await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
    expect(h.manager.appRuntimeStates()[0].jobs).toEqual([]);
  } finally { await h.manager.stopAll(); }
});

test("App disablement waits for exact cleanup and fences every background entry while it is pending", async () => {
  const h = harness(), gate = Promise.withResolvers<void>(); h.cleanup.set(0, gate.promise);
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    let finished = false; const disable = h.manager.setAppEnabled("notes", false).then(() => { finished = true; });
    await vi.waitFor(() => expect(h.appEnabled).toBe(false));
    await expect(h.manager.runJob("job-a", "notes", "inbox", new AbortController().signal)).rejects.toThrow("disabled");
    await h.manager.reconcileServices(); expect(h.attempts).toHaveLength(1); expect(finished).toBe(false);
    gate.resolve(); await disable;
    expect(h.policy.enabled).toBe(true); expect(h.manager.appRuntimeStates()[0].enabled).toBe(false);
  } finally { gate.resolve(); await h.manager.stopAll(); }
});

test("persisted disabled Apps remain fenced after Host restart", async () => {
  const h = harness();
  try {
    h.manager.startServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.setAppEnabled("notes", false); await h.manager.stopAll();
    h.manager.startServices(); await h.manager.reconcileServices();
    expect(h.attempts).toHaveLength(1); expect(h.policy.enabled).toBe(true);
    await h.manager.setAppEnabled("notes", true);
    await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
  } finally { await h.manager.stopAll(); }
});

test("Host shutdown joins a delayed enablement reply and fences its late continuation", async () => {
  const h = harness(), gate = Promise.withResolvers<void>();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.setAppEnabled("notes", false); h.holdSettingReply(gate.promise);
    const enable = h.manager.setServiceEnabled("notes", "indexer", true); const rejected = expect(enable).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(h.calls.some(call => call.body.operation === "enablement")).toBe(true));
    let stopped = false; const stop = h.manager.stopAll().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(stopped).toBe(false);
    gate.resolve(); await rejected; await stop;
    expect(h.attempts).toHaveLength(1); expect(h.manager.appRuntimeStates()).toEqual([]);
  } finally { gate.resolve(); await h.manager.stopAll(); }
});

test("a late App enable reply cannot resurrect work after a newer disable request", async () => {
  const h = harness(), gate = Promise.withResolvers<void>();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.setAppEnabled("notes", false); h.holdSettingReply(gate.promise);
    const enable = h.manager.setAppEnabled("notes", true); const rejected = expect(enable).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(h.appEnabled).toBe(true));
    const disable = h.manager.setAppEnabled("notes", false);
    gate.resolve(); await rejected; await disable;
    expect(h.appEnabled).toBe(false); expect(h.policy.enabled).toBe(true); expect(h.attempts).toHaveLength(1);
  } finally { gate.resolve(); await h.manager.stopAll(); }
});

test("Host shutdown joins App setting changes and keeps a late enable reply fenced", async () => {
  const h = harness(), gate = Promise.withResolvers<void>();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.setAppEnabled("notes", false); h.holdSettingReply(gate.promise);
    const enable = h.manager.setAppEnabled("notes", true); const rejected = expect(enable).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(h.appEnabled).toBe(true));
    let stopped = false; const shutdown = h.manager.stopAll().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(stopped).toBe(false);
    gate.resolve(); await rejected; await shutdown;
    expect(h.attempts).toHaveLength(1); expect(h.manager.appRuntimeStates()).toEqual([]);
  } finally { gate.resolve(); await h.manager.stopAll(); }
});


test("stale persisted cleanup is recovered only after a clean-boundary proof, using normal toggles", async () => {
  const h = harness(); Object.assign(h.policy, { cleanupFailed: true, lastError: "previous Host teardown uncertain" });
  try {
    await expect(h.manager.reconcileServices()).rejects.toThrow("unconfirmed");
    expect(h.attempts).toHaveLength(0); expect(h.policy.cleanupFailed).toBe(true);
    await h.manager.setServiceEnabled("notes", "indexer", false);
    await expect(h.manager.setServiceEnabled("notes", "indexer", true)).rejects.toThrow("unconfirmed");
    expect(h.policy.cleanupFailed).toBe(true); expect(h.attempts).toHaveLength(0);
    h.cleanBoundary(true); await h.manager.reconcileServices();
    await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    expect(h.policy.cleanupFailed).toBe(false); expect(h.confirmCleanBoundary).toHaveBeenCalled();
  } finally { await h.manager.stopAll(); }
});

test("confirmed complete Host teardown discharges stale persisted cleanup without an availability-probe shortcut", async () => {
  const h = harness(); Object.assign(h.policy, { cleanupFailed: true });
  try {
    await h.manager.stopAll(); await h.manager.reconcileServices();
    await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    expect(h.policy.cleanupFailed).toBe(false); expect(h.confirmCleanBoundary).not.toHaveBeenCalled();
  } finally { await h.manager.stopAll(); }
});

test("a fresh Host recovers persisted cleanup only after its backend proves a clean boundary", async () => {
  const h = harness(), fresh = h.freshManager(); Object.assign(h.policy, { cleanupFailed: true });
  try {
    await expect(fresh.reconcileServices()).rejects.toThrow("unconfirmed");
    expect(h.attempts).toHaveLength(0);
    h.cleanBoundary(true);
    await fresh.setServiceEnabled("notes", "indexer", false);
    await fresh.setServiceEnabled("notes", "indexer", true);
    await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    expect(h.policy.cleanupFailed).toBe(false);
  } finally { await fresh.stopAll(); await h.manager.stopAll(); }
});

test.each(["before", "after"] as const)("healthy Service recovery clears only its active error and preserves an unrelated failure from %s the crash", async when => {
  const h = harness();
  const failUi = () => h.manager.openViewer("notes", { webContentsId: 7, rendererGeneration: 1 }, async () => {});
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    if (when === "before") await expect(failUi()).rejects.toThrow("does not declare a UI");
    const execution = h.manager.workloadDiagnostics("notes")[0].executionId;
    h.attempts[0].exit.reject(new Error("transient Service crash"));
    await vi.waitFor(() => expect(h.policy.crashCount).toBe(1));
    if (when === "after") await expect(failUi()).rejects.toThrow("does not declare a UI");
    h.due(); await h.manager.reconcileServices();
    await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
    await vi.waitFor(() => expect(h.policy.lastError).toBeNull());
    expect(h.manager.appRuntimeStates()[0]).toMatchObject({ latestFailure: expect.stringContaining("does not declare a UI"), services: [{ state: "running", failure: null }] });
    expect(h.manager.workloadDiagnostics("notes", execution)[0]).toMatchObject({ failure: "transient Service crash", output: "watching\n", endedAt: expect.any(Number) });
    expect(h.policy.crashCount).toBe(1);
  } finally { await h.manager.stopAll(); }
});

test("crash followed by authenticated healthy startup clears App Failed while retaining failed-execution diagnostics", async () => {
  const h = harness();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.attempts[0].exit.reject(new Error("transient crash")); await vi.waitFor(() => expect(h.policy.crashCount).toBe(1));
    h.due(); await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.policy.lastError).toBeNull());
    expect(h.manager.appRuntimeStates()[0]).toMatchObject({ latestFailure: null, services: [{ state: "running", failure: null }] });
    expect(h.manager.workloadDiagnostics("notes").find(run => run.failure === "transient crash")?.endedAt).toEqual(expect.any(Number));
  } finally { await h.manager.stopAll(); }
});

test("healthy Service recovery preserves another workload's unresolved authority cleanup", async () => {
  const h = harness();
  Object.assign(h.backend, { runJob: async () => { throw new Error("job crash"); } });
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.attempts[0].exit.reject(new Error("Service crash")); await vi.waitFor(() => expect(h.policy.crashCount).toBe(1));
    h.failAuthority(true);
    await expect(h.manager.runJob("job-a", "notes", "inbox", new AbortController().signal)).rejects.toThrow("Job authority cleanup failed");
    h.failAuthority(false); h.due(); await h.manager.reconcileServices();
    await vi.waitFor(() => expect(h.policy.lastError).toBeNull());
    expect(h.manager.appRuntimeStates()[0]).toMatchObject({ latestFailure: expect.stringContaining("Job authority cleanup failed"), services: [{ state: "running", failure: null }], jobs: [{ state: "cleanup-failed" }] });
    expect(h.manager.workloadDiagnostics("notes").find(run => run.failure === "Service crash")?.endedAt).toEqual(expect.any(Number));
  } finally { h.failAuthority(false); await h.manager.stopAll(); }
});

test("Service cleanup recovery preserves a Job's unresolved cleanup failure and execution diagnostics", async () => {
  const h = harness(), runJob = vi.fn(async () => {});
  Object.assign(h.backend, { runJob });
  try {
    await h.manager.reconcileServices();
    await vi.waitFor(() => expect(h.manager.appRuntimeStates()[0].services?.[0].state).toBe("running"));
    const serviceExecution = h.manager.workloadDiagnostics("notes")[0].executionId;
    h.failAuthority(true);
    await expect(h.manager.runJob("job-cleanup", "notes", "inbox", new AbortController().signal)).rejects.toThrow("Job authority cleanup failed");
    expect(runJob).toHaveBeenCalledOnce();
    const jobEvidence = h.manager.workloadDiagnostics("notes", "job-cleanup")[0];
    expect(jobEvidence).toMatchObject({ failure: expect.stringContaining("Job authority cleanup failed"), endedAt: expect.any(Number) });
    await expect(h.manager.setServiceEnabled("notes", "indexer", false)).rejects.toThrow("Service authority cleanup failed");
    expect(h.manager.appRuntimeStates()[0]).toMatchObject({ jobs: [{ state: "cleanup-failed" }], services: [{ state: "cleanup-failed" }] });
    const serviceEvidence = h.manager.workloadDiagnostics("notes", serviceExecution)[0];
    expect(serviceEvidence).toMatchObject({ failure: expect.stringContaining("Service authority cleanup failed"), endedAt: expect.any(Number) });
    h.failAuthority(false);
    await h.manager.setServiceEnabled("notes", "indexer", false);
    await h.manager.setServiceEnabled("notes", "indexer", true);
    await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
    await vi.waitFor(() => expect(h.policy.lastError).toBeNull());
    expect(h.manager.appRuntimeStates()[0]).toMatchObject({
      latestFailure: expect.stringContaining("Job authority cleanup failed"),
      jobs: [{ state: "cleanup-failed" }], services: [{ state: "running", failure: null }],
    });
    expect(h.manager.workloadDiagnostics("notes", "job-cleanup")[0]).toEqual(jobEvidence);
    expect(h.manager.workloadDiagnostics("notes", serviceExecution)[0]).toEqual(serviceEvidence);
  } finally { h.failAuthority(false); await h.manager.stopAll(); }
});

test("successful exact authority cleanup and startup clear only the recovered Service's current failure", async () => {
  const h = harness();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.failAuthority(true); h.attempts[0].exit.reject(new Error("Service crash"));
    await vi.waitFor(() => expect(h.policy.cleanupFailed).toBe(true));
    const execution = h.manager.workloadDiagnostics("notes")[0].executionId;
    h.failAuthority(false);
    await h.manager.setServiceEnabled("notes", "indexer", false);
    await h.manager.setServiceEnabled("notes", "indexer", true);
    await vi.waitFor(() => expect(h.policy.lastError).toBeNull());
    expect(h.manager.appRuntimeStates()[0]).toMatchObject({ latestFailure: null, services: [{ state: "running", failure: null }] });
    expect(h.manager.workloadDiagnostics("notes", execution)[0].failure).toContain("Service authority cleanup failed");
  } finally { h.failAuthority(false); await h.manager.stopAll(); }
});

test("Capsule containment retains the Service loop and requires saved backoff before another attempt", async () => {
  const h = harness(), stop = Promise.withResolvers<void>();
  const stopAll = vi.spyOn(h.backend, "stopAll").mockReturnValueOnce(stop.promise);
  h.policy.restartBaseMs = 60_000;
  try {
    h.manager.startServices();
    await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.loseBoundary();
    expect(h.attempts[0].signal.aborted).toBe(true);
    await h.manager.reconcileServices(); expect(h.attempts).toHaveLength(1);
    stop.resolve();
    await vi.waitFor(async () => expect(await h.manager.status()).toMatchObject({ available: true }));
    h.failObserve(true);
    await expect(h.manager.reconcileServices()).rejects.toThrow("acknowledged");
    expect(h.attempts).toHaveLength(1);
    h.failObserve(false);
    await h.manager.reconcileServices();
    expect(h.policy).toMatchObject({ enabled: true, crashCount: 1, cleanupFailed: false, lastError: "Capsule boundary lost" });
    expect(h.policy.restartAt).toBeGreaterThan(Date.now());
    for (let i = 0; i < 5; i++) await h.manager.reconcileServices();
    expect(h.attempts).toHaveLength(1);
    h.due();
    // The existing timer, rather than a newly created recovery loop, notices
    // the due policy. This also catches accidentally abandoning that timer.
    await vi.waitFor(() => expect(h.attempts).toHaveLength(2), { timeout: 2500 });
    expect(stopAll).toHaveBeenCalledOnce();
    expect(h.manager.workloadDiagnostics("notes")).toHaveLength(2);
  } finally { stop.resolve(); h.failObserve(false); await h.manager.stopAll(); }
});

test("an unconfirmed Capsule stop keeps enabled Services unavailable without restarting them", async () => {
  const h = harness();
  const stopAll = vi.spyOn(h.backend, "stopAll").mockRejectedValue(new CapsuleRestartRequiredError("VM stop unconfirmed; restart Lamarck before using Apps"));
  try {
    h.manager.startServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.loseBoundary();
    await vi.waitFor(async () => expect(await h.manager.status()).toMatchObject({ available: false, restartRequired: true }));
    h.due();
    for (let i = 0; i < 5; i++) await h.manager.reconcileServices();
    await expect(h.manager.setServiceEnabled("notes", "indexer", true)).rejects.toThrow();
    expect(h.attempts).toHaveLength(1);
    expect(stopAll).toHaveBeenCalledOnce();
    expect(h.calls.some(call => call.url.endsWith("/apps/notes/channels"))).toBe(true);
    expect(h.calls.some(call => call.url.includes("/api/apps/activation/"))).toBe(true);
  } finally { await h.manager.stopAll().catch(() => {}); }
});

test("containment cancels both Service replacement generations and waits for their existing cleanup", async () => {
  const h = harness(), cleanup = Promise.withResolvers<void>();
  h.cleanup.set(0, cleanup.promise);
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.replace(); await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
    h.loseBoundary();
    expect(h.attempts.every(value => value.signal.aborted)).toBe(true);
    await expect(h.manager.status()).resolves.toMatchObject({ available: false });
    await h.manager.reconcileServices(); expect(h.attempts).toHaveLength(2);
    cleanup.resolve();
    await vi.waitFor(async () => expect(await h.manager.status()).toMatchObject({ available: true }));
    await h.manager.reconcileServices();
    expect(h.attempts).toHaveLength(2);
    expect(h.policy.restartAt).toBeGreaterThan(Date.now());
  } finally { cleanup.resolve(); await h.manager.stopAll(); }
});

test("intentional Host teardown can join Capsule containment and later start Services normally", async () => {
  const h = harness(), cleanup = Promise.withResolvers<void>();
  h.cleanup.set(0, cleanup.promise);
  try {
    h.manager.startServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    h.loseBoundary();
    const stopped = h.manager.stopAll();
    cleanup.resolve(); await stopped;
    h.manager.startServices();
    h.due(); await h.manager.reconcileServices();
    await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
  } finally { cleanup.resolve(); await h.manager.stopAll(); }
});

test("an enable acknowledged during Capsule containment releases only its own temporary admission block", async () => {
  const h = harness(), reply = Promise.withResolvers<void>();
  try {
    h.manager.startServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.setAppEnabled("notes", false);
    h.holdSettingReply(reply.promise);
    const enabled = h.manager.setAppEnabled("notes", true);
    const cancelled = expect(enabled).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(h.appEnabled).toBe(true));
    h.loseBoundary();
    reply.resolve(); await cancelled;
    await vi.waitFor(async () => expect(await h.manager.status()).toMatchObject({ available: true }));
    await h.manager.reconcileServices();
    await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
    expect(h.manager.appRuntimeStates()[0]).toMatchObject({ enabled: true, latestFailure: null, services: [{ state: "running" }] });
  } finally { reply.resolve(); await h.manager.stopAll(); }
});

test("a genuinely disabled App remains disabled after Capsule containment", async () => {
  const h = harness();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.setAppEnabled("notes", false);
    h.loseBoundary();
    await vi.waitFor(async () => expect(await h.manager.status()).toMatchObject({ available: true }));
    for (let i = 0; i < 3; i++) await h.manager.reconcileServices();
    expect(h.attempts).toHaveLength(1);
    expect(h.appEnabled).toBe(false);
    expect(h.manager.appRuntimeStates()[0]).toMatchObject({ enabled: false, services: [{ state: "stopped" }] });
  } finally { await h.manager.stopAll(); }
});

test.each(["before", "after"] as const)("a newer disable intent %s boundary loss survives an older enable acknowledgement", async when => {
  const h = harness(), reply = Promise.withResolvers<void>();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.setAppEnabled("notes", false);
    h.holdSettingReply(reply.promise);
    const enabled = h.manager.setAppEnabled("notes", true);
    const cancelledEnable = expect(enabled).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(h.appEnabled).toBe(true));
    if (when === "after") h.loseBoundary();
    const disabled = h.manager.setAppEnabled("notes", false);
    const cancelledDisable = expect(disabled).rejects.toThrow("cancelled");
    if (when === "before") h.loseBoundary();
    reply.resolve(); await Promise.all([cancelledEnable, cancelledDisable]);
    await vi.waitFor(async () => expect(await h.manager.status()).toMatchObject({ available: true }));
    for (let i = 0; i < 3; i++) await h.manager.reconcileServices();
    expect(h.attempts).toHaveLength(1);
    expect(h.manager.appRuntimeStates()[0].services?.[0].state).toBe("stopped");
    // Retrying the latest intent can still persist it after containment.
    await h.manager.setAppEnabled("notes", false);
    expect(h.appEnabled).toBe(false);
  } finally { reply.resolve(); await h.manager.stopAll(); }
});

test("an interrupted enable resumes independent Services while retaining viewer cleanup diagnostics", async () => {
  const h = harness(), reply = Promise.withResolvers<void>();
  try {
    await h.manager.reconcileServices(); await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
    await h.manager.setAppEnabled("notes", false);
    h.holdSettingReply(reply.promise);
    const enabled = h.manager.setAppEnabled("notes", true);
    const cancelled = expect(enabled).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(h.appEnabled).toBe(true));
    h.loseBoundary();
    await h.manager.trackViewerCleanup("notes", Promise.reject(new Error("viewer cleanup failed"))).catch(() => {});
    reply.resolve(); await cancelled;
    await vi.waitFor(async () => expect(await h.manager.status()).toMatchObject({ available: true }));
    for (let i = 0; i < 3; i++) await h.manager.reconcileServices();
    await vi.waitFor(() => expect(h.attempts).toHaveLength(2));
    expect(h.manager.appRuntimeStates()[0]).toMatchObject({ enabled: true, ui: "stopping", latestFailure: "viewer cleanup failed", services: [{ state: "running" }] });
    await expect(h.manager.setAppMode("notes", "exp")).rejects.toThrow("Stop the App");
  } finally { reply.resolve(); await h.manager.stopAll().catch(() => {}); }
});
