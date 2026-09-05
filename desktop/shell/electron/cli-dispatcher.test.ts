import { describe, expect, test, vi } from "vitest";
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
    runtimeStates: () => states,
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
