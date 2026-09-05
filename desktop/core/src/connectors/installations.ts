import type { DatabaseSync } from "node:sqlite";
import { validateConnectorId } from "./manifest";

export interface ConnectorInstallationRecord {
  readonly connectorId: string;
  readonly packageHash: string;
  readonly releaseId: string;
  readonly installedAt: number;
  readonly updatedAt: number;
}

interface InstallationRow {
  connector_id: string;
  package_hash: string;
  marketplace_release_id: string;
  installed_at: number;
  updated_at: number;
}

/** Durable display/control-plane metadata; package hashes remain artifact identity. */
export class ConnectorInstallationStore {
  constructor(private readonly systemDb: DatabaseSync) {}

  get(connectorId: string): ConnectorInstallationRecord | undefined {
    validateConnectorId(connectorId);
    const row = this.systemDb.prepare(
      "SELECT * FROM connector_installations WHERE connector_id = ?",
    ).get(connectorId) as unknown as InstallationRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  record(
    connectorId: string,
    packageHash: string,
    releaseId: string,
    now = Date.now(),
  ): ConnectorInstallationRecord {
    validateConnectorId(connectorId);
    if (!/^sha256:[0-9a-f]{64}$/.test(packageHash)) {
      throw new Error("Connector installation package hash is invalid");
    }
    if (!releaseId || releaseId.trim() !== releaseId) {
      throw new Error("Connector installation release id is invalid");
    }
    this.systemDb.prepare(
      `INSERT INTO connector_installations
         (connector_id, package_hash, marketplace_release_id, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(connector_id) DO UPDATE SET
         package_hash = excluded.package_hash,
         marketplace_release_id = excluded.marketplace_release_id,
         updated_at = excluded.updated_at`,
    ).run(connectorId, packageHash, releaseId, now, now);
    return this.get(connectorId)!;
  }

  remove(connectorId: string): boolean {
    validateConnectorId(connectorId);
    return Number(this.systemDb.prepare(
      "DELETE FROM connector_installations WHERE connector_id = ?",
    ).run(connectorId).changes) > 0;
  }
}

function toRecord(row: InstallationRow): ConnectorInstallationRecord {
  return Object.freeze({
    connectorId: row.connector_id,
    packageHash: row.package_hash,
    releaseId: row.marketplace_release_id,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  });
}
