import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import type { UpdateCheckResult } from "electron-updater";
import { DesktopUpdater, supportsDesktopUpdates } from "./desktop-updater";

function fixture(enabled = true, prepareToQuit = vi.fn(async () => {})) {
  const native = new EventEmitter();
  const client = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async (): Promise<UpdateCheckResult | null> => null), quitAndInstall: vi.fn(),
    autoInstallOnAppQuit: false, disableDifferentialDownload: false,
  });
  const update = new DesktopUpdater({ updater: client, nativeUpdater: native, enabled, version: "0.1.0", publish: vi.fn(), prepareToQuit });
  const ready = () => {
    client.emit("update-available", { version: "0.2.0" });
    client.emit("update-downloaded");
    native.emit("update-downloaded");
  };
  return { update, client, native, prepareToQuit, ready };
}

describe("desktop updates", () => {
  test("only the production macOS arm64 package enables updates", () => {
    expect(supportsDesktopUpdates("darwin", "arm64", true, "alpha")).toBe(true);
    for (const args of [["darwin", "arm64", false, "alpha"], ["darwin", "arm64", true, undefined], ["darwin", "x64", true, "alpha"], ["linux", "arm64", true, "alpha"]] as const) {
      expect(supportsDesktopUpdates(args[0], args[1], args[2], args[3])).toBe(false);
    }
    const { update, client } = fixture(false);
    update.start(); update.check();
    expect(client.checkForUpdates).not.toHaveBeenCalled();
  });
  test("checks and downloads are single-flight, including repeated timer checks", () => {
    const { update, client, native } = fixture();
    update.check(); update.check();
    expect(client.autoInstallOnAppQuit).toBe(true);
    expect(client.disableDifferentialDownload).toBe(true);
    expect(client.checkForUpdates).toHaveBeenCalledTimes(1);
    client.emit("update-available", { version: "0.2.0" }); update.check();
    expect(update.getState().phase).toBe("downloading");
    client.emit("download-progress", { percent: 42.5 });
    expect(update.getState().downloadPercent).toBe(42.5);
    client.emit("update-downloaded"); update.check();
    expect(update.getState().phase).toBe("verifying");
    native.emit("update-downloaded"); update.check();
    expect(update.getState()).toMatchObject({ phase: "ready", nextVersion: "0.2.0" });
    expect(client.checkForUpdates).toHaveBeenCalledTimes(1);
  });
  test("a downloaded ZIP cannot be installed before native signature verification", async () => {
    const { update, client } = fixture();
    client.emit("update-available", { version: "0.2.0" });
    client.emit("update-downloaded");
    await expect(update.install()).rejects.toThrow("No downloaded");
    client.emit("error", new Error("Signature mismatch"));
    expect(update.getState()).toMatchObject({ phase: "error", error: "Signature mismatch" });
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });
  test("network/signature errors are retryable without quitting", () => {
    const { update, client } = fixture();
    update.check(); client.emit("error", new Error("Signature mismatch"));
    expect(update.getState().error).toBe("Signature mismatch");
    update.check(); client.emit("update-not-available");
    expect(update.getState().phase).toBe("idle");
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });
  test("async check and download failures are consumed and permit retry", async () => {
    const { update, client } = fixture();
    client.checkForUpdates.mockRejectedValueOnce(new Error("Network unavailable"));
    update.check();
    await vi.waitFor(() => expect(update.getState().error).toBe("Network unavailable"));
    const info = { version: "0.2.0", files: [], path: "update.zip", sha512: "unused", releaseDate: "2026-09-22T00:00:00Z" };
    client.checkForUpdates.mockImplementationOnce(async () => ({
      isUpdateAvailable: true, updateInfo: info, versionInfo: info,
      downloadPromise: Promise.reject(new Error("Download disconnected")),
    }));
    update.check();
    await vi.waitFor(() => expect(update.getState().error).toBe("Download disconnected"));
    update.check();
    expect(update.getState()).toMatchObject({ phase: "checking", error: null, downloadPercent: null });
  });
  test("installation waits for runtime shutdown and repeated clicks install once", async () => {
    let finish!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { update, client, ready } = fixture(true, shutdown);
    await expect(update.install()).rejects.toThrow("No downloaded");
    ready();
    const first = update.install(); const second = update.install();
    expect(client.quitAndInstall).not.toHaveBeenCalled();
    expect(update.getState().phase).toBe("installing");
    finish(); await Promise.all([first, second]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(client.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  test("a shutdown failure preserves the downloaded update for retry", async () => {
    const { update, client, ready } = fixture(true, vi.fn(async () => { throw new Error("Still stopping"); }));
    ready();
    await expect(update.install()).rejects.toThrow("Still stopping");
    expect(update.getState().phase).toBe("ready");
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });
});
