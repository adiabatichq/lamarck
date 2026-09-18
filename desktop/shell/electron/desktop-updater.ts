import type { AutoUpdater } from "electron";

export const DESKTOP_UPDATE_FEED = "https://releases.lamarck.ai/desktop/macos/arm64/stable/latest.json";

export interface DesktopUpdateState {
  phase: "unavailable" | "idle" | "checking" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string;
  nextVersion: string | null;
  error: string | null;
}

export function supportsDesktopUpdates(platform: string, architecture: string, packaged: boolean, channel: unknown) {
  return platform === "darwin" && architecture === "arm64" && packaged && channel === "stable";
}

// Squirrel verifies the downloaded application's signature against this app's
// signing identity. Only the production packager enables this fixed feed.
export class DesktopUpdater {
  private state: DesktopUpdateState;
  private timer: ReturnType<typeof setInterval> | undefined;
  private installation: Promise<void> | undefined;

  constructor(private readonly options: {
    updater: Pick<AutoUpdater, "on" | "setFeedURL" | "checkForUpdates" | "quitAndInstall">;
    enabled: boolean;
    version: string;
    publish: (state: DesktopUpdateState) => void;
    prepareToQuit: () => Promise<void>;
  }) {
    this.state = { phase: options.enabled ? "idle" : "unavailable", currentVersion: options.version, nextVersion: null, error: null };
    if (!options.enabled) return;
    options.updater.on("error", (error: Error) => this.set({ phase: "error", error: error.message }));
    options.updater.on("update-available", () => this.set({ phase: "downloading" }));
    options.updater.on("update-not-available", () => this.set({ phase: "idle" }));
    options.updater.on("update-downloaded", (_event, _notes, name: string) => this.set({ phase: "ready", nextVersion: name || null }));
  }

  getState(): DesktopUpdateState { return { ...this.state }; }

  start() {
    if (this.state.phase === "unavailable" || this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), 6 * 60 * 60 * 1000);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = undefined; }

  check(): DesktopUpdateState {
    if (!["idle", "error"].includes(this.state.phase)) return this.getState();
    this.set({ phase: "checking", error: null, nextVersion: null });
    try {
      this.options.updater.setFeedURL({ url: DESKTOP_UPDATE_FEED, serverType: "json" });
      this.options.updater.checkForUpdates();
    } catch (error) {
      this.set({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
    return this.getState();
  }

  install(): Promise<void> {
    if (this.installation) return this.installation;
    if (this.state.phase !== "ready") return Promise.reject(new Error("No downloaded desktop update is ready"));
    this.set({ phase: "installing", error: null });
    this.stop();
    this.installation = this.options.prepareToQuit().then(() => {
      this.options.updater.quitAndInstall();
    }).catch((error) => {
      this.installation = undefined;
      this.set({ phase: "ready", error: error instanceof Error ? error.message : String(error) });
      throw error;
    });
    return this.installation;
  }

  private set(next: Partial<DesktopUpdateState>) {
    this.state = { ...this.state, ...next };
    this.options.publish(this.getState());
  }
}
