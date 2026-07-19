import type { DatabaseSync } from "node:sqlite";
import { createHash } from "crypto";
import { readFile, readdir } from "fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { loadConnectorManifest, validateConnectorId } from "./manifest";
import type {
  ConnectorOfficialCatalogEntry,
  ConnectorPackageRecord,
  ConnectorPackageTrust,
  ConnectorTrustStatus,
} from "./types";

export interface WorkspaceConnectorRegistryOptions {
  systemDb: DatabaseSync;
  officialCatalog?: ConnectorOfficialCatalogEntry[];
}

export class ConnectorApprovalStore {
  constructor(private systemDb: DatabaseSync) {}

  approveCustom(connectorId: string, hash: string, approvedAt = Date.now()): void {
    validateConnectorId(connectorId);
    this.systemDb.prepare(
      `INSERT OR REPLACE INTO connector_custom_approvals (connector_id, approved_hash, approved_at)
       VALUES (?, ?, ?)`
    ).run(connectorId, hash, approvedAt);
  }

  isApproved(connectorId: string, hash: string): boolean {
    validateConnectorId(connectorId);
    const row = this.systemDb.prepare(
      `SELECT 1 FROM connector_custom_approvals
       WHERE connector_id = ? AND approved_hash = ?
       LIMIT 1`
    ).get(connectorId, hash);
    return Boolean(row);
  }

  hasApprovalForConnector(connectorId: string): boolean {
    validateConnectorId(connectorId);
    const row = this.systemDb.prepare(
      `SELECT 1 FROM connector_custom_approvals
       WHERE connector_id = ?
       LIMIT 1`
    ).get(connectorId);
    return Boolean(row);
  }

  removeForConnector(connectorId: string): void {
    validateConnectorId(connectorId);
    this.systemDb.prepare(
      "DELETE FROM connector_custom_approvals WHERE connector_id = ?",
    ).run(connectorId);
  }
}

export class WorkspaceConnectorRegistry {
  private approvals: ConnectorApprovalStore;
  private officialHashes = new Map<string, Set<string>>();

  constructor(opts: WorkspaceConnectorRegistryOptions) {
    this.approvals = new ConnectorApprovalStore(opts.systemDb);
    for (const entry of opts.officialCatalog ?? []) {
      validateConnectorId(entry.id);
      const hashes = this.officialHashes.get(entry.id) ?? new Set<string>();
      hashes.add(entry.hash);
      this.officialHashes.set(entry.id, hashes);
    }
  }

  getApprovalStore(): ConnectorApprovalStore {
    return this.approvals;
  }

  removeApprovals(connectorId: string): void {
    this.approvals.removeForConnector(connectorId);
  }

  async loadPackage(connectorDir: string): Promise<ConnectorPackageRecord> {
    const dir = resolve(connectorDir);
    const manifest = await loadConnectorManifest(dir);
    const folderId = basename(dir);
    if (manifest.id !== folderId) {
      throw new Error(`Connector manifest id "${manifest.id}" must match folder "${folderId}"`);
    }

    const entryPath = resolveConnectorEntry(dir, manifest.entry);
    const contentHash = await hashConnectorPackage(dir);
    const trust = this.classify(manifest.id, contentHash);
    return {
      connectorId: manifest.id,
      dir,
      manifest,
      entryPath,
      contentHash,
      trust,
    };
  }

  async scan(connectorDirs: string[]): Promise<ConnectorPackageRecord[]> {
    const packages: ConnectorPackageRecord[] = [];
    for (const connectorDir of connectorDirs) {
      packages.push(await this.loadPackage(connectorDir));
    }
    return packages;
  }

  approveCustomPackage(pkg: ConnectorPackageRecord, approvedAt = Date.now()): ConnectorPackageRecord {
    this.approvals.approveCustom(pkg.connectorId, pkg.contentHash, approvedAt);
    return {
      ...pkg,
      trust: this.classify(pkg.connectorId, pkg.contentHash),
    };
  }

  classify(connectorId: string, contentHash: string): ConnectorPackageTrust {
    validateConnectorId(connectorId);
    const officialHashes = this.officialHashes.get(connectorId);
    if (officialHashes?.has(contentHash)) {
      return {
        status: "official",
        badge: "Official",
        runnable: true,
      };
    }
    if (this.approvals.isApproved(connectorId, contentHash)) {
      return {
        status: "custom",
        badge: "Custom",
        runnable: true,
      };
    }
    if (officialHashes?.size || this.approvals.hasApprovalForConnector(connectorId)) {
      return {
        status: "modified",
        badge: "Modified",
        runnable: false,
        reason: "Connector package content changed and needs approval",
      };
    }
    return {
      status: "untrusted",
      badge: "Untrusted",
      runnable: false,
      reason: "Connector package hash is not official or human-approved",
    };
  }
}

export function trustStatusForIntegration(trust: ConnectorPackageTrust): ConnectorTrustStatus {
  if (trust.status === "invalid") return "missing";
  return trust.status;
}

export function resolveConnectorEntry(connectorDir: string, entry: string): string {
  const root = resolve(connectorDir);
  const target = resolve(root, entry);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Connector entry must stay inside connector directory: ${entry}`);
  }
  return target;
}

export async function hashConnectorPackage(connectorDir: string): Promise<string> {
  const root = resolve(connectorDir);
  const hash = createHash("sha256");
  const files = await listPackageFiles(root);
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, "/");
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function listPackageFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await walk(root);
  return files.sort();
}
