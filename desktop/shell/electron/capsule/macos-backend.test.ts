import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough, Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  CAPSULE_PROTOCOL_VERSION,
  type GuestEvent,
  type JsonValue,
  type StreamKind,
} from "../../../capsule/src/protocol/types";
import {
  JsonFrameDecoder,
  MAX_ARTIFACT_ADOPTION_RECEIPT_BYTES,
} from "../../../capsule/src/protocol/codec";
import { parseArtifactAdoptionReceipt } from "../../../capsule/src/protocol/validate";
import type { CapsuleVmHostStream } from "../capsule-vm/launcher";
import type { LoadedCapsuleGuestRelease } from "./guest-release";
import { HostArtifactStore, type HostArtifact, type HostArtifactActivation } from "./artifact-store";
import type { CapsuleTreeSnapshot } from "./package-snapshot";
import type { NpmDependencyBundle } from "./dependency-broker";
import type { SystemStreamServer } from "./system-stream";
import { CapsuleGuestRequestError } from "./guest-session";
import {
  CapsuleRestartRequiredError,
  isCapsuleRestartRequiredError,
  type CapsuleUiPreparation,
} from "./backend";
import { MacOsCapsuleBackend, type MacOsCapsuleBackendOptions } from "./macos-backend";
import { CapsuleStorageBudget, type CapsuleStorageBudgetLike } from "./storage-budget";

const IMAGE = `sha256:${"1".repeat(64)}`;
const PACKAGE_A = `sha256:${"2".repeat(64)}`;
const PACKAGE_B = `sha256:${"3".repeat(64)}`;
const DEPENDENCY = `sha256:${"4".repeat(64)}`;
const INSTALL = `sha256:${"7".repeat(64)}`;
const INSTALL_B = `sha256:${"8".repeat(64)}`;
const ARTIFACT_A = `sha256:${"5".repeat(64)}`;
const ARTIFACT_B = `sha256:${"6".repeat(64)}`;
const LARGE_DEPENDENCY = `sha256:${"9".repeat(64)}`;
const MANIFEST_AUTHORITY: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
const CHANGED_MANIFEST_AUTHORITY: `sha256:${string}` = `sha256:${"b".repeat(64)}`;
const SESSION_ID = "S".repeat(43);

describe("MacOsCapsuleBackend orchestration", () => {
  test("rejects a package snapshot whose manifest changed after Core issued authority", async () => {
    const harness = createHarness();
    harness.manifestDigest = CHANGED_MANIFEST_AUTHORITY;

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("App manifest authority changed; refresh and retry");

    expect(harness.vm.startCalls).toBe(0);
    expect(harness.session.operations).toEqual([]);
    expect(harness.dependencies).not.toHaveBeenCalled();
  });

  test("plans a Replay-sized cold launch into an exact 4 GiB state descriptor", async () => {
    const harness = createHarness();
    await harness.backend.startUi(spec("sender-a"));
    expect(harness.storageEvents.slice(0, 4)).toEqual([
      "reconcile:0:/private/state/capsule/state.raw",
      "reserve:4294967296:/private/state/capsule/state.raw",
      "startGuest",
      "settle",
    ]);
    expect(harness.vm.startDescriptors).toEqual([
      expect.objectContaining({ stateDiskBytes: 4 * 1024 * 1024 * 1024 }),
    ]);
    expect(harness.lifecycleEvents.indexOf("dependency.planned"))
      .toBeLessThan(harness.lifecycleEvents.indexOf("vm.start"));
    expect(harness.lifecycleEvents.indexOf("state.prepare.cancelled"))
      .toBeLessThan(harness.lifecycleEvents.indexOf("dependency.planned"));
    await harness.backend.stopAll();
    expect(harness.lifecycleEvents.slice(-3)).toEqual([
      "helper.stop.confirmed",
      "session.close",
      "helper.close",
    ]);
  });

  test("drains and reboots an idle Guest before growing its exact state capacity", async () => {
    const harness = createHarness();
    const first = await harness.backend.startUi(spec("sender-a"));
    await harness.backend.stopUi(first.instanceId);

    harness.packageDigest = PACKAGE_B;
    harness.installWarmEligible = false;
    harness.dependencyDigest = LARGE_DEPENDENCY;
    harness.dependencyBytes = 128 * 1024 * 1024;
    harness.session.cacheBlob("dependency", LARGE_DEPENDENCY);

    await harness.backend.startUi(spec("sender-b"));
    expect(harness.vm.startCalls).toBe(2);
    expect(harness.vm.stopCalls).toBe(1);
    expect(harness.session.operations.filter((operation) => operation === "vm.drain"))
      .toHaveLength(1);
    const capacities = harness.vm.startDescriptors.map((value) => value.stateDiskBytes as number);
    expect(capacities[0]).toBe(4 * 1024 * 1024 * 1024);
    expect(capacities[1]).toBeGreaterThan(capacities[0]!);
    expect(harness.storageEvents).toContain(
      `reserve:${capacities[1]}:/private/state/capsule/state.raw`,
    );
    await harness.backend.stopAll();
  });

  test("rejects Guest capacity growth without disturbing a live last-known-good App", async () => {
    const harness = createHarness();
    const first = await harness.backend.startUi(spec("sender-a"));

    harness.packageDigest = PACKAGE_B;
    harness.installWarmEligible = false;
    harness.dependencyDigest = LARGE_DEPENDENCY;
    harness.dependencyBytes = 128 * 1024 * 1024;
    harness.session.cacheBlob("dependency", LARGE_DEPENDENCY);

    await expect(harness.backend.replaceUi(first.instanceId, spec("sender-b")))
      .rejects.toThrow("last-known-good runtime remains active");
    expect(harness.vm.startCalls).toBe(1);
    expect(harness.vm.stopCalls).toBe(0);
    expect(harness.session.buildStarts).toBe(1);
    const viewer = await harness.backend.openUiStream(first.instanceId);
    viewer.destroy();
    await harness.backend.stopAll();
  });

  test("boots lazily, cold-builds once, attaches SDK before start, streams a viewer, then takes the warm path", async () => {
    const harness = createHarness();
    const first = await harness.backend.startUi(spec("sender-a"));

    expect(harness.vm.listenerCountsAtStart).toEqual({ stream: 1, event: 1, close: 1 });
    expect(harness.session.operations).toEqual(expect.arrayContaining([
      "ping",
      "blob.import.prepare",
      "build.prepare",
      "build.start",
      "blob.export.prepare",
      "app.prepare",
      "workload.prepare",
      "workload.start",
    ]));
    expect(harness.system.attachments).toHaveLength(1);
    expect(harness.session.sdkWasAttachedAtStart).toBe(true);
    expect(harness.dependencies).toHaveBeenCalledTimes(1);
    expect(harness.session.buildStarts).toBe(1);
    expect(harness.session.artifactOutHostReceipts).toBe(1);
    expect(harness.session.artifactOutHostHalfCloses).toBe(1);
    expect(harness.lifecycleEvents.indexOf("artifact.cas.committed"))
      .toBeLessThan(harness.lifecycleEvents.indexOf("artifact.host.receipt"));
    expect(harness.lifecycleEvents.indexOf("artifact.host.receipt"))
      .toBeLessThan(harness.lifecycleEvents.indexOf("artifact.host.fin"));

    const viewer = await harness.backend.openUiStream(first.instanceId);
    expect(harness.session.operations.at(-1)).toBe("viewer.attach");
    expect(viewer).toBeInstanceOf(PassThrough);
    viewer.destroy();

    await harness.backend.stopUi(first.instanceId);
    const second = await harness.backend.startUi(spec("sender-b"));
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(harness.dependencies).toHaveBeenCalledTimes(1);
    expect(harness.session.buildStarts).toBe(1);
    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_A);
    await harness.backend.stopAll();
    expect(harness.vm.stopCalls).toBeGreaterThan(0);
  });

  test("keeps a first-launch candidate unactivated and streamable until explicit commit", async () => {
    const harness = createHarness();
    const prepared = await harness.backend.prepareUi(spec("sender-a"));

    expect(harness.store.activation).toBeUndefined();
    expect(harness.store.activationWrites).toBe(0);
    expect(harness.store.retained.get(ARTIFACT_A)).toBe(1);
    const viewer = await harness.backend.openUiStream(prepared.instanceId);

    await expect(harness.backend.commitPreparedUi(prepared.preparationId))
      .resolves.toEqual({ instanceId: prepared.instanceId });
    await expect(harness.backend.commitPreparedUi(prepared.preparationId))
      .resolves.toEqual({ instanceId: prepared.instanceId });
    await expect(harness.backend.abortPreparedUi(prepared.preparationId))
      .rejects.toThrow("already committed");
    expect(harness.store.activationWrites).toBe(1);
    expect(harness.store.activation?.artifact.digest).toBe(ARTIFACT_A);
    expect(harness.store.retained.has(ARTIFACT_A)).toBe(false);
    expect(viewer.destroyed).toBe(false);

    viewer.destroy();
    await harness.backend.stopAll();
  });

  test("authoritatively cleans a launched candidate when prepared-artifact retention fails", async () => {
    const harness = createHarness();
    harness.store.failNextRetain = true;

    await expect(harness.backend.prepareUi(spec("sender-a")))
      .rejects.toThrow("injected prepared artifact retention failure");
    expect(harness.session.stoppedApps).toHaveLength(1);
    expect(harness.system.detached).toBeGreaterThan(0);
    expect(harness.store.activation).toBeUndefined();

    await expect(harness.backend.startUi(spec("sender-b")))
      .resolves.toEqual(expect.objectContaining({ instanceId: expect.any(String) }));
    await harness.backend.stopAll();
  });

  test("aborts a prepared replacement without changing or stopping its last-known-good UI", async () => {
    const harness = createHarness();
    const active = await harness.backend.startUi(spec("sender-a"));
    const activationWrites = harness.store.activationWrites;
    harness.packageDigest = PACKAGE_B;
    const prepared = await harness.backend.prepareUi(spec("sender-b"), active.instanceId);
    const oldViewer = await harness.backend.openUiStream(active.instanceId);
    const candidateViewer = await harness.backend.openUiStream(prepared.instanceId);

    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_A);
    expect(harness.store.activationWrites).toBe(activationWrites);
    expect(harness.session.stoppedApps).toHaveLength(0);

    await harness.backend.abortPreparedUi(prepared.preparationId);
    await expect(harness.backend.abortPreparedUi(prepared.preparationId)).resolves.toBeUndefined();
    await expect(harness.backend.commitPreparedUi(prepared.preparationId))
      .rejects.toThrow("already aborted");
    expect(candidateViewer.destroyed).toBe(true);
    expect(oldViewer.destroyed).toBe(false);
    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_A);
    await expect(harness.backend.openUiStream(prepared.instanceId))
      .rejects.toThrow("no longer active or prepared");
    const stillActive = await harness.backend.openUiStream(active.instanceId);

    oldViewer.destroy();
    stillActive.destroy();
    await harness.backend.stopAll();
  });

  test("replacement commit alone rotates activation, retires the old UI, and publishes the candidate", async () => {
    const harness = createHarness();
    const active = await harness.backend.startUi(spec("sender-a"));
    harness.packageDigest = PACKAGE_B;
    const prepared = await harness.backend.prepareUi(spec("sender-b"), active.instanceId);
    const oldViewer = await harness.backend.openUiStream(active.instanceId);
    const candidateViewer = await harness.backend.openUiStream(prepared.instanceId);
    const writesBeforeCommit = harness.store.activationWrites;

    const committed = await harness.backend.commitPreparedUi(prepared.preparationId);

    expect(committed).toEqual({ instanceId: prepared.instanceId });
    expect(harness.store.activationWrites).toBe(writesBeforeCommit + 1);
    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_B);
    expect(oldViewer.destroyed).toBe(true);
    expect(candidateViewer.destroyed).toBe(false);
    await expect(harness.backend.openUiStream(active.instanceId))
      .rejects.toThrow("no longer active or prepared");
    const currentViewer = await harness.backend.openUiStream(prepared.instanceId);

    candidateViewer.destroy();
    currentViewer.destroy();
    await harness.backend.stopAll();
  });

  test("rolls activation back instead of publishing when the previous UI exits during commit", async () => {
    const harness = createHarness();
    const active = await harness.backend.startUi(spec("sender-a"));
    harness.packageDigest = PACKAGE_B;
    const prepared = await harness.backend.prepareUi(spec("sender-b"), active.instanceId);
    harness.store.afterNextActivation = () => harness.session.emitOldestWorkloadExit();

    await expect(harness.backend.commitPreparedUi(prepared.preparationId))
      .rejects.toThrow("exited");

    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_A);
    expect(harness.store.retained.size).toBe(0);
    await expect(harness.backend.openUiStream(prepared.instanceId))
      .rejects.toThrow("no longer active or prepared");
    await expect(harness.backend.openUiStream(active.instanceId))
      .rejects.toThrow("no longer active or prepared");
    await harness.backend.stopAll();
  });

  test("rejects a prepared candidate exit at commit while preserving the prior UI", async () => {
    const harness = createHarness();
    const uiLost = vi.fn();
    harness.backend.setUiLostHandler(uiLost);
    const active = await harness.backend.startUi(spec("sender-a"));
    harness.packageDigest = PACKAGE_B;
    const prepared = await harness.backend.prepareUi(spec("sender-b"), active.instanceId);

    harness.session.emitLatestWorkloadExit();

    expect(uiLost).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: prepared.instanceId,
      appId: "weather",
    }));
    await expect(harness.backend.commitPreparedUi(prepared.preparationId))
      .rejects.toThrow("exited");
    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_A);
    const oldViewer = await harness.backend.openUiStream(active.instanceId);
    await expect(harness.backend.openUiStream(prepared.instanceId))
      .rejects.toThrow("no longer active or prepared");
    await vi.waitFor(() => {
      expect(harness.session.stoppedApps).toHaveLength(1);
      expect(harness.store.retained.size).toBe(0);
    });

    oldViewer.destroy();
    await harness.backend.stopAll();
  });

  test("admits prepared abort after ordinary viewer work saturates the queue", async () => {
    const harness = createHarness();
    const prepared = await harness.backend.prepareUi(spec("sender-a"));
    harness.session.blockViewerAttach();
    const attachments = Array.from(
      { length: 32 },
      () => harness.backend.openUiStream(prepared.instanceId),
    );
    const attachmentResults = Promise.allSettled(attachments);
    const aborting = harness.backend.abortPreparedUi(prepared.preparationId);

    await vi.waitFor(() => {
      expect(harness.session.operations.at(-1)).toBe("viewer.attach");
    });
    harness.session.releaseViewerAttach();

    await expect(aborting).resolves.toBeUndefined();
    for (const result of await attachmentResults) {
      if (result.status === "fulfilled") result.value.destroy();
    }
    expect(harness.store.retained.size).toBe(0);
    await expect(harness.backend.commitPreparedUi(prepared.preparationId))
      .rejects.toThrow("already aborted");
    await harness.backend.stopAll();
  });

  test("global stop discards prepared UIs and invalidates their transaction handles", async () => {
    const harness = createHarness();
    const prepared = await harness.backend.prepareUi(spec("sender-a"));
    const viewer = await harness.backend.openUiStream(prepared.instanceId);

    await harness.backend.stopAll();

    expect(viewer.destroyed).toBe(true);
    expect(harness.store.activation).toBeUndefined();
    expect(harness.store.retained.size).toBe(0);
    await expect(harness.backend.commitPreparedUi(prepared.preparationId))
      .rejects.toThrow("already aborted");
  });

  test("retirement stops active and prepared generations before removing activation", async () => {
    const harness = createHarness();
    const active = await harness.backend.startUi(spec("sender-a"));
    harness.packageDigest = PACKAGE_B;
    const prepared = await harness.backend.prepareUi(spec("sender-b"), active.instanceId);
    const oldViewer = await harness.backend.openUiStream(active.instanceId);
    const candidateViewer = await harness.backend.openUiStream(prepared.instanceId);

    await harness.backend.retireApp("weather");

    expect(oldViewer.destroyed).toBe(true);
    expect(candidateViewer.destroyed).toBe(true);
    expect(harness.session.stoppedApps).toHaveLength(2);
    expect(harness.store.activation).toBeUndefined();
    expect(harness.store.retained.size).toBe(0);
    await expect(harness.backend.commitPreparedUi(prepared.preparationId))
      .rejects.toThrow("already aborted");
    await harness.backend.stopAll();
  });

  test("rebuilds source-only changes from the same-App sealed base without invoking the dependency broker", async () => {
    const harness = createHarness();
    const first = await harness.backend.startUi(spec("sender-a"));
    harness.packageDigest = PACKAGE_B;

    await harness.backend.replaceUi(first.instanceId, spec("sender-b"));

    expect(harness.dependencies).toHaveBeenCalledTimes(1);
    expect(harness.session.buildStarts).toBe(2);
    expect(harness.session.buildPrepares.at(-1)).toMatchObject({
      installDigest: INSTALL,
      baseArtifactDigest: ARTIFACT_A,
      baseDependencyDigest: DEPENDENCY,
    });
    expect(harness.session.buildPrepares.at(-1)).not.toHaveProperty("dependencyBlobHandle");
    expect(harness.store.activation).toMatchObject({
      packageDigest: PACKAGE_B,
      installDigest: INSTALL,
      dependencyDigest: DEPENDENCY,
    });
    await harness.backend.stopAll();
  });

  test("cold-migrates an exact legacy V1 activation before allowing dependency reuse", async () => {
    const harness = createHarness();
    const artifact = hostArtifact(ARTIFACT_A as `sha256:${string}`, Buffer.alloc(64, 7));
    harness.store.cas.set(artifact.digest, artifact);
    harness.store.activation = {
      artifact,
      packageDigest: PACKAGE_A as `sha256:${string}`,
      imageDigest: IMAGE as `sha256:${string}`,
    };

    await harness.backend.startUi(spec("sender-a"));

    expect(harness.dependencies).toHaveBeenCalledOnce();
    expect(harness.session.buildStarts).toBe(1);
    expect(harness.session.buildPrepares.at(-1)).toHaveProperty("dependencyBlobHandle");
    expect(harness.session.buildPrepares.at(-1)).not.toHaveProperty("baseArtifactBlobHandle");
    expect(harness.store.activation).toMatchObject({
      packageDigest: PACKAGE_A,
      installDigest: INSTALL,
      dependencyDigest: DEPENDENCY,
    });
    await harness.backend.stopAll();
  });

  test("cold-builds when install inputs change and cold-retries an authoritative warm miss", async () => {
    const changed = createHarness();
    const first = await changed.backend.startUi(spec("sender-a"));
    changed.packageDigest = PACKAGE_B;
    changed.installDigest = INSTALL_B;
    await changed.backend.replaceUi(first.instanceId, spec("sender-b"));
    expect(changed.dependencies).toHaveBeenCalledTimes(2);
    expect(changed.session.buildPrepares.at(-1)).toHaveProperty("dependencyBlobHandle");
    expect(changed.session.buildPrepares.at(-1)).not.toHaveProperty("baseArtifactBlobHandle");
    await changed.backend.stopAll();

    const fallback = createHarness();
    const active = await fallback.backend.startUi(spec("sender-a"));
    fallback.packageDigest = PACKAGE_B;
    fallback.session.failNextWarmBuild = true;
    await fallback.backend.replaceUi(active.instanceId, spec("sender-b"));
    expect(fallback.dependencies).toHaveBeenCalledTimes(2);
    expect(fallback.session.operations).toContain("build.cancel");
    expect(fallback.session.buildPrepares.slice(-2).map((body) => (
      body.baseArtifactDigest === undefined ? "cold" : "warm"
    ))).toEqual(["warm", "cold"]);
    expect(fallback.session.imports.size).toBe(0);
    await fallback.backend.stopAll();
  });

  test("routes ineligible install inputs and Guest-image changes through the cold builder", async () => {
    const ineligible = createHarness();
    const first = await ineligible.backend.startUi(spec("sender-a"));
    ineligible.packageDigest = PACKAGE_B;
    ineligible.installWarmEligible = false;
    await ineligible.backend.replaceUi(first.instanceId, spec("sender-b"));
    expect(ineligible.dependencies).toHaveBeenCalledTimes(2);
    expect(ineligible.session.buildPrepares.at(-1)).toHaveProperty("dependencyBlobHandle");
    expect(ineligible.session.buildPrepares.at(-1)).not.toHaveProperty("baseArtifactBlobHandle");
    await ineligible.backend.stopAll();

    const imageChanged = createHarness();
    const active = await imageChanged.backend.startUi(spec("sender-a"));
    imageChanged.packageDigest = PACKAGE_B;
    imageChanged.store.activation = {
      ...imageChanged.store.activation!,
      imageDigest: `sha256:${"9".repeat(64)}`,
    };
    await imageChanged.backend.replaceUi(active.instanceId, spec("sender-b"));
    expect(imageChanged.dependencies).toHaveBeenCalledTimes(2);
    expect(imageChanged.session.buildPrepares.at(-1)).toHaveProperty("dependencyBlobHandle");
    expect(imageChanged.session.buildPrepares.at(-1)).not.toHaveProperty("baseArtifactBlobHandle");
    await imageChanged.backend.stopAll();
  });

  test("rejects a correlated Guest blob failure while exporting a Build artifact", async () => {
    const harness = createHarness();
    harness.session.failNextExport = true;

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("Guest blob export failed: export source failed");
    expect(harness.session.operations).toContain("build.cancel");
    expect(harness.store.activation).toBeUndefined();
    await harness.backend.stopAll();
  });

  test("does not acknowledge or FIN artifact-out before Host CAS verification succeeds", async () => {
    const harness = createHarness();
    harness.store.failNextReceiveAfterDrain = true;

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("injected artifact verification failure");
    expect(harness.session.artifactOutHostReceipts).toBe(0);
    expect(harness.session.artifactOutHostHalfCloses).toBe(0);
    expect(harness.lifecycleEvents).not.toContain("artifact.host.receipt");
    expect(harness.lifecycleEvents).not.toContain("artifact.host.fin");
    await harness.backend.stopAll();
  });

  test("does not FIN or activate when the artifact adoption receipt cannot be delivered", async () => {
    const harness = createHarness();
    harness.session.failNextArtifactReceiptWrite = true;

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("injected artifact adoption receipt write failure");
    expect(harness.lifecycleEvents).toContain("artifact.cas.committed");
    expect(harness.session.artifactOutHostReceipts).toBe(0);
    expect(harness.session.artifactOutHostHalfCloses).toBe(0);
    expect(harness.store.activation).toBeUndefined();
    await harness.backend.stopAll();
  });

  test("keeps the transfer deadline active while the physical Host FIN is stalled", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.session.holdArtifactOutHostFinal = true;

      const opening = rejectionOf(harness.backend.startUi(spec("sender-a")));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_001);

      await expect(opening).resolves.toMatchObject({
        message: expect.stringContaining("idle deadline (64/64 bytes observed; phase=host-fin)"),
      });
      expect(harness.session.artifactOutHostReceipts).toBe(1);
      expect(harness.session.artifactOutHostHalfCloses).toBe(0);
      expect(harness.store.activation).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("retires exact Build imports when prepare fails before Guest dispatch", async () => {
    const harness = createHarness();
    harness.session.failBeforeOperation = "build.prepare";

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("injected pre-dispatch build.prepare failure");
    expect(harness.session.releasedImports).toEqual(expect.arrayContaining([
      expect.objectContaining({ blobKind: "package", digest: PACKAGE_A }),
      expect.objectContaining({ blobKind: "dependency", digest: DEPENDENCY }),
    ]));
    expect(harness.session.imports.size).toBe(0);
    await harness.backend.stopAll();
  });

  test("does not mask a boundary-losing secondary import with redundant Guest cleanup", async () => {
    const harness = createHarness();
    harness.session.failNextDataStreamKind = "dependency-in";
    harness.session.loseBoundaryOnDataStreamFailure = true;

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("injected dependency-in DATA failure");
    expect(harness.session.operations).not.toContain("blob.import.release");
    expect(harness.session.releasedImports).toHaveLength(0);
    await harness.backend.stopAll();
  });

  test("reports the secondary import failure and its own cleanup failure", async () => {
    const harness = createHarness();
    harness.session.failNextDataStreamKind = "dependency-in";
    harness.session.failImportReleaseForKind = "dependency";

    await expect(harness.backend.startUi(spec("sender-a"))).rejects.toThrow(
      "Guest blob import cleanup failed: injected dependency-in DATA failure; cleanup: injected dependency import release failure",
    );
    expect(harness.session.releasedImports).toEqual([
      expect.objectContaining({ blobKind: "dependency", digest: DEPENDENCY }),
    ]);
    await harness.backend.stopAll();
  });

  test("reports a secondary import failure and failed package rollback together", async () => {
    const harness = createHarness();
    harness.session.failNextDataStreamKind = "dependency-in";
    harness.session.failImportReleaseForKind = "package";

    await expect(harness.backend.startUi(spec("sender-a"))).rejects.toThrow(
      "Partial Build import cleanup failed: injected dependency-in DATA failure; cleanup: injected package import release failure",
    );
    expect(harness.session.releasedImports).toEqual([
      expect.objectContaining({ blobKind: "dependency", digest: DEPENDENCY }),
      expect.objectContaining({ blobKind: "package", digest: PACKAGE_A }),
    ]);
    await harness.backend.stopAll();
  });

  test("retires a completed Build output when Host CAS lookup fails before export handoff", async () => {
    const harness = createHarness();
    harness.store.failNextFind = true;

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("injected artifact lookup failure");
    expect(harness.session.operations).not.toContain("blob.export.prepare");
    expect(harness.session.operations).toContain("build.cancel");
    expect(harness.session.outputReleases).toEqual([
      expect.objectContaining({ digest: ARTIFACT_A, bytes: 64 }),
    ]);
    await harness.backend.stopAll();
  });

  test("retires the exact artifact import when app.prepare fails before Guest dispatch", async () => {
    const harness = createHarness();
    harness.session.failBeforeOperation = "app.prepare";

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("injected pre-dispatch app.prepare failure");
    expect(harness.session.releasedImports).toContainEqual(
      expect.objectContaining({ blobKind: "artifact", digest: ARTIFACT_A, bytes: 64 }),
    );
    expect(harness.session.imports.size).toBe(0);
    expect(harness.session.stoppedApps).toHaveLength(0);
    await harness.backend.stopAll();
  });

  test("allocates Build authority before importing package or dependency blobs", async () => {
    let calls = 0;
    const harness = createHarness({
      opaqueId: () => {
        calls += 1;
        if (calls === 2) throw new Error("injected Build identity exhaustion");
        return `${"A".repeat(20)}${String(calls).padStart(2, "0")}`;
      },
    });

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("injected Build identity exhaustion");
    expect(harness.session.operations).not.toContain("blob.import.prepare");
    expect(harness.session.imports.size).toBe(0);
    await harness.backend.stopAll();
  });

  test("allocates App authority before importing its runtime artifact", async () => {
    let calls = 0;
    const harness = createHarness({
      opaqueId: () => {
        calls += 1;
        if (calls === 3) throw new Error("injected App identity exhaustion");
        return `${"A".repeat(20)}${String(calls).padStart(2, "0")}`;
      },
    });
    const artifact = hostArtifact(ARTIFACT_A as `sha256:${string}`, Buffer.alloc(64, 7));
    harness.store.cas.set(artifact.digest, artifact);
    harness.store.activation = {
      artifact,
      packageDigest: PACKAGE_A as `sha256:${string}`,
      imageDigest: IMAGE as `sha256:${string}`,
    };

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("injected App identity exhaustion");
    expect(harness.session.operations).not.toContain("blob.import.prepare");
    expect(harness.session.imports.size).toBe(0);
    await harness.backend.stopAll();
  });

  test("keeps the old UI and activation on failed readiness, then atomically replaces it after success", async () => {
    const harness = createHarness();
    const first = await harness.backend.startUi(spec("sender-a"));
    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_A);

    harness.packageDigest = PACKAGE_B;
    harness.session.failNextReady = true;
    await expect(harness.backend.replaceUi(first.instanceId, spec("sender-b")))
      .rejects.toThrow("not ready");
    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_A);
    const oldViewer = await harness.backend.openUiStream(first.instanceId);
    oldViewer.destroy();

    const replacement = await harness.backend.replaceUi(first.instanceId, spec("sender-c"));
    expect(replacement.instanceId).not.toBe(first.instanceId);
    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_B);
    await expect(harness.backend.openUiStream(first.instanceId)).rejects.toThrow("no longer active");
    const viewer = await harness.backend.openUiStream(replacement.instanceId);
    viewer.destroy();

    const initialPrepare = harness.session.appPrepares[0]!;
    const replacementPrepare = harness.session.appPrepares.at(-1)!;
    expect(initialPrepare.mappedHostUid).not.toBe(replacementPrepare.mappedHostUid);
    expect(harness.session.stoppedApps).toContain(initialPrepare.appHandle);
    await harness.backend.stopAll();
  });

  test("restores the last-known-good activation when previous UI retirement is not confirmed", async () => {
    const harness = createHarness();
    const first = await harness.backend.startUi(spec("sender-a"));
    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_A);

    harness.packageDigest = PACKAGE_B;
    harness.session.failAppStop = true;
    await expect(harness.backend.replaceUi(first.instanceId, spec("sender-b")))
      .rejects.toThrow("Could not stop UI");
    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_A);
  });

  test("surfaces typed restart-required state from the operation that first sees an unconfirmed stop", async () => {
    const harness = createHarness();
    const first = await harness.backend.startUi(spec("sender-a"));
    harness.packageDigest = PACKAGE_B;
    harness.session.failAppStop = true;
    harness.vm.failStop = true;

    const failure = await rejectionOf(
      harness.backend.replaceUi(first.instanceId, spec("sender-b")),
    );
    expect(isCapsuleRestartRequiredError(failure)).toBe(true);
    expect(failure.message).toContain("quarantined until Host restart");
  });

  test("restores the last-known-good activation when a candidate exits during activation", async () => {
    const harness = createHarness();
    const first = await harness.backend.startUi(spec("sender-a"));
    harness.packageDigest = PACKAGE_B;
    harness.store.afterNextActivation = () => harness.session.emitLatestWorkloadExit();

    await expect(harness.backend.replaceUi(first.instanceId, spec("sender-b")))
      .rejects.toThrow("exited");
    expect(harness.store.activation?.packageDigest).toBe(PACKAGE_A);
    const oldViewer = await harness.backend.openUiStream(first.instanceId);
    oldViewer.destroy();
    await harness.backend.stopAll();
  });

  test("removes a first-launch activation when its candidate exits before publication", async () => {
    const harness = createHarness();
    harness.store.afterNextActivation = () => harness.session.emitLatestWorkloadExit();

    await expect(harness.backend.startUi(spec("sender-a"))).rejects.toThrow("exited");
    expect(harness.store.activation).toBeUndefined();
    await harness.backend.stopAll();
  });

  test("cancels an in-flight build before a queued App stop", async () => {
    const harness = createHarness();
    harness.session.holdBuild = true;
    const launch = harness.backend.startUi(spec("sender-a"));
    await vi.waitFor(() => expect(harness.session.operations).toContain("build.start"));

    const stop = harness.backend.stopApp("weather");
    await expect(launch).rejects.toThrow(/stop requested|cancelled/);
    await stop;
    expect(harness.session.operations).toContain("build.cancel");
    expect(harness.store.activation).toBeUndefined();
    await harness.backend.stopAll();
  });

  test("collapses every live instance on an asynchronous Guest boundary failure", async () => {
    const harness = createHarness();
    const boundaryLost = vi.fn();
    harness.backend.setBoundaryLostHandler(boundaryLost);
    const instance = await harness.backend.startUi(spec("sender-a"));

    harness.session.emit("fatal", new Error("CONTROL was lost"));
    await vi.waitFor(() => expect(boundaryLost).toHaveBeenCalledOnce());
    expect(boundaryLost).toHaveBeenCalledWith(expect.objectContaining({ message: "CONTROL was lost" }));
    await expect(harness.backend.openUiStream(instance.instanceId))
      .rejects.toThrow("Capsule boundary recovery is still in progress");
    expect(harness.system.detached).toBeGreaterThan(0);
    expect(harness.vm.stopCalls).toBeGreaterThan(0);
  });

  test("revokes Host authority before a blocking VM stop and shares one fatal cleanup", async () => {
    const harness = createHarness();
    const instance = await harness.backend.startUi(spec("sender-a"));
    harness.vm.blockStop();
    let stopFromBoundary: Promise<void> | undefined;
    const detachedAtNotification: number[] = [];
    harness.backend.setBoundaryLostHandler(() => {
      detachedAtNotification.push(harness.system.detached);
      // This matches CapsuleManager's immediate fail-closed callback. It must
      // join the published fatal cleanup, not start a second VM teardown.
      stopFromBoundary = harness.backend.stopAll();
    });

    harness.session.emit("fatal", new Error("CONTROL was lost"));
    await vi.waitFor(() => expect(detachedAtNotification).toEqual([1]));
    expect(harness.vm.stopCalls).toBe(1);
    expect(harness.lifecycleEvents).toContain("helper.stop.begin");
    expect(harness.lifecycleEvents).not.toContain("session.close");
    await expect(harness.backend.openUiStream(instance.instanceId))
      .rejects.toThrow("Capsule backend is stopping");

    harness.vm.releaseStop();
    await stopFromBoundary;
    expect(harness.vm.stopCalls).toBe(1);
    expect(harness.lifecycleEvents.slice(-3)).toEqual([
      "helper.stop.confirmed",
      "session.close",
      "helper.close",
    ]);
  });

  test("publishes one stopping fence while joining an in-progress fatal cleanup", async () => {
    const harness = createHarness();
    await harness.backend.startUi(spec("sender-a"));
    harness.vm.blockStop();
    let firstStop: Promise<void> | undefined;
    let duplicateStop: Promise<void> | undefined;
    let lateLaunch: Promise<CapsuleUiPreparation> | undefined;
    harness.backend.setBoundaryLostHandler(() => {
      firstStop = harness.backend.stopAll();
      duplicateStop = harness.backend.stopAll();
      lateLaunch = harness.backend.prepareUi(spec("sender-b"));
    });

    harness.session.emit("fatal", new Error("CONTROL was lost"));
    await vi.waitFor(() => expect(firstStop).toBeDefined());

    expect(duplicateStop).toBe(firstStop);
    await expect(lateLaunch).rejects.toThrow("Capsule backend is stopping");
    expect(harness.vm.stopCalls).toBe(1);

    harness.vm.releaseStop();
    await firstStop;
  });

  test("bounds stopAll while joining fatal cleanup and quarantines its stopping helper", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await harness.backend.startUi(spec("sender-a"));
      harness.lifecycleEvents.length = 0;
      harness.vm.blockStop();
      let stopFromBoundary: Promise<void> | undefined;
      harness.backend.setBoundaryLostHandler(() => {
        stopFromBoundary = harness.backend.stopAll();
      });

      harness.session.emit("fatal", new Error("CONTROL was lost"));
      await vi.advanceTimersByTimeAsync(0);
      expect(stopFromBoundary).toBeDefined();
      expect(harness.lifecycleEvents).toContain("helper.stop.begin");
      const rejected = expect(stopFromBoundary).rejects.toMatchObject({
        name: "CapsuleRestartRequiredError",
        restartRequired: true,
      });

      await vi.advanceTimersByTimeAsync(15_000);

      await rejected;
      expect(harness.lifecycleEvents).toContain("helper.close");
      await expect(harness.backend.status()).resolves.toMatchObject({
        available: false,
        restartRequired: true,
      });
      expect(harness.backend.stopAll()).toBe(stopFromBoundary);

      harness.vm.releaseStop();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("quarantines and detaches a global stop that exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await harness.backend.startUi(spec("sender-a"));
      harness.vm.blockStop();

      const stopping = harness.backend.stopAll();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.lifecycleEvents).toContain("helper.stop.begin");
      const rejected = expect(stopping).rejects.toMatchObject({
        name: "CapsuleRestartRequiredError",
        restartRequired: true,
      });
      await vi.advanceTimersByTimeAsync(15_000);

      await rejected;
      expect(harness.system.detached).toBeGreaterThan(0);
      expect(harness.lifecycleEvents).toContain("helper.close");
      await expect(harness.backend.status()).resolves.toMatchObject({
        available: false,
        restartRequired: true,
      });

      harness.vm.releaseStop();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("loses the whole VM boundary when App teardown is not confirmed", async () => {
    const harness = createHarness();
    const boundaryLost = vi.fn();
    harness.backend.setBoundaryLostHandler(boundaryLost);
    const instance = await harness.backend.startUi(spec("sender-a"));
    harness.session.failAppStop = true;

    await expect(harness.backend.stopUi(instance.instanceId)).rejects.toThrow("Could not stop UI");
    await vi.waitFor(() => expect(boundaryLost).toHaveBeenCalledOnce());
    await expect(harness.backend.openUiStream(instance.instanceId)).rejects.toThrow("no longer active");
    expect(harness.vm.stopCalls).toBeGreaterThan(0);
  });

  test("rejects viewer fan-out locally before it can exhaust the Guest DATA budget", async () => {
    const harness = createHarness();
    const instance = await harness.backend.startUi(spec("sender-a"));
    const streams = await Promise.all(
      Array.from({ length: 8 }, async () => await harness.backend.openUiStream(instance.instanceId)),
    );

    await expect(harness.backend.openUiStream(instance.instanceId))
      .rejects.toThrow("viewer connection limit");
    expect(harness.session.operations.filter((operation) => operation === "viewer.attach"))
      .toHaveLength(8);
    for (const stream of streams) stream.destroy();
    await harness.backend.stopAll();
  });

  test("cannot publish a boot boundary that faults as ping completes", async () => {
    const harness = createHarness();
    const boundaryLost = vi.fn();
    harness.backend.setBoundaryLostHandler(boundaryLost);
    harness.session.fatalAfterPing = true;

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("failed during authenticated boot");
    await vi.waitFor(() => expect(boundaryLost).toHaveBeenCalledOnce());
    expect(harness.vm.stopCalls).toBeGreaterThan(0);
    expect(harness.session.operations).toEqual(["ping"]);
  });

  test("surfaces an unconfirmed Virtualization.framework stop", async () => {
    const harness = createHarness();
    await harness.backend.startUi(spec("sender-a"));
    harness.vm.failStop = true;

    await expect(harness.backend.stopAll())
      .rejects.toThrow("quarantined until Host restart");
    expect(harness.vm.stopCalls).toBeGreaterThan(0);
    await expect(harness.backend.status()).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining("quarantined"),
    });
  });

  test("quarantines a failed boot when its VZ cleanup cannot be confirmed", async () => {
    const harness = createHarness();
    harness.vm.badArchitecture = true;
    harness.vm.failStop = true;

    const failure = await rejectionOf(harness.backend.startUi(spec("sender-a")));
    expect(failure.message).toContain("VM helper start result does not match the verified Guest release");
    expect(failure.message).toContain("quarantined until Host restart");
    expect(harness.lifecycleEvents.slice(-3)).toEqual([
      "helper.stop.begin",
      "session.close",
      "helper.close",
    ]);
    await expect(harness.backend.startUi(spec("sender-b")))
      .rejects.toThrow("quarantined until Host restart");
    expect(harness.vm.startCalls).toBe(1);
  });

  test("keeps CONTROL open until failed-boot VZ cleanup is confirmed", async () => {
    const harness = createHarness();
    harness.vm.badArchitecture = true;

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("VM helper start result does not match the verified Guest release");
    expect(harness.lifecycleEvents.slice(-3)).toEqual([
      "helper.stop.confirmed",
      "session.close",
      "helper.close",
    ]);
  });

  test("rejects a launch when the Host SDK stream closes before UI readiness", async () => {
    const harness = createHarness();
    harness.system.closeOnAttach = true;

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("SDK transport closed");
    expect(harness.store.activation).toBeUndefined();
    expect(harness.session.stoppedApps).toHaveLength(1);
    await harness.backend.stopAll();
  });

  test("allows an App to close an unused SDK Unix-socket connection after readiness without forging a new identity", async () => {
    const harness = createHarness();
    const instance = await harness.backend.startUi(spec("sender-a"));
    harness.system.closeLatest(new Error("App closed SDK Unix socket"));

    const viewer = await harness.backend.openUiStream(instance.instanceId);
    expect(viewer).toBeInstanceOf(PassThrough);
    viewer.destroy();
    expect(harness.system.attachments).toHaveLength(1);
    await harness.backend.stopAll();
  });

  test("reports a post-readiness exit once and removes the instance before Guest cleanup", async () => {
    const harness = createHarness();
    const uiLost = vi.fn();
    harness.backend.setUiLostHandler(uiLost);
    const instance = await harness.backend.startUi(spec("sender-a"));
    const viewer = await harness.backend.openUiStream(instance.instanceId);

    harness.session.emitLatestWorkloadExit();
    await vi.waitFor(() => expect(uiLost).toHaveBeenCalledOnce());
    expect(uiLost).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: instance.instanceId,
      appId: "weather",
      error: expect.objectContaining({ message: expect.stringContaining("exited") }),
    }));
    expect(viewer.destroyed).toBe(true);
    await expect(harness.backend.openUiStream(instance.instanceId))
      .rejects.toThrow("no longer active");
    await vi.waitFor(() => expect(harness.session.stoppedApps.length).toBeGreaterThan(0));
    expect(harness.system.detached).toBeGreaterThan(0);
    await harness.backend.stopAll();
  });

  test("does not report the authenticated exit caused by an expected UI stop", async () => {
    const harness = createHarness();
    const uiLost = vi.fn();
    harness.backend.setUiLostHandler(uiLost);
    harness.session.emitExitOnStop = true;
    const instance = await harness.backend.startUi(spec("sender-a"));

    await harness.backend.stopUi(instance.instanceId);
    expect(uiLost).not.toHaveBeenCalled();
    await harness.backend.stopAll();
  });

  test("retires Guest state before removing only the App-owned Host caches", async () => {
    const harness = createHarness();
    await harness.backend.startUi(spec("sender-a"));
    harness.lifecycleEvents.length = 0;
    harness.storageRemovals.length = 0;
    harness.store.deactivatedKeys.length = 0;
    harness.store.pruneCalls = 0;
    harness.session.trackRetirementLifecycle = true;
    harness.store.trackRetirementLifecycle = true;

    await harness.backend.retireApp("weather");

    const ownerKey = createHash("sha256").update("weather", "utf8").digest("hex");
    expect(harness.store.deactivatedKeys).toEqual([ownerKey]);
    expect(harness.storageRemovals).toEqual([
      { path: `/private/cache/capsule/packages/${ownerKey}`, recursive: true },
      { path: `/private/cache/capsule/dependencies/${ownerKey}`, recursive: true },
    ]);
    expect(harness.store.pruneCalls).toBe(1);
    expect(harness.lifecycleEvents).toEqual([
      "guest.app.stopped",
      "artifact.deactivated",
      "cache.removed",
      "cache.removed",
      "artifact.pruned",
    ]);
    await harness.backend.stopAll();
  });

  test("preserves activation and Host caches when Guest retirement is ambiguous", async () => {
    const harness = createHarness();
    await harness.backend.startUi(spec("sender-a"));
    harness.lifecycleEvents.length = 0;
    harness.storageRemovals.length = 0;
    harness.store.deactivatedKeys.length = 0;
    harness.store.pruneCalls = 0;
    harness.session.failAppStop = true;

    await expect(harness.backend.retireApp("weather")).rejects.toThrow("Could not stop UI");

    expect(harness.store.deactivatedKeys).toEqual([]);
    expect(harness.storageRemovals).toEqual([]);
    expect(harness.store.pruneCalls).toBe(0);
    expect(harness.store.activation).toBeDefined();
  });

  test("rejects cache retirement after boundary loss cannot confirm VZ stop", async () => {
    const harness = createHarness();
    await harness.backend.startUi(spec("sender-a"));
    harness.storageRemovals.length = 0;
    harness.store.deactivatedKeys.length = 0;
    harness.store.pruneCalls = 0;
    harness.vm.failStop = true;

    harness.session.emit("fatal", new Error("injected Guest boundary loss"));
    await vi.waitFor(async () => {
      expect(await harness.backend.status()).toMatchObject({
        available: false,
        restartRequired: true,
      });
    });

    const failure = await rejectionOf(harness.backend.retireApp("weather"));
    expect(failure).toBeInstanceOf(CapsuleRestartRequiredError);
    expect(harness.store.deactivatedKeys).toEqual([]);
    expect(harness.storageRemovals).toEqual([]);
    expect(harness.store.pruneCalls).toBe(0);
    expect(harness.store.activation).toBeDefined();
  });

  test("keeps global shutdown failed after boundary cleanup cannot confirm VZ stop", async () => {
    const harness = createHarness();
    await harness.backend.startUi(spec("sender-a"));
    harness.vm.failStop = true;

    harness.session.emit("fatal", new Error("injected Guest boundary loss"));
    await vi.waitFor(async () => {
      expect(await harness.backend.status()).toMatchObject({
        available: false,
        restartRequired: true,
      });
    });

    const failure = await rejectionOf(harness.backend.stopAll());
    expect(failure).toBeInstanceOf(CapsuleRestartRequiredError);
    await expect(harness.backend.stopAll()).rejects.toBe(failure);
    expect(harness.vm.stopCalls).toBe(1);
  });

  test("reconstructs fresh-process activation ownership and evicts stale residue before new admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-capsule-fresh-host-"));
    try {
      const stateDirectory = join(root, "state");
      const cacheDirectory = join(root, "cache");
      const artifactRoot = join(root, "artifacts");
      const packageRoot = join(cacheDirectory, "packages");
      const dependencyRoot = join(cacheDirectory, "dependencies");
      const ownerKey = appKey("weather");
      const staleOwner = "f".repeat(64);
      const managedRoots = [
        stateDirectory,
        packageRoot,
        dependencyRoot,
        join(artifactRoot, "cas"),
      ];
      const initialBudget = new CapsuleStorageBudget({
        roots: managedRoots,
        aggregateBytes: 1_024,
        perAppBytes: 1_024,
        filesystemReserveBytes: 0,
        dependencies: { availableBytes: async () => 1_000_000 },
      });
      const initialStore = new HostArtifactStore(artifactRoot, { storageBudget: initialBudget });
      const activeBytes = Buffer.from("durable last-known-good artifact");
      const activeIdentity = contentIdentity(activeBytes);
      const activeArtifact = await initialStore.receive(
        ownerKey,
        activeIdentity.digest,
        activeIdentity.bytes,
        Readable.from([activeBytes]),
      );
      await initialStore.activate(ownerKey, activeArtifact, {
        packageDigest: PACKAGE_A,
        imageDigest: IMAGE,
        installDigest: INSTALL,
        dependencyDigest: DEPENDENCY,
      });
      const staleBytes = Buffer.from("unreferenced artifact residue");
      const staleIdentity = contentIdentity(staleBytes);
      const staleArtifact = await initialStore.receive(
        staleOwner,
        staleIdentity.digest,
        staleIdentity.bytes,
        Readable.from([staleBytes]),
      );
      const stalePackage = join(packageRoot, ownerKey, "stale.snapshot");
      const staleDependency = join(dependencyRoot, ownerKey, "stale.tgz");
      await mkdir(join(packageRoot, ownerKey), { recursive: true });
      await mkdir(join(dependencyRoot, ownerKey), { recursive: true });
      await writeFile(stalePackage, Buffer.alloc(19, 1));
      await writeFile(staleDependency, Buffer.alloc(23, 2));

      const admissionBytes = 17;
      let freshBudget!: CapsuleStorageBudget;
      let reachedAdmission = false;
      const lifecycleEvents: string[] = [];
      const vm = new FakeVm(lifecycleEvents);
      const system = new FakeSystemStreamServer();
      const session = new FakeSession(system, lifecycleEvents);
      const backend = new MacOsCapsuleBackend({
        helperPath: join(root, "helper"),
        releaseResourcesRoot: join(root, "resources"),
        stateDirectory,
        cacheDirectory,
        artifactRoot,
        systemStreamServer: system as unknown as SystemStreamServer,
        dependencies: {
          hostPlatform: "darwin",
          exists: () => true,
          loadRelease: async () => guestRelease(),
          launchVm: () => vm as never,
          createSession: () => session as never,
          storageBudget: (roots) => {
            freshBudget = new CapsuleStorageBudget({
              roots,
              aggregateBytes: activeIdentity.bytes + admissionBytes,
              perAppBytes: activeIdentity.bytes + admissionBytes,
              filesystemReserveBytes: 0,
              dependencies: { availableBytes: async () => 1_000_000 },
            });
            return stateNeutralBudget(freshBudget);
          },
          artifactStore: (path, budget) => new HostArtifactStore(path, { storageBudget: budget }),
          snapshot: async ({ ownerKey: snapshotOwner, storageBudget }) => {
            expect(snapshotOwner).toBe(ownerKey);
            expect(await exists(stalePackage)).toBe(false);
            expect(await exists(staleDependency)).toBe(false);
            expect(await exists(staleArtifact.path)).toBe(false);
            expect(await readFile(activeArtifact.path)).toEqual(activeBytes);
            expect(await freshBudget.snapshot()).toMatchObject({
              usedBytes: activeIdentity.bytes,
              ownerUsedBytes: { [ownerKey]: activeIdentity.bytes },
            });
            const reservation = await storageBudget!.reserve({
              owner: ownerKey,
              scope: "package-snapshot",
              bytes: admissionBytes,
            });
            reachedAdmission = true;
            await reservation.release();
            throw new Error("stop after verified fresh-process admission");
          },
          manifestDigest: async () => MANIFEST_AUTHORITY,
          installInput: async () => ({
            digest: INSTALL as `sha256:${string}`,
            warmEligible: true,
          }),
          dependencies: async () => { throw new Error("dependency resolution was not expected"); },
          opaqueId: () => "A".repeat(22),
          nonce: () => 42,
        },
      });

      await expect(backend.startUi({
        ...spec("sender-a"),
        packageDir: join(root, "workspace", "apps", "weather"),
      })).rejects.toThrow("stop after verified fresh-process admission");
      expect(reachedAdmission).toBe(true);
      expect(await freshBudget.snapshot()).toMatchObject({
        usedBytes: activeIdentity.bytes,
        reservedBytes: 0,
        ownerUsedBytes: { [ownerKey]: activeIdentity.bytes },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retireApp removes only reconstructable App caches and is not user-facing archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-capsule-retire-files-"));
    try {
      const workspace = join(root, "workspace");
      const stateDirectory = join(root, "state");
      const cacheDirectory = join(root, "cache");
      const artifactRoot = join(root, "artifacts");
      const packageRoot = join(cacheDirectory, "packages");
      const dependencyRoot = join(cacheDirectory, "dependencies");
      const ownerKey = appKey("weather");
      const otherOwner = appKey("notes");
      const managedRoots = [
        stateDirectory,
        packageRoot,
        dependencyRoot,
        join(artifactRoot, "cas"),
      ];
      const initialBudget = new CapsuleStorageBudget({
        roots: managedRoots,
        aggregateBytes: 1_048_576,
        perAppBytes: 1_048_576,
        filesystemReserveBytes: 0,
        dependencies: { availableBytes: async () => 10_000_000 },
      });
      const initialStore = new HostArtifactStore(artifactRoot, { storageBudget: initialBudget });
      const appArtifactBytes = Buffer.alloc(64, 7);
      const appArtifactIdentity = contentIdentity(appArtifactBytes);
      const appArtifact = await initialStore.receive(
        ownerKey,
        appArtifactIdentity.digest,
        appArtifactIdentity.bytes,
        Readable.from([appArtifactBytes]),
      );
      await initialStore.activate(ownerKey, appArtifact, {
        packageDigest: PACKAGE_A,
        imageDigest: IMAGE,
        installDigest: INSTALL,
        dependencyDigest: DEPENDENCY,
      });
      const otherArtifactBytes = Buffer.from("other App LKG");
      const otherArtifactIdentity = contentIdentity(otherArtifactBytes);
      const otherArtifact = await initialStore.receive(
        otherOwner,
        otherArtifactIdentity.digest,
        otherArtifactIdentity.bytes,
        Readable.from([otherArtifactBytes]),
      );
      await initialStore.activate(otherOwner, otherArtifact, {
        packageDigest: PACKAGE_B,
        imageDigest: IMAGE,
        installDigest: INSTALL,
        dependencyDigest: DEPENDENCY,
      });

      const workspaceApp = join(workspace, "apps", "weather", "manifest.json");
      const d0d2Database = join(workspace, ".lamarck", "data.db");
      const d1Document = join(workspace, "pages", "retirement-sentinel.md");
      await mkdir(join(workspace, "apps", "weather"), { recursive: true });
      await mkdir(join(workspace, ".lamarck"), { recursive: true });
      await mkdir(join(workspace, "pages"), { recursive: true });
      const immutableSentinels = new Map<string, Buffer>([
        [workspaceApp, Buffer.from('{"manifestVersion":1,"id":"weather"}\n')],
        [d0d2Database, Buffer.from("D0 and D2 durable database sentinel")],
        [d1Document, Buffer.from("# D1 working-tree sentinel\n")],
      ]);
      for (const [path, bytes] of immutableSentinels) await writeFile(path, bytes);

      let freshBudget!: CapsuleStorageBudget;
      let freshStore!: HostArtifactStore;
      const lifecycleEvents: string[] = [];
      const vm = new FakeVm(lifecycleEvents);
      const system = new FakeSystemStreamServer();
      const session = new FakeSession(system, lifecycleEvents);
      const backend = new MacOsCapsuleBackend({
        helperPath: join(root, "helper"),
        releaseResourcesRoot: join(root, "resources"),
        stateDirectory,
        cacheDirectory,
        artifactRoot,
        systemStreamServer: system as unknown as SystemStreamServer,
        dependencies: {
          hostPlatform: "darwin",
          exists: () => true,
          loadRelease: async () => guestRelease(),
          launchVm: () => vm as never,
          createSession: () => session as never,
          storageBudget: (roots) => {
            freshBudget = new CapsuleStorageBudget({
              roots,
              aggregateBytes: 1_048_576,
              perAppBytes: 1_048_576,
              filesystemReserveBytes: 0,
              dependencies: { availableBytes: async () => 10_000_000 },
            });
            return stateNeutralBudget(freshBudget);
          },
          artifactStore: (path, budget) => {
            freshStore = new HostArtifactStore(path, { storageBudget: budget });
            return freshStore;
          },
          snapshot: async () => snapshot(PACKAGE_A, Buffer.from("package")),
          manifestDigest: async () => MANIFEST_AUTHORITY,
          installInput: async () => ({
            digest: INSTALL as `sha256:${string}`,
            warmEligible: true,
          }),
          dependencies: async () => { throw new Error("warm activation should not resolve dependencies"); },
          opaqueId: (() => {
            let id = 0;
            return () => `${"A".repeat(20)}${String(id++).padStart(2, "0")}`;
          })(),
          nonce: () => 42,
        },
      });
      await backend.startUi({
        ...spec("sender-a"),
        packageDir: join(workspace, "apps", "weather"),
      });

      const stateDisk = join(stateDirectory, "state.raw");
      const appPackageCache = join(packageRoot, ownerKey, "app.snapshot");
      const appDependencyCache = join(dependencyRoot, ownerKey, "app.tgz");
      const otherPackageCache = join(packageRoot, otherOwner, "other.snapshot");
      const otherDependencyCache = join(dependencyRoot, otherOwner, "other.tgz");
      await mkdir(join(packageRoot, ownerKey), { recursive: true });
      await mkdir(join(dependencyRoot, ownerKey), { recursive: true });
      await mkdir(join(packageRoot, otherOwner), { recursive: true });
      await mkdir(join(dependencyRoot, otherOwner), { recursive: true });
      await writeFile(stateDisk, Buffer.from("shared disposable VM state sentinel"));
      await writeFile(appPackageCache, Buffer.from("retire package cache"));
      await writeFile(appDependencyCache, Buffer.from("retire dependency cache"));
      await writeFile(otherPackageCache, Buffer.from("keep package cache"));
      await writeFile(otherDependencyCache, Buffer.from("keep dependency cache"));
      immutableSentinels.set(stateDisk, await readFile(stateDisk));

      await backend.retireApp("weather");
      await backend.stopAll();

      expect(session.stoppedApps).toHaveLength(1);
      expect(await exists(appPackageCache)).toBe(false);
      expect(await exists(appDependencyCache)).toBe(false);
      expect(await freshStore.active(ownerKey)).toBeUndefined();
      expect(await freshStore.find(appArtifactIdentity.digest, appArtifactIdentity.bytes))
        .toBeUndefined();
      expect(await readFile(otherPackageCache)).toEqual(Buffer.from("keep package cache"));
      expect(await readFile(otherDependencyCache)).toEqual(Buffer.from("keep dependency cache"));
      expect(await freshStore.active(otherOwner)).toMatchObject({
        artifact: otherArtifactIdentity,
        packageDigest: PACKAGE_B,
      });
      for (const [path, bytes] of immutableSentinels) {
        expect(await readFile(path)).toEqual(bytes);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("escalates unexpected-exit cleanup failure to the whole Guest boundary", async () => {
    const harness = createHarness();
    const uiLost = vi.fn();
    const boundaryLost = vi.fn();
    harness.backend.setUiLostHandler(uiLost);
    harness.backend.setBoundaryLostHandler(boundaryLost);
    await harness.backend.startUi(spec("sender-a"));
    harness.session.failAppStop = true;

    harness.session.emitLatestWorkloadFault("post-ready fault");
    await vi.waitFor(() => expect(uiLost).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(boundaryLost).toHaveBeenCalledOnce());
    expect(harness.vm.stopCalls).toBeGreaterThan(0);
  });
});

function spec(sender: string) {
  return {
    appId: "weather",
    manifestGeneration: 1,
    manifestDigest: MANIFEST_AUTHORITY,
    packageDir: "/workspace/apps/weather",
    command: ["npm", "run", "start"],
    port: 3_000,
    sdkSenderId: sender,
  };
}

async function rejectionOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected operation to reject");
}

function createHarness(overrides: { opaqueId?: () => string } = {}) {
  const lifecycleEvents: string[] = [];
  const vm = new FakeVm(lifecycleEvents);
  let staleStateResiduePresent = true;
  vm.onCancelStatePreparation = () => { staleStateResiduePresent = false; };
  const storageEvents: string[] = [];
  const storageRemovals: Array<{ path: string; recursive: boolean }> = [];
  vm.beforeStart = () => {
    storageEvents.push("startGuest");
    lifecycleEvents.push("vm.start");
  };
  const system = new FakeSystemStreamServer();
  const session = new FakeSession(system, lifecycleEvents);
  const store = new FakeArtifactStore(lifecycleEvents);
  let packageDigest: string = PACKAGE_A;
  let installDigest: string = INSTALL;
  let installWarmEligible = true;
  let dependencyDigest: string = DEPENDENCY;
  let dependencyBytes = Buffer.byteLength("dependency");
  let manifestDigest: string = MANIFEST_AUTHORITY;
  let id = 0;
  const dependencies = vi.fn(async (): Promise<NpmDependencyBundle> => {
    lifecycleEvents.push("dependency.planned");
    return {
      format: "npm-dependency-bundle-v1",
      snapshot: {
        ...snapshot(dependencyDigest, Buffer.from("dependency")),
        bytes: dependencyBytes,
      },
      entries: 1,
      tarballBytes: 10,
    };
  });
  const release = guestRelease();
  const options: MacOsCapsuleBackendOptions = {
    helperPath: "/Applications/Lamarck.app/Contents/Helpers/capsule-vm",
    releaseResourcesRoot: "/Applications/Lamarck.app/Contents/Resources",
    stateDirectory: "/private/state/capsule",
    cacheDirectory: "/private/cache/capsule",
    artifactRoot: "/private/artifacts/capsule",
    systemStreamServer: system as unknown as SystemStreamServer,
    dependencies: {
      hostPlatform: "darwin",
      exists: () => true,
      loadRelease: async () => release,
      launchVm: () => vm as never,
      createSession: () => session as never,
      snapshot: async () => snapshot(packageDigest, Buffer.from(`package:${packageDigest}`)),
      manifestDigest: async () => manifestDigest as `sha256:${string}`,
      installInput: async () => ({
        digest: installDigest as `sha256:${string}`,
        warmEligible: installWarmEligible,
      }),
      dependencies,
      artifactStore: () => store,
      storageBudget: () => ({
        reserve: async ({ bytes }) => ({ bytes, commit: async () => {}, release: async () => {} }),
        reserveFile: async ({ bytes, path }) => {
          storageEvents.push(`reserve:${bytes}:${path}`);
          return {
            settle: async () => { storageEvents.push("settle"); },
            release: async () => { storageEvents.push("release"); },
          };
        },
        reserveStateDisk: async ({ additionalPhysicalBytes, path }) => {
          storageEvents.push(`reserve:${additionalPhysicalBytes}:${path}`);
          return {
            commit: async () => { storageEvents.push("settle"); },
            reconcileFailure: async () => { storageEvents.push("reconcileFailure"); },
            release: async () => { storageEvents.push("release"); },
          };
        },
        reconcileStateDisk: async ({ existingPhysicalBytes, path }) => {
          storageEvents.push(`reconcile:${existingPhysicalBytes}:${path}`);
        },
        claim: async () => {},
        unclaim: async () => {},
        remove: async (path, removeOptions) => {
          if (staleStateResiduePresent) {
            throw new Error("stale state residue reached non-state storage admission");
          }
          storageRemovals.push({ path, recursive: removeOptions?.recursive === true });
          if (store.trackRetirementLifecycle) lifecycleEvents.push("cache.removed");
          return 0;
        },
      }),
      opaqueId: overrides.opaqueId
        ?? (() => `${"A".repeat(20)}${String(id++).padStart(2, "0")}`),
      nonce: () => 42,
    },
  };
  const backend = new MacOsCapsuleBackend(options);
  return {
    backend,
    vm,
    session,
    system,
    store,
    dependencies,
    storageEvents,
    storageRemovals,
    lifecycleEvents,
    get packageDigest() { return packageDigest; },
    set packageDigest(value: string) { packageDigest = value; },
    get installDigest() { return installDigest; },
    set installDigest(value: string) { installDigest = value; },
    get installWarmEligible() { return installWarmEligible; },
    set installWarmEligible(value: boolean) { installWarmEligible = value; },
    get dependencyDigest() { return dependencyDigest; },
    set dependencyDigest(value: string) { dependencyDigest = value; },
    get manifestDigest() { return manifestDigest; },
    set manifestDigest(value: string) { manifestDigest = value; },
    get dependencyBytes() { return dependencyBytes; },
    set dependencyBytes(value: number) { dependencyBytes = value; },
  };
}

class FakeVm extends EventEmitter {
  listenerCountsAtStart: Record<string, number> | undefined;
  stopCalls = 0;
  startCalls = 0;
  failStop = false;
  badArchitecture = false;
  beforeStart: (() => void) | undefined;
  onCancelStatePreparation: (() => void) | undefined;
  private stopBarrier: Promise<void> | undefined;
  private settleStop: (() => void) | undefined;

  constructor(private readonly lifecycleEvents: string[]) { super(); }

  async probe() { return { virtualizationSupported: true }; }

  async prepareState(options: { stateDiskBytes: number }) {
    return {
      preparationId: `01234567-89ab-4def-8123-${String(this.startCalls).padStart(12, "0")}`,
      stateDiskBytes: options.stateDiskBytes,
      existingPhysicalBytes: 0,
      additionalPhysicalBytes: options.stateDiskBytes,
      peakPhysicalBytes: options.stateDiskBytes,
    };
  }

  async cancelStatePreparation() {
    this.lifecycleEvents.push("state.prepare.cancelled");
    this.onCancelStatePreparation?.();
  }

  readonly startDescriptors: Array<Record<string, unknown>> = [];

  async startGuest(descriptor: Record<string, unknown>) {
    this.beforeStart?.();
    this.startCalls += 1;
    this.startDescriptors.push({ ...descriptor });
    this.listenerCountsAtStart = {
      stream: this.listenerCount("stream"),
      event: this.listenerCount("event"),
      close: this.listenerCount("close"),
    };
    const control = new PassThrough() as unknown as CapsuleVmHostStream;
    Object.defineProperty(control, "channel", { value: "control" });
    this.emit("stream", control);
    return {
      imageDigest: IMAGE,
      architecture: this.badArchitecture ? "x86_64" as const : "arm64" as const,
    };
  }

  async stopGuest() {
    this.stopCalls += 1;
    this.lifecycleEvents.push("helper.stop.begin");
    if (this.stopBarrier) await this.stopBarrier;
    if (this.failStop) throw new Error("VZ stop was not confirmed");
    this.lifecycleEvents.push("helper.stop.confirmed");
  }
  close() {
    this.lifecycleEvents.push("helper.close");
    this.removeAllListeners();
  }

  blockStop(): void {
    this.stopBarrier = new Promise<void>((resolve) => { this.settleStop = resolve; });
  }

  releaseStop(): void {
    this.settleStop?.();
    this.stopBarrier = undefined;
    this.settleStop = undefined;
  }
}

class FakeSystemStreamServer {
  attachments: Array<{
    senderId: string;
    stream: Duplex;
    onClose?: (error?: Error) => void;
  }> = [];
  detached = 0;
  closeOnAttach = false;

  attach(
    senderId: string,
    stream: Duplex,
    hooks: { onClose?: (error?: Error) => void } = {},
  ): () => void {
    this.attachments.push({ senderId, stream, onClose: hooks.onClose });
    if (this.closeOnAttach) {
      queueMicrotask(() => {
        stream.destroy();
        hooks.onClose?.(new Error("SDK transport closed"));
      });
    }
    return () => {
      this.detached += 1;
      stream.destroy();
    };
  }

  closeLatest(error?: Error): void {
    const attachment = this.attachments.at(-1)!;
    attachment.stream.destroy();
    attachment.onClose?.(error);
  }
}

interface FakeTicket {
  kind: StreamKind;
  appHandle: string;
  subjectHandle: string;
}

class FakeSession extends EventEmitter {
  readonly operations: string[] = [];
  readonly tickets = new Map<string, FakeTicket>();
  readonly imports = new Map<string, {
    blobHandle: string;
    blobKind: "package" | "dependency" | "artifact";
    digest: string;
    bytes: number;
  }>();
  readonly releasedImports: Array<Record<string, any>> = [];
  readonly outputReleases: Array<Record<string, any>> = [];
  readonly guestCache = new Set<string>();
  readonly appPrepares: Array<{ appHandle: string; mappedHostUid: number }> = [];
  readonly buildPrepares: Array<Record<string, any>> = [];
  readonly stoppedApps: string[] = [];
  readonly workloadPorts = new Map<string, number>();
  readonly workloadApps = new Map<string, string>();
  buildStarts = 0;
  artifactOutHostReceipts = 0;
  artifactOutHostHalfCloses = 0;
  failNextReady = false;
  failNextExport = false;
  failAppStop = false;
  emitExitOnStop = false;
  fatalAfterPing = false;
  holdBuild = false;
  failNextWarmBuild = false;
  failBeforeOperation: string | undefined;
  failNextDataStreamKind: StreamKind | undefined;
  holdArtifactOutHostFinal = false;
  failNextArtifactReceiptWrite = false;
  failImportReleaseForKind: "package" | "dependency" | "artifact" | undefined;
  loseBoundaryOnDataStreamFailure = false;
  sdkWasAttachedAtStart = false;
  trackRetirementLifecycle = false;
  private ticket = 0;
  private eventSeq = 0;
  private heldBuild: { reject(error: Error): void } | undefined;
  private currentPackageDigest = PACKAGE_A;
  private currentDependencyDigest = DEPENDENCY;
  private currentInstallDigest = INSTALL;
  private currentWarmBuild = false;
  private viewerAttachGate: Promise<void> | undefined;
  private releaseBlockedViewerAttach: (() => void) | undefined;

  constructor(
    private readonly system: FakeSystemStreamServer,
    private readonly lifecycleEvents: string[],
  ) { super(); }

  async waitUntilReady() {}

  issueTicket(options: FakeTicket) {
    const ticket = String(this.ticket++).padStart(43, "T");
    this.tickets.set(ticket, options);
    return { ticket };
  }

  revokeTicket(ticket: unknown): boolean {
    return typeof ticket === "string" && this.tickets.delete(ticket);
  }

  acceptDataStream() {}
  close() {
    this.lifecycleEvents.push("session.close");
    this.emit("close");
    this.removeAllListeners();
  }

  cacheBlob(kind: "package" | "dependency" | "artifact", digest: string): void {
    this.guestCache.add(`${kind}:${digest}`);
  }

  emitLatestWorkloadExit() {
    const [workloadHandle, appHandle] = [...this.workloadApps.entries()].at(-1)!;
    this.guestEvent("workload.exited", {
      appHandle,
      workloadHandle,
      exitCode: 0,
      signal: null,
    });
  }

  emitOldestWorkloadExit() {
    const [workloadHandle, appHandle] = [...this.workloadApps.entries()][0]!;
    this.guestEvent("workload.exited", {
      appHandle,
      workloadHandle,
      exitCode: 0,
      signal: null,
    });
  }

  blockViewerAttach() {
    if (this.viewerAttachGate) throw new Error("viewer attach is already blocked");
    this.viewerAttachGate = new Promise<void>((resolve) => {
      this.releaseBlockedViewerAttach = resolve;
    });
  }

  releaseViewerAttach() {
    const release = this.releaseBlockedViewerAttach;
    this.viewerAttachGate = undefined;
    this.releaseBlockedViewerAttach = undefined;
    release?.();
  }

  emitLatestWorkloadFault(message: string) {
    const [workloadHandle, appHandle] = [...this.workloadApps.entries()].at(-1)!;
    this.guestEvent("workload.faulted", { appHandle, workloadHandle, message });
  }

  async request(operation: string, body: Record<string, any>): Promise<any> {
    this.operations.push(operation);
    if (this.failBeforeOperation === operation) {
      this.failBeforeOperation = undefined;
      throw new Error(`injected pre-dispatch ${operation} failure`);
    }
    switch (operation) {
      case "ping":
        if (this.fatalAfterPing) {
          queueMicrotask(() => this.emit("fatal", new Error("late boot fault")));
        }
        return { nonce: body.nonce };
      case "blob.import.prepare": {
        this.imports.set(body.streamTicket, {
          blobHandle: body.blobHandle,
          blobKind: body.blobKind,
          digest: body.digest,
          bytes: body.bytes,
        });
        if (this.guestCache.has(`${body.blobKind}:${body.digest}`)) {
          return { alreadyPresent: true };
        }
        return { alreadyPresent: false, ready: true };
      }
      case "blob.import.release": {
        this.releasedImports.push({ ...body });
        if (this.failImportReleaseForKind === body.blobKind) {
          this.failImportReleaseForKind = undefined;
          throw new Error(`injected ${body.blobKind} import release failure`);
        }
        return { released: this.removeImport(body.blobHandle) };
      }
      case "build.prepare":
        this.buildPrepares.push({ ...body });
        this.currentPackageDigest = body.packageDigest;
        this.currentDependencyDigest = body.dependencyDigest ?? body.baseDependencyDigest;
        this.currentInstallDigest = body.installDigest;
        this.currentWarmBuild = body.baseArtifactDigest !== undefined;
        this.removeImport(body.packageBlobHandle);
        this.removeImport(body.dependencyBlobHandle);
        this.removeImport(body.baseArtifactBlobHandle);
        return { prepared: true };
      case "build.start": {
        this.buildStarts += 1;
        if (this.currentWarmBuild && this.failNextWarmBuild) {
          this.failNextWarmBuild = false;
          throw new CapsuleGuestRequestError(
            "WARM_REBUILD_UNAVAILABLE",
            "injected warm semantic miss",
          );
        }
        if (this.holdBuild) {
          return await new Promise((_resolve, reject) => { this.heldBuild = { reject }; });
        }
        const descriptor = this.descriptor();
        this.guestCache.add(`artifact:${descriptor.digest}`);
        this.guestEvent("build.progress", {
          appHandle: body.appHandle,
          buildHandle: body.buildHandle,
          phase: "materializing",
        });
        this.guestEvent("build.completed", descriptor);
        return descriptor;
      }
      case "build.cancel":
        this.holdBuild = false;
        this.heldBuild?.reject(new Error("build cancelled"));
        this.heldBuild = undefined;
        return { cancelled: true };
      case "build.output.release":
        this.outputReleases.push({ ...body });
        return { released: true };
      case "blob.export.prepare": return { ready: true };
      case "app.prepare":
        this.removeImport(body.artifactBlobHandle);
        this.appPrepares.push({ appHandle: body.appHandle, mappedHostUid: body.mappedHostUid });
        return { prepared: true };
      case "workload.prepare": {
        if (this.workloadPorts.has(body.workloadHandle)) {
          return { awaitingStreams: false, reused: true };
        }
        this.workloadPorts.set(body.workloadHandle, body.uiPort);
        this.workloadApps.set(body.workloadHandle, body.appHandle);
        return { awaitingStreams: true };
      }
      case "workload.start": {
        this.sdkWasAttachedAtStart = this.system.attachments.length > 0;
        if (!this.sdkWasAttachedAtStart) throw new Error("SDK was not attached");
        this.guestEvent("workload.started", {
          appHandle: body.appHandle,
          workloadHandle: body.workloadHandle,
        });
        if (this.failNextReady) {
          this.failNextReady = false;
          this.guestEvent("workload.faulted", {
            appHandle: body.appHandle,
            workloadHandle: body.workloadHandle,
            message: "not ready",
          });
        } else {
          this.guestEvent("workload.ready", {
            appHandle: body.appHandle,
            workloadHandle: body.workloadHandle,
            port: this.workloadPorts.get(body.workloadHandle)!,
          });
        }
        return { started: true };
      }
      case "workload.stop":
        if (this.emitExitOnStop) {
          this.guestEvent("workload.exited", {
            appHandle: body.appHandle,
            workloadHandle: body.workloadHandle,
            exitCode: 0,
            signal: null,
          });
        }
        return { stopped: true };
      case "app.stop":
        if (this.failAppStop) throw new Error("teardown failed");
        this.stoppedApps.push(body.appHandle);
        if (this.trackRetirementLifecycle) this.lifecycleEvents.push("guest.app.stopped");
        return { stopped: true };
      case "viewer.attach":
        if (this.viewerAttachGate) await this.viewerAttachGate;
        return { ready: true };
      case "vm.drain": return { drained: true };
      default: throw new Error(`unexpected operation ${operation}`);
    }
  }

  async openDataStream(ticket: string, kind: StreamKind) {
    const binding = this.tickets.get(ticket);
    if (!binding || binding.kind !== kind) throw new Error("unknown fake ticket");
    this.tickets.delete(ticket);
    if (this.failNextDataStreamKind === kind) {
      this.failNextDataStreamKind = undefined;
      const error = new Error(`injected ${kind} DATA failure`);
      if (this.loseBoundaryOnDataStreamFailure) this.emit("fatal", error);
      throw error;
    }
    const stream = kind === "artifact-out"
      ? new Duplex({
          allowHalfOpen: true,
          autoDestroy: false,
          read() {},
        })
      : new PassThrough({ allowHalfOpen: true, autoDestroy: false });
    stream.on("error", () => {});
    if (kind === "package-in" || kind === "dependency-in" || kind === "artifact-in") {
      const pending = this.imports.get(ticket)!;
      stream.on("data", () => {});
      stream.once("finish", () => {
        this.guestCache.add(`${pending.blobKind}:${pending.digest}`);
        this.guestEvent("blob.imported", {
          blobHandle: pending.blobHandle,
          digest: pending.digest,
          bytes: pending.bytes,
        });
      });
    } else if (kind === "artifact-out") {
      const descriptor = this.descriptor();
      let exportFailed = false;
      let adoptionReceiptReceived = false;
      const decoder = new JsonFrameDecoder(MAX_ARTIFACT_ADOPTION_RECEIPT_BYTES);
      Object.defineProperty(stream, "_write", {
        configurable: true,
        value: (
          chunk: Buffer,
          _encoding: BufferEncoding,
          callback: (error?: Error | null) => void,
        ) => {
          if (this.failNextArtifactReceiptWrite) {
            this.failNextArtifactReceiptWrite = false;
            callback(new Error("injected artifact adoption receipt write failure"));
            return;
          }
          try {
            for (const value of decoder.push(chunk)) {
              if (adoptionReceiptReceived) {
                throw new Error("fake Guest received duplicate artifact adoption receipts");
              }
              const receipt = parseArtifactAdoptionReceipt(value);
              if (
                receipt.sessionId !== SESSION_ID
                || receipt.ticket !== ticket
                || receipt.digest !== descriptor.digest
                || receipt.bytes !== descriptor.bytes
              ) {
                throw new Error("fake Guest received a mismatched artifact adoption receipt");
              }
              adoptionReceiptReceived = true;
              this.artifactOutHostReceipts += 1;
              this.lifecycleEvents.push("artifact.host.receipt");
            }
            callback();
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      Object.defineProperty(stream, "_final", {
        configurable: true,
        value: (callback: (error?: Error | null) => void) => {
          if (this.holdArtifactOutHostFinal) return;
          try {
            decoder.end();
            if (!adoptionReceiptReceived) {
              throw new Error("fake Guest expected exactly one artifact adoption receipt");
            }
            this.artifactOutHostHalfCloses += 1;
            this.lifecycleEvents.push("artifact.host.fin");
            if (!exportFailed) {
              this.guestEvent("blob.exported", {
                blobHandle: binding.appHandle,
                digest: descriptor.digest,
                bytes: descriptor.bytes,
              });
            }
            callback();
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      queueMicrotask(() => {
        if (this.failNextExport) {
          this.failNextExport = false;
          exportFailed = true;
          stream.push(Buffer.alloc(descriptor.bytes, 7));
          stream.push(null);
          this.guestEvent("blob.failed", {
            blobHandle: binding.appHandle,
            digest: descriptor.digest,
            bytes: descriptor.bytes,
            message: "export source failed",
          });
          return;
        }
        stream.push(Buffer.alloc(descriptor.bytes, 7));
        stream.push(null);
      });
    }
    return {
      stream,
      prelude: {
        protocolVersion: CAPSULE_PROTOCOL_VERSION,
        sessionId: SESSION_ID,
        ticket,
        kind,
      },
      binding,
    } as never;
  }

  private descriptor() {
    const digest = this.currentPackageDigest === PACKAGE_A ? ARTIFACT_A : ARTIFACT_B;
    return {
      format: "erofs-v1" as const,
      digest,
      bytes: 64,
      imageDigest: IMAGE,
      runtimeAbi: "capsule-node-v1" as const,
      architecture: "arm64" as const,
      libc: "musl",
      nodeVersion: "24.18.0",
      nodeModulesAbi: "137",
      sourceDigest: this.currentPackageDigest,
      installDigest: this.currentInstallDigest,
      dependencyDigest: this.currentDependencyDigest,
      fileCount: 3,
    };
  }

  private removeImport(blobHandle: string | undefined): boolean {
    if (!blobHandle) return false;
    for (const [ticket, pending] of this.imports) {
      if (pending.blobHandle !== blobHandle) continue;
      this.imports.delete(ticket);
      return true;
    }
    return false;
  }

  private guestEvent(type: GuestEvent["type"], body: JsonValue) {
    this.emit("event", {
      v: CAPSULE_PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      kind: "event",
      eventSeq: ++this.eventSeq,
      type,
      body,
    } satisfies GuestEvent);
  }
}

class FakeArtifactStore {
  readonly cas = new Map<string, HostArtifact>();
  readonly retained = new Map<string, number>();
  activation: (HostArtifactActivation & { packageDigest: `sha256:${string}` }) | undefined;
  activationWrites = 0;
  afterNextActivation: (() => void) | undefined;
  failNextFind = false;
  failNextReceiveAfterDrain = false;
  failNextRetain = false;
  readonly deactivatedKeys: string[] = [];
  pruneCalls = 0;
  trackRetirementLifecycle = false;

  constructor(private readonly lifecycleEvents: string[]) {}

  async active() { return this.activation; }
  async find(digest: string) {
    if (this.failNextFind) {
      this.failNextFind = false;
      throw new Error("injected artifact lookup failure");
    }
    return this.cas.get(digest);
  }

  async receive(
    _ownerKey: string,
    digest: string,
    expectedBytes: number,
    source: AsyncIterable<Uint8Array>,
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (bytes.byteLength !== expectedBytes) throw new Error("fake artifact size mismatch");
    if (this.failNextReceiveAfterDrain) {
      this.failNextReceiveAfterDrain = false;
      throw new Error("injected artifact verification failure");
    }
    const artifact = hostArtifact(digest as `sha256:${string}`, bytes);
    this.cas.set(digest, artifact);
    this.lifecycleEvents.push("artifact.cas.committed");
    return artifact;
  }

  async activate(
    _appKey: string,
    artifact: Pick<HostArtifact, "digest" | "bytes">,
    provenance: {
      packageDigest: string;
      imageDigest: string;
      installDigest?: string;
      dependencyDigest?: string;
    },
  ) {
    this.activationWrites += 1;
    const stored = this.cas.get(artifact.digest)!;
    this.activation = {
      artifact: stored,
      packageDigest: provenance.packageDigest as `sha256:${string}`,
      imageDigest: provenance.imageDigest as `sha256:${string}`,
      ...(provenance.installDigest === undefined
        ? {}
        : {
            installDigest: provenance.installDigest as `sha256:${string}`,
            dependencyDigest: provenance.dependencyDigest as `sha256:${string}`,
          }),
    };
    const afterActivation = this.afterNextActivation;
    this.afterNextActivation = undefined;
    afterActivation?.();
  }

  async deactivate(appKey: string) {
    this.deactivatedKeys.push(appKey);
    this.activation = undefined;
    if (this.trackRetirementLifecycle) this.lifecycleEvents.push("artifact.deactivated");
  }
  retain(artifact: HostArtifact) {
    if (this.failNextRetain) {
      this.failNextRetain = false;
      throw new Error("injected prepared artifact retention failure");
    }
    this.retained.set(artifact.digest, (this.retained.get(artifact.digest) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const remaining = (this.retained.get(artifact.digest) ?? 0) - 1;
        if (remaining > 0) this.retained.set(artifact.digest, remaining);
        else this.retained.delete(artifact.digest);
      },
    };
  }
  async pruneUnreferenced() {
    this.pruneCalls += 1;
    for (const digest of [...this.cas.keys()]) {
      if (this.activation?.artifact.digest === digest || this.retained.has(digest)) continue;
      this.cas.delete(digest);
    }
    if (this.trackRetirementLifecycle) this.lifecycleEvents.push("artifact.pruned");
    return 0;
  }
}

function snapshot(digest: string, bytes: Buffer): CapsuleTreeSnapshot {
  return {
    format: "capsule-tree-v1",
    digest: digest as `sha256:${string}`,
    bytes: bytes.byteLength,
    entries: 1,
    path: `/cas/${digest.slice(7)}`,
    createReadStream: () => Readable.from([bytes]) as never,
  };
}

function hostArtifact(digest: `sha256:${string}`, bytes: Buffer): HostArtifact {
  return {
    digest,
    bytes: bytes.byteLength,
    path: `/artifacts/${digest.slice(7)}`,
    createReadStream: () => Readable.from([bytes]) as never,
  };
}

function appKey(appId: string): string {
  return createHash("sha256").update(appId, "utf8").digest("hex");
}

function contentIdentity(bytes: Buffer): { digest: `sha256:${string}`; bytes: number } {
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.byteLength,
  };
}

function stateNeutralBudget(budget: CapsuleStorageBudget): CapsuleStorageBudgetLike {
  return {
    reserve: (options) => budget.reserve(options),
    reserveFile: (options) => budget.reserveFile(options),
    reserveStateDisk: async () => ({
      commit: async () => {},
      reconcileFailure: async () => {},
      release: async () => {},
    }),
    reconcileStateDisk: async () => {},
    claim: (options) => budget.claim(options),
    unclaim: (options) => budget.unclaim(options),
    remove: (path, options) => budget.remove(path, options),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function guestRelease(): LoadedCapsuleGuestRelease {
  return {
    descriptor: {} as never,
    vmImage: {
      imageBundlePath: "/resources/capsule-guest",
      stateDirectory: "/state",
      expectedManifestDigest: IMAGE,
      manifestPublicKey: `${"A".repeat(43)}=`,
      cpuCount: 4,
      memorySizeBytes: 2 * 1024 * 1024 * 1024,
    },
    handshake: {
      expectedImageDigest: IMAGE,
      expectedArchitecture: "arm64",
      expectedSupervisorVersion: "0.1.0",
      expectedFeatures: [
        "artifact-adoption-receipt-v1",
        "artifact-erofs-v1",
        "build-v1",
        "oci-policy-v1",
        "sdk-uds-v1",
        "tickets-v1",
        "vsock-record-v2",
        "warm-rebuild-v1",
      ],
    },
    runtime: {
      runtimeAbi: "capsule-node-v1",
      architecture: "arm64",
      nodeVersion: "24.18.0",
      nodeModulesAbi: "137",
      libc: "musl",
    },
  };
}
