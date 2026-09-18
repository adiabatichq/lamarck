import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppWorkload } from "../auth";
import { loadApps, type AppManifest, type AppRegistry } from "../app-loader";
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
import type { AppVersionEventAuthority, AppVersionEventWriter } from "./version-transaction";

export interface AppVersionOperationContext {
  readonly message?: string;
  readonly author?: string;
  readonly eventWriter?: AppVersionEventWriter;
  readonly eventAuthority?: AppVersionEventAuthority;
}

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

interface AppReadResult {
  registry: AppRegistry;
  inventory?: readonly AppInventoryItemV1[];
}

interface AppReadWaiter {
  inventory: boolean;
  complete(result: AppReadResult): void;
  fail(error: unknown): void;
}

export class AppLifecycleService {
  private currentRegistry: AppRegistry | undefined;
  private readonly waitingReads = new Set<AppReadWaiter>();
  private readonly activeReads = new Set<AppReadWaiter>();
  private readTask: Promise<void> | null = null;
  private readController: AbortController | null = null;
  private closed = false;

  constructor(
    private readonly appsDir: string,
    private readonly archiveRoot: string,
    readonly repository: AppRepositoryService,
    readonly activations: AppActivationCoordinator,
    readonly editMaterializations: AppEditMaterializationCoordinator,
  ) {}

  get registry(): AppRegistry {
    if (!this.currentRegistry) throw new Error("App registry has not been loaded");
    return this.currentRegistry;
  }

  async refreshRegistry(signal?: AbortSignal): Promise<AppRegistry> {
    return (await this.read(false, signal)).registry;
  }

  async inventory(signal?: AbortSignal): Promise<readonly AppInventoryItemV1[]> {
    return (await this.read(true, signal)).inventory!;
  }

  close(): Promise<void> {
    this.closed = true;
    const reason = new Error("App inventory is shutting down");
    for (const waiter of [...this.waitingReads, ...this.activeReads]) waiter.fail(reason);
    this.readController?.abort(reason);
    return this.readTask ?? Promise.resolve();
  }

  private read(inventory: boolean, signal?: AbortSignal): Promise<AppReadResult> {
    if (this.closed) return Promise.reject(new Error("App inventory is shutting down"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.waitingReads.delete(waiter);
        this.activeReads.delete(waiter);
        signal?.removeEventListener("abort", abort);
      };
      const waiter: AppReadWaiter = {
        inventory,
        complete: (result) => { cleanup(); resolve(result); },
        fail: (error) => { cleanup(); reject(error); },
      };
      const abort = () => {
        waiter.fail(signal!.reason);
        if (this.activeReads.size === 0) this.readController?.abort(signal!.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waitingReads.add(waiter);
      this.startRead();
    });
  }

  private startRead(): void {
    if (this.readTask || this.closed || this.waitingReads.size === 0) return;
    // Readers arriving after a scan starts wait for one fresh follow-up pass.
    // Do not attach each reader to the underlying Promise: cancelled readers
    // must be removable even when an OS read never settles.
    this.readTask = Promise.resolve().then(async () => {
      for (const waiter of this.waitingReads) this.activeReads.add(waiter);
      this.waitingReads.clear();
      if (this.closed || this.activeReads.size === 0) return;
      const controller = new AbortController();
      this.readController = controller;
      try {
        const registry = await loadApps(this.appsDir, controller.signal);
        controller.signal.throwIfAborted();
        this.currentRegistry = registry;
        for (const waiter of this.activeReads) {
          if (!waiter.inventory) waiter.complete({ registry });
        }
        if (this.activeReads.size === 0) return;
        const inventory = await this.scanInventory(controller.signal);
        controller.signal.throwIfAborted();
        for (const waiter of this.activeReads) waiter.complete({ registry, inventory });
      } catch (error) {
        for (const waiter of this.activeReads) waiter.fail(error);
      } finally {
        this.readController = null;
      }
    }).finally(() => {
      // Keep the slot occupied until the real operation settles, even after
      // every caller has disconnected. A timeout is not I/O completion.
      this.readTask = null;
      this.startRead();
    });
  }

  async save(appId: string, metadata: AppVersionOperationContext = {}) {
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
    metadata: AppVersionOperationContext = {},
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

  async prepareEditBases() {
    const apps = await this.currentAppDirectories();
    const bases = await Promise.all(
      apps.map((app) => this.editMaterializations.prepare(app.id, app.path)),
    );
    await this.editMaterializations.retainApps(apps.map((app) => app.id));
    return Object.freeze(bases);
  }

  async savePackage(
    appId: string,
    entries: readonly AppPackageEntry[],
    base: {
      baseVersion: string | null;
      basePackageDigest: `sha256:${string}`;
      message?: string;
      author?: string;
      eventWriter?: AppVersionEventWriter;
      eventAuthority?: AppVersionEventAuthority;
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

  private async scanInventory(signal: AbortSignal): Promise<readonly AppInventoryItemV1[]> {
    const apps: AppInventoryItemV1[] = [];
    for (const { id, path } of await this.currentAppDirectories(signal)) {
      signal.throwIfAborted();
      let draft: ReturnType<typeof validateAppPackageTree> | undefined;
      let draftError: string | undefined;
      try {
        draft = validateAppPackageTree(await collectAppPackageTree(path, signal), id);
      } catch (error) {
        signal.throwIfAborted();
        draftError = errorMessage(error);
      }

      let version: string | null = null;
      let recorded: Awaited<ReturnType<AppRepositoryService["readVersionPackage"]>> | undefined;
      let versionError: string | undefined;
      try {
        version = await this.repository.currentVersion(id, path);
        signal.throwIfAborted();
        if (version) recorded = await this.repository.readVersionPackage(id, path, version);
      } catch (error) {
        signal.throwIfAborted();
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
        name: details?.name ?? "Unavailable",
        description: details?.description ?? "N/A",
        ...(details?.runtime === undefined ? {} : { runtime: details.runtime }),
        ...(details?.permissions === undefined ? {} : { permissions: details.permissions }),
        ...(details?.createdFrom === undefined ? {} : { createdFrom: details.createdFrom }),
      }));
    }
    signal.throwIfAborted();
    return Object.freeze(apps);
  }

  private async currentAppDirectories(signal?: AbortSignal): Promise<readonly { id: string; path: string }[]> {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(this.appsDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    const apps: Array<{ id: string; path: string }> = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      signal?.throwIfAborted();
      if (!entry.isDirectory() || !PACKAGE_ID_PATTERN.test(entry.name)) continue;
      const path = join(this.appsDir, entry.name);
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) apps.push({ id: entry.name, path });
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
