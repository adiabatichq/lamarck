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
  query,
  rebuildAppVersionHistory,
  restoreAppVersion,
  retryConnectorSourceIdentity,
  startConnectorAuth,
  updateConnectorSource,
} from "./api";

describe("Core endpoint resolution", () => {
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
    const never = new Promise<never>(() => {});
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
    finish("http://localhost:32100");
    await stale;
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
