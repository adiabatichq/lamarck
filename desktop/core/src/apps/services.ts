import type { DatabaseSync } from "node:sqlite";
import type { AppRegistry } from "../app-loader";

export const APP_SERVICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_runtime_settings (
  app_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal', 'exp'))
);
CREATE TABLE IF NOT EXISTS app_services (
  app_id TEXT NOT NULL REFERENCES app_runtime_settings(app_id) ON DELETE CASCADE,
  service_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  restart_base_ms INTEGER NOT NULL CHECK (restart_base_ms >= 1000),
  restart_max_ms INTEGER NOT NULL CHECK (restart_max_ms >= restart_base_ms),
  crash_count INTEGER NOT NULL CHECK (crash_count >= 0),
  restart_at INTEGER,
  last_error TEXT,
  cleanup_failed INTEGER NOT NULL CHECK (cleanup_failed IN (0, 1)),
  PRIMARY KEY (app_id, service_id)
);
`;

export interface AppServicePolicy {
  appId: string;
  serviceId: string;
  enabled: boolean;
  revision: number;
  restartBaseMs: number;
  restartMaxMs: number;
  crashCount: number;
  restartAt: number | null;
  lastError: string | null;
  cleanupFailed: boolean;
}

/** Host control plane only; policy never enters a package or SDK channel. */
export class AppServiceStore {
  constructor(private readonly db: DatabaseSync) {}
  admitInstalled(registry: AppRegistry): void {
    this.db.exec("SAVEPOINT app_service_admission");
    try {
      for (const [appId, app] of registry.apps) {
        // A package in a download/staging directory is never in this registry.
        // Admission chooses the approved enabled default once for each setting.
        // Rescans and new activations never overwrite an explicit user choice.
        this.db.prepare("INSERT OR IGNORE INTO app_runtime_settings (app_id, enabled, revision) VALUES (?, 1, 1)").run(appId);
        for (const serviceId of Object.keys(app.manifest.runtime.services ?? {})) {
          if (!this.get(appId, serviceId)) this.setEnabled(appId, serviceId, true);
        }
      }
      this.db.exec("RELEASE app_service_admission");
    } catch (error) {
      this.db.exec("ROLLBACK TO app_service_admission; RELEASE app_service_admission");
      throw error;
    }
  }

  appSetting(appId: string): { enabled: boolean; revision: number; mode: "normal" | "exp" } | null {
    const row = this.db.prepare("SELECT enabled, revision, mode FROM app_runtime_settings WHERE app_id = ?").get(appId);
    if (row && row.mode !== "normal" && row.mode !== "exp") throw new Error("App execution policy is unavailable");
    return row ? { enabled: row.enabled === 1, revision: Number(row.revision), mode: row.mode as "normal" | "exp" } : null;
  }
  mode(appId: string): "normal" | "exp" {
    const setting = this.appSetting(appId);
    if (!setting) throw new Error("App execution policy is unavailable");
    return setting.mode;
  }
  setMode(appId: string, mode: "normal" | "exp"): void {
    if (mode !== "normal" && mode !== "exp") throw new Error("Invalid App execution mode");
    if (this.db.prepare("SELECT 1 FROM app_services WHERE app_id = ? AND cleanup_failed = 1").get(appId)) throw new Error("Stop the App and resolve workload cleanup before changing Experiment mode.");
    if (this.db.prepare("UPDATE app_runtime_settings SET mode = ?, revision = revision + 1 WHERE app_id = ?").run(mode, appId).changes !== 1) throw new Error("App execution policy is unavailable");
  }
  appEnabled(appId: string): boolean { return this.appSetting(appId)?.enabled === true; }
  setAppEnabled(appId: string, enabled: boolean): void {
    if (this.db.prepare("UPDATE app_runtime_settings SET enabled = ?, revision = revision + 1 WHERE app_id = ?").run(enabled ? 1 : 0, appId).changes !== 1) throw new Error("Installed App not found");
  }
  requireAdmission(appId: string, revision?: number): number {
    const setting = this.appSetting(appId);
    if (!setting?.enabled || (revision !== undefined && setting.revision !== revision)) throw new Error("App execution is disabled or its enablement changed");
    return setting.revision;
  }
  get(appId: string, serviceId: string): AppServicePolicy | null {
    const row = this.db.prepare("SELECT * FROM app_services WHERE app_id = ? AND service_id = ?").get(appId, serviceId);
    return row ? {
      appId: String(row.app_id), serviceId: String(row.service_id), enabled: row.enabled === 1,
      revision: Number(row.revision), restartBaseMs: Number(row.restart_base_ms), restartMaxMs: Number(row.restart_max_ms),
      crashCount: Number(row.crash_count), restartAt: row.restart_at === null ? null : Number(row.restart_at),
      lastError: row.last_error === null ? null : String(row.last_error), cleanupFailed: row.cleanup_failed === 1,
    } : null;
  }
  setEnabled(appId: string, serviceId: string, enabled: boolean): AppServicePolicy {
    if (!this.appSetting(appId)) throw new Error("Installed App not found");
    this.db.prepare(`INSERT INTO app_services VALUES (?, ?, ?, 1, 1000, 60000, 0, NULL, NULL, 0)
      ON CONFLICT(app_id, service_id) DO UPDATE SET enabled = excluded.enabled, revision = revision + 1,
        restart_at = CASE WHEN excluded.enabled = 1 THEN NULL ELSE restart_at END`)
      .run(appId, serviceId, enabled ? 1 : 0);
    return this.get(appId, serviceId)!;
  }
  observe(appId: string, serviceId: string, revision: number, observation: Pick<AppServicePolicy, "crashCount" | "restartAt" | "lastError" | "cleanupFailed">): boolean {
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(observation.crashCount) || observation.crashCount < 0
      || (observation.restartAt !== null && (!Number.isSafeInteger(observation.restartAt) || observation.restartAt < 0))
      || (observation.lastError !== null && (typeof observation.lastError !== "string" || observation.lastError.length > 4000))
      || typeof observation.cleanupFailed !== "boolean") throw new Error("Invalid Service observation");
    return this.db.prepare(`UPDATE app_services SET crash_count = ?, restart_at = ?, last_error = ?, cleanup_failed = ?
      WHERE app_id = ? AND service_id = ? AND revision = ?`).run(observation.crashCount, observation.restartAt,
      observation.lastError, observation.cleanupFailed ? 1 : 0, appId, serviceId, revision).changes === 1;
  }
  retire(appId: string): void {
    // Retiring an identity also fences a concurrently scheduled restart.
    this.db.prepare("DELETE FROM app_services WHERE app_id = ?").run(appId);
    this.db.prepare("DELETE FROM app_runtime_settings WHERE app_id = ?").run(appId);
  }
}
