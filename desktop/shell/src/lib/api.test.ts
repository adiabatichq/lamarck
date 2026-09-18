import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  approveSchemaRequest,
  cancelConnectorAuthAttempt,
  clearCoreBaseUrlCache,
  CORE_READ_TIMEOUT_MS,
  createConnectorSource,
  getCoreBaseUrl,
  inspectDataSchema,
  listAppVersions,
  listApps,
  readAppInventory,
  subscribeCoreRuntime,
  query,
  rebuildAppVersionHistory,
  restoreAppVersion,
  retryConnectorSourceIdentity,
  startConnectorAuth,
  updateConnectorSource,
} from "./api";

describe("Core endpoint resolution", () => {
  test("resolves token once and retains one authoritative Host check per subsequent inventory read", async () => {
    const host = inventoryHost();
    vi.stubGlobal("window", { lamarckHost: host });
    // Each response body is consumed exactly once.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ apps: [] }))));
    await expect(readAppInventory(new AbortController().signal)).resolves.toMatchObject({ status: "connected" });
    expect(host.getCoreRuntimeState).toHaveBeenCalledTimes(2);
    await readAppInventory(new AbortController().signal);
    expect(host.getCoreRuntimeState).toHaveBeenCalledTimes(3);
    expect(host.getCoreToken).toHaveBeenCalledTimes(1);
    expect(host.getCoreBaseUrl).toHaveBeenCalledTimes(1);
  });

  test("discards old inventory even when the generation notification has not arrived", async () => {
    const host = inventoryHost();
    host.getCoreRuntimeState.mockResolvedValueOnce({ generation: 1, phase: "ready", error: null });
    host.getCoreRuntimeState.mockResolvedValue({ generation: 2, phase: "ready", error: null });
    vi.stubGlobal("window", { lamarckHost: host });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ apps: [{ id: "old" }] }))));
    await expect(readAppInventory(new AbortController().signal)).resolves.toEqual({ apps: [], status: "checking", error: null });
  });

  test("does not overwrite a newer notification with an in-flight Host reply", async () => {
    const host = inventoryHost();
    let notify!: (state: { generation: number; phase: "failed"; error: string }) => void;
    host.onCoreRuntimeState.mockImplementation(callback => { notify = callback; return vi.fn(); });
    let reply!: (state: { generation: number; phase: "ready"; error: null }) => void;
    host.getCoreRuntimeState.mockResolvedValueOnce({ generation: 1, phase: "ready", error: null });
    host.getCoreRuntimeState.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    vi.stubGlobal("window", { lamarckHost: host });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ apps: [{ id: "old" }] }))));
    const unsubscribe = subscribeCoreRuntime(vi.fn());
    try {
      const read = readAppInventory(new AbortController().signal);
      await vi.waitFor(() => expect(reply).toBeTypeOf("function"));
      notify({ generation: 1, phase: "failed", error: "Guard lost" });
      reply({ generation: 1, phase: "ready", error: null });
      await expect(read).resolves.toEqual({ apps: [], status: "offline", error: "Guard lost" });
    } finally { unsubscribe(); }
  });

  test("shares one removable Host subscription among all mounted pollers", () => {
    const host = inventoryHost();
    const remove = vi.fn();
    host.onCoreRuntimeState.mockReturnValue(remove);
    vi.stubGlobal("window", { lamarckHost: host });
    const subscriptions = Array.from({ length: 100 }, () => subscribeCoreRuntime(vi.fn()));
    expect(host.onCoreRuntimeState).toHaveBeenCalledTimes(1);
    for (const unsubscribe of subscriptions.slice(0, -1)) unsubscribe();
    expect(remove).not.toHaveBeenCalled();
    subscriptions.at(-1)!();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("does not accumulate Host state calls when inventory polling repeatedly times out", async () => {
    vi.useFakeTimers();
    const host = inventoryHost();
    host.getCoreRuntimeState.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("window", { lamarckHost: host });
    const first = readAppInventory(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(CORE_READ_TIMEOUT_MS);
    await expect(first).resolves.toMatchObject({ status: "offline" });
    for (let attempt = 0; attempt < 100; attempt++) {
      await expect(readAppInventory(new AbortController().signal)).resolves.toMatchObject({ status: "offline" });
    }
    expect(host.getCoreRuntimeState).toHaveBeenCalledTimes(1);
    expect(host.getCoreToken).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  beforeEach(() => {
    clearCoreBaseUrlCache();
  });

  afterEach(() => {
    clearCoreBaseUrlCache();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("retries the Electron host after Core is unavailable during shell startup", async () => {
    const hostBaseUrl = vi.fn()
      .mockRejectedValueOnce(new Error("Node Core is not running"))
      .mockResolvedValueOnce("http://localhost:32100");
    vi.stubGlobal("window", {
      lamarckHost: { getCoreBaseUrl: hostBaseUrl },
    });

    await expect(getCoreBaseUrl()).rejects.toThrow("Node Core is not running");
    await expect(getCoreBaseUrl()).resolves.toBe("http://localhost:32100");
    expect(hostBaseUrl).toHaveBeenCalledTimes(2);
  });

  test("caches a successfully resolved Electron Core endpoint", async () => {
    const hostBaseUrl = vi.fn().mockResolvedValue("http://localhost:32100");
    vi.stubGlobal("window", {
      lamarckHost: { getCoreBaseUrl: hostBaseUrl },
    });

    await expect(getCoreBaseUrl()).resolves.toBe("http://localhost:32100");
    await expect(getCoreBaseUrl()).resolves.toBe("http://localhost:32100");
    expect(hostBaseUrl).toHaveBeenCalledTimes(1);
  });

  test("uses the development fallback only when there is no Electron host", async () => {
    vi.stubGlobal("window", {});

    await expect(getCoreBaseUrl()).resolves.toBe(
      import.meta.env.VITE_LAMARCK_CORE_URL ?? "http://localhost:3000",
    );
  });

  test.each(["url", "token", "fetch", "body"])("bounds stalled %s reads and permits a fresh read", async (stage) => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const never = new Promise<string>((resolve) => { finish = resolve; });
    const host = {
      getCoreBaseUrl: vi.fn().mockResolvedValue("http://localhost:32100"),
      getCoreToken: vi.fn().mockResolvedValue("test-token"),
    };
    const body = vi.fn().mockResolvedValue('{"apps":[]}');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: body });
    if (stage === "url") host.getCoreBaseUrl.mockReturnValueOnce(never);
    if (stage === "token") host.getCoreToken.mockReturnValueOnce(never);
    if (stage === "fetch") fetchMock.mockReturnValueOnce(never);
    if (stage === "body") body.mockReturnValueOnce(never);
    vi.stubGlobal("window", { lamarckHost: host });
    vi.stubGlobal("fetch", fetchMock);

    const failed = expect(listApps()).rejects.toThrow("Core did not respond within 15 seconds");
    await vi.advanceTimersByTimeAsync(CORE_READ_TIMEOUT_MS);
    await failed;
    if (stage === "fetch" || stage === "body") {
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    }
    if (stage === "url" || stage === "token") {
      for (let attempt = 0; attempt < 100; attempt++) {
        await expect(listApps()).rejects.toThrow("Core did not respond within 15 seconds");
      }
      expect(stage === "url" ? host.getCoreBaseUrl : host.getCoreToken).toHaveBeenCalledTimes(1);
      finish(stage === "url" ? "http://localhost:32100" : "test-token");
      await vi.advanceTimersByTimeAsync(0);
    }
    await expect(listApps()).resolves.toEqual({ apps: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("cancels read-only POST requests without replaying them", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal("window", { lamarckHost: {
      getCoreBaseUrl: async () => "http://localhost:32100",
      getCoreToken: async () => "test-token",
    } });
    vi.stubGlobal("fetch", fetchMock);
    const pending = expect(query("SELECT 1", undefined, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not apply read deadlines or automatic retries to mutations", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("window", { lamarckHost: {
      getCoreBaseUrl: async () => "http://localhost:32100",
      getCoreToken: async () => "test-token",
    } });
    vi.stubGlobal("fetch", fetchMock);
    const pending = createConnectorSource("github/work", "Personal");
    await vi.advanceTimersByTimeAsync(CORE_READ_TIMEOUT_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    finish({ ok: true, text: async () => '{"sourceRecord":{}}' });
    await expect(pending).resolves.toEqual({ sourceRecord: {} });
  });

  test("does not repopulate the cache with a URL resolved before runtime invalidation", async () => {
    let finish!: (value: string) => void;
    const hostBaseUrl = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }))
      .mockResolvedValue("http://localhost:32101");
    vi.stubGlobal("window", { lamarckHost: { getCoreBaseUrl: hostBaseUrl } });
    const stale = getCoreBaseUrl();
    clearCoreBaseUrlCache();
    // A caller joining the same physical IPC after invalidation must not
    // attribute its old result to the new generation and cache the old port.
    const joinedAfterInvalidation = getCoreBaseUrl();
    await Promise.resolve();
    finish("http://localhost:32100");
    await Promise.all([stale, joinedAfterInvalidation]);
    await expect(getCoreBaseUrl()).resolves.toBe("http://localhost:32101");
  });

  test("does not start an obsolete HTTP request when Host IPC resolves after cancellation", async () => {
    let finish!: (value: string) => void;
    const hostBaseUrl = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const fetchMock = vi.fn();
    vi.stubGlobal("window", { lamarckHost: {
      getCoreBaseUrl: hostBaseUrl,
      getCoreToken: async () => "test-token",
    } });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const rejected = expect(listApps(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    finish("http://localhost:32100");
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses display names for Source mutations and has an explicit identity retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ sourceRecord: {} }),
    });
    vi.stubGlobal("window", {
      lamarckHost: {
        getCoreBaseUrl: vi.fn().mockResolvedValue("http://localhost:32100"),
        getCoreToken: vi.fn().mockResolvedValue("test-token"),
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await createConnectorSource("github/work", "Personal");
    await createConnectorSource("github/work");
    await updateConnectorSource("source/1", { displayName: "Work" });
    await retryConnectorSourceIdentity("source/1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:32100/api/connectors/github%2Fwork/sources",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ displayName: "Personal" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:32100/api/connectors/github%2Fwork/sources",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://localhost:32100/api/connectors/sources/source%2F1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ displayName: "Work" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://localhost:32100/api/connectors/sources/source%2F1/identity/retry",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  });

  test("replaces and explicitly cancels pending browser auth attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({}),
    });
    vi.stubGlobal("window", {
      lamarckHost: {
        getCoreBaseUrl: vi.fn().mockResolvedValue("http://localhost:32100"),
        getCoreToken: vi.fn().mockResolvedValue("test-token"),
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await startConnectorAuth("source/1", { replacePending: true });
    await cancelConnectorAuthAttempt("source/1", "attempt/1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:32100/api/connectors/sources/source%2F1/auth/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ replacePending: true }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:32100/api/connectors/sources/source%2F1/auth/attempts/attempt%2F1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  test("uses Host-only schema inspection and sends approve-once", async () => {
    const schema = {
      tables: [{
        name: "focus",
        sql: "CREATE TABLE focus (id TEXT PRIMARY KEY NOT NULL)",
        columns: [{ name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 }],
      }],
      indexes: [{ name: "focus_by_id", table: "focus", sql: "CREATE INDEX focus_by_id ON focus(id)" }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(schema) })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ request: { status: "applied" } }),
      });
    vi.stubGlobal("window", {
      lamarckHost: {
        getCoreBaseUrl: vi.fn().mockResolvedValue("http://localhost:32100"),
        getCoreToken: vi.fn().mockResolvedValue("test-token"),
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(inspectDataSchema()).resolves.toEqual(schema);
    await approveSchemaRequest("request/1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:32100/api/schema/inspect");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:32100/api/schema/requests/request%2F1/approve",
      expect.objectContaining({ method: "POST", body: JSON.stringify({}) }),
    );
  });

  test("uses paginated App history and explicit restore/rebuild mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ versions: [], nextCursor: null }),
    });
    vi.stubGlobal("window", {
      lamarckHost: {
        getCoreBaseUrl: vi.fn().mockResolvedValue("http://localhost:32100"),
        getCoreToken: vi.fn().mockResolvedValue("test-token"),
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await listAppVersions("notes/work", { cursor: "page/token", limit: 30 });
    await restoreAppVersion("notes/work", "aaaaaaaa");
    await rebuildAppVersionHistory("notes/work");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:32100/api/apps/notes%2Fwork/versions?cursor=page%2Ftoken&limit=30",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:32100/api/apps/notes%2Fwork/restore",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ version: "aaaaaaaa" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://localhost:32100/api/apps/notes%2Fwork/version-history/rebuild",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmed: true }) }),
    );
  });

  test("preserves structured lifecycle error messages and codes", async () => {
    vi.stubGlobal("window", {
      lamarckHost: {
        getCoreBaseUrl: vi.fn().mockResolvedValue("http://localhost:32100"),
        getCoreToken: vi.fn().mockResolvedValue("test-token"),
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({
        error: { code: "APP_VERSION_CONFLICT", message: "App changed" },
      }),
    }));

    await expect(restoreAppVersion("notes", "aaaaaaaa")).rejects.toMatchObject({
      message: "App changed",
      code: "APP_VERSION_CONFLICT",
      status: 409,
    });
  });
});

function inventoryHost() {
  return {
    getCoreBaseUrl: vi.fn().mockResolvedValue("http://localhost:32100"),
    getCoreToken: vi.fn().mockResolvedValue("test-token"),
    getCoreRuntimeState: vi.fn().mockResolvedValue({ generation: 1, phase: "ready", error: null }),
    onCoreRuntimeState: vi.fn<(callback: (state: { generation: number; phase: "ready" | "failed"; error: string | null }) => void) => () => void>()
      .mockReturnValue(() => {}),
  };
}
