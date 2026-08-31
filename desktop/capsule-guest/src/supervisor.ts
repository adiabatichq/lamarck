import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import {
  blobTransferAbsoluteDeadlineMs,
  CAPSULE_PROTOCOL_VERSION,
  normalizeBlobTransferPolicy,
  GuestHandshake,
  JsonFrameDecoder,
  LinuxRuncDriver,
  MAX_ARTIFACT_ADOPTION_RECEIPT_BYTES,
  StateTransitionError,
  TicketError,
  TicketRegistry,
  createOciBundlePlan,
  createSupervisorState,
  encodeJsonFrame,
  parseArtifactAdoptionReceipt,
  parseHostRequestForSession,
  transitionSupervisor,
  type ConsumedTicketBinding,
  type BlobTransferPolicy,
  type AppPrepareBody,
  type ArtifactAdoptionReceipt,
  type BuildPrepareBody,
  type ControlResponse,
  type GuestArchitecture,
  type GuestEvent,
  type HostRequest,
  type ImportedBlobKind,
  type JsonValue,
  type RuncDriver,
  type RuncExecution,
  type SupervisorState,
  type TicketBinding,
  type WorkloadPrepareBody,
} from "@lamarck/capsule";
import { GuestBlobStore } from "./blob-store";
import { GuestBuildManager, type SealedArtifactDescriptor } from "./build-manager";
import { VsockDataDialer, type GuestDataDialer } from "./data-dialer";
import { readDataStreamPrelude } from "./data-prelude";
import { GuestResourceManager } from "./resource-manager";
import { GuestContainmentError } from "./containment-error";
import type { GuestProtocolStream } from "./lvrm-duplex";
import {
  UNBOUNDED_GUEST_RESOURCE_ADMISSION,
  type GuestResourceAdmissionLike,
  type GuestResourceLease,
} from "./resource-admission";

const TICKET_TTL_MS = 60_000;
const TICKET_REGISTRATION_RACE_MS = 5_000;
const MAX_REPLAY_RESPONSES = 1_024;
const MAX_TICKET_TOMBSTONES = 4_096;
const MAX_RETIRED_APP_TOMBSTONES = 4_096;
const RETIRED_APP_TOMBSTONE_TTL_MS = 5 * 60_000;

interface SupervisorOptions {
  bootId: string;
  imageDigest: string;
  architecture: GuestArchitecture;
  supervisorVersion: string;
  blobs: GuestBlobStore;
  builds: GuestBuildManager;
  resources: GuestResourceManager;
  admission?: GuestResourceAdmissionLike;
  runc?: RuncDriver;
  dataDialer?: GuestDataDialer;
  /** Test seam. Production uses the complete protocol ticket lifetime. */
  ticketTtlMs?: number;
  /** Test seam. Production uses the shared local-vsock transfer policy. */
  blobTransferPolicy?: Partial<BlobTransferPolicy>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingImport {
  ownerKey: string;
  kind: ImportedBlobKind;
  digest: string;
  bytes: number;
  blobHandle: string;
  phase: "prepared" | "attached" | "terminal";
}

interface PendingExport {
  ownerKey: string;
  buildHandle: string;
  digest: string;
  bytes: number;
  blobHandle: string;
  phase: "prepared" | "attached" | "terminal";
}

interface BuildBlobReferences {
  readonly ownerKey: string;
  readonly packageDigest: string;
  readonly packageBytes: number;
  readonly dependencyDigest?: string;
  readonly dependencyBytes?: number;
  readonly baseArtifactDigest?: string;
  readonly baseArtifactBytes?: number;
}

interface AppBlobReference {
  readonly ownerKey: string;
  readonly artifactDigest: string;
  readonly artifactBytes: number;
}

interface WorkloadRecord {
  body: WorkloadPrepareBody;
  sdk?: { socket: GuestProtocolStream; binding: ConsumedTicketBinding };
  cli?: { socket: GuestProtocolStream; binding: ConsumedTicketBinding };
  logs?: { socket: GuestProtocolStream; binding: ConsumedTicketBinding };
  execution?: RuncExecution;
  exit?: Promise<void>;
  readiness?: Promise<void>;
  resourceLease?: GuestResourceLease;
  finalized: boolean;
}

interface ReplayEntry {
  hash: string;
  response: ControlResponse;
}

interface InflightEntry {
  hash: string;
  response: Promise<ControlResponse>;
}

export class CapsuleGuestSupervisor {
  private readonly handshake: GuestHandshake;
  private readonly tickets = new TicketRegistry();
  private readonly runc: RuncDriver;
  private readonly dataDialer: GuestDataDialer;
  private readonly admission: GuestResourceAdmissionLike;
  private readonly ticketTtlMs: number;
  private readonly blobTransferPolicy: BlobTransferPolicy;
  private state: SupervisorState;
  private control: GuestProtocolStream | undefined;
  private readonly dataSockets = new Set<GuestProtocolStream>();
  private readonly pendingImports = new Map<string, PendingImport>();
  private readonly pendingExports = new Map<string, PendingExport>();
  private readonly buildBlobReferences = new Map<string, BuildBlobReferences>();
  private readonly buildBlobReleasePromises = new Map<string, Promise<void>>();
  private readonly buildPreparationBarriers = new Set<Promise<void>>();
  private readonly buildPreparationLocks = new Map<string, Promise<void>>();
  private readonly buildPreparationOperations = new Map<string, Promise<{ prepared: true }>>();
  private fatalBuildPreparation: Error | undefined;
  private readonly appBlobReferences = new Map<string, AppBlobReference>();
  private readonly workloads = new Map<string, WorkloadRecord>();
  private readonly workloadLocks = new Map<string, Promise<void>>();
  private readonly viewerTickets = new Map<string, { appHandle: string; workloadHandle: string; port: number }>();
  private readonly viewerSockets = new Map<string, Set<GuestProtocolStream>>();
  private readonly ticketWaiters = new Map<string, Set<Deferred<void>>>();
  private readonly ticketExpiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly forbiddenTickets = new BoundedTtlTombstones(
    MAX_TICKET_TOMBSTONES,
    TICKET_TTL_MS,
  );
  private readonly consumedTickets = new BoundedTtlTombstones(
    MAX_TICKET_TOMBSTONES,
    TICKET_TTL_MS,
  );
  private readonly retiredApps = new BoundedTtlTombstones(
    MAX_RETIRED_APP_TOMBSTONES,
    RETIRED_APP_TOMBSTONE_TTL_MS,
  );
  private readonly replay = new Map<string, ReplayEntry>();
  private readonly inflight = new Map<string, InflightEntry>();
  private drainPromise: Promise<void> | undefined;
  private draining = false;
  private eventSeq = 0;
  private sessionFaulted = false;

  constructor(private readonly options: SupervisorOptions) {
    this.handshake = new GuestHandshake({
      bootId: options.bootId,
      imageDigest: options.imageDigest,
      architecture: options.architecture,
      supervisorVersion: options.supervisorVersion,
      features: [
        "artifact-adoption-receipt-v1",
        "artifact-erofs-v1",
        "build-v1",
        "oci-policy-v1",
        "sdk-uds-v1",
        "app-cli-v1",
        "tickets-v1",
        "vsock-record-v2",
        "warm-rebuild-v1",
      ],
    });
    this.state = createSupervisorState({ bootId: options.bootId, imageDigest: options.imageDigest });
    // Workload diagnostics are bounded in memory by LinuxRuncDriver. Persistent
    // append-only logs would bypass the VM-wide disk admission budget.
    this.runc = options.runc ?? new LinuxRuncDriver();
    this.dataDialer = options.dataDialer ?? new VsockDataDialer();
    this.admission = options.admission ?? UNBOUNDED_GUEST_RESOURCE_ADMISSION;
    this.ticketTtlMs = boundedPositiveInteger(options.ticketTtlMs, TICKET_TTL_MS, TICKET_TTL_MS);
    this.blobTransferPolicy = normalizeBlobTransferPolicy(options.blobTransferPolicy);
  }

  attachControl(socket: GuestProtocolStream): void {
    if (this.control || this.sessionFaulted || this.handshake.state !== "waiting-initialize") {
      socket.destroy(new Error("Guest accepts exactly one image-bound control session"));
      return;
    }
    this.control = socket;
    socket.setNoDelay(true);
    socket.write(encodeJsonFrame(this.handshake.hello()));
    const decoder = new JsonFrameDecoder();
    socket.on("data", (chunk) => {
      try {
        for (const value of decoder.push(chunk)) this.handleControlValue(value);
      } catch (error) {
        this.failSession(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("end", () => {
      try {
        decoder.end();
      } catch (error) {
        this.failSession(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => this.failSession(error));
    socket.once("close", () => {
      if (!this.sessionFaulted && this.state.status !== "stopped") {
        this.failSession(new Error("Host control session was lost"));
      }
    });
  }

  attachData(socket: GuestProtocolStream): void {
    if (this.handshake.state !== "ready" || this.sessionFaulted) {
      socket.destroy(new Error("Guest data plane is unavailable before initialization"));
      return;
    }
    this.dataSockets.add(socket);
    socket.setNoDelay(true);
    // `readDataStreamPrelude` installs a temporary error listener. Streams
    // retained as SDK/log/viewer channels need one for their full lifetime so
    // an ECONNRESET cannot become an uncaught process-level exception.
    socket.on("error", () => undefined);
    socket.once("close", () => this.dataSockets.delete(socket));
    void this.routeDataSocket(socket).catch((error) => {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
      this.failSession(error instanceof Error ? error : new Error(String(error)));
    });
  }

  snapshot(): SupervisorState {
    return structuredClone(this.state);
  }

  private handleControlValue(value: unknown): void {
    if (this.handshake.state === "waiting-initialize") {
      const ready = this.handshake.initialize(value);
      this.state = transitionSupervisor(this.state, {
        type: "session.initialize",
        sessionId: ready.sessionId,
      });
      this.control?.write(encodeJsonFrame(ready));
      return;
    }
    const sessionId = this.handshake.sessionId!;
    const request = parseHostRequestForSession(value, sessionId);
    const hash = canonicalHash(request);
    const replay = this.replay.get(request.requestId);
    if (replay) {
      if (replay.hash !== hash) {
        this.failSession(new Error("requestId was replayed with a different authenticated body"));
        return;
      }
      this.writeControl(replay.response);
      return;
    }
    const inflight = this.inflight.get(request.requestId);
    if (inflight) {
      if (inflight.hash !== hash) {
        this.failSession(new Error("inflight requestId was reused with a different body"));
        return;
      }
      void inflight.response.then((response) => this.writeControl(response));
      return;
    }
    const response = this.dispatchResponse(request);
    this.inflight.set(request.requestId, { hash, response });
    void response.then((resolved) => {
      this.inflight.delete(request.requestId);
      this.rememberReplay(request.requestId, hash, resolved);
      this.writeControl(resolved);
    });
  }

  private async dispatchResponse(request: HostRequest): Promise<ControlResponse> {
    try {
      const result = await this.dispatch(request);
      return {
        v: CAPSULE_PROTOCOL_VERSION,
        sessionId: request.sessionId,
        kind: "response",
        requestId: request.requestId,
        ok: true,
        result,
      };
    } catch (error) {
      if (isFatalGuestError(error)) {
        const fatal = error instanceof Error ? error : new Error(String(error));
        setImmediate(() => this.failSession(fatal));
      }
      return {
        v: CAPSULE_PROTOCOL_VERSION,
        sessionId: request.sessionId,
        kind: "response",
        requestId: request.requestId,
        ok: false,
        error: {
          code: errorCode(error),
          message: boundedMessage(error),
        },
      };
    }
  }

  private async dispatch(request: HostRequest): Promise<JsonValue> {
    switch (request.op) {
      case "ping":
        return { nonce: request.body.nonce };
      case "blob.import.prepare":
        return await this.prepareBlobImport(request.body);
      case "blob.import.release": {
        const released = await this.options.blobs.releaseExpected({
          ownerKey: request.body.ownerKey,
          referenceId: `import:${request.body.blobHandle}`,
          kind: request.body.blobKind,
          digest: request.body.digest,
          bytes: request.body.bytes,
        });
        return { released };
      }
      case "blob.export.prepare": {
        if (!await this.options.blobs.has("artifact", request.body.digest, request.body.bytes)) {
          throw new Error("artifact export references a missing or size-mismatched CAS blob");
        }
        const exportReference = `export:${request.body.blobHandle}`;
        const acquiredExport = await this.options.blobs.acquireReference({
          ownerKey: request.body.ownerKey,
          referenceId: exportReference,
          kind: "artifact",
          digest: request.body.digest,
          bytes: request.body.bytes,
        });
        try {
          const released = await this.options.blobs.releaseExpected({
            ownerKey: request.body.ownerKey,
            referenceId: `build:${request.body.buildHandle}:output`,
            kind: "artifact",
            digest: request.body.digest,
            bytes: request.body.bytes,
          });
          if (!released) throw new Error("artifact export has no exact Build output reference");
        } catch (error) {
          if (acquiredExport) await this.options.blobs.release(exportReference);
          throw error;
        }
        const pending: PendingExport = {
          ownerKey: request.body.ownerKey,
          buildHandle: request.body.buildHandle,
          digest: request.body.digest,
          bytes: request.body.bytes,
          blobHandle: request.body.blobHandle,
          phase: "prepared",
        };
        try {
          this.issueTicket({
            sessionId: request.sessionId,
            ticket: request.body.streamTicket,
            kind: "artifact-out",
            appHandle: request.body.blobHandle,
            subjectHandle: request.body.blobHandle,
            ttlMs: this.ticketTtlMs,
          });
          this.pendingExports.set(request.body.streamTicket, pending);
          await this.dataDialer.open();
        } catch (error) {
          if (this.pendingExports.get(request.body.streamTicket) === pending) {
            this.pendingExports.delete(request.body.streamTicket);
          }
          this.revokeTicket(request.body.streamTicket);
          this.finishBlob(pending, "blob.failed", boundedMessage(error));
          await this.releaseExportReference(pending);
          throw error;
        }
        if (pending.phase === "terminal") {
          throw new Error("artifact export ticket expired before DATA transport became ready");
        }
        return { ready: true };
      }
      case "build.prepare": {
        if (this.fatalBuildPreparation) throw this.fatalBuildPreparation;
        if (this.draining) throw new Error("Guest Build supervisor is draining");
        const preparationBarrier = deferred<void>();
        this.buildPreparationBarriers.add(preparationBarrier.promise);
        // A fatal preparation result must be observable by a concurrent drain
        // even when no drain has attached to the barrier yet.
        void preparationBarrier.promise.catch(() => undefined);
        const operationKey = `${request.body.buildHandle}:${canonicalHash(request.body)}`;
        let operation = this.buildPreparationOperations.get(operationKey);
        if (!operation) {
          operation = this.performBuildPreparation(request.body);
          this.buildPreparationOperations.set(operationKey, operation);
          const tracked = operation;
          void tracked.finally(() => {
            if (this.buildPreparationOperations.get(operationKey) === tracked) {
              this.buildPreparationOperations.delete(operationKey);
            }
          }).catch(() => undefined);
        }
        try {
          return await operation;
        } catch (error) {
          if (isFatalGuestError(error)) {
            const fatal = error instanceof Error ? error : new Error(String(error));
            this.fatalBuildPreparation ??= fatal;
            preparationBarrier.reject(fatal);
          } else preparationBarrier.resolve();
          throw error;
        } finally {
          preparationBarrier.resolve();
          this.buildPreparationBarriers.delete(preparationBarrier.promise);
        }
      }
      case "build.start": {
        this.emit("build.progress", {
          appHandle: request.body.appHandle,
          buildHandle: request.body.buildHandle,
          phase: "materializing",
        });
        try {
          const descriptor = await this.options.builds.start(
            request.body.appHandle,
            request.body.buildHandle,
          );
          this.emit("build.completed", descriptor);
          return asJson(descriptor);
        } catch (error) {
          this.emit("build.failed", {
            appHandle: request.body.appHandle,
            buildHandle: request.body.buildHandle,
            message: boundedMessage(error),
          });
          throw error;
        } finally {
          await this.releaseBuildInputReferences(request.body.buildHandle);
        }
      }
      case "build.cancel":
        await this.options.builds.cancel(
          request.body.appHandle,
          request.body.buildHandle,
          request.body.graceMs,
        );
        await this.releaseBuildInputReferences(request.body.buildHandle);
        return { cancelled: true };
      case "build.output.release": {
        const released = await this.options.blobs.releaseExpected({
          ownerKey: request.body.ownerKey,
          referenceId: `build:${request.body.buildHandle}:output`,
          kind: "artifact",
          digest: request.body.digest,
          bytes: request.body.bytes,
        });
        return { released };
      }
      case "app.prepare": {
        const artifactReference = `app:${request.body.appHandle}:artifact`;
        let acquired = false;
        let resourcePrepared = false;
        try {
          if (this.retiredApps.has(request.body.appHandle)) {
            throw new Error("Retired App handle cannot be reused");
          }
          this.state = transitionSupervisor(this.state, { type: "app.prepare", ...request.body });
          if (this.state.apps[request.body.appHandle]?.status === "ready") {
            const existing = this.appBlobReferences.get(request.body.appHandle);
            if (
              !existing
              || existing.ownerKey !== request.body.ownerKey
              || existing.artifactDigest !== request.body.artifactDigest
              || existing.artifactBytes !== request.body.artifactBytes
            ) throw new Error("Prepared App blob ownership cannot be rebound");
            await this.releaseAppImportReference(request.body);
            // Idempotent prepare may observe the exact import hold already
            // transferred to this App reference.
            return { prepared: true, reused: true };
          }
          acquired = await this.options.blobs.acquireReference({
            ownerKey: request.body.ownerKey,
            referenceId: artifactReference,
            kind: "artifact",
            digest: request.body.artifactDigest,
            bytes: request.body.artifactBytes,
          });
          await this.options.resources.prepareApp(request.body);
          resourcePrepared = true;
          this.appBlobReferences.set(request.body.appHandle, {
            ownerKey: request.body.ownerKey,
            artifactDigest: request.body.artifactDigest,
            artifactBytes: request.body.artifactBytes,
          });
          const importReleased = await this.releaseAppImportReference(request.body);
          if (!importReleased) throw new Error("App artifact import reference is missing");
          this.state = transitionSupervisor(this.state, {
            type: "app.prepared",
            appHandle: request.body.appHandle,
          });
          return { prepared: true };
        } catch (error) {
          if (resourcePrepared) {
            let cleanupError: unknown;
            try {
              await this.releaseAppImportReference(request.body);
            } catch (failure) {
              cleanupError = failure;
            }
            throw new GuestContainmentError(
              `Prepared App ${request.body.appHandle} lost its artifact reference transition`,
              {
                cause: cleanupError === undefined
                  ? error
                  : new AggregateError([error, cleanupError], "Prepared App reference cleanup failed"),
              },
            );
          }
          const cleanupFailures: unknown[] = [];
          if (acquired) {
            try {
              await this.options.blobs.release(artifactReference);
            } catch (failure) {
              cleanupFailures.push(failure);
            }
          }
          try {
            await this.releaseAppImportReference(request.body);
          } catch (failure) {
            cleanupFailures.push(failure);
          }
          if (this.state.apps[request.body.appHandle]) {
            try {
              this.state = transitionSupervisor(this.state, {
                type: "app.faulted",
                appHandle: request.body.appHandle,
                reason: boundedMessage(error),
              });
            } catch (failure) {
              cleanupFailures.push(failure);
            }
          }
          if (cleanupFailures.length > 0) {
            throw new GuestContainmentError(
              `App ${request.body.appHandle} prepare cleanup was not authoritative`,
              { cause: new AggregateError([error, ...cleanupFailures], "App prepare cleanup failed") },
            );
          }
          throw error;
        }
      }
      case "app.stop":
        if (this.retiredApps.has(request.body.appHandle)) {
          return { stopped: true, reused: true };
        }
        await this.stopApp(request.body.appHandle);
        return { stopped: true };
      case "workload.prepare":
        return await this.withWorkloadLock(request.body.workloadHandle, async () => (
          await this.prepareWorkload(request.body, request.sessionId)
        ));
      case "workload.start":
        await this.withWorkloadLock(request.body.workloadHandle, async () => (
          await this.startWorkload(request.body.appHandle, request.body.workloadHandle, request.sessionId)
        ));
        return { started: true };
      case "workload.stop":
        await this.withWorkloadLock(request.body.workloadHandle, async () => (
          await this.stopWorkload(request.body.appHandle, request.body.workloadHandle, request.body.graceMs)
        ));
        return { stopped: true };
      case "viewer.attach": {
        const record = this.requireWorkload(request.body.appHandle, request.body.workloadHandle);
        if (record.body.workloadKind !== "ui" || record.body.uiPort === undefined) {
          throw new Error("viewer ticket requires a prepared UI workload");
        }
        const state = this.state.apps[request.body.appHandle]?.workloads[request.body.workloadHandle];
        if (state?.status !== "ready") throw new Error("UI workload has not passed viewer readiness");
        this.issueTicket({
          sessionId: request.sessionId,
          ticket: request.body.viewerTicket,
          kind: "viewer",
          appHandle: request.body.appHandle,
          subjectHandle: request.body.workloadHandle,
          ttlMs: this.ticketTtlMs,
        });
        this.viewerTickets.set(request.body.viewerTicket, {
          appHandle: request.body.appHandle,
          workloadHandle: request.body.workloadHandle,
          port: record.body.uiPort,
        });
        try {
          await this.dataDialer.open();
        } catch (error) {
          this.viewerTickets.delete(request.body.viewerTicket);
          this.revokeTicket(request.body.viewerTicket);
          throw error;
        }
        return { ready: true };
      }
      case "viewer.detach": {
        const sockets = this.viewerSockets.get(request.body.workloadHandle);
        if (sockets) for (const socket of sockets) socket.destroy();
        this.viewerSockets.delete(request.body.workloadHandle);
        return { detached: true };
      }
      case "vm.drain":
        this.state = transitionSupervisor(this.state, { type: "vm.drain" });
        await this.drain();
        this.state = transitionSupervisor(this.state, { type: "vm.stopped" });
        return { drained: true };
    }
  }

  private async prepareBlobImport(body: Extract<HostRequest, { op: "blob.import.prepare" }>["body"]): Promise<JsonValue> {
    if (await this.options.blobs.has(body.blobKind, body.digest, body.bytes)) {
      await this.options.blobs.acquireReference({
        ownerKey: body.ownerKey,
        referenceId: `import:${body.blobHandle}`,
        kind: body.blobKind,
        digest: body.digest,
        bytes: body.bytes,
      });
      this.forbiddenTickets.add(body.streamTicket);
      this.rejectTicketWaiters(body.streamTicket, new Error("cache hit must not open an import stream"));
      return { alreadyPresent: true };
    }
    const kind = body.blobKind === "package"
      ? "package-in"
      : body.blobKind === "dependency"
        ? "dependency-in"
        : "artifact-in";
    this.issueTicket({
      sessionId: this.handshake.sessionId!,
      ticket: body.streamTicket,
      kind,
      appHandle: body.blobHandle,
      subjectHandle: body.blobHandle,
      ttlMs: this.ticketTtlMs,
    });
    const pending: PendingImport = {
      ownerKey: body.ownerKey,
      kind: body.blobKind,
      digest: body.digest,
      bytes: body.bytes,
      blobHandle: body.blobHandle,
      phase: "prepared",
    };
    this.pendingImports.set(body.streamTicket, pending);
    try {
      await this.dataDialer.open();
    } catch (error) {
      if (this.pendingImports.get(body.streamTicket) === pending) {
        this.pendingImports.delete(body.streamTicket);
      }
      this.revokeTicket(body.streamTicket);
      this.finishBlob(pending, "blob.failed", boundedMessage(error));
      throw error;
    }
    if (pending.phase === "terminal") {
      throw new Error("blob import ticket expired before DATA transport became ready");
    }
    return { alreadyPresent: false, ready: true };
  }

  private async prepareWorkload(body: WorkloadPrepareBody, sessionId: string): Promise<JsonValue> {
    const existing = this.workloads.get(body.workloadHandle);
    this.state = transitionSupervisor(this.state, {
      type: "workload.prepare",
      appHandle: body.appHandle,
      workloadHandle: body.workloadHandle,
      workloadKind: body.workloadKind,
      launchSpec: body,
    });
    if (existing) {
      const awaitingStreams = existing.sdk === undefined
        || existing.cli === undefined
        || (existing.body.logsTicket !== undefined && existing.logs === undefined);
      return { awaitingStreams, reused: true };
    }
    this.workloads.set(body.workloadHandle, { body, finalized: false });
    const issuedTickets = [body.sdkTicket, body.cliTicket];
    this.issueTicket({
      sessionId,
      ticket: body.sdkTicket,
      kind: "sdk",
      appHandle: body.appHandle,
      subjectHandle: body.workloadHandle,
      ttlMs: this.ticketTtlMs,
    });
    this.issueTicket({
      sessionId,
      ticket: body.cliTicket,
      kind: "cli",
      appHandle: body.appHandle,
      subjectHandle: body.workloadHandle,
      ttlMs: this.ticketTtlMs,
    });
    if (body.logsTicket) {
      issuedTickets.push(body.logsTicket);
      this.issueTicket({
        sessionId,
        ticket: body.logsTicket,
        kind: "logs",
        appHandle: body.appHandle,
        subjectHandle: body.workloadHandle,
        ttlMs: this.ticketTtlMs,
      });
    }
    try {
      await Promise.all(issuedTickets.map(async () => this.dataDialer.open()));
    } catch (error) {
      for (const ticket of issuedTickets) this.revokeTicket(ticket);
      const record = this.workloads.get(body.workloadHandle);
      record?.sdk?.socket.destroy();
      record?.cli?.socket.destroy();
      record?.logs?.socket.destroy();
      this.workloads.delete(body.workloadHandle);
      this.state = transitionSupervisor(this.state, {
        type: "workload.faulted",
        appHandle: body.appHandle,
        workloadHandle: body.workloadHandle,
        reason: boundedMessage(error),
      });
      throw error;
    }
    return { awaitingStreams: true };
  }

  private async startWorkload(appHandle: string, workloadHandle: string, sessionId: string): Promise<void> {
    const record = this.requireWorkload(appHandle, workloadHandle);
    if (!record.sdk || record.sdk.socket.destroyed) throw new Error("authenticated SDK stream has not attached");
    if (!record.cli || record.cli.socket.destroyed) throw new Error("authenticated App CLI stream has not attached");
    if (record.body.logsTicket && (!record.logs || record.logs.socket.destroyed)) {
      throw new Error("declared logs stream has not attached");
    }
    const app = this.state.apps[appHandle];
    if (!app) throw new Error("App state is missing");
    this.state = transitionSupervisor(this.state, {
      type: "workload.start",
      appHandle,
      workloadHandle,
    });
    const resources = {
      memoryBytes: 512 * 1024 * 1024,
      pids: 256,
      cpuQuotaMicros: 100_000,
    };
    const plan = createOciBundlePlan({
      appHandle,
      workloadHandle,
      workloadKind: record.body.workloadKind,
      artifactDigest: app.artifactDigest,
      mappedHostUid: app.mappedHostUid,
      mappedHostGid: app.mappedHostGid,
      argv: record.body.argv,
      cwd: record.body.cwd,
      environment: record.body.environment,
      resources,
    });
    const expectedIdentity = {
      appHandle,
      workloadHandle,
      workloadKind: record.body.workloadKind,
      artifactDigest: app.artifactDigest,
      mappedHostUid: app.mappedHostUid,
      mappedHostGid: app.mappedHostGid,
      argv: record.body.argv,
      cwd: record.body.cwd,
      environment: record.body.environment,
      resources,
    };
    try {
      if (record.resourceLease) throw new Error("workload already owns a resource reservation");
      record.resourceLease = await this.admission.reserve(`workload:${workloadHandle}`, {
        memoryBytes: resources.memoryBytes,
      });
      const execution = await this.runc.start({
        plan,
        expectedIdentity,
        sessionId,
        sdkChannel: {
          source: record.sdk.socket,
          consumedTicket: record.sdk.binding,
        },
        cliChannel: {
          source: record.cli.socket,
          consumedTicket: record.cli.binding,
        },
        ...(record.logs === undefined
          ? {}
          : { logsChannel: { source: record.logs.socket, consumedTicket: record.logs.binding } }),
      });
      record.execution = execution;
      try {
        // No await is allowed between retaining the execution handle and the
        // state transition. If the transition loses a concurrent lifecycle
        // race, the newly created container is synchronously torn down below.
        this.state = transitionSupervisor(this.state, {
          type: "workload.started",
          appHandle,
          workloadHandle,
        });
      } catch (error) {
        const failures: unknown[] = [];
        try {
          await this.runc.stop(execution.containerId, 0);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        try {
          await this.runc.delete(execution.containerId);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        if (failures.length > 0) {
          throw new GuestContainmentError(
            `Workload ${workloadHandle} launch rollback was not authoritative`,
            { cause: new AggregateError([error, ...failures], "workload launch rollback failed") },
          );
        }
        record.execution = undefined;
        record.resourceLease?.release();
        record.resourceLease = undefined;
        throw error;
      }
      record.exit = this.watchWorkloadExit(appHandle, workloadHandle, record);
      void record.exit.catch((error) => this.failSession(
        error instanceof GuestContainmentError
          ? error
          : new GuestContainmentError(`Workload ${workloadHandle} exit could not be authenticated`, {
            cause: error,
          }),
      ));
      this.emit("workload.started", { appHandle, workloadHandle });
      if (record.body.workloadKind === "ui" && record.body.uiPort !== undefined) {
        record.readiness = this.watchViewerReadiness(
          appHandle,
          workloadHandle,
          record.body.uiPort,
          record,
        );
        void record.readiness.catch((error) => this.failSession(
          asContainmentError(
            `UI workload ${workloadHandle} readiness teardown was not authoritative`,
            error,
          ),
        ));
      }
    } catch (error) {
      if (!record.execution && !isFatalGuestError(error)) {
        record.resourceLease?.release();
        record.resourceLease = undefined;
      }
      this.state = transitionSupervisor(this.state, {
        type: "workload.faulted",
        appHandle,
        workloadHandle,
        reason: boundedMessage(error),
      });
      this.emit("workload.faulted", { appHandle, workloadHandle, message: boundedMessage(error) });
      throw error;
    }
  }

  private async watchWorkloadExit(
    appHandle: string,
    workloadHandle: string,
    record: WorkloadRecord,
  ): Promise<void> {
    const exit = await record.execution!.wait();
    if (record.finalized) return;
    record.finalized = true;
    try {
      this.state = transitionSupervisor(this.state, {
        type: "workload.exited",
        appHandle,
        workloadHandle,
        exitCode: exit.exitCode,
        signal: exit.signal,
      });
    } catch (error) {
      if (!(error instanceof StateTransitionError)) throw error;
    }
    try {
      await this.runc.delete(record.execution!.containerId);
    } catch (error) {
      throw new GuestContainmentError(
        `Workload ${workloadHandle} runc state could not be deleted after exit`,
        { cause: error },
      );
    }
    record.execution = undefined;
    record.resourceLease?.release();
    record.resourceLease = undefined;
    record.logs?.socket.end();
    record.sdk?.socket.destroy();
    record.cli?.socket.destroy();
    this.emit("workload.exited", { appHandle, workloadHandle, ...exit });
  }

  private async watchViewerReadiness(
    appHandle: string,
    workloadHandle: string,
    port: number,
    record: WorkloadRecord,
  ): Promise<void> {
    try {
      await this.options.resources.waitForViewerReady(appHandle, port, 30_000);
      if (record.finalized) return;
      this.state = transitionSupervisor(this.state, {
        type: "workload.ready",
        appHandle,
        workloadHandle,
      });
      this.emit("workload.ready", { appHandle, workloadHandle, port });
    } catch (error) {
      if (record.finalized) return;
      this.state = transitionSupervisor(this.state, {
        type: "workload.faulted",
        appHandle,
        workloadHandle,
        reason: boundedMessage(error),
      });
      this.emit("workload.faulted", {
        appHandle,
        workloadHandle,
        message: boundedMessage(error),
      });
      try {
        await this.runc.stop(record.execution!.containerId, 0);
      } catch (stopError) {
        throw asContainmentError(
          `UI workload ${workloadHandle} could not be contained after readiness failure`,
          stopError,
        );
      }
    }
  }

  private async stopWorkload(appHandle: string, workloadHandle: string, graceMs: number): Promise<void> {
    const record = this.requireWorkload(appHandle, workloadHandle);
    const workload = this.state.apps[appHandle]?.workloads[workloadHandle];
    if (workload && workload.status !== "stopping" && workload.status !== "exited" && workload.status !== "faulted") {
      this.state = transitionSupervisor(this.state, {
        type: "workload.stop",
        appHandle,
        workloadHandle,
      });
    }
    if (record.execution) {
      try {
        await this.runc.stop(record.execution.containerId, graceMs);
      } catch (error) {
        throw asContainmentError(
          `Workload ${workloadHandle} stop could not prove cgroup containment`,
          error,
        );
      }
      await record.exit;
    } else if (!record.finalized) {
      record.finalized = true;
      this.state = transitionSupervisor(this.state, {
        type: "workload.exited",
        appHandle,
        workloadHandle,
        exitCode: null,
        signal: "SIGTERM",
      });
      record.sdk?.socket.destroy();
      record.cli?.socket.destroy();
      record.logs?.socket.end();
    }
  }

  private async stopApp(appHandle: string): Promise<void> {
    this.state = transitionSupervisor(this.state, { type: "app.stop", appHandle });
    const workloads = [...this.workloads.entries()].filter(([, record]) => record.body.appHandle === appHandle);
    const stopped = await Promise.allSettled(
      workloads.map(async ([handle]) => this.withWorkloadLock(handle, async () => (
        await this.stopWorkload(appHandle, handle, 2_000)
      ))),
    );
    let resourceFailure: unknown;
    try {
      // This kills the App aggregate cgroup even when an individual runc
      // operation failed, so no descendant can survive a Host stop.
      await this.options.resources.stopApp(appHandle);
    } catch (error) {
      resourceFailure = error;
    }
    if (!resourceFailure) {
      for (const [, record] of workloads) {
        record.resourceLease?.release();
        record.resourceLease = undefined;
        record.execution = undefined;
      }
    }
    for (let index = 0; index < stopped.length; index += 1) {
      const result = stopped[index]!;
      if (result.status !== "rejected") continue;
      const [handle] = workloads[index]!;
      try {
        this.state = transitionSupervisor(this.state, {
          type: "workload.faulted",
          appHandle,
          workloadHandle: handle,
          reason: boundedMessage(result.reason),
        });
      } catch {
        // The aggregate cgroup teardown remains the authoritative fail-safe.
      }
    }
    if (resourceFailure) throw resourceFailure;
    this.state = transitionSupervisor(this.state, { type: "app.stopped", appHandle });
    this.retireAppRecords(appHandle, workloads);
    const artifactReference = this.appBlobReferences.get(appHandle);
    if (artifactReference) {
      const released = await this.options.blobs.releaseExpected({
        ownerKey: artifactReference.ownerKey,
        referenceId: `app:${appHandle}:artifact`,
        kind: "artifact",
        digest: artifactReference.artifactDigest,
        bytes: artifactReference.artifactBytes,
      });
      if (!released) {
        throw new Error("exact App artifact reference is missing after authoritative stop");
      }
    }
    this.appBlobReferences.delete(appHandle);
    this.retiredApps.add(appHandle);
    const failures = stopped.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => (failure as PromiseRejectedResult).reason),
        `App ${appHandle} stopped with workload cleanup failures`,
      );
    }
  }

  private drain(): Promise<void> {
    if (!this.drainPromise) {
      this.draining = true;
      this.drainPromise = this.performDrain();
    }
    return this.drainPromise;
  }

  private async performDrain(): Promise<void> {
    const apps = Object.keys(this.state.apps).filter((handle) => this.state.apps[handle]?.status !== "stopped");
    // Fence was raised synchronously by drain(). Join any supervisor-side
    // ownership transition that began before it, including the window before
    // BuildManager.prepare has published its own lifecycle record.
    const preparationResults = await Promise.allSettled([...this.buildPreparationBarriers]);
    // Build leases share the Guest-wide artifact mount registry with Runtime.
    // Let every Build cleanup barrier settle before ResourceManager performs
    // the final registry-drained assertion; concurrent assertion would mistake
    // a still-authorized Build lease for leaked containment state.
    const buildResults = await Promise.allSettled([this.options.builds.drain()]);
    // Once BuildManager proves every lifecycle finalizer has settled, retire
    // every remaining prepared/in-flight input hold exactly. This also joins a
    // concurrent build.start finally through releaseBuildInputReferences'
    // per-handle promise, rather than racing it with blanket CAS releaseAll.
    const buildReferenceResults = buildResults[0]?.status === "fulfilled"
      ? await Promise.allSettled(
          [...this.buildBlobReferences.keys()].map(async (handle) => (
            await this.releaseBuildInputReferences(handle)
          )),
        )
      : [];
    const appStopResults = await Promise.allSettled(
      apps.map(async (handle) => this.stopApp(handle)),
    );
    // Aggregate teardown still runs after an individual App stop fails, but
    // it cannot erase that failure: missing exact artifact ownership is not
    // made authoritative merely because the cgroup/mount registry drained.
    const appDrainResults = await Promise.allSettled([this.options.resources.drain()]);
    const failures = [
      ...preparationResults,
      ...(this.fatalBuildPreparation === undefined
        ? []
        : [{ status: "rejected" as const, reason: this.fatalBuildPreparation }]),
      ...buildResults,
      ...buildReferenceResults,
      ...appStopResults,
      ...appDrainResults,
    ]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new GuestContainmentError(
        "Guest drain was not authoritative; Guest must be terminated",
        { cause: new AggregateError(failures, "Guest drain failed") },
      );
    }
    await this.options.blobs.releaseAll();
    this.buildBlobReferences.clear();
    this.buildBlobReleasePromises.clear();
    this.appBlobReferences.clear();
  }

  private async routeDataSocket(socket: GuestProtocolStream): Promise<void> {
    const prelude = await readDataStreamPrelude(socket);
    if (prelude.sessionId !== this.handshake.sessionId) throw new Error("data stream belongs to another session");
    const binding = await this.consumeTicketEventually(prelude.ticket, prelude.kind);
    if (prelude.kind === "package-in" || prelude.kind === "dependency-in" || prelude.kind === "artifact-in") {
      const pending = this.pendingImports.get(prelude.ticket);
      if (!pending) throw new Error("import ticket has no prepared CAS operation");
      // Attachment atomically moves this operation out of the ticket-TTL phase.
      // No await may occur before the prepared record is removed.
      this.pendingImports.delete(prelude.ticket);
      pending.phase = "attached";
      try {
        await withBlobTransferDeadline(
          socket,
          pending.bytes,
          this.blobTransferPolicy,
          async () => {
            await this.options.blobs.receive(
              pending.kind,
              pending.digest,
              pending.bytes,
              socket,
              {
                ownerKey: pending.ownerKey,
                referenceId: `import:${pending.blobHandle}`,
              },
            );
            await endSocketWriteDirection(socket);
            await socket.waitForProtocolClose();
          },
        );
        this.finishBlob(pending, "blob.imported");
      } catch (error) {
        this.finishBlob(pending, "blob.failed", boundedMessage(error));
        throw error;
      }
      return;
    }
    if (prelude.kind === "artifact-out") {
      const pending = this.pendingExports.get(prelude.ticket);
      if (!pending) throw new Error("export ticket has no prepared artifact");
      this.pendingExports.delete(prelude.ticket);
      pending.phase = "attached";
      // Observe the Host direction before the first artifact byte is written.
      // Otherwise a FIN which arrived with the prelude could be mistaken for
      // the post-CAS adoption proof once Guest output has completed.
      const hostFin = trackArtifactHostFin(socket, {
        type: "artifact.adopted",
        protocolVersion: CAPSULE_PROTOCOL_VERSION,
        sessionId: prelude.sessionId,
        ticket: prelude.ticket,
        digest: pending.digest,
        bytes: pending.bytes,
      });
      let transferError: Error | undefined;
      try {
        await withBlobTransferDeadline(socket, pending.bytes, this.blobTransferPolicy, async () => {
          const source = await this.options.blobs.open("artifact", pending.digest);
          await exportArtifactToDataSocket(
            source,
            socket,
            pending.bytes,
            () => hostFin.markGuestFinQueued(),
          );
          hostFin.markGuestFinFlushed();
          // The Host sends an exact adoption receipt and then its directional
          // FIN only after it has observed our FIN, verified the exact
          // bytes/digest, and durably committed the CAS entry. The explicit
          // Host FIN ends the readable direction; overall operation success
          // still waits for LVRM's subsequent dual-CLOSE commit. Keep the
          // transfer deadline active through every signal: a bare physical
          // EOF, FIN without CLOSE, or RESET can never release the export
          // reference or emit blob.exported.
          await hostFin.promise;
          await socket.waitForProtocolClose();
        });
      } catch (error) {
        transferError = error instanceof Error ? error : new Error(String(error));
      } finally {
        hostFin.cancel();
      }
      let releaseError: Error | undefined;
      try {
        await this.releaseExportReference(pending);
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
      if (transferError || releaseError) {
        const failure = transferError && releaseError
          ? new AggregateError([transferError, releaseError], "artifact export and exact-reference release failed")
          : transferError ?? releaseError!;
        this.finishBlob(pending, "blob.failed", boundedMessage(failure));
        throw failure;
      }
      this.finishBlob(pending, "blob.exported");
      return;
    }
    if (prelude.kind === "sdk" || prelude.kind === "cli" || prelude.kind === "logs") {
      const record = this.workloads.get(binding.subjectHandle);
      if (!record || record.body.appHandle !== binding.appHandle) {
        throw new Error("workload stream references an unknown launch");
      }
      if (prelude.kind === "sdk") {
        if (record.sdk) throw new Error("SDK stream already attached");
        record.sdk = { socket, binding };
        this.state = transitionSupervisor(this.state, {
          type: "workload.sdk-attached",
          appHandle: binding.appHandle,
          workloadHandle: binding.subjectHandle,
        });
      } else if (prelude.kind === "cli") {
        if (record.cli) throw new Error("App CLI stream already attached");
        record.cli = { socket, binding };
      } else {
        if (record.logs) throw new Error("logs stream already attached");
        record.logs = { socket, binding };
      }
      return;
    }
    if (prelude.kind === "viewer") {
      const viewer = this.viewerTickets.get(prelude.ticket);
      if (!viewer) throw new Error("viewer ticket has no declared workload port");
      this.viewerTickets.delete(prelude.ticket);
      let sockets = this.viewerSockets.get(viewer.workloadHandle);
      if (!sockets) {
        sockets = new Set();
        this.viewerSockets.set(viewer.workloadHandle, sockets);
      }
      sockets.add(socket);
      socket.once("close", () => sockets!.delete(socket));
      try {
        await this.options.resources.proxyViewer(viewer.appHandle, viewer.port, socket);
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    throw new Error(`unhandled data stream kind ${prelude.kind}`);
  }

  private issueTicket(options: Parameters<TicketRegistry["issue"]>[0]): TicketBinding {
    const binding = this.tickets.issue(options);
    const timer = setTimeout(() => this.expireTicket(binding.ticket), options.ttlMs);
    timer.unref();
    this.ticketExpiryTimers.set(binding.ticket, timer);
    const waiters = this.ticketWaiters.get(binding.ticket);
    if (waiters) {
      this.ticketWaiters.delete(binding.ticket);
      for (const waiter of waiters) waiter.resolve();
    }
    return binding;
  }

  private async consumeTicketEventually(
    ticket: string,
    kind: Parameters<TicketRegistry["consume"]>[2],
  ): Promise<ConsumedTicketBinding> {
    if (this.forbiddenTickets.has(ticket)) throw new Error("cache-hit import ticket cannot open a stream");
    if (this.consumedTickets.has(ticket)) throw new Error("data stream ticket was replayed");
    try {
      const binding = this.consumeTicket(ticket, kind);
      this.consumedTickets.add(ticket);
      return binding;
    } catch (error) {
      if (!(error instanceof TicketError) || error.code !== "TICKET_UNKNOWN") throw error;
    }
    const waiter = deferred<void>();
    let waiters = this.ticketWaiters.get(ticket);
    if (!waiters) {
      waiters = new Set();
      this.ticketWaiters.set(ticket, waiters);
    }
    waiters.add(waiter);
    const timer = setTimeout(() => waiter.reject(new Error("data stream ticket was never prepared")), TICKET_REGISTRATION_RACE_MS);
    try {
      await waiter.promise;
    } finally {
      clearTimeout(timer);
      waiters.delete(waiter);
      if (waiters.size === 0) this.ticketWaiters.delete(ticket);
    }
    const binding = this.consumeTicket(ticket, kind);
    this.consumedTickets.add(ticket);
    return binding;
  }

  private consumeTicket(
    ticket: string,
    kind: Parameters<TicketRegistry["consume"]>[2],
  ): ConsumedTicketBinding {
    const binding = this.tickets.consume(ticket, this.handshake.sessionId!, kind);
    this.clearTicketExpiry(ticket);
    return binding;
  }

  private revokeTicket(ticket: string): boolean {
    this.clearTicketExpiry(ticket);
    return this.tickets.revoke(ticket);
  }

  private expireTicket(ticket: string): void {
    this.ticketExpiryTimers.delete(ticket);
    this.tickets.revoke(ticket);
    const pendingImport = this.pendingImports.get(ticket);
    if (pendingImport) {
      this.pendingImports.delete(ticket);
      this.finishBlob(
        pendingImport,
        "blob.failed",
        "blob import ticket expired before DATA attachment",
      );
    }
    const pendingExport = this.pendingExports.get(ticket);
    if (pendingExport) {
      this.pendingExports.delete(ticket);
      this.finishBlob(
        pendingExport,
        "blob.failed",
        "blob export ticket expired before DATA attachment",
      );
      void this.releaseExportReference(pendingExport).catch((error: unknown) => {
        this.failSession(error instanceof Error ? error : new Error(String(error)));
      });
    }
    this.viewerTickets.delete(ticket);
    this.rejectTicketWaiters(ticket, new Error("data stream ticket expired before attachment"));
  }

  private clearTicketExpiry(ticket: string): void {
    const timer = this.ticketExpiryTimers.get(ticket);
    if (timer) clearTimeout(timer);
    this.ticketExpiryTimers.delete(ticket);
  }

  private finishBlob(
    pending: PendingImport | PendingExport,
    type: "blob.imported" | "blob.exported" | "blob.failed",
    message?: string,
  ): boolean {
    if (pending.phase === "terminal") return false;
    pending.phase = "terminal";
    this.emit(type, {
      blobHandle: pending.blobHandle,
      digest: pending.digest,
      bytes: pending.bytes,
      ...(message === undefined ? {} : { message }),
    });
    return true;
  }

  private async performBuildPreparation(
    body: BuildPrepareBody,
  ): Promise<{ prepared: true }> {
    const releasePreparationLock = await this.acquireBuildPreparationLock(body.buildHandle);
    try {
      // A request admitted before a fatal sibling transition must not begin
      // after that transition releases the per-Build lock.
      if (this.fatalBuildPreparation) throw this.fatalBuildPreparation;
      const packageReference = `build:${body.buildHandle}:package`;
      const dependencyReference = `build:${body.buildHandle}:dependency`;
      const baseArtifactReference = `build:${body.buildHandle}:base-artifact`;
      let existing: BuildBlobReferences | undefined;
      const acquired: string[] = [];
      let ownershipEstablished = false;
      try {
        existing = this.buildBlobReferences.get(body.buildHandle);
        if (existing && (
          existing.ownerKey !== body.ownerKey
          || existing.packageDigest !== body.packageDigest
          || existing.packageBytes !== body.packageBytes
          || existing.dependencyDigest !== body.dependencyDigest
          || existing.dependencyBytes !== body.dependencyBytes
          || existing.baseArtifactDigest !== body.baseArtifactDigest
          || existing.baseArtifactBytes !== body.baseArtifactBytes
        )) {
          throw new Error("Build blob ownership cannot be rebound");
        }
        if (await this.options.blobs.acquireReference({
          ownerKey: body.ownerKey,
          referenceId: packageReference,
          kind: "package",
          digest: body.packageDigest,
          bytes: body.packageBytes,
        })) acquired.push(packageReference);
        if (body.dependencyDigest && body.dependencyBytes) {
          if (await this.options.blobs.acquireReference({
            ownerKey: body.ownerKey,
            referenceId: dependencyReference,
            kind: "dependency",
            digest: body.dependencyDigest,
            bytes: body.dependencyBytes,
          })) acquired.push(dependencyReference);
        }
        if (body.baseArtifactDigest && body.baseArtifactBytes) {
          if (await this.options.blobs.acquireReference({
            ownerKey: body.ownerKey,
            referenceId: baseArtifactReference,
            kind: "artifact",
            digest: body.baseArtifactDigest,
            bytes: body.baseArtifactBytes,
          })) acquired.push(baseArtifactReference);
        }
        await this.options.builds.prepare(body);
        this.buildBlobReferences.set(body.buildHandle, {
          ownerKey: body.ownerKey,
          packageDigest: body.packageDigest,
          packageBytes: body.packageBytes,
          ...(body.dependencyDigest === undefined
            ? {}
            : {
                dependencyDigest: body.dependencyDigest,
                dependencyBytes: body.dependencyBytes,
              }),
          ...(body.baseArtifactDigest === undefined
            ? {}
            : {
                baseArtifactDigest: body.baseArtifactDigest,
                baseArtifactBytes: body.baseArtifactBytes,
              }),
        });
        ownershipEstablished = true;
        const packageImportReleased = await this.options.blobs.releaseExpected({
          ownerKey: body.ownerKey,
          referenceId: `import:${body.packageBlobHandle}`,
          kind: "package",
          digest: body.packageDigest,
          bytes: body.packageBytes,
        });
        if (!packageImportReleased && !existing) {
          throw new Error("Build package import reference is missing");
        }
        if (body.dependencyDigest && body.dependencyBytes && body.dependencyBlobHandle) {
          const dependencyImportReleased = await this.options.blobs.releaseExpected({
            ownerKey: body.ownerKey,
            referenceId: `import:${body.dependencyBlobHandle}`,
            kind: "dependency",
            digest: body.dependencyDigest,
            bytes: body.dependencyBytes,
          });
          if (!dependencyImportReleased && !existing) {
            throw new Error("Build dependency import reference is missing");
          }
        }
        if (body.baseArtifactDigest && body.baseArtifactBytes && body.baseArtifactBlobHandle) {
          const baseArtifactImportReleased = await this.options.blobs.releaseExpected({
            ownerKey: body.ownerKey,
            referenceId: `import:${body.baseArtifactBlobHandle}`,
            kind: "artifact",
            digest: body.baseArtifactDigest,
            bytes: body.baseArtifactBytes,
          });
          if (!baseArtifactImportReleased && !existing) {
            throw new Error("Build base artifact import reference is missing");
          }
        }
        return { prepared: true };
      } catch (error) {
        const cleanupFailures: unknown[] = [];
        if (!ownershipEstablished) {
          const releases = await Promise.allSettled(
            acquired.map(async (reference) => await this.options.blobs.release(reference)),
          );
          for (const release of releases) {
            if (release.status === "rejected") {
              cleanupFailures.push(release.reason);
            } else if (!release.value) {
              cleanupFailures.push(new Error("acquired Build blob reference disappeared before release"));
            }
          }
        }
        try {
          await this.releaseBuildImportReferences(body, existing !== undefined);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        if (cleanupFailures.length > 0) {
          throw new GuestContainmentError(
            `Build ${body.buildHandle} import-reference cleanup was not authoritative`,
            { cause: new AggregateError([error, ...cleanupFailures], "Build prepare cleanup failed") },
          );
        }
        if (ownershipEstablished) {
          throw new GuestContainmentError(
            `Prepared Build ${body.buildHandle} lost its exact import-reference transition`,
            { cause: error },
          );
        }
        throw error;
      }
    } catch (error) {
      if (isFatalGuestError(error)) {
        this.fatalBuildPreparation ??= error instanceof Error
          ? error
          : new Error(String(error));
      }
      throw error;
    } finally {
      releasePreparationLock();
    }
  }

  private async releaseBuildInputReferences(buildHandle: string): Promise<void> {
    const releasing = this.buildBlobReleasePromises.get(buildHandle);
    if (releasing) return await releasing;
    const references = this.buildBlobReferences.get(buildHandle);
    if (!references) return;
    const operation = this.performBuildInputRelease(buildHandle, references);
    this.buildBlobReleasePromises.set(buildHandle, operation);
    try {
      await operation;
      this.buildBlobReferences.delete(buildHandle);
    } finally {
      if (this.buildBlobReleasePromises.get(buildHandle) === operation) {
        this.buildBlobReleasePromises.delete(buildHandle);
      }
    }
  }

  private async performBuildInputRelease(
    buildHandle: string,
    references: BuildBlobReferences,
  ): Promise<void> {
    const releases: Array<Promise<boolean>> = [this.options.blobs.releaseExpected({
      ownerKey: references.ownerKey,
      referenceId: `build:${buildHandle}:package`,
      kind: "package",
      digest: references.packageDigest,
      bytes: references.packageBytes,
    })];
    if (references.dependencyDigest && references.dependencyBytes) {
      releases.push(this.options.blobs.releaseExpected({
        ownerKey: references.ownerKey,
        referenceId: `build:${buildHandle}:dependency`,
        kind: "dependency",
        digest: references.dependencyDigest,
        bytes: references.dependencyBytes,
      }));
    }
    if (references.baseArtifactDigest && references.baseArtifactBytes) {
      releases.push(this.options.blobs.releaseExpected({
        ownerKey: references.ownerKey,
        referenceId: `build:${buildHandle}:base-artifact`,
        kind: "artifact",
        digest: references.baseArtifactDigest,
        bytes: references.baseArtifactBytes,
      }));
    }
    const results = await Promise.allSettled(releases);
    const failures = results.flatMap((result) => (
      result.status === "rejected"
        ? [result.reason]
        : result.value
          ? []
          : [new Error("exact Build blob reference disappeared before release")]
    ));
    if (failures.length > 0) {
      throw new GuestContainmentError(
        `Build ${buildHandle} blob-reference cleanup was not authoritative`,
        { cause: new AggregateError(failures, "Build blob release failed") },
      );
    }
  }

  private async releaseBuildImportReferences(
    body: BuildPrepareBody,
    allowAlreadyReleased = false,
  ): Promise<void> {
    const releases: Array<Promise<boolean>> = [this.options.blobs.releaseExpected({
      ownerKey: body.ownerKey,
      referenceId: `import:${body.packageBlobHandle}`,
      kind: "package",
      digest: body.packageDigest,
      bytes: body.packageBytes,
    })];
    if (body.dependencyDigest && body.dependencyBytes && body.dependencyBlobHandle) {
      releases.push(this.options.blobs.releaseExpected({
        ownerKey: body.ownerKey,
        referenceId: `import:${body.dependencyBlobHandle}`,
        kind: "dependency",
        digest: body.dependencyDigest,
        bytes: body.dependencyBytes,
      }));
    }
    if (body.baseArtifactDigest && body.baseArtifactBytes && body.baseArtifactBlobHandle) {
      releases.push(this.options.blobs.releaseExpected({
        ownerKey: body.ownerKey,
        referenceId: `import:${body.baseArtifactBlobHandle}`,
        kind: "artifact",
        digest: body.baseArtifactDigest,
        bytes: body.baseArtifactBytes,
      }));
    }
    const results = await Promise.allSettled(releases);
    const failures = results.flatMap((result) => (
      result.status === "rejected"
        ? [result.reason]
        : result.value || allowAlreadyReleased
          ? []
          : [new Error("exact Build import reference disappeared before release")]
    ));
    if (failures.length > 0) {
      throw new AggregateError(failures, "Build import-reference release failed");
    }
  }

  private async releaseAppImportReference(body: AppPrepareBody): Promise<boolean> {
    return await this.options.blobs.releaseExpected({
      ownerKey: body.ownerKey,
      referenceId: `import:${body.artifactBlobHandle}`,
      kind: "artifact",
      digest: body.artifactDigest,
      bytes: body.artifactBytes,
    });
  }

  private async releaseExportReference(pending: PendingExport): Promise<void> {
    const released = await this.options.blobs.releaseExpected({
      ownerKey: pending.ownerKey,
      referenceId: `export:${pending.blobHandle}`,
      kind: "artifact",
      digest: pending.digest,
      bytes: pending.bytes,
    });
    if (!released) throw new Error("exact artifact export reference is missing");
  }

  private retireAppRecords(
    appHandle: string,
    workloads: Array<[string, WorkloadRecord]>,
  ): void {
    for (const [workloadHandle, record] of workloads) {
      this.revokeTicket(record.body.sdkTicket);
      this.revokeTicket(record.body.cliTicket);
      if (record.body.logsTicket) this.revokeTicket(record.body.logsTicket);
      const sockets = this.viewerSockets.get(workloadHandle);
      if (sockets) for (const socket of sockets) socket.destroy();
      this.viewerSockets.delete(workloadHandle);
      this.workloadLocks.delete(workloadHandle);
      this.workloads.delete(workloadHandle);
    }
    for (const [ticket, viewer] of this.viewerTickets) {
      if (viewer.appHandle !== appHandle) continue;
      this.viewerTickets.delete(ticket);
      this.revokeTicket(ticket);
    }
  }

  private rejectTicketWaiters(ticket: string, error: Error): void {
    const waiters = this.ticketWaiters.get(ticket);
    if (!waiters) return;
    this.ticketWaiters.delete(ticket);
    for (const waiter of waiters) waiter.reject(error);
  }

  private requireWorkload(appHandle: string, workloadHandle: string): WorkloadRecord {
    const record = this.workloads.get(workloadHandle);
    if (!record || record.body.appHandle !== appHandle) throw new Error("Unknown workload handle");
    return record;
  }

  private async withWorkloadLock<T>(workloadHandle: string, action: () => Promise<T>): Promise<T> {
    const prior = this.workloadLocks.get(workloadHandle) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(async () => await gate);
    this.workloadLocks.set(workloadHandle, tail);
    await prior.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.workloadLocks.get(workloadHandle) === tail) this.workloadLocks.delete(workloadHandle);
    }
  }

  private async acquireBuildPreparationLock(buildHandle: string): Promise<() => void> {
    const prior = this.buildPreparationLocks.get(buildHandle) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = prior.catch(() => undefined).then(async () => await gate);
    this.buildPreparationLocks.set(buildHandle, tail);
    await prior.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      if (this.buildPreparationLocks.get(buildHandle) === tail) {
        this.buildPreparationLocks.delete(buildHandle);
      }
    };
  }

  private emit(type: GuestEvent["type"], body: unknown): void {
    if (!this.handshake.sessionId || this.sessionFaulted) return;
    const event: GuestEvent = {
      v: CAPSULE_PROTOCOL_VERSION,
      sessionId: this.handshake.sessionId,
      kind: "event",
      eventSeq: ++this.eventSeq,
      type,
      body: asJson(body),
    };
    this.writeControl(event);
  }

  private writeControl(value: unknown): void {
    if (!this.control || this.control.destroyed || this.sessionFaulted) return;
    this.control.write(encodeJsonFrame(value, this.handshake.maxControlFrameBytes));
  }

  private rememberReplay(requestId: string, hash: string, response: ControlResponse): void {
    this.replay.set(requestId, { hash, response });
    while (this.replay.size > MAX_REPLAY_RESPONSES) {
      const oldest = this.replay.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.replay.delete(oldest);
    }
  }

  private failSession(error: Error): void {
    if (this.sessionFaulted) return;
    this.sessionFaulted = true;
    if (this.handshake.sessionId) {
      this.tickets.revokeSession(this.handshake.sessionId);
      try {
        this.state = transitionSupervisor(this.state, {
          type: "session.lost",
          reason: boundedMessage(error),
        });
      } catch {
        // State is diagnostic only after the security boundary has failed closed.
      }
    }
    for (const socket of this.dataSockets) socket.destroy(error);
    for (const waiters of this.ticketWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.pendingImports.clear();
    this.pendingExports.clear();
    this.viewerTickets.clear();
    this.viewerSockets.clear();
    this.ticketWaiters.clear();
    for (const timer of this.ticketExpiryTimers.values()) clearTimeout(timer);
    this.ticketExpiryTimers.clear();
    this.forbiddenTickets.clear();
    this.consumedTickets.clear();
    this.retiredApps.clear();
    this.control?.destroy(error);
    this.dataDialer.close();
    // The Host will terminate the VM after a lost boundary. Keep the rejection
    // observed locally as well; an unhandled rejection must not race process
    // shutdown or obscure the original control-session failure.
    void this.drain().catch(() => undefined);
  }
}

/**
 * Bounded replay history for one-use authorities. Entries are retained long
 * enough to reject normal late duplicates immediately. Once expired or
 * evicted, the underlying TicketRegistry still rejects the stream as unknown,
 * so bounding this diagnostic fast path never turns a replay into authority.
 *
 * @internal Exported for deterministic contract tests only.
 */
export class BoundedTtlTombstones {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("tombstone limit must be positive");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("tombstone TTL must be positive");
  }

  get size(): number {
    this.cleanupExpired();
    return this.entries.size;
  }

  add(value: string): void {
    this.cleanupExpired();
    this.entries.delete(value);
    this.entries.set(value, this.now() + this.ttlMs);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  has(value: string): boolean {
    this.cleanupExpired();
    return this.entries.has(value);
  }

  clear(): void {
    this.entries.clear();
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const [value, expiresAt] of this.entries) {
      if (expiresAt > now) continue;
      this.entries.delete(value);
    }
  }
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new Error(`integer must be between 1 and ${maximum}`);
  }
  return candidate;
}

async function withBlobTransferDeadline<T>(
  socket: GuestProtocolStream,
  bytes: number,
  policy: BlobTransferPolicy,
  operation: () => Promise<T>,
): Promise<T> {
  const fail = (message: string) => {
    socket.destroy(new Error(message));
  };
  const onIdle = () => fail("blob DATA stream made no byte progress before its idle deadline");
  socket.setTimeout(policy.idleTimeoutMs);
  socket.once("timeout", onIdle);
  const absoluteTimer = setTimeout(
    () => fail("blob DATA stream exceeded its size-derived absolute deadline"),
    blobTransferAbsoluteDeadlineMs(bytes, policy),
  );
  absoluteTimer.unref();
  try {
    return await operation();
  } finally {
    clearTimeout(absoluteTimer);
    socket.setTimeout(0);
    socket.off("timeout", onIdle);
  }
}

/**
 * Streams one already-authenticated artifact over only the Guest -> Host
 * direction of a DATA socket. A DATA socket is a full duplex authority: the
 * Host's write-half ending after the prelude must not truncate this direction.
 * The caller separately waits for the bound adoption receipt, directional
 * Host FIN, and LVRM normal-close commit after this function flushes Guest FIN.
 *
 * The CAS source performs its final identity and digest checks when iteration
 * completes. Consequently the clean FIN is sent only after the source has
 * completed those checks and the authenticated byte length is exact. Any
 * source, length, or socket-write failure destroys the transport instead of
 * presenting an ambiguous successful half-close.
 *
 * @internal Exported for focused protocol contract tests.
 */
export async function exportArtifactToDataSocket(
  source: Readable,
  socket: GuestProtocolStream,
  expectedBytes: number,
  onGuestFinQueued: () => void = () => {},
): Promise<void> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error("artifact export byte length is outside the protocol limit");
  }
  let writtenBytes = 0;
  try {
    for await (const rawChunk of source) {
      const chunk = Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
      if (chunk.byteLength === 0) continue;
      writtenBytes += chunk.byteLength;
      if (writtenBytes > expectedBytes) {
        throw new Error("artifact DATA stream exceeded its authenticated byte length");
      }
      await writeSocketChunk(socket, chunk);
    }
    if (writtenBytes !== expectedBytes) {
      throw new Error(
        `artifact DATA stream ended at ${writtenBytes} bytes; expected ${expectedBytes}`,
      );
    }
    onGuestFinQueued();
    await endSocketWriteDirection(socket);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!source.destroyed) source.destroy(failure);
    if (!socket.destroyed) socket.destroy(failure);
    throw failure;
  }
}

interface ArtifactHostFinTracker {
  readonly promise: Promise<void>;
  markGuestFinQueued(): void;
  markGuestFinFlushed(): void;
  cancel(): void;
}

function trackArtifactHostFin(
  socket: GuestProtocolStream,
  expectedReceipt: ArtifactAdoptionReceipt,
): ArtifactHostFinTracker {
  let guestFinQueued = false;
  let guestFinFlushed = false;
  let receiptReceived = false;
  let hostFinReceived = false;
  let settled = false;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const decoder = new JsonFrameDecoder(MAX_ARTIFACT_ADOPTION_RECEIPT_BYTES);

  const cleanup = () => {
    socket.off("data", onData);
    socket.off("end", onEnd);
    socket.off("error", onError);
    socket.off("close", onClose);
  };
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectPromise(error);
    else resolvePromise();
  };
  const maybeFinish = () => {
    if (guestFinFlushed && receiptReceived && hostFinReceived) finish();
  };
  const onData = (chunk: Buffer) => {
    if (chunk.byteLength === 0 || settled) return;
    if (!guestFinQueued) {
      finish(new Error(
        "Host artifact adoption receipt arrived before verified Guest output and Guest FIN",
      ));
      return;
    }
    try {
      for (const value of decoder.push(chunk)) {
        if (receiptReceived) {
          throw new Error("Host sent more than one artifact adoption receipt");
        }
        const receipt = parseArtifactAdoptionReceipt(value);
        if (
          receipt.sessionId !== expectedReceipt.sessionId
          || receipt.ticket !== expectedReceipt.ticket
          || receipt.digest !== expectedReceipt.digest
          || receipt.bytes !== expectedReceipt.bytes
        ) {
          throw new Error(
            "Host artifact adoption receipt does not match this one-use export",
          );
        }
        receiptReceived = true;
        maybeFinish();
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const onEnd = () => {
    if (!guestFinQueued) {
      finish(new Error("Host FIN arrived before verified Guest output and Guest FIN"));
      return;
    }
    try {
      decoder.end();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!receiptReceived) {
      finish(new Error("Host FIN arrived without an artifact adoption receipt"));
      return;
    }
    hostFinReceived = true;
    maybeFinish();
  };
  const onError = (error: Error) => finish(error);
  const onClose = () => {
    if (socket.readableEnded) onEnd();
    else finish(new Error("Host closed the artifact DATA stream without a clean FIN"));
  };
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // Early FIN/error is deliberately observed before the output loop awaits the
  // promise. Keep that rejection handled until the ordered adoption gate joins
  // it after Guest FIN.
  void promise.catch(() => undefined);

  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.once("error", onError);
  socket.once("close", onClose);
  if (socket.readableEnded) onEnd();
  else if (socket.destroyed || !socket.readable) {
    finish(new Error("Host closed the artifact DATA stream without a clean FIN"));
  } else {
    const buffered = socket.read();
    if (buffered !== null) onData(Buffer.from(buffered));
    if (!settled) socket.resume();
  }

  return {
    promise,
    markGuestFinQueued: () => {
      guestFinQueued = true;
    },
    markGuestFinFlushed: () => {
      guestFinFlushed = true;
      maybeFinish();
    },
    cancel: () => finish(new Error("artifact Host-FIN tracking was cancelled")),
  };
}

async function writeSocketChunk(socket: GuestProtocolStream, chunk: Buffer): Promise<void> {
  if (socket.destroyed || !socket.writable || socket.writableEnded) {
    throw new Error("Host closed the artifact DATA stream before Guest output completed");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error(
      "artifact DATA stream closed before a queued Guest write completed",
    ));
    socket.once("error", onError);
    socket.once("close", onClose);
    try {
      socket.write(chunk, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function endSocketWriteDirection(socket: GuestProtocolStream): Promise<void> {
  if (socket.destroyed) throw new Error("artifact DATA stream closed before Guest FIN");
  if (socket.writableFinished) return;
  if (socket.writableEnded) {
    throw new Error("artifact DATA stream write direction ended before Guest FIN was confirmed");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.off("finish", onFinish);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onFinish = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error(
      "artifact DATA stream closed before Guest FIN was confirmed",
    ));
    socket.once("finish", onFinish);
    socket.once("error", onError);
    socket.once("close", onClose);
    try {
      socket.end();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return result;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function errorCode(error: unknown): string {
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate)
    ? candidate
    : "CAPSULE_OPERATION_FAILED";
}

function isFatalGuestError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "fatalGuest" in error
    && (error as { fatalGuest?: unknown }).fatalGuest === true;
}

function asContainmentError(message: string, cause: unknown): Error {
  if (cause instanceof Error && isFatalGuestError(cause)) return cause;
  return new GuestContainmentError(message, { cause });
}

function boundedMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 1_024) || "Capsule operation failed";
}
