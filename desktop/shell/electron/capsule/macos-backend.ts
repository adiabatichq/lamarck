import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
  blobTransferAbsoluteDeadlineMs,
  DEFAULT_BLOB_TRANSFER_POLICY,
  type BlobTransferPolicy,
} from "../../../capsule/src/protocol/blob-transfer";
import {
  encodeJsonFrame,
  MAX_ARTIFACT_ADOPTION_RECEIPT_BYTES,
} from "../../../capsule/src/protocol/codec";
import { parseArtifactAdoptionReceipt } from "../../../capsule/src/protocol/validate";
import {
  APP_MANIFEST_DIGEST_PATTERN,
  APP_MANIFEST_MAX_BYTES,
  digestNormalizedAppManifest,
  type AppManifestDigest,
} from "../../../capsule/src/app-manifest-authority";
import {
  CAPSULE_STATE_CAPACITY_MIN_BYTES,
  createCapsuleBuildStateCapacityPlan,
  createCapsuleRuntimeStoragePlan,
  createCapsuleRuntimeStateCapacityPlan,
  type CapsuleBuildStorageInput,
  type CapsuleBuildStoragePlan,
  type CapsuleLiveRuntimeStorageLease,
  type CapsuleRetainedBlob,
  type CapsuleRuntimeStoragePlan,
} from "../../../capsule/src/storage-plan";
import {
  evaluateNpmInstallInput,
  MAX_INSTALL_NPMRC_BYTES,
  MAX_INSTALL_PACKAGE_JSON_BYTES,
  MAX_INSTALL_PACKAGE_LOCK_BYTES,
} from "../../../capsule/src/build/install-input";
import {
  CAPSULE_PROTOCOL_VERSION,
  type GuestEvent,
  type HostOperation,
  type ImportedBlobFormat,
  type ImportedBlobKind,
  type JsonValue,
  type StreamKind,
} from "../../../capsule/src/protocol/types";
import { generateOpaqueId } from "../../../capsule/src/protocol/tickets";
import type {
  CapsuleBackend,
  CapsuleBackendStatus,
  CapsuleUiInstance,
  CapsuleUiLostEvent,
  CapsuleUiSpec,
} from "./backend";
import {
  CAPSULE_MAX_VIEWER_CONNECTIONS_PER_INSTANCE,
  CapsuleManifestAuthorityChangedError,
  CapsuleRestartRequiredError,
} from "./backend";
import {
  launchCapsuleVmHost,
  type CapsuleVmGuestImage,
  type CapsuleVmHostStream,
} from "../capsule-vm/launcher";
import type { CapsuleVmEvent } from "../capsule-vm/protocol";
import {
  CapsuleGuestSession,
  CapsuleGuestRequestError,
  type CapsuleGuestControlRequestOptions,
  type CapsuleGuestSessionOptions,
  type OpenedGuestDataStream,
  type RequestBodyFor,
} from "./guest-session";
import {
  loadCapsuleGuestRelease,
  type LoadedCapsuleGuestRelease,
} from "./guest-release";
import {
  createCapsulePackageSnapshot,
  readCapsuleTreeSelection,
  type CapsuleTreeSnapshot,
} from "./package-snapshot";
import {
  createNpmDependencyBundle,
  type NpmDependencyBundle,
} from "./dependency-broker";
import {
  HostArtifactStore,
  type HostArtifact,
  type HostArtifactActivation,
} from "./artifact-store";
import type { SystemStreamServer } from "./system-stream";
import { CapsuleStorageBudget, type CapsuleStorageBudgetLike } from "./storage-budget";
import {
  correlateBlobExportedEvent,
  correlateBlobFailedEvent,
  correlateBlobImportedEvent,
  correlateBuildCompletedEvent,
  correlateBuildFailedEvent,
  correlateBuildProgressEvent,
  correlateWorkloadExitedEvent,
  correlateWorkloadFaultedEvent,
  correlateWorkloadReadyEvent,
  correlateWorkloadStartedEvent,
  parseAppPrepareResult,
  parseAppStopResult,
  parseBlobExportPrepareResult,
  parseBlobImportPrepareResult,
  parseBlobImportReleaseResult,
  parseBuildCancelResult,
  parseBuildOutputReleaseResult,
  parseBuildDescriptor,
  parseBuildPrepareResult,
  parsePingResult,
  parseViewerAttachResult,
  parseVmDrainResult,
  parseWorkloadPrepareResult,
  parseWorkloadStartResult,
  parseWorkloadStopResult,
  CapsuleGuestResultError,
  type BuildDescriptorExpectation,
  type SealedGuestArtifactDescriptor,
} from "./guest-results";

const USER_NAMESPACE_RANGE = 65_536;
const FIRST_USER_NAMESPACE_BASE = 131_072;
const LAST_USER_NAMESPACE_BASE = 2_147_418_112;
const TICKET_TTL_MS = 60_000;
const UI_READY_TIMEOUT_MS = 45_000;
const WORKLOAD_STREAM_ATTACH_TIMEOUT_MS = 10_000;
const BLOB_EVENT_CONFIRM_TIMEOUT_MS = 10_000;
const BUILD_TIMEOUT_MS = 120_000;
const BUILD_REQUEST_TIMEOUT_MS = 10 * 60_000;
const MAX_SERIAL_OPERATIONS = 32;
const MAX_EARLY_DATA_STREAMS = 64;
const MAX_LIVE_UI_INSTANCES = 16;
const MAX_VIEWER_STREAMS_GLOBAL = 32;

export interface MacOsCapsuleBackendOptions {
  /** Absolute path to the signed Swift Virtualization.framework helper. */
  helperPath: string;
  /** Trusted Electron resources root containing capsule-guest-release.json. */
  releaseResourcesRoot: string;
  /** Host-private mutable VM disk state. */
  stateDirectory: string;
  /** Host-private package/dependency snapshot cache. */
  cacheDirectory: string;
  /** Host-private sealed runtime artifact CAS and activation pointers. */
  artifactRoot: string;
  /** Host terminator for the workload's ticket-bound System SDK stream. */
  systemStreamServer: SystemStreamServer;
  /** Narrow seams used by deterministic orchestration tests. */
  dependencies?: Partial<MacOsCapsuleBackendDependencies>;
}

interface VmHostLike {
  probe(): Promise<{ virtualizationSupported: boolean }>;
  prepareState(options: {
    stateDirectory: string;
    stateDiskBytes: number;
  }): Promise<{
    preparationId: string;
    stateDiskBytes: number;
    existingPhysicalBytes: number;
    additionalPhysicalBytes: number;
    peakPhysicalBytes: number;
  }>;
  startGuest(image: CapsuleVmGuestImage): Promise<{
    imageDigest: string;
    architecture: "arm64" | "x86_64";
  }>;
  cancelStatePreparation(preparationId: string): Promise<void>;
  stopGuest(): Promise<void>;
  close(): void;
  on(event: "stream", listener: (stream: CapsuleVmHostStream) => void): this;
  on(event: "event", listener: (event: CapsuleVmEvent) => void): this;
  on(event: "close", listener: (error: Error) => void): this;
}

interface GuestSessionLike {
  waitUntilReady(): Promise<unknown>;
  issueTicket(options: {
    kind: StreamKind;
    appHandle: string;
    subjectHandle: string;
    ttlMs: number;
  }): { ticket: string };
  revokeTicket(ticket: unknown): boolean;
  request<TOperation extends HostOperation, TResult extends JsonValue = JsonValue>(
    operation: TOperation,
    body: RequestBodyFor<TOperation>,
    options?: CapsuleGuestControlRequestOptions,
  ): Promise<TResult>;
  openDataStream(
    ticket: string,
    kind: StreamKind,
    options?: { timeoutMs?: number },
  ): Promise<OpenedGuestDataStream>;
  acceptDataStream(stream: Duplex): void;
  close(): void;
  on(event: "event", listener: (event: GuestEvent) => void): this;
  on(event: "fatal", listener: (error: Error) => void): this;
  on(event: "close", listener: (error?: Error) => void): this;
  off(event: "event", listener: (event: GuestEvent) => void): this;
  off(event: "fatal", listener: (error: Error) => void): this;
  off(event: "close", listener: (error?: Error) => void): this;
}

interface ArtifactStoreLike {
  active(appKey: string): Promise<HostArtifactActivation | undefined>;
  find(digest: string, bytes?: number): Promise<HostArtifact | undefined>;
  receive(
    ownerKey: string,
    digest: string,
    bytes: number,
    source: AsyncIterable<Uint8Array>,
  ): Promise<HostArtifact>;
  activate(
    appKey: string,
    artifact: Pick<HostArtifact, "digest" | "bytes">,
    provenance: {
      packageDigest: string;
      imageDigest: string;
      installDigest?: string;
      dependencyDigest?: string;
    },
  ): Promise<void>;
  deactivate(appKey: string): Promise<void>;
  pruneUnreferenced(): Promise<number>;
}

export interface MacOsCapsuleBackendDependencies {
  hostPlatform: NodeJS.Platform;
  exists(path: string): boolean;
  loadRelease: typeof loadCapsuleGuestRelease;
  launchVm(options: { executablePath: string }): VmHostLike;
  createSession(control: Duplex, options: CapsuleGuestSessionOptions): GuestSessionLike;
  snapshot(options: {
    packageDir: string;
    cacheDir: string;
    ownerKey?: string;
    storageBudget?: CapsuleStorageBudgetLike;
  }): Promise<CapsuleTreeSnapshot>;
  manifestDigest(snapshot: CapsuleTreeSnapshot): Promise<AppManifestDigest>;
  installInput(snapshot: CapsuleTreeSnapshot): ReturnType<typeof inspectSnapshotInstallInput>;
  dependencies(options: {
    packageSnapshot: Pick<CapsuleTreeSnapshot, "path" | "digest" | "bytes">;
    cacheDir: string;
    signal?: AbortSignal;
    ownerKey?: string;
    storageBudget?: CapsuleStorageBudgetLike;
  }): Promise<NpmDependencyBundle>;
  artifactStore(root: string, storageBudget: CapsuleStorageBudgetLike): ArtifactStoreLike;
  storageBudget(roots: readonly string[]): CapsuleStorageBudgetLike;
  opaqueId(): string;
  nonce(): number;
}

interface BootBoundary {
  readonly generation: number;
  readonly helper: VmHostLike;
  readonly session: GuestSessionLike;
  readonly release: LoadedCapsuleGuestRelease;
  readonly stateDiskBytes: number;
  intentional: boolean;
}

interface UiRecord {
  readonly instanceId: string;
  readonly appId: string;
  readonly appHandle: string;
  readonly workloadHandle: string;
  readonly userNamespaceBase: number;
  readonly artifact: HostArtifact;
  readonly installDigest?: string;
  readonly dependencyDigest?: string;
  readonly spec: CapsuleUiSpec;
  readonly bootGeneration: number;
  readonly detachSystemStream: () => void;
  readonly viewerStreams: Set<Duplex>;
  lifecycle: "launching" | "replacement" | "active" | "stopping" | "lost";
  terminalError?: Error;
}

interface Candidate extends UiRecord {
  activated: boolean;
}

interface ResolvedArtifact {
  readonly artifact: HostArtifact;
  readonly installDigest?: string;
  readonly dependencyDigest?: string;
}

type ArtifactBuildInput =
  | { readonly mode: "cold"; readonly dependencies: NpmDependencyBundle }
  | { readonly mode: "warm"; readonly base: HostArtifactActivation };

interface ActivationCheckpoint {
  readonly appKey: string;
  readonly previous: HostArtifactActivation | undefined;
}

interface EventWaiter<T> {
  readonly promise: Promise<T>;
  armTimeout(timeoutMs: number): void;
  cancel(error?: Error): void;
}

class GuestOperationError extends Error {
  override readonly name = "GuestOperationError";
}

type BuildDescriptor = SealedGuestArtifactDescriptor;

const DEFAULT_DEPENDENCIES: MacOsCapsuleBackendDependencies = {
  hostPlatform: process.platform,
  exists: existsSync,
  loadRelease: loadCapsuleGuestRelease,
  launchVm: ({ executablePath }) => launchCapsuleVmHost({
    executablePath,
    requestTimeoutMs: 60_000,
    onLog: (message) => console.warn(`[capsule-vm] ${message.trimEnd()}`),
  }),
  createSession: (control, options) => new CapsuleGuestSession(control, options),
  snapshot: createCapsulePackageSnapshot,
  manifestDigest: readSnapshotManifestDigest,
  installInput: inspectSnapshotInstallInput,
  dependencies: createNpmDependencyBundle,
  artifactStore: (root, storageBudget) => new HostArtifactStore(root, { storageBudget }),
  storageBudget: (roots) => new CapsuleStorageBudget({ roots }),
  opaqueId: generateOpaqueId,
  nonce: () => randomBytes(6).readUIntBE(0, 6),
};

/**
 * Production macOS Capsule backend.
 *
 * All application bytes cross the verified Guest boundary as immutable,
 * digest-bound blobs. The Host never falls back to spawning App commands.
 */
export class MacOsCapsuleBackend implements CapsuleBackend {
  readonly #options: MacOsCapsuleBackendOptions;
  readonly #dependencies: MacOsCapsuleBackendDependencies;
  readonly #artifacts: ArtifactStoreLike;
  readonly #storageBudget: CapsuleStorageBudgetLike;
  readonly #serial = new BoundedSerialQueue(MAX_SERIAL_OPERATIONS);
  readonly #instances = new Map<string, UiRecord>();
  readonly #workloads = new Map<string, UiRecord>();
  readonly #namespaceBases = new Set<number>();
  readonly #launchControllers = new Map<string, Set<AbortController>>();

  #boundaryLostHandler: ((error: unknown) => void) | undefined;
  #uiLostHandler: ((event: CapsuleUiLostEvent) => void) | undefined;
  #bootPromise: Promise<BootBoundary> | undefined;
  #boot: BootBoundary | undefined;
  #bootGeneration = 0;
  #fatalCleanup: Promise<void> | undefined;
  #stopAllPromise: Promise<void> | undefined;
  #terminalFailure: Error | undefined;
  #stoppingAll = false;

  constructor(options: MacOsCapsuleBackendOptions) {
    this.#options = options;
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    this.#storageBudget = this.#dependencies.storageBudget([
      options.stateDirectory,
      join(options.cacheDirectory, "packages"),
      join(options.cacheDirectory, "dependencies"),
      join(options.artifactRoot, "cas"),
    ]);
    this.#artifacts = this.#dependencies.artifactStore(options.artifactRoot, this.#storageBudget);
  }

  setBoundaryLostHandler(handler: (error: unknown) => void): void {
    this.#boundaryLostHandler = handler;
  }

  setUiLostHandler(handler: (event: CapsuleUiLostEvent) => void): void {
    this.#uiLostHandler = handler;
  }

  async status(): Promise<CapsuleBackendStatus> {
    if (this.#terminalFailure) {
      return {
        available: false,
        backend: "apple-virtualization",
        reason: this.#terminalFailure.message,
        restartRequired: this.#terminalFailure instanceof CapsuleRestartRequiredError,
      };
    }
    if (this.#dependencies.hostPlatform !== "darwin") {
      return {
        available: false,
        backend: "apple-virtualization",
        reason: "Apple Virtualization.framework is available only on macOS.",
      };
    }
    if (!this.#dependencies.exists(this.#options.helperPath)) {
      return {
        available: false,
        backend: "apple-virtualization",
        reason: "The signed Lamarck Capsule VM helper is not installed.",
      };
    }
    try {
      await this.#loadRelease();
      if (this.#boot) return { available: true, backend: "apple-virtualization" };
      const helper = this.#dependencies.launchVm({ executablePath: this.#options.helperPath });
      // A probe helper has no Capsule authority, but still needs a close
      // listener before its first request so failure is always observed.
      helper.on("close", () => {});
      try {
        const probe = await helper.probe();
        if (!probe.virtualizationSupported) {
          return {
            available: false,
            backend: "apple-virtualization",
            reason: "Virtualization.framework is unavailable to the signed helper on this device.",
          };
        }
      } finally {
        helper.close();
      }
      return { available: true, backend: "apple-virtualization" };
    } catch (error) {
      return {
        available: false,
        backend: "apple-virtualization",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  startUi(spec: CapsuleUiSpec): Promise<CapsuleUiInstance> {
    return this.#withLaunch(spec.appId, (signal) => this.#serial.run(async () => {
      this.#assertAcceptingWork();
      const ownerKey = hashAppId(spec.appId);
      return await this.#withTransientStorage(ownerKey, async () => {
      if (this.#instances.size >= MAX_LIVE_UI_INSTANCES) {
        throw new Error("Capsule backend reached its live UI isolation limit");
      }
      const release = await this.#loadRelease();
      const snapshot = await this.#dependencies.snapshot({
        packageDir: spec.packageDir,
        cacheDir: join(this.#options.cacheDirectory, "packages", ownerKey),
        ownerKey,
        storageBudget: this.#storageBudget,
      });
      await this.#assertSnapshotManifestAuthority(snapshot, spec);
      throwIfAborted(signal);
      const resolved = await this.#resolveArtifact(release, spec, snapshot, signal);
      const runtimeCapacity = createCapsuleRuntimeStateCapacityPlan({
        artifact: retainedArtifact(resolved.artifact),
        liveRuntimeLeases: this.#liveRuntimeStorageLeases(),
      });
      const boot = await this.#ensureBoot(runtimeCapacity.stateDiskBytes, release);
      const candidate = await this.#launchCandidate(
        boot,
        spec,
        resolved,
        runtimeCapacity.runtimePlan,
        signal,
      );
      let activation: ActivationCheckpoint | undefined;
      try {
        activation = await this.#activateCandidate(candidate, snapshot, boot);
        this.#publishCandidate(candidate);
        return { instanceId: candidate.instanceId };
      } catch (error) {
        const failures: unknown[] = [error];
        if (activation) {
          try {
            await this.#rollbackCandidateActivation(candidate, activation);
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
        }
        try {
          await this.#discardCandidate(candidate, boot);
        } catch (cleanupError) {
          failures.push(cleanupError);
          await this.#loseBoundary(cleanupError, boot);
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "Candidate activation rollback or cleanup failed");
        }
        throw failures[0];
      }
      });
    }));
  }

  replaceUi(instanceId: string, spec: CapsuleUiSpec): Promise<CapsuleUiInstance> {
    return this.#withLaunch(spec.appId, (signal) => this.#serial.run(async () => {
      this.#assertAcceptingWork();
      const ownerKey = hashAppId(spec.appId);
      return await this.#withTransientStorage(ownerKey, async () => {
      const previous = this.#instances.get(instanceId);
      if (!previous) throw new Error("App Capsule UI instance is no longer active");
      if (previous.appId !== spec.appId) throw new Error("Replacement App identity mismatch");
      if (previous.bootGeneration !== this.#boot?.generation) {
        throw new Error("Previous UI belongs to a lost Guest boundary");
      }
      const release = await this.#loadRelease();
      const snapshot = await this.#dependencies.snapshot({
        packageDir: spec.packageDir,
        cacheDir: join(this.#options.cacheDirectory, "packages", ownerKey),
        ownerKey,
        storageBudget: this.#storageBudget,
      });
      await this.#assertSnapshotManifestAuthority(snapshot, spec);
      throwIfAborted(signal);
      const resolved = await this.#resolveArtifact(release, spec, snapshot, signal);
      const runtimeCapacity = createCapsuleRuntimeStateCapacityPlan({
        artifact: retainedArtifact(resolved.artifact),
        liveRuntimeLeases: this.#liveRuntimeStorageLeases(),
      });
      const boot = await this.#ensureBoot(runtimeCapacity.stateDiskBytes, release);
      if (previous.bootGeneration !== boot.generation) {
        throw new Error("Previous UI belongs to a lost Guest boundary");
      }
      const candidate = await this.#launchCandidate(
        boot,
        spec,
        resolved,
        runtimeCapacity.runtimePlan,
        signal,
      );
      let activation: ActivationCheckpoint;
      try {
        // Last-known-good: no mutation of the live instance happens until the
        // replacement has passed Guest-side TCP readiness.
        activation = await this.#activateCandidate(candidate, snapshot, boot);
        candidate.lifecycle = "replacement";
      } catch (error) {
        try {
          await this.#discardCandidate(candidate, boot);
        } catch (cleanupError) {
          await this.#loseBoundary(cleanupError, boot);
          throw new AggregateError(
            [error, cleanupError],
            "Replacement cleanup lost Guest containment",
          );
        }
        throw error;
      }

      try {
        await this.#stopRecord(previous, boot);
      } catch (error) {
        // A failed retirement loses containment certainty. The manager must
        // revoke both generations rather than exposing two App identities.
        let rollbackError: unknown;
        try {
          await this.#rollbackCandidateActivation(candidate, activation);
        } catch (failure) {
          rollbackError = failure;
        }
        await this.#loseBoundary(error, boot);
        if (rollbackError !== undefined) {
          throw new AggregateError(
            [error, rollbackError],
            "Previous UI retirement and activation rollback both failed",
          );
        }
        throw error;
      }
      try {
        if (candidate.terminalError) throw candidate.terminalError;
        this.#instances.delete(previous.instanceId);
        this.#publishCandidate(candidate);
      } catch (error) {
        let rollbackError: unknown;
        try {
          await this.#rollbackCandidateActivation(candidate, activation);
        } catch (failure) {
          rollbackError = failure;
        }
        await this.#loseBoundary(error, boot);
        if (rollbackError !== undefined) {
          throw new AggregateError(
            [error, rollbackError],
            "Replacement publication and activation rollback both failed",
          );
        }
        throw error;
      }
      return { instanceId: candidate.instanceId };
      });
    }));
  }

  openUiStream(instanceId: string): Promise<Duplex> {
    return this.#serial.run(async () => {
      const instance = this.#instances.get(instanceId);
      if (!instance) throw new Error("App Capsule UI instance is no longer active");
      if (instance.viewerStreams.size >= CAPSULE_MAX_VIEWER_CONNECTIONS_PER_INSTANCE) {
        throw new Error("App viewer connection limit reached");
      }
      if (this.#activeViewerStreamCount() >= MAX_VIEWER_STREAMS_GLOBAL) {
        throw new Error("Capsule viewer connection budget is full");
      }
      const boot = await this.#requireCurrentBoot(instance.bootGeneration);
      const ticket = boot.session.issueTicket({
        kind: "viewer",
        appHandle: instance.appHandle,
        subjectHandle: instance.workloadHandle,
        ttlMs: TICKET_TTL_MS,
      });
      const rawResult = await boot.session.request("viewer.attach", {
        appHandle: instance.appHandle,
        workloadHandle: instance.workloadHandle,
        viewerTicket: ticket.ticket,
      }, { revokeTicketsOnFailure: [ticket.ticket] });
      this.#parseGuestResult(boot, parseViewerAttachResult, rawResult);
      const opened = await boot.session.openDataStream(ticket.ticket, "viewer");
      instance.viewerStreams.add(opened.stream);
      const forget = () => instance.viewerStreams.delete(opened.stream);
      opened.stream.once("close", forget);
      opened.stream.once("end", forget);
      return opened.stream;
    });
  }

  stopUi(instanceId: string): Promise<void> {
    const known = this.#instances.get(instanceId);
    if (known) this.#abortLaunches(known.appId, "UI stop requested");
    return this.#serial.run(async () => {
      const instance = this.#instances.get(instanceId);
      if (!instance) return;
      const boot = await this.#requireCurrentBoot(instance.bootGeneration);
      try {
        await this.#stopRecord(instance, boot);
        this.#instances.delete(instanceId);
      } catch (error) {
        await this.#loseBoundary(error, boot);
        throw error;
      }
    });
  }

  stopApp(appId: string): Promise<void> {
    this.#abortLaunches(appId, "App stop requested");
    return this.#serial.run(async () => {
      const records = [...this.#instances.values()].filter((record) => record.appId === appId);
      if (records.length === 0) return;
      const boot = await this.#requireCurrentBoot(records[0]!.bootGeneration);
      for (const record of records) {
        try {
          await this.#stopRecord(record, boot);
          this.#instances.delete(record.instanceId);
        } catch (error) {
          await this.#loseBoundary(error, boot);
          throw error;
        }
      }
    });
  }

  retireApp(appId: string): Promise<void> {
    this.#abortLaunches(appId, "App retirement requested");
    return this.#serial.run(async () => {
      // A boundary-loss path clears the in-memory instance registry before it
      // knows whether VZ actually stopped. Wait for an in-progress cleanup,
      // then refuse Host cache retirement if that stop remained ambiguous.
      // Otherwise an empty registry could be mistaken for authoritative App
      // teardown and destroy the last-known-good activation after quarantine.
      if (this.#fatalCleanup) await this.#fatalCleanup;
      if (this.#terminalFailure) throw this.#terminalFailure;

      const records = [...this.#instances.values()].filter((record) => record.appId === appId);
      if (records.length > 0) {
        const boot = await this.#requireCurrentBoot(records[0]!.bootGeneration);
        for (const record of records) {
          try {
            await this.#stopRecord(record, boot);
            this.#instances.delete(record.instanceId);
          } catch (error) {
            // Host cache retirement is allowed only after Guest aggregate
            // teardown is authoritative. Ambiguity keeps the activation/LKG
            // intact and quarantines the shared boundary.
            await this.#loseBoundary(error, boot);
            throw error;
          }
        }
      }

      const ownerKey = hashAppId(appId);
      // These are the complete App-owned reconstructable Host targets. The
      // physical Workspace and D0/D1/D2 are deliberately unreachable here.
      await this.#artifacts.deactivate(ownerKey);
      await this.#storageBudget.remove(
        join(this.#options.cacheDirectory, "packages", ownerKey),
        { recursive: true },
      );
      await this.#storageBudget.remove(
        join(this.#options.cacheDirectory, "dependencies", ownerKey),
        { recursive: true },
      );
      await this.#artifacts.pruneUnreferenced();
    });
  }

  stopAll(): Promise<void> {
    if (this.#stopAllPromise) return this.#stopAllPromise;
    if (this.#fatalCleanup) return this.#fatalCleanup;
    this.#stoppingAll = true;
    this.#abortAllLaunches("Capsule backend is stopping");
    const operation = this.#serial.run(async () => {
        const boot = this.#boot;
        if (boot) {
          const failures: unknown[] = [];
          for (const record of [...this.#instances.values()]) {
            try {
              await this.#stopRecord(record, boot);
            } catch (error) {
              failures.push(error);
            }
          }
          this.#instances.clear();
          this.#workloads.clear();
          try {
            const result = await boot.session.request("vm.drain", {});
            this.#parseGuestResult(boot, parseVmDrainResult, result);
          } catch (error) {
            failures.push(error);
          }
          try {
            await this.#shutdownBoot(boot);
          } catch (error) {
            failures.push(error);
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, "Capsule Guest shutdown was incomplete");
          }
        } else if (this.#bootPromise) {
          const pending = await this.#bootPromise.catch(() => undefined);
          if (pending) await this.#shutdownBoot(pending);
        }
        this.#instances.clear();
        this.#workloads.clear();
      });
    let tracked!: Promise<void>;
    tracked = operation.finally(() => {
      this.#stoppingAll = false;
      if (this.#stopAllPromise === tracked) this.#stopAllPromise = undefined;
    });
    this.#stopAllPromise = tracked;
    return tracked;
  }

  async #loadRelease(): Promise<LoadedCapsuleGuestRelease> {
    return await this.#dependencies.loadRelease({
      resourcesRoot: this.#options.releaseResourcesRoot,
      stateDirectory: this.#options.stateDirectory,
    });
  }

  async #ensureBoot(
    requiredStateDiskBytes: number,
    release: LoadedCapsuleGuestRelease,
  ): Promise<BootBoundary> {
    const current = this.#boot;
    if (
      current
      && current.stateDiskBytes >= requiredStateDiskBytes
      && sameGuestRelease(current.release, release)
    ) {
      return current;
    }
    if (this.#bootPromise) {
      await this.#bootPromise;
      return await this.#ensureBoot(requiredStateDiskBytes, release);
    }
    if (current) {
      if (this.#instances.size > 0 || this.#workloads.size > 0) {
        throw new Error(
          "Capsule Guest capacity or release change was rejected while a live App runtime exists; the last-known-good runtime remains active",
        );
      }
      try {
        const drained = await current.session.request("vm.drain", {});
        this.#parseGuestResult(current, parseVmDrainResult, drained);
        await this.#shutdownBoot(current);
      } catch (error) {
        await this.#loseBoundary(error, current);
        throw error;
      }
    }

    const promise = this.#createBoot(requiredStateDiskBytes, release);
    this.#bootPromise = promise;
    try {
      const boot = await promise;
      if (this.#bootPromise !== promise) throw new Error("Capsule Guest boot was superseded");
      if (
        boot.intentional
        || boot.generation !== this.#bootGeneration
        || this.#fatalCleanup
      ) {
        throw new Error("Capsule Guest boundary failed during authenticated boot");
      }
      this.#boot = boot;
      return boot;
    } finally {
      if (this.#bootPromise === promise) this.#bootPromise = undefined;
    }
  }

  async #createBoot(
    stateDiskBytes: number,
    release: LoadedCapsuleGuestRelease,
  ): Promise<BootBoundary> {
    const helper = this.#dependencies.launchVm({ executablePath: this.#options.helperPath });
    const generation = ++this.#bootGeneration;
    const earlyData: Duplex[] = [];
    let session: GuestSessionLike | undefined;
    let boundary: BootBoundary | undefined;
    let intentional = false;
    let guestStartAttempted = false;
    let statePreparation: Awaited<ReturnType<VmHostLike["prepareState"]>> | undefined;
    let stateStorage: Awaited<ReturnType<CapsuleStorageBudgetLike["reserveStateDisk"]>> | undefined;
    let stateStorageSettled = false;
    let settleControl!: (value: GuestSessionLike) => void;
    let rejectControl!: (error: Error) => void;
    const control = new Promise<GuestSessionLike>((resolve, reject) => {
      settleControl = resolve;
      rejectControl = reject;
    });
    void control.catch(() => {});

    const provisional = (): BootBoundary | undefined => {
      if (!session) return undefined;
      boundary ??= {
        generation,
        helper,
        session,
        release,
        stateDiskBytes,
        get intentional() { return intentional; },
        set intentional(value: boolean) { intentional = value; },
      };
      return boundary;
    };
    const fail = (error: unknown) => {
      const normalized = asError(error);
      rejectControl(normalized);
      const boot = provisional();
      if (!intentional && boot) this.#loseBoundaryInBackground(normalized, boot);
    };

    // All lifecycle and stream listeners are installed before probe/start, so
    // a fast Guest cannot create an unauthenticated admission race.
    helper.on("stream", (stream) => {
      if (stream.channel === "control") {
        if (session) {
          stream.destroy(new Error("Capsule Guest opened a duplicate CONTROL stream"));
          fail(new Error("Capsule Guest opened a duplicate CONTROL stream"));
          return;
        }
        session = this.#dependencies.createSession(stream, release.handshake);
        session.on("fatal", fail);
        session.on("close", (error) => {
          if (!intentional) fail(error ?? new Error("Capsule Guest CONTROL session closed"));
        });
        session.on("event", (event) => {
          const boot = provisional();
          if (boot) this.#observeWorkloadTerminalEvent(boot, event);
        });
        for (const data of earlyData.splice(0)) session.acceptDataStream(data);
        settleControl(session);
        return;
      }
      if (session) {
        session.acceptDataStream(stream);
      } else if (earlyData.length < MAX_EARLY_DATA_STREAMS) {
        stream.on("error", () => {});
        stream.pause();
        earlyData.push(stream);
      } else {
        stream.destroy(new Error("Capsule Guest exceeded the early DATA stream bound"));
        fail(new Error("Capsule Guest exceeded the early DATA stream bound"));
      }
    });
    helper.on("event", (event) => {
      if (event.type === "vm.failure") fail(new Error(`${event.code}: ${event.message}`));
      if (event.type === "vm.state" && (event.state === "failed" || event.state === "stopped") && !intentional) {
        fail(new Error(`Capsule VM entered unexpected ${event.state} state`));
      }
    });
    helper.on("close", (error) => {
      if (!intentional) fail(error);
    });

    try {
      const probe = await helper.probe();
      if (!probe.virtualizationSupported) {
        throw new Error("Virtualization.framework is unavailable to the signed helper");
      }
      statePreparation = await helper.prepareState({
        stateDirectory: release.vmImage.stateDirectory,
        stateDiskBytes,
      });
      stateStorage = await this.#storageBudget.reserveStateDisk({
        owner: "host",
        path: join(this.#options.stateDirectory, "state.raw"),
        stateDiskBytes: statePreparation.stateDiskBytes,
        existingPhysicalBytes: statePreparation.existingPhysicalBytes,
        additionalPhysicalBytes: statePreparation.additionalPhysicalBytes,
        peakPhysicalBytes: statePreparation.peakPhysicalBytes,
      });
      guestStartAttempted = true;
      const started = await helper.startGuest({
        ...release.vmImage,
        stateDiskBytes,
        statePreparationId: statePreparation.preparationId,
      });
      await stateStorage.commit();
      stateStorageSettled = true;
      if (
        started.imageDigest !== release.handshake.expectedImageDigest
        || normalizeVmArchitecture(started.architecture) !== release.handshake.expectedArchitecture
      ) {
        throw new Error("VM helper start result does not match the verified Guest release");
      }
      session = await withTimeout(control, 60_000, "Capsule Guest did not open CONTROL");
      await session.waitUntilReady();
      const nonce = this.#dependencies.nonce();
      const ping = await session.request("ping", { nonce });
      parsePingResult(ping, nonce);
      return provisional()!;
    } catch (error) {
      const bootFailure = asError(error);
      intentional = true;
      for (const data of earlyData) data.destroy();
      let stopError: unknown;
      if (statePreparation && !guestStartAttempted) {
        try {
          await helper.cancelStatePreparation(statePreparation.preparationId);
        } catch {
          // Closing the helper below is the authoritative fallback for a
          // preparation-only lease: process teardown drops the BSD lock and
          // no VZVirtualMachine has started or retained the state inode.
        }
      }
      if (guestStartAttempted) {
        try {
          await helper.stopGuest();
        } catch (error) {
          stopError = error;
        }
      }
      // Keep CONTROL intact until Virtualization.framework has begun and
      // confirmed teardown. Closing it first makes the Guest treat transport
      // loss as a fault and race a reboot against the Host stop request.
      session?.close();
      helper.close();
      let storageError: unknown;
      if (stateStorage && !stateStorageSettled) {
        try {
          if (guestStartAttempted) await stateStorage.reconcileFailure();
          else await stateStorage.release();
          stateStorageSettled = true;
        } catch (error) {
          storageError = error;
        }
      }
      if (stopError !== undefined || storageError !== undefined) {
        const cleanupFailures = [stopError, storageError]
          .filter((failure): failure is NonNullable<typeof failure> => failure !== undefined);
        const quarantineReason = stopError !== undefined && storageError !== undefined
          ? "VZ stop was not confirmed and state-disk usage could not be reconciled"
          : stopError !== undefined
            ? "VZ stop was not confirmed"
            : "State-disk usage could not be reconciled";
        const quarantined = new CapsuleRestartRequiredError(
          `Capsule boot failed: ${bootFailure.message}. ${quarantineReason}; runtime is quarantined until Host restart`,
          {
            cause: new AggregateError(
              [bootFailure, ...cleanupFailures],
              "Capsule boot and cleanup both failed",
            ),
          },
        );
        this.#terminalFailure = quarantined;
        throw quarantined;
      }
      throw bootFailure;
    }
  }

  async #resolveArtifact(
    release: LoadedCapsuleGuestRelease,
    spec: CapsuleUiSpec,
    snapshot: CapsuleTreeSnapshot,
    signal: AbortSignal,
  ): Promise<ResolvedArtifact> {
    const appKey = hashAppId(spec.appId);
    const active = await this.#artifacts.active(appKey);
    if (
      active
      && active.packageDigest === snapshot.digest
      && active.imageDigest === release.handshake.expectedImageDigest
      && active.installDigest !== undefined
      && active.dependencyDigest !== undefined
    ) {
      return {
        artifact: active.artifact,
        installDigest: active.installDigest,
        dependencyDigest: active.dependencyDigest,
      };
    }

    const installInput = await this.#dependencies.installInput(snapshot);
    throwIfAborted(signal);
    if (
      installInput.warmEligible
      && active?.imageDigest === release.handshake.expectedImageDigest
      && active.installDigest === installInput.digest
      && active.dependencyDigest !== undefined
    ) {
      const input = { mode: "warm" as const, base: active };
      try {
        const capacity = createCapsuleBuildStateCapacityPlan({
          build: buildStorageInput(snapshot, input),
          retainedImportBlobs: buildRetainedBlobs(snapshot, input),
          liveRuntimeLeases: this.#liveRuntimeStorageLeases(),
        });
        const boot = await this.#ensureBoot(capacity.stateDiskBytes, release);
        return await this.#buildArtifact(
          boot,
          spec,
          snapshot,
          installInput.digest,
          input,
          capacity.buildPlan,
          signal,
        );
      } catch (error) {
        if (!isWarmRebuildUnavailable(error)) throw error;
        throwIfAborted(signal);
      }
    }

    const dependencies = await this.#dependencies.dependencies({
      packageSnapshot: snapshot,
      cacheDir: join(this.#options.cacheDirectory, "dependencies", appKey),
      signal,
      ownerKey: appKey,
      storageBudget: this.#storageBudget,
    });
    throwIfAborted(signal);
    const input = { mode: "cold" as const, dependencies };
    const capacity = createCapsuleBuildStateCapacityPlan({
      build: buildStorageInput(snapshot, input),
      retainedImportBlobs: buildRetainedBlobs(snapshot, input),
      liveRuntimeLeases: this.#liveRuntimeStorageLeases(),
    });
    const boot = await this.#ensureBoot(capacity.stateDiskBytes, release);
    return await this.#buildArtifact(
      boot,
      spec,
      snapshot,
      installInput.digest,
      input,
      capacity.buildPlan,
      signal,
    );
  }

  async #assertSnapshotManifestAuthority(
    snapshot: CapsuleTreeSnapshot,
    spec: CapsuleUiSpec,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(spec.manifestGeneration)
      || spec.manifestGeneration < 1
      || !APP_MANIFEST_DIGEST_PATTERN.test(spec.manifestDigest)
    ) {
      throw new Error("Capsule UI manifest authority is invalid");
    }
    const capturedDigest = await this.#dependencies.manifestDigest(snapshot);
    if (capturedDigest !== spec.manifestDigest) {
      throw new CapsuleManifestAuthorityChangedError();
    }
  }

  async #buildArtifact(
    boot: BootBoundary,
    spec: CapsuleUiSpec,
    snapshot: CapsuleTreeSnapshot,
    installDigest: `sha256:${string}`,
    input: ArtifactBuildInput,
    storagePlan: CapsuleBuildStoragePlan,
    signal: AbortSignal,
  ): Promise<ResolvedArtifact> {
    const appKey = hashAppId(spec.appId);
    const appHandle = this.#dependencies.opaqueId();
    const buildHandle = this.#dependencies.opaqueId();
    const namespaceBase = this.#allocateNamespace();
    // v1 has no independently attested cgroup/netns/volume teardown result.
    // Quarantine every Build userns range for this complete VM boot, even
    // after success, so a latent cleanup bug can never overlap a later App or
    // Build identity. A verified VM shutdown clears the allocation set.
    const packageBlobHandle = await this.#importBlob(
      boot,
      appKey,
      "package",
      "capsule-tree-v1",
      snapshot,
      signal,
    );
    const secondary = input.mode === "cold"
      ? {
          kind: "dependency" as const,
          format: "npm-dependency-bundle-v1" as const,
          blob: input.dependencies.snapshot,
        }
      : {
          kind: "artifact" as const,
          format: "erofs-v1" as const,
          blob: input.base.artifact,
        };
    let secondaryBlobHandle: string;
    try {
      secondaryBlobHandle = await this.#importBlob(
        boot,
        appKey,
        secondary.kind,
        secondary.format,
        secondary.blob,
        signal,
      );
    } catch (error) {
      // A fatal CONTROL/DATA failure starts whole-boundary teardown
      // synchronously. Guest-owned references die with that boundary; trying
      // another CONTROL release here can only fail and obscure the operation
      // that actually lost the boundary.
      if (boot.intentional) throw error;
      try {
        const released = await this.#releaseImportedBlob(
          boot,
          appKey,
          packageBlobHandle,
          "package",
          snapshot,
        );
        if (!released) throw new Error("Guest package import reference disappeared before Build prepare");
      } catch (cleanupError) {
        await this.#loseBoundary(cleanupError, boot);
        throw cleanupAggregateError("Partial Build import cleanup failed", error, cleanupError);
      }
      throw error;
    }

    let buildPrepared = false;
    let completedDescriptor: BuildDescriptor | undefined;
    let outputRetired = false;
    let buildStart: Promise<JsonValue> | undefined;
    let cancelBuild: Promise<void> | undefined;
    const requestCancel = () => {
      cancelBuild ??= boot.session.request("build.cancel", {
        appHandle,
        buildHandle,
        graceMs: 2_000,
      }).then((result) => {
        this.#parseGuestResult(boot, parseBuildCancelResult, result);
      });
      return cancelBuild;
    };
    try {
      const prepared = await boot.session.request("build.prepare", {
        ownerKey: appKey,
        appHandle,
        buildHandle,
        packageDigest: snapshot.digest,
        packageBytes: snapshot.bytes,
        packageBlobHandle,
        installDigest,
        ...(input.mode === "cold"
          ? {
              dependencyDigest: input.dependencies.snapshot.digest,
              dependencyBytes: input.dependencies.snapshot.bytes,
              dependencyBlobHandle: secondaryBlobHandle,
            }
          : {
              baseArtifactDigest: input.base.artifact.digest,
              baseArtifactBytes: input.base.artifact.bytes,
              baseArtifactBlobHandle: secondaryBlobHandle,
              baseDependencyDigest: input.base.dependencyDigest!,
            }),
        mappedHostUid: namespaceBase,
        mappedHostGid: namespaceBase,
        storagePlanVersion: storagePlan.version,
        scratchBytes: storagePlan.scratchBytes,
        artifactOutputBytes: storagePlan.artifactOutputBytes,
        timeoutMs: BUILD_TIMEOUT_MS,
        resources: {
          memoryBytes: 2 * 1024 * 1024 * 1024,
          pids: 512,
          cpuQuotaMicros: 200_000,
        },
      });
      this.#parseGuestResult(boot, parseBuildPrepareResult, prepared);
      buildPrepared = true;
      throwIfAborted(signal);

      const expectations: BuildDescriptorExpectation = {
        imageDigest: boot.release.handshake.expectedImageDigest,
        ...boot.release.runtime,
        sourceDigest: snapshot.digest,
        installDigest,
        dependencyDigest: input.mode === "cold"
          ? input.dependencies.snapshot.digest
          : input.base.dependencyDigest,
      };
      const completed = this.#waitForBuild(
        boot,
        appHandle,
        buildHandle,
        expectations,
        signal,
      );
      buildStart = boot.session.request("build.start", { appHandle, buildHandle }, {
        timeoutMs: BUILD_REQUEST_TIMEOUT_MS,
      });
      const cancellation = onAbort(signal, async () => {
        await requestCancel().catch(() => {});
      });
      let rawDescriptor: JsonValue;
      try {
        rawDescriptor = await raceAbort(buildStart, signal);
      } catch (error) {
        completed.cancel(asError(error));
        throw error;
      } finally {
        cancellation();
      }
      const descriptor = this.#parseGuestResult(
        boot,
        (value) => parseBuildDescriptor(value, expectations),
        rawDescriptor,
      );
      // A successful build.start response means the exact Build output ref
      // exists even if subsequent event correlation or Host CAS work fails.
      completedDescriptor = descriptor;
      const eventDescriptor = await completed.promise;
      if (!deepEqual(descriptor, eventDescriptor)) {
        await this.#loseBoundary(new Error("Guest build response/event descriptors disagree"), boot);
        throw new Error("Guest build response/event descriptors disagree");
      }

      const existing = await this.#artifacts.find(descriptor.digest, descriptor.bytes);
      if (existing) {
        const released = await boot.session.request("build.output.release", {
          ownerKey: appKey,
          buildHandle,
          digest: descriptor.digest,
          bytes: descriptor.bytes,
        });
        this.#parseGuestResult(boot, parseBuildOutputReleaseResult, released);
        outputRetired = true;
        return {
          artifact: existing,
          installDigest,
          dependencyDigest: descriptor.dependencyDigest!,
        };
      }
      const artifact = await this.#exportArtifact(
        boot,
        appKey,
        buildHandle,
        descriptor,
        signal,
        () => { outputRetired = true; },
      );
      return {
        artifact,
        installDigest,
        dependencyDigest: descriptor.dependencyDigest!,
      };
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (completedDescriptor && !outputRetired) {
        try {
          const released = await boot.session.request("build.output.release", {
            ownerKey: appKey,
            buildHandle,
            digest: completedDescriptor.digest,
            bytes: completedDescriptor.bytes,
          });
          this.#parseGuestResult(boot, parseBuildOutputReleaseResult, released);
          outputRetired = true;
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (buildPrepared) {
        try {
          await requestCancel();
          if (buildStart) {
            await withTimeout(
              buildStart.then(() => undefined, () => undefined),
              30_000,
              "Cancelled Guest build did not finish resource cleanup",
            );
          }
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      } else {
        try {
          const [packageReleased, secondaryReleased] = await Promise.all([
            this.#releaseImportedBlob(
              boot,
              appKey,
              packageBlobHandle,
              "package",
              snapshot,
            ),
            this.#releaseImportedBlob(
              boot,
              appKey,
              secondaryBlobHandle,
              secondary.kind,
              secondary.blob,
            ),
          ]);
          if (!packageReleased || !secondaryReleased) {
            // The prepare request may have crossed the boundary and adopted
            // both refs before its response failed. Only a confirmed cancel
            // can retire that alternate ownership state.
            if (packageReleased !== secondaryReleased) {
              throw new Error("Guest Build import ownership was only partially retired");
            }
            await requestCancel();
          }
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (cleanupFailures.length > 0) {
        const cleanupError = new AggregateError(
          cleanupFailures,
          "Unsuccessful Build cleanup was not authoritative",
        );
        await this.#loseBoundary(cleanupError, boot);
        throw new AggregateError([error, cleanupError], "Build cleanup did not retire exact Guest resources");
      }
      throw error;
    }
  }

  async #importBlob(
    boot: BootBoundary,
    ownerKey: string,
    blobKind: ImportedBlobKind,
    format: ImportedBlobFormat,
    blob: Pick<CapsuleTreeSnapshot, "digest" | "bytes" | "createReadStream">,
    signal: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const blobHandle = this.#dependencies.opaqueId();
    const kind: StreamKind = blobKind === "package"
      ? "package-in"
      : blobKind === "dependency"
        ? "dependency-in"
        : "artifact-in";
    const ticket = boot.session.issueTicket({
      kind,
      appHandle: blobHandle,
      subjectHandle: blobHandle,
      ttlMs: TICKET_TTL_MS,
    });
    const imported = this.#waitForBlobImport(
      boot,
      blobHandle,
      blob.digest,
      blob.bytes,
      signal,
    );
    try {
      const rawResult = await boot.session.request("blob.import.prepare", {
        ownerKey,
        blobHandle,
        blobKind,
        format,
        digest: blob.digest,
        bytes: blob.bytes,
        streamTicket: ticket.ticket,
      }, { revokeTicketsOnFailure: [ticket.ticket] });
      const result = this.#parseGuestResult(boot, parseBlobImportPrepareResult, rawResult);
      if (result.alreadyPresent) {
        imported.cancel();
        if (!boot.session.revokeTicket(ticket.ticket)) {
          const error = new Error("Guest cache hit consumed a Host import ticket");
          await this.#loseBoundary(error, boot);
          throw error;
        }
        return blobHandle;
      }
      const opened = await boot.session.openDataStream(ticket.ticket, kind);
      const transfer = startBlobTransfer(opened.stream, blob.bytes, signal);
      try {
        await writeIterable(
          opened.stream,
          blob.createReadStream(),
          transfer.signal,
          transfer.progress,
        );
        transfer.complete();
        imported.armTimeout(BLOB_EVENT_CONFIRM_TIMEOUT_MS);
        await imported.promise;
        return blobHandle;
      } catch (error) {
        transfer.cancel(asError(error));
        opened.stream.destroy(asError(error));
        throw error;
      }
    } catch (error) {
      imported.cancel(asError(error));
      boot.session.revokeTicket(ticket.ticket);
      // Boundary teardown is already the authoritative cleanup for all Guest
      // imports. A release request on the failed session would replace the
      // useful transfer/transport failure with a predictable CONTROL error.
      if (boot.intentional) throw error;
      try {
        await this.#releaseImportedBlob(boot, ownerKey, blobHandle, blobKind, blob);
      } catch (cleanupError) {
        await this.#loseBoundary(cleanupError, boot);
        throw cleanupAggregateError("Guest blob import cleanup failed", error, cleanupError);
      }
      throw error;
    }
  }

  async #releaseImportedBlob(
    boot: BootBoundary,
    ownerKey: string,
    blobHandle: string,
    blobKind: ImportedBlobKind,
    blob: Pick<CapsuleTreeSnapshot, "digest" | "bytes">,
  ): Promise<boolean> {
    const raw = await boot.session.request("blob.import.release", {
      ownerKey,
      blobHandle,
      blobKind,
      digest: blob.digest,
      bytes: blob.bytes,
    });
    return this.#parseGuestResult(boot, parseBlobImportReleaseResult, raw).released;
  }

  async #exportArtifact(
    boot: BootBoundary,
    ownerKey: string,
    buildHandle: string,
    descriptor: BuildDescriptor,
    signal: AbortSignal,
    onOutputHandoff: () => void,
  ): Promise<HostArtifact> {
    throwIfAborted(signal);
    const blobHandle = this.#dependencies.opaqueId();
    const ticket = boot.session.issueTicket({
      kind: "artifact-out",
      appHandle: blobHandle,
      subjectHandle: blobHandle,
      ttlMs: TICKET_TTL_MS,
    });
    const exported = this.#waitForBlobExport(
      boot,
      blobHandle,
      descriptor.digest,
      descriptor.bytes,
      signal,
    );
    try {
      const result = await boot.session.request("blob.export.prepare", {
        ownerKey,
        buildHandle,
        blobHandle,
        digest: descriptor.digest,
        bytes: descriptor.bytes,
        streamTicket: ticket.ticket,
      }, { revokeTicketsOnFailure: [ticket.ticket] });
      this.#parseGuestResult(boot, parseBlobExportPrepareResult, result);
      // The Guest atomically replaced the Build output ref with an export ref
      // before acknowledging this operation. From here the export lifecycle,
      // rather than the Build lifecycle, owns exact cleanup.
      onOutputHandoff();
      const opened = await boot.session.openDataStream(ticket.ticket, "artifact-out");
      const transfer = startBlobTransfer(opened.stream, descriptor.bytes, signal);
      let observedArtifactBytes = 0;
      try {
        const artifact = await this.#artifacts.receive(
          ownerKey,
          descriptor.digest,
          descriptor.bytes,
          abortableIterable(
            opened.stream,
            transfer.signal,
            (bytes) => {
              transfer.progress(bytes);
              observedArtifactBytes += bytes;
              if (observedArtifactBytes === descriptor.bytes) transfer.setPhase("guest-fin");
            },
            () => transfer.setPhase("host-cas"),
          ),
        );
        // A clean Guest FIN is part of the authenticated export result. Only
        // after the Host has observed that FIN, verified the exact length and
        // digest, and durably committed the CAS entry may it acknowledge
        // adoption. The receipt is bound to this one-use stream, and the
        // following explicit FIN proves the complete receipt was delivered.
        // Reaching the advertised byte count alone is never completion.
        const adoptionReceipt = parseArtifactAdoptionReceipt({
          type: "artifact.adopted",
          protocolVersion: CAPSULE_PROTOCOL_VERSION,
          sessionId: opened.prelude.sessionId,
          ticket: opened.prelude.ticket,
          digest: descriptor.digest,
          bytes: descriptor.bytes,
        });
        transfer.setPhase("host-receipt");
        await raceAbort(
          writeChunk(
            opened.stream,
            encodeJsonFrame(adoptionReceipt, MAX_ARTIFACT_ADOPTION_RECEIPT_BYTES),
          ),
          transfer.signal,
        );
        transfer.setPhase("host-fin");
        await raceAbort(endWritable(opened.stream), transfer.signal);
        // Keep the idle and size-derived absolute deadlines alive through the
        // Guest's authenticated blob.exported confirmation. A saturated
        // helper writer or a FIN which never crosses LVRM must fail under the
        // same transfer budget rather than being reclassified as a detached
        // event wait.
        exported.armTimeout(BLOB_EVENT_CONFIRM_TIMEOUT_MS);
        await exported.promise;
        transfer.complete();
        return artifact;
      } catch (error) {
        transfer.cancel(asError(error));
        throw error;
      }
    } catch (error) {
      exported.cancel(asError(error));
      boot.session.revokeTicket(ticket.ticket);
      throw error;
    }
  }

  async #launchCandidate(
    boot: BootBoundary,
    spec: CapsuleUiSpec,
    resolved: ResolvedArtifact,
    storagePlan: CapsuleRuntimeStoragePlan,
    signal: AbortSignal,
  ): Promise<Candidate> {
    const { artifact } = resolved;
    throwIfAborted(signal);
    const ownerKey = hashAppId(spec.appId);
    const appHandle = this.#dependencies.opaqueId();
    const workloadHandle = this.#dependencies.opaqueId();
    const instanceId = this.#dependencies.opaqueId();
    const namespaceBase = this.#allocateNamespace();
    let detachSystemStream: (() => void) | undefined;
    const candidate: Candidate = {
      instanceId,
      appId: spec.appId,
      appHandle,
      workloadHandle,
      userNamespaceBase: namespaceBase,
      artifact,
      ...(resolved.installDigest === undefined
        ? {}
        : {
            installDigest: resolved.installDigest,
            dependencyDigest: resolved.dependencyDigest,
          }),
      spec: Object.freeze({ ...spec, command: Object.freeze([...spec.command]) as unknown as string[] }),
      bootGeneration: boot.generation,
      detachSystemStream: () => detachSystemStream?.(),
      viewerStreams: new Set(),
      lifecycle: "launching",
      activated: false,
    };
    let artifactBlobHandle: string;
    try {
      artifactBlobHandle = await this.#importBlob(
        boot,
        ownerKey,
        "artifact",
        "erofs-v1",
        artifact,
        signal,
      );
    } catch (error) {
      // No Guest resource has observed this userns range yet. Unlike a Build
      // range, it is safe to reuse after the exact import cleanup completes.
      this.#releaseNamespace(namespaceBase);
      throw error;
    }
    this.#workloads.set(workloadHandle, candidate);
    let appPrepared = false;
    try {
      const appResult = await boot.session.request("app.prepare", {
        ownerKey,
        appHandle,
        artifactDigest: artifact.digest,
        artifactBytes: artifact.bytes,
        artifactBlobHandle,
        mappedHostUid: namespaceBase,
        mappedHostGid: namespaceBase,
        storagePlanVersion: storagePlan.version,
        scratchBytes: storagePlan.scratchBytes,
      });
      this.#parseGuestResult(boot, parseAppPrepareResult, appResult);
      appPrepared = true;

      const sdkTicket = boot.session.issueTicket({
        kind: "sdk",
        appHandle,
        subjectHandle: workloadHandle,
        ttlMs: TICKET_TTL_MS,
      });
      const workloadPrepareBody: RequestBodyFor<"workload.prepare"> = {
        appHandle,
        workloadHandle,
        workloadKind: "ui",
        argv: [...spec.command],
        cwd: "/app",
        environment: {},
        sdkTicket: sdkTicket.ticket,
        uiPort: spec.port,
      };
      const workloadResult = await boot.session.request(
        "workload.prepare",
        workloadPrepareBody,
        { revokeTicketsOnFailure: [sdkTicket.ticket] },
      );
      const initialPrepare = this.#parseGuestResult(
        boot,
        parseWorkloadPrepareResult,
        workloadResult,
      );
      if (!initialPrepare.awaitingStreams || initialPrepare.reused) {
        const error = new Error("Guest unexpectedly reused a new workload handle");
        await this.#loseBoundary(error, boot);
        throw error;
      }
      const sdk = await boot.session.openDataStream(sdkTicket.ticket, "sdk");
      let sdkClosed: Error | undefined;
      const sdkClosure = new Promise<never>((_resolve, reject) => {
        detachSystemStream = this.#options.systemStreamServer.attach(
          spec.sdkSenderId,
          sdk.stream,
          { onClose: (error) => {
            sdkClosed = error ?? new Error("System SDK stream closed before UI readiness");
            reject(sdkClosed);
          } },
        );
      });
      void sdkClosure.catch(() => {});

      // A Host transport write is not proof that the Guest supervisor has
      // consumed the prelude and attached the authenticated SDK DATA stream
      // to the workload record. The idempotent prepare operation is the
      // authenticated cross-plane barrier: only the Guest can change
      // awaitingStreams to false after workload.sdk-attached.
      await this.#waitForWorkloadStreamsAttached(
        boot,
        workloadPrepareBody,
        signal,
      );

      const ready = this.#waitForWorkloadReady(
        boot,
        appHandle,
        workloadHandle,
        spec.port,
        signal,
      );
      try {
        const started = await boot.session.request("workload.start", { appHandle, workloadHandle });
        this.#parseGuestResult(boot, parseWorkloadStartResult, started);
        await Promise.race([ready.promise, sdkClosure]);
      } catch (error) {
        ready.cancel(asError(error));
        throw error;
      }
      if (sdkClosed) throw sdkClosed;
      throwIfAborted(signal);
      return candidate;
    } catch (error) {
      detachSystemStream?.();
      candidate.lifecycle = "stopping";
      if (!appPrepared) {
        let releasedBeforePrepare = false;
        try {
          releasedBeforePrepare = await this.#releaseImportedBlob(
            boot,
            ownerKey,
            artifactBlobHandle,
            "artifact",
            artifact,
          );
        } catch (cleanupError) {
          await this.#loseBoundary(cleanupError, boot);
          throw new AggregateError(
            [error, cleanupError],
            "Candidate App import cleanup was not authoritative",
          );
        }
        if (releasedBeforePrepare) {
          this.#releaseNamespace(namespaceBase);
          this.#workloads.delete(workloadHandle);
          throw error;
        }
        // A false result may mean app.prepare adopted the ref before its
        // response failed. Fall through to authoritative aggregate teardown.
      }
      try {
        const stopped = await boot.session.request("app.stop", { appHandle });
        this.#parseGuestResult(boot, parseAppStopResult, stopped);
        this.#releaseNamespace(namespaceBase);
        this.#workloads.delete(workloadHandle);
      } catch (cleanupError) {
        await this.#loseBoundary(cleanupError, boot);
        throw new AggregateError(
          [error, cleanupError],
          "Candidate App cleanup did not confirm Guest cgroup teardown",
        );
      }
      throw error;
    }
  }

  async #activateCandidate(
    candidate: Candidate,
    snapshot: CapsuleTreeSnapshot,
    boot: BootBoundary,
  ): Promise<ActivationCheckpoint> {
    if (candidate.terminalError) throw candidate.terminalError;
    await this.#assertBoot(boot);
    const checkpoint: ActivationCheckpoint = {
      appKey: hashAppId(candidate.appId),
      previous: await this.#artifacts.active(hashAppId(candidate.appId)),
    };
    try {
      await this.#artifacts.activate(checkpoint.appKey, candidate.artifact, {
        packageDigest: snapshot.digest,
        imageDigest: boot.release.handshake.expectedImageDigest,
        ...(candidate.installDigest === undefined
          ? {}
          : {
              installDigest: candidate.installDigest,
              dependencyDigest: candidate.dependencyDigest,
            }),
      });
      candidate.activated = true;
      if (candidate.terminalError) throw candidate.terminalError;
      await this.#assertBoot(boot);
      return checkpoint;
    } catch (error) {
      try {
        await this.#restoreActivation(checkpoint);
        candidate.activated = false;
      } catch (rollbackError) {
        this.#terminalFailure ??= new CapsuleRestartRequiredError(
          "Host artifact activation could not be rolled back; runtime is quarantined",
          { cause: rollbackError },
        );
        throw new AggregateError(
          [error, rollbackError],
          "Candidate activation and rollback both failed",
        );
      }
      throw error;
    }
  }

  async #rollbackCandidateActivation(
    candidate: Candidate,
    checkpoint: ActivationCheckpoint,
  ): Promise<void> {
    if (!candidate.activated) return;
    try {
      await this.#restoreActivation(checkpoint);
      candidate.activated = false;
    } catch (error) {
      this.#terminalFailure ??= new CapsuleRestartRequiredError(
        "Host artifact activation rollback failed; runtime is quarantined",
        { cause: error },
      );
      throw error;
    }
  }

  async #restoreActivation(checkpoint: ActivationCheckpoint): Promise<void> {
    if (checkpoint.previous) {
      await this.#artifacts.activate(checkpoint.appKey, checkpoint.previous.artifact, {
        packageDigest: checkpoint.previous.packageDigest,
        imageDigest: checkpoint.previous.imageDigest,
        ...(checkpoint.previous.installDigest === undefined
          ? {}
          : {
              installDigest: checkpoint.previous.installDigest,
              dependencyDigest: checkpoint.previous.dependencyDigest,
            }),
      });
      return;
    }
    await this.#artifacts.deactivate(checkpoint.appKey);
  }

  async #discardCandidate(candidate: Candidate, boot: BootBoundary): Promise<void> {
    candidate.lifecycle = "stopping";
    candidate.detachSystemStream();
    const result = await boot.session.request("app.stop", { appHandle: candidate.appHandle });
    this.#parseGuestResult(boot, parseAppStopResult, result);
    this.#releaseNamespace(candidate.userNamespaceBase);
    this.#workloads.delete(candidate.workloadHandle);
  }

  async #stopRecord(record: UiRecord, boot: BootBoundary): Promise<void> {
    record.lifecycle = "stopping";
    const failures: unknown[] = [];
    for (const stream of record.viewerStreams) stream.destroy();
    record.viewerStreams.clear();
    try {
      const result = await boot.session.request("workload.stop", {
        appHandle: record.appHandle,
        workloadHandle: record.workloadHandle,
        graceMs: 2_000,
      });
      this.#parseGuestResult(boot, parseWorkloadStopResult, result);
    } catch (error) {
      failures.push(error);
    }
    try {
      const result = await boot.session.request("app.stop", { appHandle: record.appHandle });
      this.#parseGuestResult(boot, parseAppStopResult, result);
    } catch (error) {
      failures.push(error);
    }
    record.detachSystemStream();
    if (failures.length > 0) {
      throw new AggregateError(failures, `Could not stop UI ${record.instanceId}`);
    }
    this.#releaseNamespace(record.userNamespaceBase);
    this.#workloads.delete(record.workloadHandle);
  }

  #publishCandidate(candidate: Candidate): void {
    if (candidate.terminalError) throw candidate.terminalError;
    if (this.#workloads.get(candidate.workloadHandle) !== candidate) {
      throw new Error("Candidate workload ownership changed before publication");
    }
    candidate.lifecycle = "active";
    this.#instances.set(candidate.instanceId, candidate);
  }

  #observeWorkloadTerminalEvent(boot: BootBoundary, event: GuestEvent): void {
    if (event.type !== "workload.exited" && event.type !== "workload.faulted") return;
    const claimed = claimedWorkloadIdentity(event);
    if (!claimed) {
      this.#loseBoundaryInBackground(
        new Error("Guest emitted an unauthenticated workload terminal event"),
        boot,
      );
      return;
    }
    const record = this.#workloads.get(claimed.workloadHandle);
    if (!record) return;

    let terminalError: Error;
    try {
      if (event.type === "workload.faulted") {
        const fault = correlateWorkloadFaultedEvent(event, record);
        terminalError = new GuestOperationError(`Guest UI workload faulted: ${fault.message}`);
      } else {
        const exit = correlateWorkloadExitedEvent(event, record);
        terminalError = new GuestOperationError(
          `Guest UI workload exited (${exit.exitCode ?? exit.signal ?? "unknown"})`,
        );
      }
    } catch (error) {
      this.#loseBoundaryInBackground(asError(error), boot);
      return;
    }

    if (record.bootGeneration !== boot.generation) {
      this.#loseBoundaryInBackground(new Error("Guest terminal event crossed VM generations"), boot);
      return;
    }
    if (record.lifecycle === "stopping" || record.lifecycle === "lost") return;
    record.terminalError = terminalError;
    if (record.lifecycle === "launching") return;
    if (record.lifecycle === "replacement") {
      this.#loseBoundaryInBackground(terminalError, boot);
      return;
    }

    record.lifecycle = "lost";
    this.#instances.delete(record.instanceId);
    let notificationError: unknown;
    try {
      // Manager/Main synchronously detach renderer and both SystemBroker
      // senders before this method closes Guest-facing transports.
      this.#uiLostHandler?.({
        instanceId: record.instanceId,
        appId: record.appId,
        error: terminalError,
      });
    } catch (error) {
      notificationError = error;
    }
    for (const stream of record.viewerStreams) stream.destroy();
    record.viewerStreams.clear();
    record.detachSystemStream();

    if (notificationError !== undefined) {
      this.#loseBoundaryInBackground(notificationError, boot);
      return;
    }
    void this.#serial.run(async () => {
      try {
        const result = await boot.session.request("app.stop", { appHandle: record.appHandle });
        this.#parseGuestResult(boot, parseAppStopResult, result);
        this.#releaseNamespace(record.userNamespaceBase);
        this.#workloads.delete(record.workloadHandle);
      } catch (error) {
        await this.#loseBoundary(error, boot);
      }
    }).catch((error) => this.#loseBoundaryInBackground(error, boot));
  }

  #waitForBlobImport(
    boot: BootBoundary,
    blobHandle: string,
    digest: string,
    bytes: number,
    signal: AbortSignal,
  ): EventWaiter<void> {
    return this.#eventWaiter(boot, undefined, signal, (event) => {
      if (event.type === "blob.imported") {
        correlateBlobImportedEvent(event, { blobHandle, digest, bytes });
        return { done: true, value: undefined };
      }
      if (event.type === "blob.failed") {
        const failed = correlateBlobFailedEvent(event, { blobHandle, digest, bytes });
        throw new GuestOperationError(`Guest blob import failed: ${failed.message}`);
      }
      return undefined;
    });
  }

  #waitForBlobExport(
    boot: BootBoundary,
    blobHandle: string,
    digest: string,
    bytes: number,
    signal: AbortSignal,
  ): EventWaiter<void> {
    return this.#eventWaiter(boot, undefined, signal, (event) => {
      if (event.type === "blob.exported") {
        correlateBlobExportedEvent(event, { blobHandle, digest, bytes });
        return { done: true, value: undefined };
      }
      if (event.type === "blob.failed") {
        const failed = correlateBlobFailedEvent(event, { blobHandle, digest, bytes });
        throw new GuestOperationError(`Guest blob export failed: ${failed.message}`);
      }
      return undefined;
    });
  }

  #waitForBuild(
    boot: BootBoundary,
    appHandle: string,
    buildHandle: string,
    expected: BuildDescriptorExpectation,
    signal: AbortSignal,
  ): EventWaiter<BuildDescriptor> {
    return this.#eventWaiter(boot, BUILD_REQUEST_TIMEOUT_MS, signal, (event) => {
      if (event.type === "build.progress") {
        correlateBuildProgressEvent(event, { appHandle, buildHandle });
        return undefined;
      }
      if (event.type === "build.completed") {
        const descriptor = correlateBuildCompletedEvent(event, expected);
        return { done: true, value: descriptor };
      }
      if (event.type === "build.failed") {
        const failed = correlateBuildFailedEvent(event, { appHandle, buildHandle });
        throw new GuestOperationError(`Guest build failed: ${failed.message}`);
      }
      return undefined;
    });
  }

  #waitForWorkloadReady(
    boot: BootBoundary,
    appHandle: string,
    workloadHandle: string,
    port: number,
    signal: AbortSignal,
  ): EventWaiter<void> {
    let started = false;
    return this.#eventWaiter(boot, UI_READY_TIMEOUT_MS, signal, (event) => {
      if (event.type === "workload.started") {
        const actual = claimedWorkloadIdentity(event);
        if (actual && !sameWorkload(actual, { appHandle, workloadHandle })) {
          correlateWorkloadStartedEvent(event, actual);
          return undefined;
        }
        correlateWorkloadStartedEvent(event, { appHandle, workloadHandle });
        started = true;
        return undefined;
      }
      if (event.type === "workload.ready") {
        const actual = claimedWorkloadIdentity(event);
        if (actual && !sameWorkload(actual, { appHandle, workloadHandle })) {
          correlateWorkloadReadyEvent(event, {
            ...actual,
            port: claimedViewerPort(event),
          });
          return undefined;
        }
        correlateWorkloadReadyEvent(event, { appHandle, workloadHandle, port });
        if (!started) throw new Error("Guest reported workload.ready before workload.started");
        return { done: true, value: undefined };
      }
      if (event.type === "workload.faulted") {
        const actual = claimedWorkloadIdentity(event);
        if (actual && !sameWorkload(actual, { appHandle, workloadHandle })) {
          correlateWorkloadFaultedEvent(event, actual);
          return undefined;
        }
        const faulted = correlateWorkloadFaultedEvent(event, { appHandle, workloadHandle });
        throw new GuestOperationError(`Guest UI workload faulted: ${faulted.message}`);
      }
      if (event.type === "workload.exited") {
        const actual = claimedWorkloadIdentity(event);
        if (actual && !sameWorkload(actual, { appHandle, workloadHandle })) {
          correlateWorkloadExitedEvent(event, actual);
          return undefined;
        }
        correlateWorkloadExitedEvent(event, { appHandle, workloadHandle });
        throw new GuestOperationError("Guest UI workload exited before viewer readiness");
      }
      return undefined;
    });
  }

  async #waitForWorkloadStreamsAttached(
    boot: BootBoundary,
    body: RequestBodyFor<"workload.prepare">,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + WORKLOAD_STREAM_ATTACH_TIMEOUT_MS;
    for (;;) {
      throwIfAborted(signal);
      const raw = await boot.session.request("workload.prepare", body);
      const result = this.#parseGuestResult(boot, parseWorkloadPrepareResult, raw);
      if (!result.awaitingStreams && result.reused === true) return;
      if (Date.now() >= deadline) {
        throw new Error("Guest did not confirm the authenticated SDK stream attachment");
      }
      await abortableDelay(10, signal);
    }
  }

  #eventWaiter<T>(
    boot: BootBoundary,
    timeoutMs: number | undefined,
    signal: AbortSignal,
    correlate: (event: GuestEvent) => { done: true; value: T } | undefined,
  ): EventWaiter<T> {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (error: Error) => void;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbortSignal);
      boot.session.off("event", onEvent);
      boot.session.off("fatal", onFatal);
      boot.session.off("close", onClose);
    };
    const reject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const onEvent = (event: GuestEvent) => {
      if (settled) return;
      try {
        const result = correlate(event);
        if (!result?.done) return;
        settled = true;
        cleanup();
        resolvePromise(result.value);
      } catch (error) {
        const normalized = asError(error);
        reject(normalized);
        if (!(normalized instanceof GuestOperationError)) {
          this.#loseBoundaryInBackground(normalized, boot);
        }
      }
    };
    const onFatal = (error: Error) => reject(error);
    const onClose = (error?: Error) => reject(error ?? new Error("Guest session closed"));
    const onAbortSignal = () => reject(abortError(signal));
    const armTimeout = (durationMs: number) => {
      if (settled) return;
      if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
        reject(new Error("Guest event timeout must be a positive integer"));
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const error = new Error("Timed out waiting for authenticated Guest event");
        reject(error);
        this.#loseBoundaryInBackground(error, boot);
      }, durationMs);
    };
    const promise = new Promise<T>((resolve, rejectValue) => {
      resolvePromise = resolve;
      rejectPromise = rejectValue;
    });
    void promise.catch(() => {});
    boot.session.on("event", onEvent);
    boot.session.on("fatal", onFatal);
    boot.session.on("close", onClose);
    signal.addEventListener("abort", onAbortSignal, { once: true });
    if (signal.aborted) onAbortSignal();
    if (timeoutMs !== undefined) armTimeout(timeoutMs);
    return {
      promise,
      armTimeout,
      cancel: (error = new Error("Guest event waiter cancelled")) => reject(error),
    };
  }

  async #requireCurrentBoot(generation: number): Promise<BootBoundary> {
    const boot = this.#boot;
    if (!boot || boot.intentional) throw new Error("Guest boundary is no longer current");
    if (boot.generation !== generation) throw new Error("Guest boundary changed");
    return boot;
  }

  #parseGuestResult<T>(
    boot: BootBoundary,
    parser: (value: unknown) => T,
    value: unknown,
  ): T {
    try {
      return parser(value);
    } catch (error) {
      if (error instanceof CapsuleGuestResultError) this.#loseBoundaryInBackground(error, boot);
      throw error;
    }
  }

  async #assertBoot(boot: BootBoundary): Promise<void> {
    if (this.#boot !== boot || boot.intentional) throw new Error("Guest boundary is no longer current");
  }

  async #shutdownBoot(boot: BootBoundary): Promise<void> {
    boot.intentional = true;
    if (this.#boot === boot) this.#boot = undefined;
    try {
      await boot.helper.stopGuest();
      // Only the helper's confirmed VZ stop response authorizes reuse of
      // quarantined userns ranges. A failed stop keeps them reserved even if a
      // later boot succeeds, preventing overlap with an unconfirmed old VM.
      this.#namespaceBases.clear();
    } catch (error) {
      const terminalFailure = new CapsuleRestartRequiredError(
        "Capsule VM stop was not confirmed; runtime is quarantined until Host restart",
        { cause: error },
      );
      this.#terminalFailure ??= terminalFailure;
      throw this.#terminalFailure;
    } finally {
      // CONTROL loss is a Guest fault signal. Close it only after the helper
      // has confirmed the VM stop (or after that confirmation has failed and
      // the Host has quarantined this runtime).
      boot.session.close();
      // CapsuleVmHostClient.close synchronously kills the helper transport;
      // stopGuest failure is still surfaced to the caller above.
      boot.helper.close();
    }
  }

  #loseBoundaryInBackground(error: unknown, expected?: BootBoundary): void {
    // Renderer/System authority has already been revoked synchronously. A
    // typed quarantine rejection is intentionally observed only by the
    // foreground operation that triggered it; event callbacks leave the same
    // state visible through status() without creating an unhandled rejection.
    void this.#loseBoundary(error, expected).catch(() => {});
  }

  async #loseBoundary(error: unknown, expected?: BootBoundary): Promise<void> {
    if (expected && this.#boot && this.#boot !== expected) return;
    if (this.#fatalCleanup) {
      await this.#fatalCleanup;
      if (this.#terminalFailure) throw this.#terminalFailure;
      return;
    }
    const failure = asError(error);
    this.#abortAllLaunches(failure.message);
    const boot = expected ?? this.#boot;
    if (boot) boot.intentional = true;
    for (const instance of this.#instances.values()) {
      instance.detachSystemStream();
      for (const stream of instance.viewerStreams) stream.destroy();
      instance.viewerStreams.clear();
    }
    this.#instances.clear();
    this.#workloads.clear();

    // Publish the in-progress cleanup promise before notifying the manager, so
    // its fail-closed stopAll cannot start a second teardown. Host renderer and
    // SystemBroker authority is revoked synchronously; a slow or wedged VZ
    // stop must never extend an App capability's lifetime.
    let settleCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { settleCleanup = resolve; });
    this.#fatalCleanup = cleanup;
    try {
      this.#boundaryLostHandler?.(failure);
    } catch {}

    void (async () => {
      let shutdownError: unknown;
      if (boot) {
        try {
          await this.#shutdownBoot(boot);
        } catch (error) {
          shutdownError = error;
        }
      }
      this.#bootPromise = undefined;
      if (shutdownError !== undefined) {
        console.error("[capsule-vm] Capsule boundary cleanup could not confirm VM stop", shutdownError);
      }
    })().then(
      settleCleanup,
      (unexpected) => {
        this.#terminalFailure ??= new CapsuleRestartRequiredError(
          "Capsule boundary cleanup failed unexpectedly; runtime is quarantined until Host restart",
          { cause: unexpected },
        );
        settleCleanup();
      },
    );
    try {
      await cleanup;
    } finally {
      if (this.#fatalCleanup === cleanup) this.#fatalCleanup = undefined;
    }
    if (this.#terminalFailure) throw this.#terminalFailure;
  }

  #allocateNamespace(): number {
    for (
      let base = FIRST_USER_NAMESPACE_BASE;
      base <= LAST_USER_NAMESPACE_BASE;
      base += USER_NAMESPACE_RANGE
    ) {
      if (this.#namespaceBases.has(base)) continue;
      this.#namespaceBases.add(base);
      return base;
    }
    throw new Error("Capsule Guest exhausted isolated user namespace ranges");
  }

  #activeViewerStreamCount(): number {
    let streams = 0;
    for (const instance of this.#instances.values()) streams += instance.viewerStreams.size;
    return streams;
  }

  #liveRuntimeStorageLeases(): CapsuleLiveRuntimeStorageLease[] {
    return [...new Set(this.#workloads.values())].map((record) => ({
      artifact: retainedArtifact(record.artifact),
      scratchBytes: createCapsuleRuntimeStoragePlan(record.artifact.bytes).scratchBytes,
    }));
  }

  #releaseNamespace(base: number): void {
    this.#namespaceBases.delete(base);
  }

  async #withTransientStorage<T>(ownerKey: string, operation: () => Promise<T>): Promise<T> {
    if (!this.#boot && !this.#bootPromise) {
      await this.#reconcileStateDiskResidueBeforeStorageAdmission();
    }
    const packageCache = join(this.#options.cacheDirectory, "packages", ownerKey);
    const dependencyCache = join(this.#options.cacheDirectory, "dependencies", ownerKey);
    const reclaim = async () => {
      await this.#storageBudget.remove(packageCache, { recursive: true });
      await this.#storageBudget.remove(dependencyCache, { recursive: true });
      await this.#artifacts.pruneUnreferenced();
    };
    await reclaim();
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await operation();
    } catch (error) {
      failure = error;
    }
    try {
      await reclaim();
    } catch (cleanupError) {
      if (failure !== undefined) {
        throw new AggregateError([failure, cleanupError], "Capsule operation and storage GC failed");
      }
      throw cleanupError;
    }
    if (failure !== undefined) throw failure;
    return result!;
  }

  async #reconcileStateDiskResidueBeforeStorageAdmission(): Promise<void> {
    const release = await this.#loadRelease();
    const helper = this.#dependencies.launchVm({ executablePath: this.#options.helperPath });
    helper.on("close", () => {});
    try {
      const probe = await helper.probe();
      if (!probe.virtualizationSupported) {
        throw new Error("Virtualization.framework is unavailable to the signed helper");
      }
      const prepared = await helper.prepareState({
        stateDirectory: release.vmImage.stateDirectory,
        stateDiskBytes: CAPSULE_STATE_CAPACITY_MIN_BYTES,
      });
      try {
        await this.#storageBudget.reconcileStateDisk({
          owner: "host",
          path: join(this.#options.stateDirectory, "state.raw"),
          existingPhysicalBytes: prepared.existingPhysicalBytes,
        });
      } finally {
        await helper.cancelStatePreparation(prepared.preparationId);
      }
    } finally {
      helper.close();
    }
  }

  #withLaunch<T>(appId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let controllers = this.#launchControllers.get(appId);
    if (!controllers) {
      controllers = new Set();
      this.#launchControllers.set(appId, controllers);
    }
    controllers.add(controller);
    return operation(controller.signal).finally(() => {
      controllers!.delete(controller);
      if (controllers!.size === 0) this.#launchControllers.delete(appId);
    });
  }

  #abortLaunches(appId: string, reason: string): void {
    for (const controller of this.#launchControllers.get(appId) ?? []) {
      controller.abort(new Error(reason));
    }
  }

  #abortAllLaunches(reason: string): void {
    for (const appId of this.#launchControllers.keys()) this.#abortLaunches(appId, reason);
  }

  #assertAcceptingWork(): void {
    if (this.#terminalFailure) throw this.#terminalFailure;
    if (this.#stoppingAll) throw new Error("Capsule backend is stopping");
    if (this.#fatalCleanup) throw new Error("Capsule boundary recovery is still in progress");
  }
}

class BoundedSerialQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(private readonly limit: number) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#pending >= this.limit) {
      return Promise.reject(new Error("Capsule backend operation queue is full"));
    }
    this.#pending += 1;
    const start = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    return start.then(operation).finally(() => {
      this.#pending -= 1;
      release();
    });
  }
}

interface ActiveBlobTransfer {
  readonly signal: AbortSignal;
  readonly progress: (bytes: number) => void;
  setPhase(phase: BlobTransferPhase): void;
  complete(): void;
  cancel(error: Error): void;
}

type BlobTransferPhase =
  | "data"
  | "guest-fin"
  | "host-cas"
  | "host-receipt"
  | "host-fin";

export function startBlobTransfer(
  stream: Duplex,
  expectedBytes: number,
  parentSignal: AbortSignal,
  policy: BlobTransferPolicy = DEFAULT_BLOB_TRANSFER_POLICY,
): ActiveBlobTransfer {
  const controller = new AbortController();
  let observedBytes = 0;
  let phase: BlobTransferPhase = "data";
  let settled = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(absoluteTimer);
    parentSignal.removeEventListener("abort", onParentAbort);
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    clear();
    controller.abort(error);
    stream.destroy(error);
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      fail(new Error(
        "Host blob DATA stream made no byte progress before its idle deadline "
        + `(${observedBytes}/${expectedBytes} bytes observed; phase=${phase})`,
      ));
    }, policy.idleTimeoutMs);
  };
  const onParentAbort = () => fail(abortError(parentSignal));
  const absoluteTimer = setTimeout(() => {
    fail(new Error("Host blob DATA stream exceeded its size-derived absolute deadline"));
  }, blobTransferAbsoluteDeadlineMs(expectedBytes, policy));
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  armIdle();
  if (parentSignal.aborted) onParentAbort();

  return {
    signal: controller.signal,
    progress: (bytes) => {
      if (settled) throw abortError(controller.signal);
      if (!Number.isSafeInteger(bytes) || bytes < 1) {
        const error = new Error("Blob transfer reported an invalid byte count");
        fail(error);
        throw error;
      }
      observedBytes += bytes;
      if (!Number.isSafeInteger(observedBytes) || observedBytes > expectedBytes) {
        const error = new Error("Blob DATA stream exceeded its advertised byte count");
        fail(error);
        throw error;
      }
      armIdle();
    },
    setPhase: (nextPhase) => {
      if (settled) throw abortError(controller.signal);
      phase = nextPhase;
    },
    complete: () => {
      if (settled) throw abortError(controller.signal);
      if (observedBytes !== expectedBytes) {
        const error = new Error(
          `Blob DATA stream ended at ${observedBytes} bytes; expected ${expectedBytes}`,
        );
        fail(error);
        throw error;
      }
      settled = true;
      clear();
    },
    cancel: (error) => fail(error),
  };
}

export async function writeIterable(
  destination: Duplex,
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<void> {
  try {
    for await (const chunk of iterateWithAbort(source, signal)) {
      if (!(chunk instanceof Uint8Array)) throw new Error("Blob source emitted non-byte content");
      await raceAbort(writeChunk(destination, chunk), signal);
      progress(chunk.byteLength);
    }
    await raceAbort(endWritable(destination), signal);
  } catch (error) {
    destination.destroy(asError(error));
    throw error;
  }
}

export async function* abortableIterable(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  progress: (bytes: number) => void,
  onComplete: () => void = () => {},
): AsyncIterable<Uint8Array> {
  for await (const chunk of iterateWithAbort(source, signal)) {
    progress(chunk.byteLength);
    yield chunk;
  }
  onComplete();
}

async function* iterateWithAbort(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let completed = false;
  const destroySource = () => {
    const destroy = (source as { destroy?: () => void }).destroy;
    if (typeof destroy === "function") destroy.call(source);
  };
  const onAbortSignal = () => destroySource();
  signal.addEventListener("abort", onAbortSignal, { once: true });
  if (signal.aborted) onAbortSignal();
  try {
    for (;;) {
      const item = await raceAbort(Promise.resolve(iterator.next()), signal);
      if (item.done) {
        completed = true;
        return;
      }
      throwIfAborted(signal);
      yield item.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbortSignal);
    if (!completed) destroySource();
    if (typeof iterator.return === "function") {
      // Invocation is mandatory, but cleanup cannot be allowed to reintroduce
      // an unbounded wait after the transfer deadline already fired.
      try {
        void Promise.resolve(iterator.return()).catch(() => {});
      } catch {
        // The transfer error remains authoritative; the source was destroyed.
      }
    }
  }
}

function writeChunk(destination: Duplex, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    destination.write(chunk, (error) => error ? reject(error) : resolve());
  });
}

function endWritable(destination: Duplex): Promise<void> {
  return new Promise((resolve, reject) => {
    destination.end((error?: Error | null) => error ? reject(error) : resolve());
  });
}

function onAbort(signal: AbortSignal, operation: () => Promise<void>): () => void {
  const listener = () => { void operation(); };
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbortSignal);
      resolve();
    }, milliseconds);
    const onAbortSignal = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbortSignal, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

async function readSnapshotManifestDigest(
  snapshot: CapsuleTreeSnapshot,
): Promise<AppManifestDigest> {
  const selection = await readCapsuleTreeSelection(snapshot, [
    { path: "manifest.json", maxBytes: APP_MANIFEST_MAX_BYTES },
  ]);
  const source = selection.contents.get("manifest.json");
  if (!source) throw new Error("App package snapshot must contain manifest.json");

  let manifest: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error("App package snapshot contains invalid manifest.json", { cause: error });
  }
  return digestNormalizedAppManifest(manifest);
}

async function inspectSnapshotInstallInput(snapshot: CapsuleTreeSnapshot) {
  const selection = await readCapsuleTreeSelection(snapshot, [
    { path: "package.json", maxBytes: MAX_INSTALL_PACKAGE_JSON_BYTES },
    { path: "package-lock.json", maxBytes: MAX_INSTALL_PACKAGE_LOCK_BYTES },
    { path: ".npmrc", maxBytes: MAX_INSTALL_NPMRC_BYTES },
    { path: "binding.gyp" },
    { path: "npm-shrinkwrap.json" },
  ]);
  const packageJson = selection.contents.get("package.json");
  const packageLock = selection.contents.get("package-lock.json");
  if (!packageJson) throw new Error("App package snapshot must contain package.json");
  if (!packageLock) throw new Error("App package snapshot must contain package-lock.json");
  const npmrc = selection.contents.get(".npmrc");
  return evaluateNpmInstallInput({
    packageJson,
    packageLock,
    ...(npmrc === undefined ? {} : { npmrc }),
    hasBindingGyp: selection.present.has("binding.gyp"),
    hasShrinkwrap: selection.present.has("npm-shrinkwrap.json"),
  });
}

function buildStorageInput(
  snapshot: CapsuleTreeSnapshot,
  input: ArtifactBuildInput,
): CapsuleBuildStorageInput {
  return input.mode === "cold"
    ? {
        mode: "cold",
        packageBytes: snapshot.bytes,
        dependencyBytes: input.dependencies.snapshot.bytes,
      }
    : {
        mode: "warm",
        packageBytes: snapshot.bytes,
        baseArtifactBytes: input.base.artifact.bytes,
      };
}

function buildRetainedBlobs(
  snapshot: CapsuleTreeSnapshot,
  input: ArtifactBuildInput,
): CapsuleRetainedBlob[] {
  return [
    { key: `package:${snapshot.digest}`, bytes: snapshot.bytes },
    input.mode === "cold"
      ? {
          key: `dependency:${input.dependencies.snapshot.digest}`,
          bytes: input.dependencies.snapshot.bytes,
        }
      : retainedArtifact(input.base.artifact),
  ];
}

function retainedArtifact(
  artifact: Pick<HostArtifact, "digest" | "bytes">,
): CapsuleRetainedBlob {
  return { key: `artifact:${artifact.digest}`, bytes: artifact.bytes };
}

function sameGuestRelease(
  left: LoadedCapsuleGuestRelease,
  right: LoadedCapsuleGuestRelease,
): boolean {
  return deepEqual(left.descriptor, right.descriptor)
    && deepEqual(left.handshake, right.handshake)
    && deepEqual(left.runtime, right.runtime);
}

function isWarmRebuildUnavailable(error: unknown): boolean {
  return error instanceof CapsuleGuestRequestError
    && error.code === "WARM_REBUILD_UNAVAILABLE";
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Capsule operation aborted");
}

function normalizeVmArchitecture(value: "arm64" | "x86_64"): "arm64" | "x64" {
  return value === "x86_64" ? "x64" : value;
}

function hashAppId(appId: string): string {
  return createHash("sha256").update(appId, "utf8").digest("hex");
}

function claimedWorkloadIdentity(
  event: GuestEvent,
): { appHandle: string; workloadHandle: string } | undefined {
  if (typeof event.body !== "object" || event.body === null || Array.isArray(event.body)) {
    return undefined;
  }
  const body = event.body as Record<string, JsonValue>;
  return typeof body.appHandle === "string" && typeof body.workloadHandle === "string"
    ? { appHandle: body.appHandle, workloadHandle: body.workloadHandle }
    : undefined;
}

function claimedViewerPort(event: GuestEvent): number {
  if (typeof event.body !== "object" || event.body === null || Array.isArray(event.body)) return 0;
  const port = (event.body as Record<string, JsonValue>).port;
  return typeof port === "number" ? port : 0;
}

function sameWorkload(
  left: { appHandle: string; workloadHandle: string },
  right: { appHandle: string; workloadHandle: string },
): boolean {
  return left.appHandle === right.appHandle && left.workloadHandle === right.workloadHandle;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function cleanupAggregateError(
  summary: string,
  primary: unknown,
  cleanup: unknown,
): AggregateError {
  const primaryError = asError(primary);
  const cleanupError = asError(cleanup);
  return new AggregateError(
    [primaryError, cleanupError],
    `${summary}: ${primaryError.message}; cleanup: ${cleanupError.message}`,
  );
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
