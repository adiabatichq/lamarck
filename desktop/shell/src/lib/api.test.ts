import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearCoreBaseUrlCache, getCoreBaseUrl } from "./api";

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
});
