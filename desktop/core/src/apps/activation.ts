import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AppManifestDigest } from "../../../capsule/src/app-manifest-authority";
import { digestNormalizedAppManifest } from "../../../capsule/src/app-manifest-authority";
import type { AppWorkload } from "../auth";
import type { AppManifest } from "../app-loader";
import { isDeclaredWorkload } from "../app-runtime-policy";
import { collectAppPackageTree, validateAppPackageTree } from "./package-tree";
import { AppRepositoryService } from "./repository";

export interface PreparedAppActivationV1 {
  readonly schemaVersion: 1;
  readonly activationId: string;
  readonly activationSequence: number;
  readonly appId: string;
  readonly workload: AppWorkload;
  readonly version: string;
  readonly manifest: AppManifest;
  readonly manifestDigest: AppManifestDigest;
  readonly packageDigest: `sha256:${string}`;
  readonly immutablePackagePath: string;
}

export class AppActivationCoordinator {
  private readonly activations = new Map<string, PreparedAppActivationV1>();
  private sequence = 0;

  constructor(
    private readonly repository: AppRepositoryService,
    private readonly cacheRoot: string,
  ) {}

  async prepare(options: {
    readonly appId: string;
    readonly appDir: string;
    readonly workload: AppWorkload;
  }): Promise<PreparedAppActivationV1> {
    const admitted = await this.repository.activate({
      appId: options.appId,
      appDir: options.appDir,
      validateCandidate(candidate) {
        if (!isDeclaredWorkload(candidate.manifest, options.workload)) {
          throw new Error(`App ${options.appId} does not declare workload ${options.workload}`);
        }
      },
    });
    const packageValue = await this.repository.readVersionPackage(
      options.appId,
      options.appDir,
      admitted.version,
    );
    if (!isDeclaredWorkload(packageValue.manifest, options.workload)) {
      throw new Error("Retained App version workload authority does not match activation admission");
    }
    const immutablePackagePath = await this.materialize({
      appId: options.appId,
      appDir: options.appDir,
      version: admitted.version,
      expectedDigest: packageValue.digest,
    });
    const activation = Object.freeze({
      schemaVersion: 1 as const,
      activationId: allocateActivationId(this.activations),
      activationSequence: ++this.sequence,
      appId: options.appId,
      workload: options.workload,
      version: admitted.version,
      manifest: packageValue.manifest,
      manifestDigest: digestNormalizedAppManifest(packageValue.manifest),
      packageDigest: packageValue.digest,
      immutablePackagePath,
    });
    this.activations.set(activation.activationId, activation);
    return activation;
  }

  require(
    activationId: string,
    appId: string,
    workload: AppWorkload,
  ): PreparedAppActivationV1 {
    const activation = this.activations.get(activationId);
    if (
      !activation
      || activation.appId !== appId
      || activation.workload !== workload
    ) {
      throw new Error("App activation record is unavailable or does not match the requested workload");
    }
    return activation;
  }

  async release(activationId: string): Promise<boolean> {
    const activation = this.activations.get(activationId);
    if (!activation || !this.activations.delete(activationId)) return false;
    if ([...this.activations.values()].some((value) => (
      value.immutablePackagePath === activation.immutablePackagePath
    ))) return true;
    await makeTreeWritable(activation.immutablePackagePath).catch((error) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
    await rm(activation.immutablePackagePath, { recursive: true, force: true });
    return true;
  }

  private async materialize(options: {
    readonly appId: string;
    readonly appDir: string;
    readonly version: string;
    readonly expectedDigest: `sha256:${string}`;
  }): Promise<string> {
    const appRoot = resolve(this.cacheRoot, options.appId);
    const destination = resolve(appRoot, options.version);
    await mkdir(appRoot, { recursive: true, mode: 0o700 });
    if (await isDirectory(destination)) {
      await assertMaterialization(destination, options.appId, options.expectedDigest);
      return destination;
    }

    const stage = await mkdtemp(join(appRoot, ".materialize-"));
    try {
      await this.repository.materializeVersion({
        appId: options.appId,
        appDir: options.appDir,
        version: options.version,
        destination: stage,
      });
      try {
        await rename(stage, destination);
        await makeTreeReadonly(destination);
      } catch (error) {
        if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOTEMPTY")) throw error;
        await assertMaterialization(destination, options.appId, options.expectedDigest);
      }
      return destination;
    } finally {
      await makeTreeWritable(stage).catch((error) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
      await rm(stage, { recursive: true, force: true });
    }
  }
}

async function assertMaterialization(
  path: string,
  appId: string,
  expectedDigest: string,
): Promise<void> {
  const packageValue = validateAppPackageTree(await collectAppPackageTree(path), appId);
  if (packageValue.digest !== expectedDigest) {
    throw new Error("Immutable App version cache does not match its retained commit");
  }
}

async function makeTreeReadonly(directory: string): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true });
  for (const child of children) {
    const path = join(directory, child.name);
    if (child.isDirectory()) {
      await makeTreeReadonly(path);
      await chmod(path, 0o555);
    } else if (child.isFile()) {
      await chmod(path, 0o444);
    } else {
      throw new Error(`Immutable App materialization contains unsupported entry: ${basename(path)}`);
    }
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
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Immutable App version cache path is invalid");
    }
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function allocateActivationId(records: ReadonlyMap<string, unknown>): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const value = `activation_${randomBytes(24).toString("base64url")}`;
    if (!records.has(value)) return value;
  }
  throw new Error("Could not allocate App activation record");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
