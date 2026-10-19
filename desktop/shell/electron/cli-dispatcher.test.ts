import { describe, expect, test, vi } from "vitest";
import { encodeCliHttpResponse, decodeCliHttpResponse, type AppRuntimeState } from "@lamarck/cli";
import { CapsuleDiagnostics } from "./capsule/diagnostics";
import { CliOperationDispatcher, type ManagedCliIdentity } from "./cli-dispatcher";

describe("Shell CLI operation dispatcher", () => {
  test("binds the selected principal and joins committed Capsule runtime state", async () => {
    let forwarded: unknown;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      forwarded = JSON.parse(String(init?.body));
      return Response.json({
        requestId: "apps-1",
        ok: true,
        result: [app("running"), app("idle")],
      });
    });
    const dispatcher = create(fetchImpl, [{ appId: "running", runningWorkloads: 1 }]);
    const request = { requestId: "apps-1", operation: "app.list", input: {} } as const;
    const result = await dispatcher.dispatch(request, { environment: "managed", principal: identity() });

    expect(forwarded).toEqual({ request, principal: identity() });
    expect(result.response).toMatchObject({
      ok: true,
      result: [
        { id: "running", runtime: { running: true } },
        { id: "idle", runtime: { running: false } },
      ],
    });
  });

  test("uses the one archive coordinator and preserves typed domain failures", async () => {
    const events: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      events.push("core");
      return Response.json({
        requestId: body.request.requestId,
        ok: false,
        error: { code: "APP_NOT_FOUND", message: "App not found: missing" },
      });
    });
    const dispatcher = new CliOperationDispatcher({
      coreBaseUrl: "http://127.0.0.1:3000",
      coreToken: "core-secret",
      fetch: fetchImpl,
      runtimeStates: () => [],
      archive: async (_request, _context, executeCore) => {
        events.push("coordinate");
        return { response: await executeCore() };
      },
    });
    const response = await dispatcher.dispatch(
      { requestId: "archive-1", operation: "app.archive", input: { appId: "missing" } },
      { environment: "host", principal: { kind: "system" } },
    );
    expect(events).toEqual(["coordinate", "core"]);
    expect(response.response).toEqual({
      requestId: "archive-1",
      ok: false,
      error: { code: "APP_NOT_FOUND", message: "App not found: missing" },
    });
  });

  test("rejects operations outside the negotiated environment before Core", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await create(fetchImpl, []).dispatch(
      { requestId: "refresh-1", operation: "app.refresh", input: { appId: "focus" } },
      { environment: "host", principal: { kind: "system" } },
    );
    expect(response.response).toMatchObject({ ok: false, error: { code: "CLI_UNSUPPORTED_COMMAND" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("preserves a typed Core failure even when Core returns a non-success HTTP status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      requestId: "source-1",
      ok: false,
      error: { code: "SOURCE_NOT_FOUND", message: "Source missing was not found." },
    }, { status: 404 }));
    const result = await create(fetchImpl, []).dispatch(
      { requestId: "source-1", operation: "source.inspect", input: { sourceId: "missing" } },
      { environment: "host", principal: { kind: "system" } },
    );
    expect(result.response).toEqual({
      requestId: "source-1",
      ok: false,
      error: { code: "SOURCE_NOT_FOUND", message: "Source missing was not found." },
    });
  });
});

function create(fetchImpl: typeof fetch, states: readonly { appId: string; runningWorkloads: number }[]) {
  return new CliOperationDispatcher({
    coreBaseUrl: "http://127.0.0.1:3000",
    coreToken: "core-secret",
    fetch: fetchImpl,
    runtimeStates: () => states.map(state => ({ ...state, ui: "closed", stopping: false, latestFailure: null, jobs: [] })),
  });
}

function identity(): ManagedCliIdentity {
  return {
    kind: "app",
    appId: "initiator",
    workload: "ui",
    appCommit: "a".repeat(40),
    writeTables: ["app_initiator_notes"],
    fileGrants: ["apps/initiator/"],
    workloadHandle: "workload_1",
  };
}

function app(id: string) {
  return {
    id,
    name: id,
    description: `${id} App`,
    lifecycle: {
      version: null,
      hasUnrecordedChanges: false,
      manifestHealth: "valid",
      versionHealth: "unversioned",
    },
    runtime: { running: false },
    path: `/apps/${id}`,
  };
}


describe("Host App runtime CLI", () => {
  const context = { environment: "host", principal: { kind: "system" } } as const;
  function setup(overrides: Partial<ConstructorParameters<typeof CliOperationDispatcher>[0]> = {}) {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const { request } = JSON.parse(String(init?.body));
      return Response.json({ requestId: request.requestId, ok: true, result: {
        ...app("notes"), workloads: { services: { sync: { command: ["node", "sync.mjs"] } } }, runtime: { running: false, enabled: false },
      } });
    });
    const setAppEnabled = vi.fn(async () => {});
    const setServiceEnabled = vi.fn(async () => {});
    const workloadDiagnostics = vi.fn(() => []);
    return { fetchImpl, setAppEnabled, setServiceEnabled, workloadDiagnostics, dispatcher: new CliOperationDispatcher({
      coreBaseUrl: "http://core.test", coreToken: "secret", fetch: fetchImpl, runtimeStates: () => [],
      setAppEnabled, setServiceEnabled, workloadDiagnostics, ...overrides,
    }) };
  }

  test.each(["app.enable", "app.disable", "app.service.enable", "app.service.disable"] as const)("%s joins the existing management callback", async operation => {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const setting = vi.fn(() => done);
    const { dispatcher, fetchImpl } = setup({ setAppEnabled: setting, setServiceEnabled: setting });
    const service = operation.startsWith("app.service.");
    const enabled = operation.endsWith(".enable");
    const input = { appId: "notes", ...(service ? { serviceId: "sync" } : {}) };
    let completed = false;
    const result = dispatcher.dispatch({ requestId: "change", operation, input }, context).then(value => { completed = true; return value; });
    await vi.waitFor(() => expect(setting).toHaveBeenCalled());
    expect(setting.mock.calls[0]).toEqual(service ? ["notes", "sync", enabled] : ["notes", enabled]);
    expect(completed).toBe(false);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).request.operation).toBe("app.inspect");
    finish();
    expect((await result).response).toEqual({ requestId: "change", ok: true, result: { ...input, enabled } });
  });

  test("does not claim success when cleanup or persistence fails", async () => {
    const { dispatcher } = setup({ setAppEnabled: async () => { throw new AggregateError([], "cleanup failed"); } });
    expect((await dispatcher.dispatch({ requestId: "failed", operation: "app.disable", input: { appId: "notes" } }, context)).response)
      .toMatchObject({ ok: false, error: { code: "APP_RUNTIME_FAILED" } });
  });

  test("managed requests cannot reach Host management or diagnostic callbacks", async () => {
    const { dispatcher, fetchImpl, setAppEnabled, setServiceEnabled, workloadDiagnostics } = setup();
    for (const operation of ["app.enable", "app.disable", "app.service.enable", "app.service.disable", "app.activity"]) {
      const input = { appId: "notes", ...(operation.startsWith("app.service.") ? { serviceId: "sync" } : {}) };
      expect((await dispatcher.dispatch({ requestId: "denied", operation, input }, { environment: "managed", principal: identity() })).response)
        .toMatchObject({ ok: false, error: { code: "CLI_UNSUPPORTED_COMMAND" } });
    }
    for (const callback of [fetchImpl, setAppEnabled, setServiceEnabled, workloadDiagnostics]) expect(callback).not.toHaveBeenCalled();
  });

  test("reports missing Apps and undeclared Services without mutating runtime", async () => {
    const { dispatcher, setServiceEnabled } = setup();
    expect((await dispatcher.dispatch({ requestId: "missing", operation: "app.service.disable", input: { appId: "notes", serviceId: "missing" } }, context)).response)
      .toMatchObject({ ok: false, error: { code: "APP_SERVICE_NOT_FOUND" } });
    expect(setServiceEnabled).not.toHaveBeenCalled();
    const diagnostics = vi.fn(() => []);
    const missing = setup({ workloadDiagnostics: diagnostics, fetch: async () => Response.json({ requestId: "missing", ok: false, error: { code: "APP_NOT_FOUND", message: "App missing" } }) });
    expect((await missing.dispatcher.dispatch({ requestId: "missing", operation: "app.activity", input: { appId: "missing" } }, context)).response)
      .toMatchObject({ ok: false, error: { code: "APP_NOT_FOUND" } });
    expect(diagnostics).not.toHaveBeenCalled();
  });

  test("inspection includes real jobs, cleanup failures and service policies; missing policy stays unknown", async () => {
    const state: AppRuntimeState = {
      appId: "notes", enabled: true, runningWorkloads: 1, ui: "closed", stopping: true, latestFailure: "cleanup failed",
      jobs: [{ runId: "run-1", jobId: "daily", triggerId: "trigger-1", state: "cleanup-failed", cleanupError: "still owned" }],
      services: [{ serviceId: "sync", enabled: true, state: "stopped", executionId: null, restartAt: null, failure: null }],
    };
    const { dispatcher } = setup({ runtimeStates: () => [state] });
    const request = { requestId: "inspect", operation: "app.inspect", input: { appId: "notes" } };
    expect((await dispatcher.dispatch(request, context)).response).toMatchObject({ ok: true, result: { runtime: {
      running: true, enabled: false, ui: "closed", stopping: true, jobs: state.jobs, services: state.services, latestFailure: "cleanup failed",
    } } });
    expect((await setup().dispatcher.dispatch(request, context)).response).toMatchObject({ ok: true, result: { runtime: {
      running: false, enabled: false, jobs: [], services: [{ serviceId: "sync", enabled: null, state: "unconfigured" }],
    } } });
    const managed = (await dispatcher.dispatch(request, { environment: "managed", principal: identity() })).response;
    expect(managed).toMatchObject({ ok: true, result: { runtime: { running: true } } });
    if (managed.ok) expect((managed.result as { runtime: unknown }).runtime).toEqual({ running: true });
  });

  test("activity uses App-scoped sanitized diagnostics and stays within the V1 frame", async () => {
    const evidence = new CapsuleDiagnostics(["host-secret"]);
    evidence.begin("other", "job", "private", "other-run");
    evidence.append("other-run", Buffer.from("other App output"));
    for (let i = 0; i < 8; i++) {
      evidence.begin("notes", "job", "daily", `run-${i}`);
      evidence.append(`run-${i}`, Buffer.from('"\\\t'.repeat(64 * 1024) + "host-secret最後"));
      evidence.finish(`run-${i}`);
    }
    const { dispatcher } = setup({ workloadDiagnostics: appId => evidence.read(appId) });
    const response = (await dispatcher.dispatch({ requestId: "activity", operation: "app.activity", input: { appId: "notes" } }, context)).response;
    const wire = encodeCliHttpResponse("app.activity", response);
    expect(await decodeCliHttpResponse(wire, "app.activity", "activity")).toEqual(response);
    expect(JSON.stringify(response)).not.toContain("host-secret");
    expect(JSON.stringify(response)).not.toContain("other App output");
    expect(response).toMatchObject({ ok: true, result: expect.arrayContaining([expect.objectContaining({ droppedBytes: expect.any(Number), output: expect.stringContaining("[redacted]最後") })]) });
  });
});
