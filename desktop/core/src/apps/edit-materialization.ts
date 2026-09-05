import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  collectAppPackageTree,
  hashAppPackageTree,
  materializeAppPackageTree,
} from "./package-tree";
import { AppRepositoryService } from "./repository";

export interface AppEditBaseV1 {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly version: string | null;
  readonly packageDigest: `sha256:${string}`;
  /** Relative to the Host's read-only app-edit-bases share; never a Host path. */
  readonly lowerPath: string;
}

/** Creates immutable, reconstructable lowers for private Capsule editing. */
export class AppEditMaterializationCoordinator {
  private readonly preparations = new Map<string, Promise<AppEditBaseV1>>();

  constructor(
    private readonly repository: AppRepositoryService,
    private readonly cacheRoot: string,
  ) {}

  prepare(appId: string, appDir: string): Promise<AppEditBaseV1> {
    const previous = this.preparations.get(appId);
    const operation = (previous?.catch(() => undefined) ?? Promise.resolve())
      .then(() => this.prepareExclusive(appId, appDir));
    this.preparations.set(appId, operation);
    void operation.finally(() => {
      if (this.preparations.get(appId) === operation) this.preparations.delete(appId);
    }).catch(() => {});
    return operation;
  }

  async retainApps(appIds: Iterable<string>): Promise<void> {
    const retained = new Set(appIds);
    let entries;
    try {
      entries = await readdir(this.cacheRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (retained.has(entry.name)) continue;
      await removeOwnedPath(join(this.cacheRoot, entry.name), entry.isDirectory());
    }
  }

  private async prepareExclusive(appId: string, appDir: string): Promise<AppEditBaseV1> {
    const canonicalEntries = await collectAppPackageTree(appDir);
    const canonicalDigest = hashAppPackageTree(canonicalEntries);
    const version = await this.repository.currentVersion(appId, appDir);
    let key = `draft-${canonicalDigest.slice("sha256:".length)}`;
    let entries = canonicalEntries;
    if (version) {
      const recorded = await this.repository.readVersionPackage(appId, appDir, version);
      if (recorded.digest === canonicalDigest) {
        key = version;
        entries = recorded.entries;
      }
    }
    const appRoot = resolve(this.cacheRoot, appId);
    const destination = resolve(appRoot, key);
    await mkdir(appRoot, { recursive: true, mode: 0o700 });
    if (!await isDirectory(destination)) {
      const stage = await mkdtemp(join(appRoot, ".edit-base-"));
      try {
        await materializeAppPackageTree(entries, stage);
        const stagedDigest = hashAppPackageTree(await collectAppPackageTree(stage));
        if (stagedDigest !== canonicalDigest) {
          throw new Error("Staged App editing base digest mismatch");
        }
        let published = false;
        try {
          await rename(stage, destination);
          published = true;
        } catch (error) {
          if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOTEMPTY")) throw error;
        }
        if (published) {
          try {
            await makeTreeReadonly(destination);
          } catch (error) {
            await makeTreeWritable(destination).catch(() => undefined);
            await rm(destination, { recursive: true, force: true }).catch(() => undefined);
            throw error;
          }
        }
      } finally {
        await makeTreeWritable(stage).catch(() => undefined);
        await rm(stage, { recursive: true, force: true });
      }
    }
    const reread = hashAppPackageTree(await collectAppPackageTree(destination));
    if (reread !== canonicalDigest) {
      throw new Error("Immutable App editing base digest mismatch");
    }
    await retainOnlyCurrentLower(appRoot, key);
    return Object.freeze({
      schemaVersion: 1,
      appId,
      version,
      packageDigest: canonicalDigest,
      lowerPath: `${appId}/${key}`,
    });
  }
}

async function retainOnlyCurrentLower(appRoot: string, currentKey: string): Promise<void> {
  for (const entry of await readdir(appRoot, { withFileTypes: true })) {
    if (entry.name === currentKey) continue;
    await removeOwnedPath(join(appRoot, entry.name), entry.isDirectory());
  }
}

async function removeOwnedPath(path: string, directory: boolean): Promise<void> {
  if (directory) await makeTreeWritable(path).catch((error) => {
    if (!isNodeError(error, "ENOENT")) throw error;
  });
  await rm(path, { recursive: directory, force: true });
}

async function makeTreeReadonly(directory: string): Promise<void> {
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, child.name);
    if (child.isDirectory()) {
      await makeTreeReadonly(path);
      await chmod(path, 0o555);
    } else if (child.isFile()) await chmod(path, 0o444);
    else throw new Error(`Editing base contains unsupported entry: ${basename(path)}`);
  }
  await chmod(directory, 0o555);
}

async function makeTreeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, child.name);
    if (child.isDirectory()) await makeTreeWritable(path);
    else if (child.isFile()) await chmod(path, 0o600);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Editing base path is invalid");
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
