import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppWorkload } from "../auth";
import type { AppManifest } from "../app-loader";
import { PACKAGE_ID_PATTERN } from "../package-id";
import { AppLifecycleError } from "./errors";
import { AppActivationCoordinator } from "./activation";
import { AppEditMaterializationCoordinator } from "./edit-materialization";
import {
  collectAppPackageTree,
  validateAppPackageTree,
  type AppPackageEntry,
} from "./package-tree";
import { AppRepositoryService } from "./repository";

export interface AppInventoryItemV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly path: string;
  readonly version: string | null;
  readonly packageDirty: boolean;
  readonly manifestHealth:
    | { readonly status: "valid" }
    | { readonly status: "invalid"; readonly message: string };
  readonly versionHealth:
    | { readonly status: "healthy" }
    | { readonly status: "unversioned" }
    | { readonly status: "unavailable"; readonly message: string };
  readonly name: string;
  readonly description: string;
  readonly runtime?: AppManifest["runtime"];
  readonly permissions?: AppManifest["permissions"];
  readonly createdFrom?: AppManifest["createdFrom"];
}

export class AppLifecycleService {
  constructor(
    private readonly appsDir: string,
    private readonly archiveRoot: string,
    readonly repository: AppRepositoryService,
    readonly activations: AppActivationCoordinator,
    readonly editMaterializations: AppEditMaterializationCoordinator,
  ) {}

  async save(appId: string, metadata: { message?: string; author?: string } = {}) {
    return this.repository.save({
      appId,
      appDir: await this.resolveAppDir(appId),
      ...metadata,
    });
  }

  async versions(appId: string, page: { cursor?: string; limit?: number } = {}) {
    return this.repository.listVersions({
      appId,
      appDir: await this.resolveAppDir(appId),
      ...page,
    });
  }

  async restore(
    appId: string,
    version: string,
    metadata: { message?: string; author?: string } = {},
  ) {
    return this.repository.restore({
      appId,
      appDir: await this.resolveAppDir(appId),
      version,
      ...metadata,
    });
  }

  async prepareActivation(appId: string, workload: AppWorkload) {
    return this.activations.prepare({
      appId,
      appDir: await this.resolveAppDir(appId),
      workload,
    });
  }

  async prepareEditBase(appId: string) {
    return this.editMaterializations.prepare(appId, await this.resolveAppDir(appId));
  }

  async savePackage(
    appId: string,
    entries: readonly AppPackageEntry[],
    base: {
      baseVersion: string | null;
      basePackageDigest: `sha256:${string}`;
      message?: string;
      author?: string;
    },
  ) {
    return this.repository.savePackage({
      appId,
      appDir: await this.resolveAppDir(appId),
      entries,
      ...base,
    });
  }

  async rebuildVersionHistory(appId: string) {
    return this.repository.rebuildVersionHistory({
      appId,
      appDir: await this.resolveAppDir(appId),
      archiveRoot: this.archiveRoot,
    });
  }

  async inventory(): Promise<readonly AppInventoryItemV1[]> {
    let entries;
    try {
      entries = await readdir(this.appsDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    const apps: AppInventoryItemV1[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !PACKAGE_ID_PATTERN.test(entry.name)) continue;
      const id = entry.name;
      const path = join(this.appsDir, id);
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;

      let draft: ReturnType<typeof validateAppPackageTree> | undefined;
      let draftError: string | undefined;
      try {
        draft = validateAppPackageTree(await collectAppPackageTree(path), id);
      } catch (error) {
        draftError = errorMessage(error);
      }

      let version: string | null = null;
      let recorded: Awaited<ReturnType<AppRepositoryService["readVersionPackage"]>> | undefined;
      let versionError: string | undefined;
      try {
        version = await this.repository.currentVersion(id, path);
        if (version) recorded = await this.repository.readVersionPackage(id, path, version);
      } catch (error) {
        versionError = errorMessage(error);
        version = null;
      }
      const details = draft?.manifest ?? recorded?.manifest;
      apps.push(Object.freeze({
        schemaVersion: 1,
        id,
        path,
        version,
        packageDirty: draft === undefined || recorded === undefined || draft.digest !== recorded.digest,
        manifestHealth: draft === undefined
          ? Object.freeze({ status: "invalid" as const, message: draftError ?? "App package is invalid" })
          : Object.freeze({ status: "valid" as const }),
        versionHealth: versionError !== undefined
          ? Object.freeze({
              status: "unavailable" as const,
              message: "App version history is unavailable",
            })
          : version === null
            ? Object.freeze({ status: "unversioned" as const })
            : Object.freeze({ status: "healthy" as const }),
        name: details?.name ?? id,
        description: details?.description ?? (draftError ?? "App manifest is unavailable"),
        ...(details?.runtime === undefined ? {} : { runtime: details.runtime }),
        ...(details?.permissions === undefined ? {} : { permissions: details.permissions }),
        ...(details?.createdFrom === undefined ? {} : { createdFrom: details.createdFrom }),
      }));
    }
    return Object.freeze(apps);
  }

  private async resolveAppDir(appId: string): Promise<string> {
    if (!PACKAGE_ID_PATTERN.test(appId)) {
      throw new AppLifecycleError("APP_NOT_FOUND", `App not found: ${appId}`);
    }
    const path = join(this.appsDir, appId);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a physical directory");
    } catch (error) {
      throw new AppLifecycleError("APP_NOT_FOUND", `App not found: ${appId}`, { cause: error });
    }
    return path;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
