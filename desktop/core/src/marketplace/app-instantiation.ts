import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { loadApps, type AppManifest } from "../app-loader";
import { PACKAGE_ID_PATTERN, SCOPED_PACKAGE_ID_PATTERN } from "../package-id";

export interface InstantiateMarketplaceAppOptions {
  readonly verifiedSourceDir: string;
  readonly appsDir: string;
  readonly packageId: string;
  readonly releaseId: string;
  readonly localId?: string;
  readonly initializeRepository: (appDir: string) => Promise<void>;
}

export interface InstantiatedMarketplaceApp {
  readonly id: string;
  readonly dir: string;
  readonly manifest: AppManifest;
}

/**
 * Materialize a verified App template as an independent local App. The target
 * directory is reserved first. Repository initialization follows complete
 * package publication and any failure rolls the newly owned target back.
 */
export async function instantiateMarketplaceApp(
  options: InstantiateMarketplaceAppOptions,
): Promise<InstantiatedMarketplaceApp> {
  if (!SCOPED_PACKAGE_ID_PATTERN.test(options.packageId)) {
    throw new Error("Marketplace App package ID must be scoped");
  }
  if (!isOpaqueReleaseId(options.releaseId)) {
    throw new Error("Marketplace App release ID is invalid");
  }
  const localId = options.localId ?? options.packageId;
  if (!PACKAGE_ID_PATTERN.test(localId)) {
    throw new Error("Local App ID is invalid");
  }

  const sourceManifest = await readSourceManifest(options.verifiedSourceDir);
  if (sourceManifest.id !== options.packageId) {
    throw new Error("Verified Marketplace App manifest ID changed before instantiation");
  }
  const manifest: AppManifest = {
    ...sourceManifest,
    id: localId,
    createdFrom: {
      packageId: options.packageId,
      releaseId: options.releaseId,
    },
  };

  await mkdir(options.appsDir, { recursive: true, mode: 0o755 });
  const target = join(options.appsDir, localId);
  let ownsTarget = false;
  try {
    await mkdir(target, { recursive: false, mode: 0o755 });
    ownsTarget = true;
    await chmod(target, 0o755);
    await copyVerifiedAppTree(options.verifiedSourceDir, target, true);
    await writeNewFile(
      join(target, "manifest.json"),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      0o644,
    );
    await options.initializeRepository(target);

    const loaded = (await loadApps(options.appsDir)).apps.get(localId);
    if (!loaded || loaded.dir !== target) {
      throw new Error(`Marketplace App local copy ${localId} failed App Manifest V1 validation`);
    }
    return Object.freeze({ id: localId, dir: target, manifest: loaded.manifest });
  } catch (error) {
    if (ownsTarget) {
      try {
        await rm(target, { recursive: true, force: true });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Marketplace App ${localId} failed and rollback was incomplete`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

async function readSourceManifest(sourceDir: string): Promise<AppManifest> {
  const handle = await open(join(sourceDir, "manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat({ bigint: true });
    if (!details.isFile() || details.size < 1n || details.size > 1024n * 1024n) {
      throw new Error("Verified Marketplace App manifest is not a bounded regular file");
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()));
    } catch (error) {
      throw new Error("Verified Marketplace App manifest is malformed", { cause: error });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Verified Marketplace App manifest is malformed");
    }
    return value as AppManifest;
  } finally {
    await handle.close();
  }
}

async function copyVerifiedAppTree(
  sourceDir: string,
  destinationDir: string,
  skipRootManifest = false,
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (skipRootManifest && entry.name === "manifest.json") continue;
    if (entry.name === ".git" || entry.name === ".lamarck" || entry.name === "node_modules") {
      throw new Error(`Verified Marketplace App retained excluded entry ${entry.name}`);
    }
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destination, { mode: 0o755 });
      await copyVerifiedAppTree(source, destination);
      await chmod(destination, 0o755);
    } else if (entry.isFile()) {
      const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const details = await sourceHandle.stat();
        if (!details.isFile()) throw new Error(`Marketplace App entry changed: ${entry.name}`);
        await writeNewFile(destination, await sourceHandle.readFile(), 0o644);
      } finally {
        await sourceHandle.close();
      }
    } else {
      throw new Error(`Verified Marketplace App contains unsupported entry ${entry.name}`);
    }
  }
}

async function writeNewFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

function isOpaqueReleaseId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
