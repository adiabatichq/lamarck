import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearCoreBaseUrlCache,
  createConnectorIntegration,
  getCoreBaseUrl,
  retryConnectorSourceIdentity,
  updateConnectorIntegration,
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
      text: async () => JSON.stringify({ integration: {} }),
    });
    vi.stubGlobal("window", {
      lamarckHost: {
        getCoreBaseUrl: vi.fn().mockResolvedValue("http://localhost:32100"),
        getCoreToken: vi.fn().mockResolvedValue("test-token"),
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await createConnectorIntegration("github/work", "Personal");
    await createConnectorIntegration("github/work");
    await updateConnectorIntegration("source/1", { displayName: "Work" });
    await retryConnectorSourceIdentity("source/1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:32100/api/connectors/github%2Fwork/integrations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ displayName: "Personal" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:32100/api/connectors/github%2Fwork/integrations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://localhost:32100/api/connectors/integrations/source%2F1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ displayName: "Work" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://localhost:32100/api/connectors/integrations/source%2F1/identity/retry",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  });
});
