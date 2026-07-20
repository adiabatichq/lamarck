import { EventEmitter } from "node:events";
import { Readable, PassThrough, type Duplex } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { GuestEvent, JsonValue, StreamKind } from "../../../capsule/src/protocol/types";
import type { CapsuleVmHostStream } from "../capsule-vm/launcher";
import type { LoadedCapsuleGuestRelease } from "./guest-release";
import type { HostArtifact, HostArtifactActivation } from "./artifact-store";
import type { CapsuleTreeSnapshot } from "./package-snapshot";
import type { NpmDependencyBundle } from "./dependency-broker";
import type { SystemStreamServer } from "./system-stream";
import { CapsuleGuestRequestError } from "./guest-session";
import { MacOsCapsuleBackend, type MacOsCapsuleBackendOptions } from "./macos-backend";

const IMAGE = `sha256:${"1".repeat(64)}`;
const PACKAGE_A = `sha256:${"2".repeat(64)}`;
const PACKAGE_B = `sha256:${"3".repeat(64)}`;
const DEPENDENCY = `sha256:${"4".repeat(64)}`;
const INSTALL = `sha256:${"7".repeat(64)}`;
const INSTALL_B = `sha256:${"8".repeat(64)}`;
const ARTIFACT_A = `sha256:${"5".repeat(64)}`;
const ARTIFACT_B = `sha256:${"6".repeat(64)}`;

describe("MacOsCapsuleBackend orchestration", () => {
  test("reserves the fixed VM state disk before the helper may start it", async () => {
    const harness = createHarness();
    await harness.backend.startUi(spec("sender-a"));
    expect(harness.storageEvents.slice(0, 3)).toEqual([
      "reserve:17179869184:/private/state/capsule/state.raw",
      "startGuest",
      "settle",
    ]);
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
    await expect(harness.backend.openUiStream(instance.instanceId)).rejects.toThrow("no longer active");
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
    await expect(harness.backend.openUiStream(instance.instanceId)).rejects.toThrow("no longer active");

    harness.vm.releaseStop();
    await stopFromBoundary;
    expect(harness.vm.stopCalls).toBe(1);
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

    await expect(harness.backend.stopAll()).rejects.toThrow("shutdown was incomplete");
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

    await expect(harness.backend.startUi(spec("sender-a")))
      .rejects.toThrow("quarantined until Host restart");
    await expect(harness.backend.startUi(spec("sender-b")))
      .rejects.toThrow("quarantined until Host restart");
    expect(harness.vm.startCalls).toBe(1);
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
    packageDir: "/workspace/apps/weather",
    command: ["npm", "run", "start"],
    port: 3_000,
    sdkSenderId: sender,
  };
}

function createHarness(overrides: { opaqueId?: () => string } = {}) {
  const vm = new FakeVm();
  const storageEvents: string[] = [];
  vm.beforeStart = () => storageEvents.push("startGuest");
  const system = new FakeSystemStreamServer();
  const session = new FakeSession(system);
  const store = new FakeArtifactStore();
  let packageDigest: string = PACKAGE_A;
  let installDigest: string = INSTALL;
  let installWarmEligible = true;
  let id = 0;
  const dependencies = vi.fn(async (): Promise<NpmDependencyBundle> => ({
    format: "npm-dependency-bundle-v1",
    snapshot: snapshot(DEPENDENCY, Buffer.from("dependency")),
    entries: 1,
    tarballBytes: 10,
  }));
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
        claim: async () => {},
        unclaim: async () => {},
        remove: async () => 0,
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
    get packageDigest() { return packageDigest; },
    set packageDigest(value: string) { packageDigest = value; },
    get installDigest() { return installDigest; },
    set installDigest(value: string) { installDigest = value; },
    get installWarmEligible() { return installWarmEligible; },
    set installWarmEligible(value: boolean) { installWarmEligible = value; },
  };
}

class FakeVm extends EventEmitter {
  listenerCountsAtStart: Record<string, number> | undefined;
  stopCalls = 0;
  startCalls = 0;
  failStop = false;
  badArchitecture = false;
  beforeStart: (() => void) | undefined;
  private stopBarrier: Promise<void> | undefined;
  private settleStop: (() => void) | undefined;

  async probe() { return { virtualizationSupported: true }; }

  async startGuest() {
    this.beforeStart?.();
    this.startCalls += 1;
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
    if (this.stopBarrier) await this.stopBarrier;
    if (this.failStop) throw new Error("VZ stop was not confirmed");
  }
  close() {}

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
  failNextReady = false;
  failNextExport = false;
  failAppStop = false;
  emitExitOnStop = false;
  fatalAfterPing = false;
  holdBuild = false;
  failNextWarmBuild = false;
  failBeforeOperation: string | undefined;
  sdkWasAttachedAtStart = false;
  private ticket = 0;
  private eventSeq = 0;
  private heldBuild: { reject(error: Error): void } | undefined;
  private currentPackageDigest = PACKAGE_A;
  private currentDependencyDigest = DEPENDENCY;
  private currentInstallDigest = INSTALL;
  private currentWarmBuild = false;

  constructor(private readonly system: FakeSystemStreamServer) { super(); }

  async waitUntilReady() {}

  issueTicket(options: FakeTicket) {
    const ticket = `ticket-${this.ticket++}`;
    this.tickets.set(ticket, options);
    return { ticket };
  }

  revokeTicket(ticket: unknown): boolean {
    return typeof ticket === "string" && this.tickets.delete(ticket);
  }

  acceptDataStream() {}
  close() { this.emit("close"); }

  emitLatestWorkloadExit() {
    const [workloadHandle, appHandle] = [...this.workloadApps.entries()].at(-1)!;
    this.guestEvent("workload.exited", {
      appHandle,
      workloadHandle,
      exitCode: 0,
      signal: null,
    });
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
        return { stopped: true };
      case "viewer.attach": return { ready: true };
      case "vm.drain": return { drained: true };
      default: throw new Error(`unexpected operation ${operation}`);
    }
  }

  async openDataStream(ticket: string, kind: StreamKind) {
    const binding = this.tickets.get(ticket);
    if (!binding || binding.kind !== kind) throw new Error("unknown fake ticket");
    this.tickets.delete(ticket);
    const stream = new PassThrough();
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
      queueMicrotask(() => {
        if (this.failNextExport) {
          this.failNextExport = false;
          stream.end(Buffer.alloc(descriptor.bytes, 7));
          this.guestEvent("blob.failed", {
            blobHandle: binding.appHandle,
            digest: descriptor.digest,
            bytes: descriptor.bytes,
            message: "export source failed",
          });
          return;
        }
        stream.end(Buffer.alloc(descriptor.bytes, 7));
        this.guestEvent("blob.exported", {
          blobHandle: binding.appHandle,
          digest: descriptor.digest,
          bytes: descriptor.bytes,
        });
      });
    }
    return {
      stream,
      prelude: { kind },
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
      nodeVersion: "24.10.0",
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
      v: 1,
      sessionId: "S".repeat(43),
      kind: "event",
      eventSeq: ++this.eventSeq,
      type,
      body,
    } satisfies GuestEvent);
  }
}

class FakeArtifactStore {
  readonly cas = new Map<string, HostArtifact>();
  activation: (HostArtifactActivation & { packageDigest: `sha256:${string}` }) | undefined;
  afterNextActivation: (() => void) | undefined;
  failNextFind = false;

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
    const artifact = hostArtifact(digest as `sha256:${string}`, bytes);
    this.cas.set(digest, artifact);
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

  async deactivate() { this.activation = undefined; }
  async pruneUnreferenced() { return 0; }
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
        "artifact-erofs-v1",
        "build-v1",
        "oci-policy-v1",
        "sdk-uds-v1",
        "tickets-v1",
        "warm-rebuild-v1",
      ],
    },
    runtime: {
      runtimeAbi: "capsule-node-v1",
      architecture: "arm64",
      nodeVersion: "24.10.0",
      nodeModulesAbi: "137",
      libc: "musl",
    },
  };
}
