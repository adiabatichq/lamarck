import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { DesktopUpdater, DESKTOP_UPDATE_FEED, supportsDesktopUpdates } from "./desktop-updater";

function fixture(enabled = true, prepareToQuit = vi.fn(async () => {})) {
  const native = Object.assign(new EventEmitter(), {
    getFeedURL: vi.fn(() => DESKTOP_UPDATE_FEED), setFeedURL: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn(),
  });
  const update = new DesktopUpdater({ updater: native, enabled, version: "0.1.0", publish: vi.fn(), prepareToQuit });
  return { update, native, prepareToQuit };
}

describe("desktop updates", () => {
  test("only the production macOS arm64 package enables updates", () => {
    expect(supportsDesktopUpdates("darwin", "arm64", true, "alpha")).toBe(true);
    for (const args of [["darwin", "arm64", false, "alpha"], ["darwin", "arm64", true, undefined], ["darwin", "x64", true, "alpha"], ["linux", "arm64", true, "alpha"]] as const) {
      expect(supportsDesktopUpdates(args[0], args[1], args[2], args[3])).toBe(false);
    }
    const { update, native } = fixture(false);
    update.start(); update.check();
    expect(native.checkForUpdates).not.toHaveBeenCalled();
  });
  test("checks and downloads are single-flight, including repeated timer checks", () => {
    const { update, native } = fixture();
    update.check(); update.check();
    expect(native.setFeedURL).toHaveBeenCalledWith({ url: DESKTOP_UPDATE_FEED, serverType: "json" });
    expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
    native.emit("update-available"); update.check();
    expect(update.getState().phase).toBe("downloading");
    expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
    native.emit("update-downloaded", {}, "", "0.2.0"); update.check();
    expect(update.getState()).toMatchObject({ phase: "ready", nextVersion: "0.2.0" });
    expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
  });
  test("network/signature errors are retryable without quitting", () => {
    const { update, native } = fixture();
    update.check(); native.emit("error", new Error("Signature mismatch"));
    expect(update.getState().error).toBe("Signature mismatch");
    update.check(); native.emit("update-not-available");
    expect(update.getState().phase).toBe("idle");
    expect(native.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(native.quitAndInstall).not.toHaveBeenCalled();
  });
  test("installation waits for runtime shutdown and repeated clicks install once", async () => {
    let finish!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { update, native } = fixture(true, shutdown);
    await expect(update.install()).rejects.toThrow("No downloaded");
    native.emit("update-downloaded", {}, "", "0.2.0");
    const first = update.install(); const second = update.install();
    expect(native.quitAndInstall).not.toHaveBeenCalled();
    expect(update.getState().phase).toBe("installing");
    finish(); await Promise.all([first, second]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(native.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  test("a shutdown failure preserves the downloaded update for retry", async () => {
    const { update, native } = fixture(true, vi.fn(async () => { throw new Error("Still stopping"); }));
    native.emit("update-downloaded", {}, "", "0.2.0");
    await expect(update.install()).rejects.toThrow("Still stopping");
    expect(update.getState().phase).toBe("ready");
    expect(native.quitAndInstall).not.toHaveBeenCalled();
  });
});
