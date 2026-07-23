import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readlink,
  realpath,
  rm,
  rmdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  createBuildOciBundlePlan,
  evaluateNpmInstallInput,
  MAX_INSTALL_NPMRC_BYTES,
  MAX_INSTALL_PACKAGE_JSON_BYTES,
  MAX_INSTALL_PACKAGE_LOCK_BYTES,
  requireCapsuleBuildStoragePlan,
  validateArtifactDigest,
  validateOpaqueId,
  type BuildOciPlanInput,
  type BuildPrepareBody,
} from "@lamarck/capsule";
import { GuestBlobStore } from "./blob-store";
import {
  BuildCancellationError,
  BuildContainmentError,
  type BuildCapsuleRunner,
  LinuxBuildCapsuleRunner,
} from "./build-runner";
import { DEFAULT_GUEST_PATHS, type GuestFilesystemPaths } from "./config";
import { runFixedCommand } from "./fixed-command";
import { materializeCapsuleTree } from "./tree-materializer";
import {
  createBoundedVolume,
  destroyBoundedVolume,
  type BoundedVolumeOptions,
} from "./bounded-volume";
import {
  UNBOUNDED_GUEST_RESOURCE_ADMISSION,
  type GuestResourceAdmissionLike,
  type GuestResourceLease,
} from "./resource-admission";
import {
  packageLockHasRegistryPackages,
  validateDependencyBundle,
  validatePackageLock as validatePackageLockValue,
  validateWorkspaceLink,
} from "./dependency-bundle";
import type { ArtifactMountLease, ArtifactMountRegistry } from "./resource-manager";

const SYSTEM_PROTOCOL_VERSION = 1;
export const BUILD_MEMORY_ADMISSION_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;
/** Build identities are never recycled inside one verified Guest boot. */
export const MAX_BUILD_HANDLES_PER_BOOT = 4_096;
export const MAX_LIVE_BUILDS = 64;
export const MAX_PREPARING_BUILDS = 8;
export const MAX_TERMINAL_BUILD_RESULTS = 1_024;
export const TERMINAL_BUILD_RESULT_TTL_MS = 5 * 60_000;
export const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
export const MAX_PACKAGE_LOCK_BYTES = 64 * 1024 * 1024;

export interface SealedArtifactDescriptor {
  format: "erofs-v1";
  digest: string;
  bytes: number;
  imageDigest: string;
  runtimeAbi: "capsule-node-v1";
  architecture: NodeJS.Architecture;
  libc: string;
  nodeVersion: string;
  nodeModulesAbi: string;
  sourceDigest: string;
  installDigest: string;
  dependencyDigest?: string;
  fileCount: number;
}

export interface ArtifactSealer {
  seal(
    source: string,
    output: string,
    signal?: AbortSignal,
    options?: { readonlyNodeModules?: boolean },
  ): Promise<{ fileCount: number }>;
}

interface BuildRecord {
  body: BuildPrepareBody;
  state: "prepared" | "running";
  controller?: AbortController;
  /** Settles only after all runc/cgroup/netns/volume cleanup is authoritative. */
  lifecycle?: Promise<SealedArtifactDescriptor>;
}

interface TerminalBuildRecord {
  appHandle: string;
  state: "completed" | "failed" | "cancelled";
  expiresAt: number;
  descriptor?: SealedArtifactDescriptor;
  fault?: string;
}

interface PreparingBuildRecord {
  appHandle: string;
  fingerprint: string;
  promise: Promise<void>;
}

export interface BuildManagerOptions {
  paths?: GuestFilesystemPaths;
  runner?: BuildCapsuleRunner;
  sealer?: ArtifactSealer;
  imageDigest: string;
  manageOwnership?: boolean;
  admission?: GuestResourceAdmissionLike;
  /** Production shares the exact Runtime artifact mount ledger. */
  artifactMountRegistry?: ArtifactMountRegistry;
  warmMounts?: WarmNodeModulesMountOperations;
  volumeOperations?: BuildVolumeOperations;
  /** Deterministic test clock. */
  now?: () => number;
}

export interface WarmNodeModulesMountOperations {
  attach(source: string, destination: string, signal?: AbortSignal): Promise<void>;
  detach(destination: string): Promise<void>;
}

export interface BuildVolumeOperations {
  create(options: BoundedVolumeOptions): Promise<void>;
  destroy(options: { imagePath: string; mountPath: string }): Promise<void>;
}

export class WarmRebuildUnavailableError extends Error {
  readonly code = "WARM_REBUILD_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WarmRebuildUnavailableError";
  }
}

export interface BuildResourceCleanupOperations {
  deleteNetworkNamespace(path: string): Promise<void>;
  destroyVolume(options: { imagePath: string; mountPath: string }): Promise<void>;
  removeCgroupTree(path: string): Promise<void>;
}

export class GuestBuildManager {
  private readonly paths: GuestFilesystemPaths;
  private readonly runner: BuildCapsuleRunner;
  private readonly sealer: ArtifactSealer;
  private readonly imageDigest: string;
  private readonly manageOwnership: boolean;
  private readonly admission: GuestResourceAdmissionLike;
  private readonly artifactMountRegistry: ArtifactMountRegistry | undefined;
  private readonly warmMounts: WarmNodeModulesMountOperations;
  private readonly volumeOperations: BuildVolumeOperations;
  private readonly builds = new Map<string, BuildRecord>();
  private readonly preparingBuilds = new Map<string, PreparingBuildRecord>();
  private readonly seenBuildHandles = new Map<string, string>();
  private readonly terminalBuilds = new Map<string, TerminalBuildRecord>();
  private readonly now: () => number;
  private draining = false;
  private drainPromise: Promise<void> | undefined;
  private fatalContainment: BuildContainmentError | undefined;

  constructor(private readonly blobs: GuestBlobStore, options: BuildManagerOptions) {
    this.paths = options.paths ?? DEFAULT_GUEST_PATHS;
    this.runner = options.runner ?? new LinuxBuildCapsuleRunner();
    this.sealer = options.sealer ?? new ErofsArtifactSealer(this.paths.mkfsErofsPath);
    this.imageDigest = validateArtifactDigest(options.imageDigest, "imageDigest");
    this.manageOwnership = options.manageOwnership ?? true;
    this.admission = options.admission ?? UNBOUNDED_GUEST_RESOURCE_ADMISSION;
    this.artifactMountRegistry = options.artifactMountRegistry;
    this.warmMounts = options.warmMounts ?? LINUX_WARM_NODE_MODULES_MOUNTS;
    this.volumeOperations = options.volumeOperations ?? {
      create: createBoundedVolume,
      destroy: destroyBoundedVolume,
    };
    this.now = options.now ?? Date.now;
  }

  prepare(body: BuildPrepareBody): Promise<void> {
    this.assertAcceptingBuilds();
    requireBuildStoragePlan(body);
    const buildHandle = validateOpaqueId(body.buildHandle, "buildHandle");
    const appHandle = validateOpaqueId(body.appHandle, "appHandle");
    validateArtifactDigest(body.packageDigest, "packageDigest");
    validateArtifactDigest(body.installDigest, "installDigest");
    if (body.dependencyDigest) validateArtifactDigest(body.dependencyDigest, "dependencyDigest");
    if (body.baseArtifactDigest) validateArtifactDigest(body.baseArtifactDigest, "baseArtifactDigest");
    if (body.baseDependencyDigest) validateArtifactDigest(body.baseDependencyDigest, "baseDependencyDigest");
    const cloned = structuredClone(body);
    const fingerprint = JSON.stringify(cloned);
    const existing = this.builds.get(buildHandle);
    if (existing) {
      return JSON.stringify(existing.body) === fingerprint && existing.state === "prepared"
        ? Promise.resolve()
        : Promise.reject(new Error(`Build handle ${buildHandle} cannot be reused`));
    }
    const preparing = this.preparingBuilds.get(buildHandle);
    if (preparing) {
      return preparing.appHandle === appHandle && preparing.fingerprint === fingerprint
        ? preparing.promise
        : Promise.reject(new Error(`Build handle ${buildHandle} cannot be reused`));
    }
    if (this.seenBuildHandles.has(buildHandle)) {
      return Promise.reject(new Error(`Retired Build handle ${buildHandle} cannot be reused`));
    }
    if (this.preparingBuilds.size >= MAX_PREPARING_BUILDS) {
      return Promise.reject(new Error(
        `Guest Build prepare admission limit ${MAX_PREPARING_BUILDS} is exhausted`,
      ));
    }
    if (this.builds.size + this.preparingBuilds.size >= MAX_LIVE_BUILDS) {
      return Promise.reject(new Error(
        `Guest live Build admission limit ${MAX_LIVE_BUILDS} is exhausted`,
      ));
    }
    if (this.seenBuildHandles.size + this.preparingBuilds.size >= MAX_BUILD_HANDLES_PER_BOOT) {
      return Promise.reject(new Error(
        `Guest Build identity budget ${MAX_BUILD_HANDLES_PER_BOOT} is exhausted for this boot`,
      ));
    }

    let tracked!: Promise<void>;
    const operation = this.prepareBuild(cloned).then(() => {
      // CAS verification yields. The drain fence must win before publishing a
      // live/seen authority record.
      this.assertAcceptingBuilds();
      this.seenBuildHandles.set(buildHandle, appHandle);
      this.builds.set(buildHandle, { body: cloned, state: "prepared" });
    });
    tracked = operation.finally(() => {
      if (this.preparingBuilds.get(buildHandle)?.promise === tracked) {
        this.preparingBuilds.delete(buildHandle);
      }
    });
    this.preparingBuilds.set(buildHandle, { appHandle, fingerprint, promise: tracked });
    return tracked;
  }

  private async prepareBuild(body: BuildPrepareBody): Promise<void> {
    if (!await this.blobs.has("package", body.packageDigest)) {
      throw new Error(`package blob ${body.packageDigest} has not been imported`);
    }
    if (body.dependencyDigest && !await this.blobs.has("dependency", body.dependencyDigest)) {
      throw new Error(`dependency blob ${body.dependencyDigest} has not been imported`);
    }
    if (body.baseArtifactDigest && !await this.blobs.has("artifact", body.baseArtifactDigest)) {
      throw new Error(`base artifact blob ${body.baseArtifactDigest} has not been imported`);
    }
  }

  start(appHandle: string, buildHandle: string): Promise<SealedArtifactDescriptor> {
    this.assertAcceptingBuilds();
    validateOpaqueId(appHandle, "appHandle");
    validateOpaqueId(buildHandle, "buildHandle");
    const record = this.builds.get(buildHandle);
    if (!record) {
      const terminal = this.getTerminalBuild(buildHandle);
      if (terminal?.appHandle === appHandle && terminal.state === "completed" && terminal.descriptor) {
        return Promise.resolve(terminal.descriptor);
      }
      return Promise.reject(new Error("Unknown or retired Build handle"));
    }
    if (record.body.appHandle !== appHandle) {
      return Promise.reject(new Error("Unknown Build handle"));
    }
    if (record.state === "running") return record.lifecycle!;
    record.state = "running";
    const controller = new AbortController();
    record.controller = controller;
    const lifecycle = this.executeBuild(record, controller).then(
      (descriptor) => {
        try {
          throwIfAborted(controller.signal);
        } catch (error) {
          this.retireBuild(buildHandle, record, {
            appHandle,
            state: "cancelled",
            fault: error instanceof Error ? error.message : String(error),
            expiresAt: this.now() + TERMINAL_BUILD_RESULT_TTL_MS,
          });
          throw error;
        }
        this.retireBuild(buildHandle, record, {
          appHandle,
          state: "completed",
          descriptor,
          expiresAt: this.now() + TERMINAL_BUILD_RESULT_TTL_MS,
        });
        return descriptor;
      },
      (error: unknown) => {
        if (error instanceof BuildContainmentError) this.fatalContainment ??= error;
        this.retireBuild(buildHandle, record, {
          appHandle,
          state: controller.signal.aborted && !(error instanceof BuildContainmentError)
            ? "cancelled"
            : "failed",
          fault: error instanceof Error ? error.message : String(error),
          expiresAt: this.now() + TERMINAL_BUILD_RESULT_TTL_MS,
        });
        throw error;
      },
    );
    record.lifecycle = lifecycle;
    void lifecycle.catch(() => undefined);
    return lifecycle;
  }

  private async executeBuild(
    record: BuildRecord,
    controller: AbortController,
  ): Promise<SealedArtifactDescriptor> {
    const { buildHandle } = record.body;
    const buildKey = `b-${opaqueKey(buildHandle)}`;
    const root = `${this.paths.buildRoot}/${buildKey}`;
    const volumeImage = `${this.paths.buildRoot}/${buildKey}.scratch.ext4`;
    const workspace = `${root}/workspace`;
    const dependencies = `${root}/dependencies`;
    const home = `${root}/home`;
    const output = `${root}/artifact.erofs`;
    const netnsPath = `${this.paths.netnsRoot}/${buildKey}`;
    const cgroupPath = `${this.paths.cgroupRoot}/builds/${buildKey}`;
    const warmRequested = record.body.baseArtifactDigest !== undefined;
    const warmNodeModules = `${workspace}/node_modules`;
    let resourceLease: GuestResourceLease | undefined;
    let warmArtifactLease: ArtifactMountLease | undefined;
    let warmNodeModulesAttached = false;
    let volumeAttempted = false;
    let networkAttempted = false;
    let containmentFailed = false;
    let primaryError: unknown;
    try {
      throwIfAborted(controller.signal);
      resourceLease = await this.admission.reserve(
        `build:${buildHandle}`,
        buildAdmissionRequest(record.body),
      );
      throwIfAborted(controller.signal);
      volumeAttempted = true;
      await this.volumeOperations.create({
        imagePath: volumeImage,
        mountPath: root,
        bytes: record.body.scratchBytes,
        label: `LBUILD${buildKey.slice(2, 9).toUpperCase()}`,
        signal: controller.signal,
      });
      throwIfAborted(controller.signal);
      await materializeCapsuleTree(
        await this.blobs.open("package", record.body.packageDigest),
        workspace,
        controller.signal,
      );
      throwIfAborted(controller.signal);
      const packageMetadata = await validatePackageMetadata(workspace, controller.signal);
      const hasPackageLock = await regularFileExists(`${workspace}/package-lock.json`);
      if (!hasPackageLock) {
        throw new Error("Build Capsule requires package-lock.json lockfileVersion 2 or 3");
      }
      const packageLock = await readBoundedJsonFile(
        `${workspace}/package-lock.json`,
        MAX_PACKAGE_LOCK_BYTES,
        "package-lock.json",
        controller.signal,
      );
      validatePackageLockValue(packageLock);
      const currentInstallInput = await evaluateInstallInputAt(workspace, controller.signal);
      if (currentInstallInput.digest !== record.body.installDigest) {
        throw installInputMismatch("candidate package");
      }
      throwIfAborted(controller.signal);

      if (warmRequested) {
        if (!currentInstallInput.warmEligible) {
          throw new WarmRebuildUnavailableError(
            currentInstallInput.reason ?? "candidate install input is not warm-reusable",
          );
        }
        if (!this.artifactMountRegistry || !record.body.baseArtifactDigest) {
          throw new WarmRebuildUnavailableError("Guest has no warm artifact mount authority");
        }
        try {
          warmArtifactLease = await this.artifactMountRegistry.acquire(
            record.body.baseArtifactDigest,
          );
        } catch (error) {
          if (isFatalGuestError(error)) {
            throw new BuildContainmentError(
              "Warm base artifact mount cleanup was not authoritative",
              { cause: error },
            );
          }
          throw new WarmRebuildUnavailableError("sealed warm base could not be mounted", {
            cause: error,
          });
        }
        try {
          const baseInstallInput = await evaluateInstallInputAt(
            warmArtifactLease.mountRoot,
            controller.signal,
          );
          if (
            baseInstallInput.digest !== record.body.installDigest
            || !baseInstallInput.warmEligible
          ) {
            throw new WarmRebuildUnavailableError(
              baseInstallInput.reason ?? "sealed warm base install inputs do not match",
            );
          }
          const baseNodeModules = `${warmArtifactLease.mountRoot}/node_modules`;
          await requireRealDirectoryInside(
            baseNodeModules,
            warmArtifactLease.mountRoot,
            "sealed warm base node_modules",
          );
          if (packageMetadata.requiresSystemSdk) {
            await validateInstalledSystemSdk(baseNodeModules, controller.signal);
          }
        } catch (error) {
          throwIfAborted(controller.signal);
          if (error instanceof WarmRebuildUnavailableError) throw error;
          if (isFatalGuestError(error)) {
            throw new BuildContainmentError(
              "Warm base validation lost authoritative Guest containment",
              { cause: error },
            );
          }
          throw new WarmRebuildUnavailableError(
            "sealed warm base is structurally unsuitable",
            { cause: error },
          );
        }
      } else {
        await mkdir(dependencies, { recursive: true, mode: 0o700 });
        if (record.body.dependencyDigest) {
          await materializeCapsuleTree(
            await this.blobs.open("dependency", record.body.dependencyDigest),
            dependencies,
            controller.signal,
          );
        } else {
          await mkdir(`${dependencies}/tarballs`, { recursive: true, mode: 0o755 });
          await writeFile(
            `${dependencies}/manifest.json`,
            '{"version":1,"entries":[]}\n',
            { encoding: "utf8", mode: 0o644 },
          );
        }
        throwIfAborted(controller.signal);
        await mkdir(home, { recursive: true, mode: 0o700 });
        if (record.body.dependencyDigest) {
          await validateDependencyBundle(dependencies, controller.signal);
        } else if (packageLockHasRegistryPackages(packageLock)) {
          throw new Error("package-lock requires an imported npm dependency bundle");
        }
      }
      throwIfAborted(controller.signal);
      const appUid = record.body.mappedHostUid + 1_000;
      const appGid = record.body.mappedHostGid + 1_000;
      if (this.manageOwnership) {
        await chownTree(root, appUid, appGid, controller.signal);
      }
      throwIfAborted(controller.signal);
      if (warmRequested) {
        const baseNodeModules = `${warmArtifactLease!.mountRoot}/node_modules`;
        try {
          await this.warmMounts.attach(baseNodeModules, warmNodeModules, controller.signal);
          warmNodeModulesAttached = true;
        } catch (error) {
          // Production attach reports a fatalGuest error only when a partial
          // bind could not be proven absent. Retain the base lease and scratch
          // backing in that state; ordinary/typed misses prove no bind remains.
          if (isFatalGuestError(error)) warmNodeModulesAttached = true;
          throw error;
        }
      } else {
        const input: BuildOciPlanInput = {
          appHandle: record.body.appHandle,
          buildHandle: record.body.buildHandle,
          packageDigest: record.body.packageDigest,
          ...(record.body.dependencyDigest === undefined
            ? {}
            : { dependencyDigest: record.body.dependencyDigest }),
          mappedHostUid: record.body.mappedHostUid,
          mappedHostGid: record.body.mappedHostGid,
          resources: record.body.resources,
        };
        const plan = createBuildOciBundlePlan(input);
        if (plan.networkNamespacePath !== netnsPath) {
          throw new Error("Build network namespace differs from the closed OCI policy");
        }
        await prepareBuildCgroup(this.paths.cgroupRoot);
        await mkdir(this.paths.netnsRoot, { recursive: true, mode: 0o700 });
        throwIfAborted(controller.signal);
        networkAttempted = true;
        await runFixedCommand(this.paths.netHelperPath, ["create", netnsPath], {
          signal: controller.signal,
        });
        throwIfAborted(controller.signal);
        const run = await this.runner.run(plan, input, record.body.timeoutMs, controller.signal);
        throwIfAborted(controller.signal);
        if (run.exitCode !== 0) {
          throw new Error(`offline npm materialization failed (${run.exitCode}): ${tail(run.logs)}`);
        }
        if (packageMetadata.requiresSystemSdk) {
          await validateInstalledSystemSdk(`${workspace}/node_modules`, controller.signal);
        }
      }
      throwIfAborted(controller.signal);
      await validateSealableTree(workspace, controller.signal);
      throwIfAborted(controller.signal);
      const sealed = await this.sealer.seal(
        workspace,
        output,
        controller.signal,
        warmRequested ? { readonlyNodeModules: true } : undefined,
      );
      throwIfAborted(controller.signal);
      const sealedDetails = await lstat(output);
      if (
        !sealedDetails.isFile()
        || sealedDetails.isSymbolicLink()
        || sealedDetails.size < 1
      ) {
        throw new Error("Build sealer did not emit a regular artifact");
      }
      if (sealedDetails.size > record.body.artifactOutputBytes) {
        throw new Error(
          `sealed artifact ${sealedDetails.size} bytes exceeds the ${record.body.artifactOutputBytes} byte Build output ceiling`,
        );
      }
      const imported = await this.blobs.importLocalFile("artifact", output, {
        ownerKey: record.body.ownerKey,
        referenceId: `build:${buildHandle}:output`,
        maximumBytes: record.body.artifactOutputBytes,
        signal: controller.signal,
      });
      throwIfAborted(controller.signal);
      const descriptor: SealedArtifactDescriptor = {
        format: "erofs-v1",
        digest: imported.digest,
        bytes: imported.bytes,
        imageDigest: this.imageDigest,
        runtimeAbi: "capsule-node-v1",
        architecture: process.arch,
        libc: runtimeLibc(),
        nodeVersion: process.versions.node,
        nodeModulesAbi: process.versions.modules,
        sourceDigest: record.body.packageDigest,
        installDigest: record.body.installDigest,
        ...((record.body.dependencyDigest ?? record.body.baseDependencyDigest) === undefined
          ? {}
          : { dependencyDigest: record.body.dependencyDigest ?? record.body.baseDependencyDigest }),
        fileCount: sealed.fileCount,
      };
      return descriptor;
    } catch (error) {
      primaryError = error;
      containmentFailed = error instanceof BuildContainmentError;
      throw error;
    } finally {
      let warmCleanupError: unknown;
      if (warmNodeModulesAttached) {
        try {
          await this.warmMounts.detach(warmNodeModules);
          warmNodeModulesAttached = false;
        } catch (error) {
          warmCleanupError = error;
        }
      }
      if (warmArtifactLease && !warmNodeModulesAttached && !containmentFailed) {
        try {
          await warmArtifactLease.release();
          warmArtifactLease = undefined;
        } catch (error) {
          warmCleanupError = warmCleanupError === undefined
            ? error
            : new AggregateError([warmCleanupError, error], "Warm Build mount cleanup failed");
        }
      }
      if (warmCleanupError !== undefined) containmentFailed = true;
      try {
        await cleanupBuildResources({
          buildHandle,
          netnsPath,
          volumeImage,
          root,
          cgroupPath,
          networkAttempted,
          volumeAttempted,
          storageMayBeInUse: containmentFailed,
          operations: {
            deleteNetworkNamespace: async (path) => {
              await runFixedCommand(this.paths.netHelperPath, ["delete", path], {
                allowExitCodes: [0, 2],
              });
            },
            destroyVolume: this.volumeOperations.destroy,
            removeCgroupTree: removeBuildCgroupTree,
          },
        });
        if (!containmentFailed) resourceLease?.release();
      } catch (cleanupError) {
        throw new BuildContainmentError(
          `Build ${buildHandle} resource cleanup was not authoritative; Guest must be terminated`,
          { cause: primaryError === undefined
            ? cleanupError
            : new AggregateError([primaryError, cleanupError], "Build operation and resource cleanup failed") },
        );
      }
      if (warmCleanupError !== undefined) {
        throw new BuildContainmentError(
          `Build ${buildHandle} warm dependency cleanup was not authoritative; Guest must be terminated`,
          { cause: primaryError === undefined
            ? warmCleanupError
            : new AggregateError([primaryError, warmCleanupError], "Build and warm cleanup failed") },
        );
      }
    }
  }

  async cancel(appHandle: string, buildHandle: string, graceMs: number): Promise<void> {
    validateOpaqueId(appHandle, "appHandle");
    validateOpaqueId(buildHandle, "buildHandle");
    const record = this.builds.get(buildHandle);
    if (!record) {
      const terminal = this.getTerminalBuild(buildHandle);
      if (terminal?.appHandle === appHandle) return;
      if (this.seenBuildHandles.get(buildHandle) === appHandle) return;
      throw new Error("Unknown or retired Build handle");
    }
    if (record.body.appHandle !== appHandle) throw new Error("Unknown Build handle");
    if (record.state === "prepared") {
      this.retireBuild(buildHandle, record, {
        appHandle,
        state: "cancelled",
        expiresAt: this.now() + TERMINAL_BUILD_RESULT_TTL_MS,
      });
      return;
    }

    const lifecycle = record.lifecycle;
    if (!lifecycle) {
      throw new BuildContainmentError(`Running Build ${buildHandle} has no lifecycle barrier`);
    }
    record.controller?.abort(new BuildCancellationError("Build cancelled by Host", graceMs));
    try {
      await lifecycle;
    } catch (error) {
      if (error instanceof BuildContainmentError) throw error;
      // A normal abort/build error is safe only because lifecycle settled
      // after the authoritative finalizer.
      return;
    }
  }

  /**
   * Permanently closes Build admission for this Guest boot, cancels every
   * prepared/running Build, and waits for each running Build's authoritative
   * containment and privileged-resource cleanup barrier.
   */
  drain(): Promise<void> {
    this.draining = true;
    this.drainPromise ??= this.performDrain();
    return this.drainPromise;
  }

  private async performDrain(): Promise<void> {
    if (this.fatalContainment) throw this.fatalContainment;
    // `prepare()` owns a bounded slot before its first CAS hash. Waiting these
    // barriers proves every source FileHandle is closed; the drain fence makes
    // their post-hash publication check reject.
    const preparationBarriers = [...this.preparingBuilds.values()].map(
      (record) => record.promise,
    );
    const lifecycleBarriers: Promise<SealedArtifactDescriptor>[] = [];
    for (const [buildHandle, record] of [...this.builds]) {
      if (record.state === "prepared") {
        this.retireBuild(buildHandle, record, {
          appHandle: record.body.appHandle,
          state: "cancelled",
          expiresAt: this.now() + TERMINAL_BUILD_RESULT_TTL_MS,
        });
        continue;
      }
      if (!record.lifecycle) {
        throw new BuildContainmentError(
          `Running Build ${record.body.buildHandle} has no authoritative cleanup barrier`,
        );
      }
      record.controller?.abort(new BuildCancellationError(
        "Guest Build authority was revoked during drain",
        0,
      ));
      lifecycleBarriers.push(record.lifecycle);
    }

    const [preparations, lifecycles] = await Promise.all([
      Promise.allSettled(preparationBarriers),
      Promise.allSettled(lifecycleBarriers),
    ]);
    // Normal prepare rejection is expected after the drain fence. Merely
    // awaiting it is what proves CAS source iterators/FileHandles are closed.
    void preparations;
    const failures: unknown[] = lifecycles.flatMap((result) => (
      result.status === "rejected" && result.reason instanceof BuildContainmentError
        ? [result.reason]
        : []
    ));
    if (this.fatalContainment) failures.push(this.fatalContainment);
    if (this.builds.size > 0) {
      failures.push(new Error(`${this.builds.size} Build(s) remained live after drain`));
    }
    if (failures.length > 0) {
      throw new BuildContainmentError(
        "Guest Build drain was not authoritative; Guest must be terminated",
        { cause: new AggregateError(failures, "Build drain failed") },
      );
    }
  }

  private assertAcceptingBuilds(): void {
    if (this.fatalContainment) throw this.fatalContainment;
    if (this.draining) throw new Error("Guest Build manager is draining");
  }

  private retireBuild(
    buildHandle: string,
    record: BuildRecord,
    terminal: TerminalBuildRecord,
  ): void {
    if (this.builds.get(buildHandle) !== record) return;
    record.controller = undefined;
    this.builds.delete(buildHandle);
    this.cleanupTerminalBuilds();
    this.terminalBuilds.delete(buildHandle);
    this.terminalBuilds.set(buildHandle, terminal);
    while (this.terminalBuilds.size > MAX_TERMINAL_BUILD_RESULTS) {
      const oldest = this.terminalBuilds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.terminalBuilds.delete(oldest);
    }
  }

  private getTerminalBuild(buildHandle: string): TerminalBuildRecord | undefined {
    this.cleanupTerminalBuilds();
    return this.terminalBuilds.get(buildHandle);
  }

  private cleanupTerminalBuilds(): void {
    const now = this.now();
    for (const [handle, terminal] of this.terminalBuilds) {
      if (terminal.expiresAt > now) continue;
      this.terminalBuilds.delete(handle);
    }
  }

}

export async function cleanupBuildResources(options: {
  buildHandle: string;
  netnsPath: string;
  volumeImage: string;
  root: string;
  cgroupPath: string;
  networkAttempted: boolean;
  volumeAttempted: boolean;
  storageMayBeInUse: boolean;
  operations: BuildResourceCleanupOperations;
}): Promise<void> {
  const failures: unknown[] = [];
  if (options.networkAttempted) {
    try {
      await options.operations.deleteNetworkNamespace(options.netnsPath);
    } catch (error) {
      failures.push(error);
    }
  }
  // Never unmount Build storage until the cgroup/runc layer proved that every
  // descendant is gone. Retaining the mount and reservation is safer than
  // exposing a live process to a recycled backing file.
  if (options.volumeAttempted && !options.storageMayBeInUse) {
    try {
      await options.operations.destroyVolume({
        imagePath: options.volumeImage,
        mountPath: options.root,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (!options.storageMayBeInUse) {
    try {
      await options.operations.removeCgroupTree(options.cgroupPath);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new BuildContainmentError(
      `Build ${options.buildHandle} netns/volume/cgroup cleanup failed`,
      { cause: new AggregateError(failures, "Build resource cleanup failed") },
    );
  }
}

/** @internal Exported for the fixed Guest admission-floor contract test. */
export function buildAdmissionRequest(body: BuildPrepareBody): {
  diskBytes: number;
  memoryBytes: number;
} {
  const storage = requireBuildStoragePlan(body);
  return {
    diskBytes: storage.scratchBytes,
    // Metadata validation and sealing execute in the trusted supervisor,
    // outside the Build cgroup. Charge the production 2 GiB floor even if a
    // malformed Host request asks for a smaller container limit.
    memoryBytes: Math.max(
      body.resources.memoryBytes,
      BUILD_MEMORY_ADMISSION_FLOOR_BYTES,
    ),
  };
}

function requireBuildStoragePlan(body: BuildPrepareBody) {
  const supplied = {
    version: body.storagePlanVersion,
    scratchBytes: body.scratchBytes,
    artifactOutputBytes: body.artifactOutputBytes,
  };
  if (body.dependencyBytes !== undefined && body.baseArtifactBytes === undefined) {
    return requireCapsuleBuildStoragePlan({
      mode: "cold",
      packageBytes: body.packageBytes,
      dependencyBytes: body.dependencyBytes,
    }, supplied);
  }
  if (body.baseArtifactBytes !== undefined && body.dependencyBytes === undefined) {
    return requireCapsuleBuildStoragePlan({
      mode: "warm",
      packageBytes: body.packageBytes,
      baseArtifactBytes: body.baseArtifactBytes,
    }, supplied);
  }
  throw new Error("Build requires exactly one authenticated dependency or warm base input");
}

async function removeBuildCgroupTree(path: string): Promise<void> {
  let directory;
  try {
    directory = await opendir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const children: string[] = [];
  for await (const entry of directory) {
    if (entry.isDirectory()) children.push(`${path}/${entry.name}`);
  }
  for (const child of children) await removeBuildCgroupTree(child);
  try {
    await rmdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function prepareBuildCgroup(root: string): Promise<void> {
  const builds = `${root}/builds`;
  await mkdir(builds, { recursive: true, mode: 0o755 });
  await enableCgroupControllers(root, ["cpu", "memory", "pids"]);
  await enableCgroupControllers(builds, ["cpu", "memory", "pids"]);
}

async function enableCgroupControllers(path: string, controllers: readonly string[]): Promise<void> {
  const available = new Set(
    (await readFile(`${path}/cgroup.controllers`, "utf8")).trim().split(/\s+/).filter(Boolean),
  );
  const enabled = controllers.filter((controller) => available.has(controller));
  if (enabled.length > 0) {
    await writeFile(`${path}/cgroup.subtree_control`, enabled.map((item) => `+${item}`).join(" "));
  }
}

export class ErofsArtifactSealer implements ArtifactSealer {
  constructor(private readonly mkfsPath: string) {}

  async seal(
    source: string,
    output: string,
    signal?: AbortSignal,
    options?: { readonlyNodeModules?: boolean },
  ): Promise<{ fileCount: number }> {
    const fileCount = await normalizeSealableTree(
      source,
      signal,
      options?.readonlyNodeModules === true ? resolve(source, "node_modules") : undefined,
    );
    throwIfAborted(signal);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await rm(output, { force: true });
    await runFixedCommand(this.mkfsPath, [
      "--all-root",
      "-T",
      "0",
      "-U",
      "00000000-0000-0000-0000-000000000000",
      "--",
      output,
      source,
    ], { timeoutMs: 5 * 60_000, signal });
    throwIfAborted(signal);
    const details = await stat(output);
    if (!details.isFile() || details.size < 4_096) throw new Error("mkfs.erofs did not emit an artifact");
    return { fileCount };
  }
}

async function validatePackageMetadata(
  workspace: string,
  signal?: AbortSignal,
): Promise<{ requiresSystemSdk: boolean }> {
  const value = await readBoundedJsonFile(
    `${workspace}/package.json`,
    MAX_PACKAGE_JSON_BYTES,
    "package.json",
    signal,
  );
  if (!isPlainObject(value)) throw new Error("package.json must contain an object");
  let requiresSystemSdk = false;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const dependencies = value[field];
    if (dependencies === undefined) continue;
    if (!isPlainObject(dependencies)) throw new Error(`package.json ${field} must be an object`);
    for (const [name, specification] of Object.entries(dependencies)) {
      if (typeof specification !== "string") throw new Error(`dependency ${name} must be a string`);
      if (name === "@lamarck/system") requiresSystemSdk = true;
      if (/^(?:file:|link:)/i.test(specification)) {
        const target = specification.slice(specification.indexOf(":") + 1).replace(/^\.\//, "");
        validateWorkspaceLink(target, `dependency ${name}`);
        continue;
      }
      if (/^workspace:/i.test(specification)) continue;
      if (/^(?:git(?:\+|:)|https?:|ssh:|github:)/i.test(specification)) {
        throw new Error(`dependency ${name} uses unsupported non-registry source ${specification}`);
      }
    }
  }
  return { requiresSystemSdk };
}

async function validateSealableTree(root: string, signal?: AbortSignal): Promise<void> {
  const rootPath = resolve(root);
  const pending = [rootPath];
  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop()!;
    const directory = await opendir(current);
    for await (const entry of directory) {
      throwIfAborted(signal);
      const path = join(current, entry.name);
      const details = await lstat(path);
      if (details.isDirectory()) {
        pending.push(path);
      } else if (details.isFile()) {
        continue;
      } else if (details.isSymbolicLink()) {
        const target = await readlink(path);
        if (target.startsWith("/") || target.includes("\0")) {
          throw new Error(`artifact symlink ${path} has an unsafe target`);
        }
        const resolved = resolve(dirname(path), target);
        if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${sep}`)) {
          throw new Error(`artifact symlink ${path} escapes the artifact root`);
        }
      } else {
        throw new Error(`artifact contains a device, socket, or FIFO at ${path}`);
      }
    }
  }
}

async function normalizeSealableTree(
  root: string,
  signal?: AbortSignal,
  readonlySubtree?: string,
): Promise<number> {
  await validateSealableTree(root, signal);
  let count = 0;
  const pending = [resolve(root)];
  const immutable = readonlySubtree === undefined ? undefined : resolve(readonlySubtree);
  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop()!;
    const directory = await opendir(current);
    const preserveMetadata = immutable !== undefined
      && (current === immutable || current.startsWith(`${immutable}${sep}`));
    // Artifact ownership cannot be pre-shifted for every App user namespace.
    // World write here is scoped to the App-private overlay: the EROFS lower
    // is immutable, there is no cross-App mount, and all same-App workloads
    // intentionally share one trust boundary. It permits real COW edits and
    // framework caches without eagerly copying the complete artifact.
    if (!preserveMetadata) {
      await chmod(current, 0o777);
      await utimes(current, 0, 0);
    }
    for await (const entry of directory) {
      throwIfAborted(signal);
      count += 1;
      const path = join(current, entry.name);
      const details = await lstat(path);
      if (details.isDirectory()) {
        pending.push(path);
      } else if (details.isFile()) {
        if (!preserveMetadata) {
          await chmod(path, details.mode & 0o111 ? 0o777 : 0o666);
          await utimes(path, 0, 0);
        }
      }
    }
  }
  return count;
}

async function chownTree(root: string, uid: number, gid: number, signal?: AbortSignal): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop()!;
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      await lchown(current, uid, gid);
      continue;
    }
    await chown(current, uid, gid);
    if (!details.isDirectory()) continue;
    const directory = await opendir(current);
    for await (const entry of directory) {
      throwIfAborted(signal);
      pending.push(join(current, entry.name));
    }
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function evaluateInstallInputAt(root: string, signal?: AbortSignal) {
  const packageJson = await readBoundedRegularBytes(
    `${root}/package.json`,
    MAX_INSTALL_PACKAGE_JSON_BYTES,
    "package.json",
    signal,
  );
  const packageLock = await readBoundedRegularBytes(
    `${root}/package-lock.json`,
    MAX_INSTALL_PACKAGE_LOCK_BYTES,
    "package-lock.json",
    signal,
  );
  const npmrc = await readOptionalBoundedRegularBytes(
    `${root}/.npmrc`,
    MAX_INSTALL_NPMRC_BYTES,
    ".npmrc",
    signal,
  );
  return evaluateNpmInstallInput({
    packageJson,
    packageLock,
    ...(npmrc === undefined ? {} : { npmrc }),
    hasBindingGyp: await pathExists(`${root}/binding.gyp`),
    hasShrinkwrap: await pathExists(`${root}/npm-shrinkwrap.json`),
  });
}

async function readBoundedRegularBytes(
  path: string,
  maximumBytes: number,
  label: string,
  signal?: AbortSignal,
  allowEmpty = false,
): Promise<Buffer> {
  throwIfAborted(signal);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (
      !details.isFile()
      || (!allowEmpty && details.size < 1)
      || details.size > maximumBytes
    ) {
      throw new Error(`${label} exceeds its Guest install-input bound`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== details.size || bytes.byteLength > maximumBytes) {
      throw new Error(`${label} changed while reading install inputs`);
    }
    throwIfAborted(signal);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readOptionalBoundedRegularBytes(
  path: string,
  maximumBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  try {
    return await readBoundedRegularBytes(path, maximumBytes, label, signal, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function requireRealDirectoryInside(path: string, root: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  if (!canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error(`${label} escapes its containing directory`);
  }
}

async function validateInstalledSystemSdk(nodeModules: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const root = `${nodeModules}/@lamarck/system`;
  await requireRealDirectoryInside(root, nodeModules, "installed System SDK");
  const packageJson = JSON.parse((await readBoundedRegularBytes(
    `${root}/package.json`,
    MAX_PACKAGE_JSON_BYTES,
    "System SDK package.json",
    signal,
  )).toString("utf8")) as unknown;
  validateSystemSdkProtocolMetadata(packageJson);
  throwIfAborted(signal);
}

/** @internal Exported only for the fixed Guest compatibility contract test. */
export function validateSystemSdkProtocolMetadata(packageJson: unknown): void {
  if (
    !isPlainObject(packageJson)
    || packageJson.name !== "@lamarck/system"
    || packageJson.lamarckSystemProtocol !== SYSTEM_PROTOCOL_VERSION
    || typeof packageJson.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)
  ) {
    throw new Error(`installed @lamarck/system is not compatible with System protocol V${SYSTEM_PROTOCOL_VERSION}`);
  }
}

function installInputMismatch(label: string): Error & { code: string } {
  return Object.assign(new Error(`${label} install fingerprint does not match the Host request`), {
    code: "INSTALL_INPUT_MISMATCH",
  });
}

function isFatalGuestError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "fatalGuest" in error
    && (error as { fatalGuest?: unknown }).fatalGuest === true;
}

/** @internal Production operation exported only for the privileged Linux boundary gate. */
export const LINUX_WARM_NODE_MODULES_MOUNTS: WarmNodeModulesMountOperations = Object.freeze({
  attach: async (source: string, destination: string, signal?: AbortSignal) => {
    throwIfAborted(signal);
    try {
      await lstat(destination);
      throw new WarmRebuildUnavailableError("candidate node_modules already exists before warm bind");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(destination, { mode: 0o700 });
    try {
      await runFixedCommand("/bin/mount", ["--bind", "--", source, destination], { signal });
      await runFixedCommand("/bin/mount", [
        "-o",
        "remount,bind,ro,nosuid,nodev",
        "--",
        destination,
      ], { signal });
      const state = await readMountState(destination);
      if (!state.mounted || !state.readOnly) {
        throw new Error("warm node_modules bind is not a read-only mount");
      }
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      try {
        if ((await readMountState(destination)).mounted) {
          await runFixedCommand("/bin/umount", ["--", destination]);
        }
        if ((await readMountState(destination)).mounted) {
          throw new Error("failed warm bind remained mounted");
        }
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (cleanupFailures.length === 0) {
        await rm(destination, { recursive: true, force: true });
        throwIfAborted(signal);
        throw new WarmRebuildUnavailableError("warm node_modules could not be attached", {
          cause: error,
        });
      }
      throw new BuildContainmentError(
        "failed warm node_modules bind could not be authoritatively removed",
        { cause: new AggregateError([error, ...cleanupFailures], "warm bind cleanup failed") },
      );
    }
  },
  detach: async (destination: string) => {
    try {
      const state = await readMountState(destination);
      if (!state.mounted) {
        throw new Error("warm node_modules bind disappeared before release");
      }
      await runFixedCommand("/bin/umount", ["--", destination]);
      if ((await readMountState(destination)).mounted) {
        throw new Error("warm node_modules bind remained mounted after unmount");
      }
      await rm(destination, { recursive: true });
    } catch (error) {
      if (error instanceof BuildContainmentError) throw error;
      throw new BuildContainmentError(
        "warm node_modules bind cleanup was not authoritative",
        { cause: error },
      );
    }
  },
});

async function readMountState(path: string): Promise<{ mounted: boolean; readOnly: boolean }> {
  const target = resolve(path);
  const input = await readFile("/proc/self/mountinfo", "utf8");
  for (const line of input.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 6 || fields[4] !== target) continue;
    return { mounted: true, readOnly: fields[5]!.split(",").includes("ro") };
  }
  return { mounted: false, readOnly: false };
}

/** @internal Exported for deterministic metadata-bound regression tests. */
export async function readBoundedJsonFile(
  path: string,
  maximumBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("JSON byte bound must be a positive integer");
  }
  throwIfAborted(signal);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte Guest parse bound`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte Guest parse bound`);
    }
    throwIfAborted(signal);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`${label} is not valid UTF-8`, { cause: error });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`${label} is not valid JSON`, { cause: error });
    }
  } finally {
    await handle.close();
  }
}

function runtimeLibc(): string {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
  const header = report.header ?? {};
  return header.glibcVersionRuntime ? `glibc-${header.glibcVersionRuntime}` : "glibc-unknown";
}

function opaqueKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function tail(value: string): string {
  return value.slice(Math.max(0, value.length - 8_192)).trim() || "no build log";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Build aborted");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
