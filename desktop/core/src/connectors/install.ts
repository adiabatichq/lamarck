import { randomUUID } from "crypto";
import { cp, mkdir, readdir, rename, rm, stat } from "fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "path";
import {
  loadConnectorEventCatalog,
  loadConnectorManifest,
  validateConnectorId,
} from "./manifest";
import { hashConnectorPackage } from "./registry";
import type { ConnectorManifest } from "./types";
import type { ConnectorSupervisor } from "./supervisor";
import type { ConnectorHostGuard } from "./guard";

export interface InstalledConnector {
  manifest: ConnectorManifest;
  dir: string;
}

export interface InstallConnectorOptions {
  sourceDir: string;
  workspacePath: string;
  connectorId?: string;
}

export interface RegisterWorkspaceConnectorsOptions {
  skipInvalid?: boolean;
  onError?: (connectorDir: string, error: unknown) => void;
}

export function workspaceConnectorsDir(workspacePath: string): string {
  return resolve(workspacePath, "connectors");
}

export function resolveWorkspaceConnectorDir(
  workspacePath: string,
  connectorId: string,
): string {
  validateConnectorId(connectorId);
  const root = workspaceConnectorsDir(workspacePath);
  const target = resolve(root, connectorId);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Connector directory must stay inside workspace connectors/: ${connectorId}`);
  }
  return target;
}

export async function installConnector(
  opts: InstallConnectorOptions,
): Promise<InstalledConnector> {
  const { sourceDir, manifest, connectorsDir, targetDir } = await prepareConnectorMaterialization(opts);
  await mkdir(connectorsDir, { recursive: true });

  // Install never replaces an existing Connector. Package replacement belongs
  // to the separate transactional Update lifecycle so Sources are preserved.
  if (await pathExists(targetDir)) {
    throw new Error(`Connector already installed: ${manifest.id}`);
  }

  // Stage then rename so a crash mid-copy never leaves a half-written
  // package squatting on the connector's directory.
  const stagingDir = await stageConnectorPackage(sourceDir, connectorsDir, "install");
  try {
    await rename(stagingDir, targetDir);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }

  return {
    manifest,
    dir: targetDir,
  };
}

export async function materializeBuiltInConnector(
  opts: InstallConnectorOptions,
): Promise<InstalledConnector> {
  return installConnector(opts);
}

export async function removeInstalledConnector(
  workspacePath: string,
  connectorId: string,
): Promise<boolean> {
  const targetDir = resolveWorkspaceConnectorDir(workspacePath, connectorId);
  if (!(await pathExists(targetDir))) return false;
  await rm(targetDir, { recursive: true, force: true });
  return true;
}

export async function removeConnectorFromWorkspace(opts: {
  workspacePath: string;
  connectorId: string;
  supervisor: ConnectorSupervisor;
}): Promise<boolean> {
  // This is the user-facing removal coordinator. Source cleanup happens while
  // the package is still registered; the low-level folder helper remains only
  // for filesystem recovery/tests.
  return opts.supervisor.removeConnector(
    opts.connectorId,
    () => removeInstalledConnector(opts.workspacePath, opts.connectorId),
  );
}

export async function listInstalledConnectorDirs(workspacePath: string): Promise<string[]> {
  const connectorsDir = workspaceConnectorsDir(workspacePath);
  let entries;
  try {
    entries = await readdir(connectorsDir, { withFileTypes: true });
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(connectorsDir, entry.name))
    .sort();
}

// Built-ins are bundled catalog entries: packages shipped with the app that
// can be installed without a download. Listing them never copies anything —
// installation is always an explicit user action through the same install
// flow as any other connector package.
// A bundled package without a valid manifest is not a catalog entry. That is
// already how any invalid package is treated here, so packages parked without
// an approved Source identity need no list of their own: the manifest gate
// rejects them and onError reports which ones, by name, on every listing.
export async function listAvailableBuiltIns(
  builtinsDir: string,
  onError?: (connectorDir: string, error: unknown) => void,
): Promise<InstalledConnector[]> {
  let entries;
  try {
    entries = await readdir(builtinsDir, { withFileTypes: true });
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }

  const available: InstalledConnector[] = [];
  for (const entry of entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(builtinsDir, entry.name);
    try {
      const manifest = await loadConnectorManifest(dir);
      if (manifest.id !== entry.name) {
        throw new Error(`Connector manifest id "${manifest.id}" must match folder "${entry.name}"`);
      }
      await loadConnectorEventCatalog(dir, manifest);
      available.push({ manifest, dir });
    } catch (err) {
      if (!onError) throw err;
      onError(dir, err);
    }
  }
  return available;
}

export interface InstallConnectorFromSourceOptions extends InstallConnectorOptions {
  guard: ConnectorHostGuard;
}

export interface UpdateConnectorFromSourceOptions extends InstallConnectorFromSourceOptions {
  supervisor: ConnectorSupervisor;
}

export interface UpdatedConnector extends InstalledConnector {
  updated: boolean;
  fromHash: string;
  toHash: string;
}

// The one install path: copies the package into the workspace and records the
// action in D0 as connector.installed. Reinstalling after a removal emits a
// fresh event — D0 keeps the full install/remove history.
export async function installConnectorFromSource(
  opts: InstallConnectorFromSourceOptions,
): Promise<InstalledConnector> {
  const installed = await installConnector(opts);
  await opts.guard.writeEvent({
    type: "connector.installed",
    startedAt: Date.now(),
    payload: {
      connector_id: installed.manifest.id,
      package_hash: await hashConnectorPackage(installed.dir),
    },
  });
  return installed;
}

// Update is Install's same package-materialization flow with a different
// precondition: the globally unique connector id must already exist and the
// candidate hash must differ. Source rows remain untouched.
export async function updateConnectorFromSource(
  opts: UpdateConnectorFromSourceOptions,
): Promise<UpdatedConnector> {
  const {
    sourceDir,
    manifest: sourceManifest,
    connectorsDir,
    targetDir,
  } = await prepareConnectorMaterialization(opts);
  const connectorId = sourceManifest.id;
  if (!opts.supervisor.isRegistered(connectorId)) {
    throw new Error(`Connector is not installed: ${connectorId}`);
  }

  if (!(await pathExists(targetDir))) {
    throw new Error(`Connector package is missing: ${connectorId}`);
  }
  await mkdir(connectorsDir, { recursive: true });

  const currentHash = await hashConnectorPackage(targetDir);
  const stagingDir = await stageConnectorPackage(sourceDir, connectorsDir, "update");
  const backupDir = join(connectorsDir, `.update-backup-${randomUUID()}`);

  try {
    const stagedManifest = await loadConnectorManifest(stagingDir);
    if (stagedManifest.id !== connectorId) {
      throw new Error(
        `Connector manifest id "${stagedManifest.id}" does not match installed id "${connectorId}"`,
      );
    }
    const candidateHash = await hashConnectorPackage(stagingDir);
    if (candidateHash === currentHash) {
      return {
        manifest: stagedManifest,
        dir: targetDir,
        updated: false,
        fromHash: currentHash,
        toHash: candidateHash,
      };
    }

    return await opts.supervisor.withConnectorUpdate(
      connectorId,
      stagedManifest,
      async () => {
        let oldPackageMoved = false;
        let candidateInstalled = false;
        let committed = false;
        try {
          await rename(targetDir, backupDir);
          oldPackageMoved = true;
          await rename(stagingDir, targetDir);
          candidateInstalled = true;

          const manifest = await opts.supervisor.registerDirectory(targetDir);
          await opts.guard.writeEvent({
            type: "connector.updated",
            startedAt: Date.now(),
            payload: {
              connector_id: connectorId,
              from_hash: currentHash,
              to_hash: candidateHash,
            },
          });
          committed = true;
          return {
            manifest,
            dir: targetDir,
            updated: true,
            fromHash: currentHash,
            toHash: candidateHash,
          };
        } catch (updateError) {
          try {
            if (candidateInstalled && await pathExists(targetDir)) {
              await rm(targetDir, { recursive: true, force: true });
            }
            if (oldPackageMoved && await pathExists(backupDir)) {
              await rename(backupDir, targetDir);
            }
            if (await pathExists(targetDir)) {
              await opts.supervisor.registerDirectory(targetDir);
            }
          } catch (rollbackError) {
            throw new AggregateError(
              [updateError, rollbackError],
              `Connector ${connectorId} update and rollback both failed`,
            );
          }
          throw updateError;
        } finally {
          if (committed) {
            await rm(backupDir, { recursive: true, force: true }).catch(() => {});
          }
        }
      },
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function prepareConnectorMaterialization(
  opts: InstallConnectorOptions,
): Promise<{
  sourceDir: string;
  manifest: ConnectorManifest;
  connectorsDir: string;
  targetDir: string;
}> {
  const sourceDir = resolve(opts.sourceDir);
  const manifest = await loadConnectorManifest(sourceDir);
  await loadConnectorEventCatalog(sourceDir, manifest);
  if (opts.connectorId && opts.connectorId !== manifest.id) {
    throw new Error(
      `Connector manifest id "${manifest.id}" does not match requested id "${opts.connectorId}"`,
    );
  }
  return {
    sourceDir,
    manifest,
    connectorsDir: workspaceConnectorsDir(opts.workspacePath),
    targetDir: resolveWorkspaceConnectorDir(opts.workspacePath, manifest.id),
  };
}

async function stageConnectorPackage(
  sourceDir: string,
  connectorsDir: string,
  action: "install" | "update",
): Promise<string> {
  const stagingDir = join(connectorsDir, `.${action}-staging-${randomUUID()}`);
  try {
    await cp(sourceDir, stagingDir, { recursive: true });
    const manifest = await loadConnectorManifest(stagingDir);
    await loadConnectorEventCatalog(stagingDir, manifest);
    await hashConnectorPackage(stagingDir);
    return stagingDir;
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

export async function registerWorkspaceConnectors(
  supervisor: ConnectorSupervisor,
  workspacePath: string,
  opts: RegisterWorkspaceConnectorsOptions = {},
): Promise<ConnectorManifest[]> {
  const manifests: ConnectorManifest[] = [];
  const connectorDirs = await listInstalledConnectorDirs(workspacePath);
  for (const connectorDir of connectorDirs) {
    try {
      const manifest = await supervisor.registerDirectory(connectorDir);
      manifests.push(manifest);
    } catch (err) {
      if (!opts.skipInvalid) throw err;
      opts.onError?.(connectorDir, err);
    }
  }
  // Folder absence is authoritative at boot. Invalid-but-present folders are
  // reported above and retained for repair; only truly absent packages cause
  // the Source ownership cascade.
  await supervisor.reconcileInstalledConnectorIds(connectorDirs.map((dir) => basename(dir)));
  return manifests;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

function isNotFoundError(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as { code?: string }).code === "ENOENT";
}
