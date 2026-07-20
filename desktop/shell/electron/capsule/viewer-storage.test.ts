import { describe, expect, test, vi } from "vitest";
import {
  clearDisposableAppViewerStorage,
  DISPOSABLE_APP_VIEWER_STORAGE_TYPES,
} from "./viewer-storage";

describe("disposable App viewer storage", () => {
  test("clears origin storage and the HTTP cache together", async () => {
    const clearStorageData = vi.fn(async () => {});
    const clearCache = vi.fn(async () => {});

    await clearDisposableAppViewerStorage({ clearStorageData, clearCache });

    expect(clearStorageData).toHaveBeenCalledOnce();
    expect(clearStorageData).toHaveBeenCalledWith({
      storages: [...DISPOSABLE_APP_VIEWER_STORAGE_TYPES],
    });
    expect(clearCache).toHaveBeenCalledOnce();
  });

  test("does not report cleanup success when either storage surface fails", async () => {
    const clearStorageData = vi.fn(async () => {
      throw new Error("storage cleanup failed");
    });
    const clearCache = vi.fn(async () => {});

    await expect(clearDisposableAppViewerStorage({ clearStorageData, clearCache }))
      .rejects.toThrow("storage cleanup failed");
    expect(clearCache).toHaveBeenCalledOnce();
  });
});
