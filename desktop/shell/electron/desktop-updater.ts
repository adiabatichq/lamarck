import type { MacUpdater } from "electron-updater";

export interface DesktopUpdateState {
  phase: "unavailable" | "idle" | "checking" | "downloading" | "verifying" | "ready" | "installing" | "error";
  currentVersion: string;
  nextVersion: string | null;
  error: string | null;
  downloadPercent: number | null;
}

export function supportsDesktopUpdates(platform: string, architecture: string, packaged: boolean, channel: unknown) {
  return platform === "darwin" && architecture === "arm64" && packaged && channel === "alpha";
}

// electron-updater downloads to disk; Squirrel verifies and stages the local
// archive. Only Squirrel's completion makes Update & Restart available.
export class DesktopUpdater {
  private state: DesktopUpdateState;
  private timer: ReturnType<typeof setInterval> | undefined;
  private installation: Promise<void> | undefined;

  constructor(private readonly options: {
    updater?: Pick<MacUpdater, "checkForUpdates" | "quitAndInstall" | "autoInstallOnAppQuit" | "disableDifferentialDownload"> & {
      on: (...args: Parameters<MacUpdater["on"]>) => unknown;
    };
    nativeUpdater: { on(event: "update-downloaded", listener: () => void): unknown };
    enabled: boolean;
    version: string;
    publish: (state: DesktopUpdateState) => void;
    prepareToQuit: () => Promise<void>;
  }) {
    this.state = { phase: options.enabled ? "idle" : "unavailable", currentVersion: options.version, nextVersion: null, error: null, downloadPercent: null };
    if (!options.enabled) return;
    const updater = options.updater;
    if (!updater) throw new Error("Desktop updater is missing");
    updater.autoInstallOnAppQuit = true;
    // Releases currently publish full ZIPs, without blockmaps.
    updater.disableDifferentialDownload = true;
    updater.on("error", (error: Error) => this.failed(error));
    updater.on("update-available", (info: { version: string }) => this.set({ phase: "downloading", nextVersion: info.version }));
    updater.on("download-progress", (progress: { percent: number }) => this.set({ downloadPercent: progress.percent }));
    updater.on("update-not-available", () => this.set({ phase: "idle" }));
    updater.on("update-downloaded", () => this.set({ phase: "verifying", downloadPercent: 100 }));
    options.nativeUpdater.on("update-downloaded", () => {
      if (this.state.phase === "verifying") this.set({ phase: "ready" });
    });
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
    this.set({ phase: "checking", error: null, nextVersion: null, downloadPercent: null });
    try {
      void this.options.updater!.checkForUpdates()
        .then((result) => result?.downloadPromise)
        .catch((error) => this.failed(error));
    } catch (error) {
      this.failed(error);
    }
    return this.getState();
  }

  install(): Promise<void> {
    if (this.installation) return this.installation;
    if (this.state.phase !== "ready") return Promise.reject(new Error("No downloaded desktop update is ready"));
    this.set({ phase: "installing", error: null });
    this.stop();
    this.installation = this.options.prepareToQuit().then(() => {
      this.options.updater!.quitAndInstall();
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

  private failed(error: unknown) {
    this.set({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
}
