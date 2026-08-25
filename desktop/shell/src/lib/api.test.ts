import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  approveSchemaRequest,
  cancelConnectorAuthAttempt,
  clearCoreBaseUrlCache,
  createConnectorSource,
  getCoreBaseUrl,
  inspectDataSchema,
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
});
