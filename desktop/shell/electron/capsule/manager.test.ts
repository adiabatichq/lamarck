import { describe, expect, test, vi } from "vitest";
import { PassThrough, type Duplex } from "node:stream";
import type {
  CapsuleBackend,
  CapsuleUiInstance,
  CapsuleUiPreparation,
  CapsuleUiSpec,
} from "./backend";
import { CapsuleRestartRequiredError } from "./backend";
import { CapsuleManager, type PreparedViewerBinding } from "./manager";

const MANIFEST_GENERATION = 7;
const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_MANIFEST_DIGEST = `sha256:${"b".repeat(64)}`;

class FakeBackend implements CapsuleBackend {
  starts: CapsuleUiSpec[] = [];
  stops: string[] = [];
  appStops: string[] = [];
  appRetires: string[] = [];
  replacements: Array<{ instanceId: string; spec: CapsuleUiSpec }> = [];
  preparations: Array<{
    preparationId: string;
    instanceId: string;
    previousInstanceId?: string;
    spec: CapsuleUiSpec;
  }> = [];
  committedPreparations: string[] = [];
  abortedPreparations: string[] = [];
  openedStreams: string[] = [];
  stopAllCalls = 0;
  failStopUi = false;
  rebuildGate: Promise<void> | undefined;
  retireGate: Promise<void> | undefined;
  loseReplacementBeforeReturn = false;
  loseCommittedReplacementBeforeReturn = false;
  boundaryLostHandler: ((error: unknown) => void) | undefined;
  uiLostHandler: ((event: { instanceId: string; appId: string; error: Error }) => void) | undefined;
  setBoundaryLostHandler(handler: (error: unknown) => void) {
    this.boundaryLostHandler = handler;
  }
  setUiLostHandler(handler: (event: { instanceId: string; appId: string; error: Error }) => void) {
    this.uiLostHandler = handler;
  }
  async status() { return { available: true, backend: "fake" }; }
  async prepareUi(
    spec: CapsuleUiSpec,
    previousInstanceId?: string,
  ): Promise<CapsuleUiPreparation> {
    if (previousInstanceId) {
      this.replacements.push({ instanceId: previousInstanceId, spec });
      await this.rebuildGate;
    } else {
      this.starts.push(spec);
    }
    const suffix = previousInstanceId ? `${previousInstanceId}-replacement` : `instance-${spec.appId}`;
    const prepared = {
      preparationId: `preparation-${this.preparations.length + 1}`,
      instanceId: suffix,
      previousInstanceId,
      spec,
    };
    this.preparations.push(prepared);
    if (this.loseReplacementBeforeReturn && previousInstanceId) {
      this.uiLostHandler?.({
        instanceId: prepared.instanceId,
        appId: spec.appId,
        error: new Error("replacement exited before publication"),
      });
    }
    return prepared;
  }
  async commitPreparedUi(preparationId: string): Promise<CapsuleUiInstance> {
    this.committedPreparations.push(preparationId);
    const prepared = this.preparations.find((candidate) => (
      candidate.preparationId === preparationId
    ));
    if (!prepared) throw new Error("unknown preparation");
    if (this.loseCommittedReplacementBeforeReturn && prepared.previousInstanceId) {
      this.uiLostHandler?.({
        instanceId: prepared.instanceId,
        appId: prepared.spec.appId,
        error: new Error("committed replacement exited before Host publication"),
      });
    }
    return { instanceId: prepared.instanceId };
  }
  async abortPreparedUi(preparationId: string): Promise<void> {
    this.abortedPreparations.push(preparationId);
  }
  async startUi(spec: CapsuleUiSpec): Promise<CapsuleUiInstance> {
    this.starts.push(spec);
    return { instanceId: `instance-${spec.appId}` };
  }
  async replaceUi(instanceId: string, spec: CapsuleUiSpec): Promise<CapsuleUiInstance> {
    this.replacements.push({ instanceId, spec });
    await this.rebuildGate;
    const replacement = { instanceId: `${instanceId}-replacement` };
    if (this.loseReplacementBeforeReturn) {
      this.uiLostHandler?.({
        instanceId: replacement.instanceId,
        appId: spec.appId,
        error: new Error("replacement exited before publication"),
      });
    }
    return replacement;
  }
  async openUiStream(instanceId: string): Promise<Duplex> {
    this.openedStreams.push(instanceId);
    return new PassThrough();
  }
  async stopUi(id: string) {
    this.stops.push(id);
    if (this.failStopUi) throw new Error("stop failed");
  }
  async stopApp(appId: string) { this.appStops.push(appId); }
  async retireApp(appId: string) {
    this.appRetires.push(appId);
    await this.retireGate;
  }
  async stopAll() { this.stopAllCalls += 1; }
}

function createFetch(
  runtimeByApp: Record<string, unknown> = {},
  options: { issuedManifestDigest?: string } = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let issued = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/apps")) {
      return Response.json({
        apps: ["app-a", "app-b"].map((id) => ({
          id,
          manifestGeneration: MANIFEST_GENERATION,
          manifestDigest: MANIFEST_DIGEST,
          runtime: runtimeByApp[id]
            ?? { ui: { command: ["npm", "run", "start"], port: 3000 } },
        })),
      });
    }
    if (url.endsWith("/api/app-runtime/channels") && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as {
        appId: string;
        manifestGeneration: number;
        manifestDigest: string;
      };
      const { appId } = request;
      issued += 1;
      return Response.json({
        capability: `secret-capability-${appId}-${issued}`,
        channelId: `channel-${appId}-${issued}`,
        manifestGeneration: request.manifestGeneration,
        manifestDigest: options.issuedManifestDigest ?? request.manifestDigest,
      });
    }
    if (url.includes("/api/app-runtime/channels/channel-") && init?.method === "DELETE") {
      return Response.json({ ok: true });
    }
    if (url.includes("/api/app-runtime/apps/") && init?.method === "DELETE") {
      return Response.json({ ok: true, revoked: 0 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function systemBindings() {
  return {
    bindSystemSender: vi.fn(),
    unbindSystemSender: vi.fn(),
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

const verifyPreparedViewer = async (binding: {
  assertCurrent(): void;
}): Promise<void> => {
  binding.assertCurrent();
};
const publishReloadedViewer = (): void => {};

describe("CapsuleManager", () => {
  test("derives the UI launch from Core and keeps the capability Host-side", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });

    const viewer = await manager.openViewer("app-a", 7, verifyPreparedViewer);
    expect(viewer).toMatchObject({
      appId: "app-a",
      channelId: "channel-app-a-2",
      capability: "secret-capability-app-a-2",
    });
    expect(backend.starts).toEqual([{
      appId: "app-a",
      manifestGeneration: MANIFEST_GENERATION,
      manifestDigest: MANIFEST_DIGEST,
      packageDir: "/workspace/apps/app-a",
      command: ["npm", "run", "start"],
      port: 3000,
      sdkSenderId: expect.stringMatching(/^capsule_/),
    }]);
    expect(JSON.stringify(backend.starts)).not.toContain("secret-capability");
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer host-token");
    }
  });

  test("keeps a prepared launch unpublished until its hidden viewer verifies", async () => {
    const backend = new FakeBackend();
    const { fetch } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });
    let preparedBinding!: PreparedViewerBinding;
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let reportVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      reportVerificationStarted = resolve;
    });

    const opening = manager.openViewer("app-a", 7, async (binding) => {
      preparedBinding = binding;
      reportVerificationStarted();
      await verificationGate;
      binding.assertCurrent();
    });
    await verificationStarted;

    expect(manager.getViewer(preparedBinding.viewerId, 7)).toBeNull();
    expect(backend.committedPreparations).toEqual([]);
    expect(preparedBinding).toMatchObject({
      appId: "app-a",
      instanceId: "instance-app-a",
      channelId: "channel-app-a-2",
      capability: "secret-capability-app-a-2",
    });
    const stream = await preparedBinding.openUiStream();
    stream.destroy();
    expect(backend.openedStreams).toEqual(["instance-app-a"]);

    releaseVerification();
    const opened = await opening;
    expect(opened.viewerId).toBe(preparedBinding.viewerId);
    expect(backend.committedPreparations).toEqual(["preparation-1"]);
    expect(manager.getViewer(opened.viewerId, 7)).toBe(opened);
    const committedStream = await preparedBinding.openUiStream();
    committedStream.destroy();
    expect(backend.openedStreams).toEqual([
      "instance-app-a",
      "instance-app-a",
    ]);
  });

  test("aborts a failed prepared launch without publishing its viewer", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });
    let candidateViewerId = "";

    await expect(manager.openViewer("app-a", 7, async (binding) => {
      candidateViewerId = binding.viewerId;
      throw new Error("hidden document returned 503");
    })).rejects.toThrow("hidden document returned 503");

    expect(manager.getViewer(candidateViewerId, 7)).toBeNull();
    expect(backend.committedPreparations).toEqual([]);
    expect(backend.abortedPreparations).toEqual(["preparation-1"]);
    for (const channel of [1, 2]) {
      expect(calls.some((call) => call.url.endsWith(`/channels/channel-app-a-${channel}`)))
        .toBe(true);
    }
  });

  test("aborts a prepared launch when the hidden renderer invalidates it", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });
    let candidateViewerId = "";

    await expect(manager.openViewer("app-a", 7, async (binding) => {
      candidateViewerId = binding.viewerId;
      binding.invalidate(new Error("hidden renderer exited"));
    })).rejects.toThrow("launch was cancelled");

    expect(manager.getViewer(candidateViewerId, 7)).toBeNull();
    expect(backend.committedPreparations).toEqual([]);
    expect(backend.abortedPreparations).toEqual(["preparation-1"]);
    for (const channel of [1, 2]) {
      expect(calls.some((call) => call.url.endsWith(`/channels/channel-app-a-${channel}`)))
        .toBe(true);
    }
  });

  test("preserves the prior viewer and capabilities when replacement verification fails", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });
    const opened = await manager.openViewer("app-a", 7, verifyPreparedViewer);

    await expect(manager.reloadApp("app-a", async () => {
      throw new Error("replacement document was incomplete");
    }, publishReloadedViewer)).rejects.toThrow("replacement document was incomplete");

    expect(manager.getViewer(opened.viewerId, 7)).toBe(opened);
    expect(backend.committedPreparations).toEqual(["preparation-1"]);
    expect(backend.abortedPreparations).toEqual(["preparation-2"]);
    for (const channel of [1, 2]) {
      expect(calls.some((call) => call.url.endsWith(`/channels/channel-app-a-${channel}`)))
        .toBe(false);
    }
    for (const channel of [3, 4]) {
      expect(calls.some((call) => call.url.endsWith(`/channels/channel-app-a-${channel}`)))
        .toBe(true);
    }
  });

  test("does not launch when Core cannot issue the exact manifest authority", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch({}, {
      issuedManifestDigest: OTHER_MANIFEST_DIGEST,
    });
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });

    await expect(manager.openViewer("app-a", 7, verifyPreparedViewer))
      .rejects.toThrow("different App manifest authority");
    expect(backend.starts).toEqual([]);
    const issuance = calls.find((call) => (
      call.url.endsWith("/api/app-runtime/channels")
      && call.init?.method === "POST"
    ));
    expect(JSON.parse(String(issuance?.init?.body))).toEqual({
      appId: "app-a",
      workload: "ui",
      manifestGeneration: MANIFEST_GENERATION,
      manifestDigest: MANIFEST_DIGEST,
    });
  });

  test("binds close to the owner and revokes the exact Core channel", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });
    const viewer = await manager.openViewer("app-a", 7, verifyPreparedViewer);

    expect(await manager.closeViewer(viewer.viewerId, 8)).toBe(false);
    expect(backend.stops).toEqual([]);
    expect(await manager.closeViewer(viewer.viewerId, 7)).toBe(true);
    expect(backend.stops).toEqual(["instance-app-a"]);
    expect(calls.some((call) => call.url.endsWith("/channels/channel-app-a-1"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/channels/channel-app-a-2"))).toBe(true);
  });

  test("fails closed before issuing authority when the backend is unavailable", async () => {
    const { fetch, calls } = createFetch();
    const manager = new CapsuleManager({
      backend: {
        async status() { return { available: false, backend: "test", reason: "no verified image" }; },
        async prepareUi() { throw new Error("must not prepare"); },
        async commitPreparedUi() { throw new Error("must not commit"); },
        async abortPreparedUi() {},
        async startUi() { throw new Error("must not run"); },
        async replaceUi() { throw new Error("must not replace"); },
        async openUiStream() { throw new Error("must not stream"); },
        async stopUi() {},
        async stopApp() {},
        async retireApp() {},
        async stopAll() {},
      },
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });

    await expect(manager.openViewer("app-a", 7, verifyPreparedViewer)).rejects.toThrow("no verified image");
    expect(calls).toEqual([]);
  });

  test("preserves a typed restart-required backend state", async () => {
    const backend = new FakeBackend();
    backend.status = async () => ({
      available: false,
      backend: "test",
      reason: "VM stop was not confirmed",
      restartRequired: true,
    });
    const { fetch, calls } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });

    await expect(manager.openViewer("app-a", 7, verifyPreparedViewer))
      .rejects.toBeInstanceOf(CapsuleRestartRequiredError);
    expect(calls).toEqual([]);
  });

  test("stops the whole App boundary and revokes all of its Core channels", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });

    await manager.stopApp("app-a");
    expect(backend.appStops).toEqual(["app-a"]);
    expect(calls.some((call) => call.url.endsWith("/api/app-runtime/apps/app-a/channels")))
      .toBe(true);
  });

  test("globally detaches and revokes every viewer when individual stop loses containment", async () => {
    const backend = new FakeBackend();
    const onBackendBoundaryLost = vi.fn();
    const { fetch, calls } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
      onBackendBoundaryLost,
    });
    const viewerA = await manager.openViewer("app-a", 7, verifyPreparedViewer);
    const viewerB = await manager.openViewer("app-b", 8, verifyPreparedViewer);
    backend.failStopUi = true;

    const failure = await rejectionOf(manager.closeViewer(viewerA.viewerId, 7));
    expect(failure.message).toContain("backend boundary was lost");
    expect(failure.message).toContain("stop failed");

    expect(onBackendBoundaryLost).toHaveBeenCalledOnce();
    expect(backend.stopAllCalls).toBe(1);
    expect(manager.getViewer(viewerB.viewerId, 8)).toBeNull();
    expect(calls.some((call) => call.url.endsWith("/channels/channel-app-b-3"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/channels/channel-app-b-4"))).toBe(true);
  });

  test("revokes every live channel when the backend loses its boundary asynchronously", async () => {
    const backend = new FakeBackend();
    const onBackendBoundaryLost = vi.fn();
    const { fetch, calls } = createFetch();
    const bindings = systemBindings();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...bindings,
      onBackendBoundaryLost,
    });
    const viewer = await manager.openViewer("app-a", 7, verifyPreparedViewer);

    backend.boundaryLostHandler?.(new Error("Guest control channel lost"));
    await vi.waitFor(() => expect(backend.stopAllCalls).toBe(1));

    expect(onBackendBoundaryLost).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Guest control channel lost" }),
    );
    expect(manager.getViewer(viewer.viewerId, 7)).toBeNull();
    expect(bindings.unbindSystemSender).toHaveBeenCalledWith(
      backend.starts[0]!.sdkSenderId,
    );
    expect(calls.some((call) => call.url.endsWith("/channels/channel-app-a-1"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/channels/channel-app-a-2"))).toBe(true);
  });

  test("synchronously detaches one unexpectedly exited UI before revoking its channels", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch();
    const bindings = systemBindings();
    const onUiLost = vi.fn();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...bindings,
      onUiLost,
    });
    const viewer = await manager.openViewer("app-a", 7, verifyPreparedViewer);

    backend.uiLostHandler?.({
      instanceId: viewer.instanceId,
      appId: "app-a",
      error: new Error("workload exited"),
    });

    expect(manager.getViewer(viewer.viewerId, 7)).toBeNull();
    expect(bindings.unbindSystemSender).toHaveBeenCalledWith(
      backend.starts[0]!.sdkSenderId,
    );
    expect(onUiLost).toHaveBeenCalledWith(expect.objectContaining({
      viewerId: viewer.viewerId,
      instanceId: viewer.instanceId,
    }));
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url.endsWith("/channels/channel-app-a-1"))).toBe(true);
      expect(calls.some((call) => call.url.endsWith("/channels/channel-app-a-2"))).toBe(true);
    });
  });

  test("tombstones a launch lost while its browser capability is still being issued", async () => {
    const backend = new FakeBackend();
    const base = createFetch();
    let capabilityRequests = 0;
    let releaseBrowserCapability!: () => void;
    let reportBrowserRequestStarted!: () => void;
    const browserCapabilityStarted = new Promise<void>((resolve) => {
      reportBrowserRequestStarted = resolve;
    });
    const browserCapabilityGate = new Promise<void>((resolve) => {
      releaseBrowserCapability = resolve;
    });
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/app-runtime/channels") && init?.method === "POST") {
        capabilityRequests += 1;
        if (capabilityRequests === 2) {
          reportBrowserRequestStarted();
          await browserCapabilityGate;
        }
      }
      return await base.fetch(input, init);
    }) as typeof globalThis.fetch;
    const bindings = systemBindings();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...bindings,
    });

    const opening = manager.openViewer("app-a", 7, verifyPreparedViewer);
    await browserCapabilityStarted;
    backend.uiLostHandler?.({
      instanceId: "instance-app-a",
      appId: "app-a",
      error: new Error("workload exited during publication"),
    });
    expect(bindings.unbindSystemSender).toHaveBeenCalledWith(
      backend.starts[0]!.sdkSenderId,
    );
    releaseBrowserCapability();

    await expect(opening).rejects.toThrow("workload exited during publication");
    expect(await manager.reloadApp(
      "app-a",
      verifyPreparedViewer,
      publishReloadedViewer,
    )).toEqual({ active: false, browserBindings: [] });
    expect(backend.abortedPreparations).toContain("preparation-1");
    expect(base.calls.some((call) => call.url.endsWith("/channels/channel-app-a-1"))).toBe(true);
    expect(base.calls.some((call) => call.url.endsWith("/channels/channel-app-a-2"))).toBe(true);
  });

  test("tombstones a replacement lost before the manager can publish it", async () => {
    const backend = new FakeBackend();
    const base = createFetch();
    const bindings = systemBindings();
    const onUiLost = vi.fn();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch: base.fetch,
      ...bindings,
      onUiLost,
    });
    const opened = await manager.openViewer("app-a", 7, verifyPreparedViewer);
    backend.loseReplacementBeforeReturn = true;

    await expect(manager.reloadApp(
      "app-a",
      verifyPreparedViewer,
      publishReloadedViewer,
    )).rejects.toThrow(
      "replacement exited before publication",
    );

    expect(manager.getViewer(opened.viewerId, 7)).toBe(opened);
    expect(onUiLost).not.toHaveBeenCalled();
    expect(backend.abortedPreparations).toContain("preparation-2");
    for (const channel of [3, 4]) {
      expect(base.calls.some((call) => call.url.endsWith(`/channels/channel-app-a-${channel}`)))
        .toBe(true);
    }
    for (const channel of [1, 2]) {
      expect(base.calls.some((call) => call.url.endsWith(`/channels/channel-app-a-${channel}`)))
        .toBe(false);
    }
  });

  test("never leaves the retired prior viewer mapped after post-commit candidate loss", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch();
    const bindings = systemBindings();
    const onUiLost = vi.fn();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...bindings,
      onUiLost,
    });
    const opened = await manager.openViewer("app-a", 7, verifyPreparedViewer);
    backend.loseCommittedReplacementBeforeReturn = true;

    await expect(manager.reloadApp(
      "app-a",
      verifyPreparedViewer,
      publishReloadedViewer,
    )).rejects.toThrow(
      "committed replacement exited before Host publication",
    );

    expect(manager.getViewer(opened.viewerId, 7)).toBeNull();
    expect(bindings.unbindSystemSender).toHaveBeenCalledWith(
      backend.starts[0]!.sdkSenderId,
    );
    expect(onUiLost).toHaveBeenCalledWith(expect.objectContaining({
      viewerId: opened.viewerId,
      instanceId: opened.instanceId,
    }));
    expect(backend.stops).toContain("instance-app-a-replacement");
    for (const channel of [1, 2, 3, 4]) {
      expect(calls.some((call) => call.url.endsWith(`/channels/channel-app-a-${channel}`)))
        .toBe(true);
    }
  });

  test("detaches a prior viewer lost during candidate verification", async () => {
    const backend = new FakeBackend();
    const { fetch } = createFetch();
    const bindings = systemBindings();
    const onUiLost = vi.fn();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...bindings,
      onUiLost,
    });
    const opened = await manager.openViewer("app-a", 7, verifyPreparedViewer);
    let prepared!: PreparedViewerBinding;
    let reportVerifierStarted!: () => void;
    const verifierStarted = new Promise<void>((resolve) => {
      reportVerifierStarted = resolve;
    });
    const reload = manager.reloadApp("app-a", async (binding) => {
      prepared = binding;
      reportVerifierStarted();
      await new Promise<void>((_resolve, reject) => {
        binding.signal.addEventListener("abort", () => reject(binding.signal.reason), {
          once: true,
        });
      });
    }, publishReloadedViewer);
    await verifierStarted;

    backend.uiLostHandler?.({
      instanceId: opened.instanceId,
      appId: "app-a",
      error: new Error("prior workload exited during verification"),
    });

    expect(prepared.signal.aborted).toBe(true);
    expect(manager.getViewer(opened.viewerId, 7)).toBeNull();
    expect(onUiLost).toHaveBeenCalledWith(expect.objectContaining({
      viewerId: opened.viewerId,
      instanceId: opened.instanceId,
    }));
    await expect(reload).rejects.toThrow("prior workload exited during verification");
    expect(backend.abortedPreparations).toContain("preparation-2");
  });

  test("does not report a replacement active if it exits while old channels are retiring", async () => {
    const backend = new FakeBackend();
    const base = createFetch();
    let releaseOldChannel!: () => void;
    let reportOldChannelRetirement!: () => void;
    const oldChannelRetirementStarted = new Promise<void>((resolve) => {
      reportOldChannelRetirement = resolve;
    });
    const oldChannelGate = new Promise<void>((resolve) => { releaseOldChannel = resolve; });
    const cutoverOrder: string[] = [];
    let held = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!held && init?.method === "DELETE" && url.endsWith("/channels/channel-app-a-1")) {
        held = true;
        cutoverOrder.push("old-channel-revocation");
        reportOldChannelRetirement();
        await oldChannelGate;
      }
      return await base.fetch(input, init);
    }) as typeof globalThis.fetch;
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
      onUiLost: vi.fn(),
    });
    const opened = await manager.openViewer("app-a", 7, verifyPreparedViewer);

    const reload = manager.reloadApp(
      "app-a",
      verifyPreparedViewer,
      (binding) => {
        cutoverOrder.push("renderer-publication");
        expect(manager.getViewer(binding.viewerId, 7)).toMatchObject({
          instanceId: binding.instanceId,
          channelId: binding.channelId,
        });
      },
    );
    await oldChannelRetirementStarted;
    expect(cutoverOrder).toEqual([
      "renderer-publication",
      "old-channel-revocation",
    ]);
    backend.uiLostHandler?.({
      instanceId: "instance-app-a-replacement",
      appId: "app-a",
      error: new Error("replacement exited during Host cutover"),
    });
    releaseOldChannel();

    await expect(reload).rejects.toThrow("stopped before Host publication completed");
    expect(manager.getViewer(opened.viewerId, 7)).toBeNull();
    await vi.waitFor(() => {
      expect(base.calls.some((call) => call.url.endsWith("/channels/channel-app-a-3"))).toBe(true);
      expect(base.calls.some((call) => call.url.endsWith("/channels/channel-app-a-4"))).toBe(true);
    });
  });

  test("removes the committed generation when synchronous renderer publication fails", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch();
    const bindings = systemBindings();
    const onUiLost = vi.fn();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...bindings,
      onUiLost,
    });
    const opened = await manager.openViewer("app-a", 7, verifyPreparedViewer);

    await expect(manager.reloadApp(
      "app-a",
      verifyPreparedViewer,
      () => {
        throw new Error("renderer cutover failed");
      },
    )).rejects.toThrow("renderer cutover failed");

    expect(manager.getViewer(opened.viewerId, 7)).toBeNull();
    expect(backend.stops).toContain("instance-app-a-replacement");
    expect(onUiLost).toHaveBeenCalledWith(expect.objectContaining({
      viewerId: opened.viewerId,
      instanceId: "instance-app-a-replacement",
    }));
    for (const channel of [1, 2, 3, 4]) {
      expect(calls.some((call) => call.url.endsWith(`/channels/channel-app-a-${channel}`)))
        .toBe(true);
    }
  });

  test("does not let best-effort renderer retirement hold the reload fence", async () => {
    const backend = new FakeBackend();
    const { fetch } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });
    await manager.openViewer("app-a", 7, verifyPreparedViewer);

    await expect(manager.reloadApp(
      "app-a",
      verifyPreparedViewer,
      () => ({ cleanup: new Promise<void>(() => {}) }),
    )).resolves.toMatchObject({
      active: true,
      browserBindings: [{
        instanceId: "instance-app-a-replacement",
      }],
    });
  });

  test("fails closed when a manifest declares unsupported service or job workloads", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch({
      "app-a": {
        ui: { command: ["npm", "run", "start"], port: 3000 },
        services: { indexer: { command: ["npm", "run", "indexer"] } },
      },
      "app-b": {
        jobs: { daily: { command: ["npm", "run", "daily"] } },
      },
    });
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });

    await expect(manager.openViewer("app-a", 7, verifyPreparedViewer)).rejects.toThrow("declares services");
    await expect(manager.openViewer("app-b", 7, verifyPreparedViewer)).rejects.toThrow("declares jobs");
    expect(backend.starts).toEqual([]);
    expect(calls.filter((call) => call.url.endsWith("/api/app-runtime/channels")))
      .toEqual([]);
  });

  test("cancels an in-flight rebuild before waiting for it to settle", async () => {
    const backend = new FakeBackend();
    let releaseRebuild!: () => void;
    backend.rebuildGate = new Promise<void>((resolve) => { releaseRebuild = resolve; });
    const { fetch } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });
    await manager.openViewer("app-a", 7, verifyPreparedViewer);

    const rebuild = manager.reloadApp(
      "app-a",
      verifyPreparedViewer,
      publishReloadedViewer,
    );
    await Promise.resolve();
    const stop = manager.stopApp("app-a");
    await Promise.resolve();
    expect(backend.appStops).toEqual(["app-a"]);

    releaseRebuild();
    await expect(rebuild).rejects.toThrow("reload was cancelled");
    await stop;
    expect(backend.appStops).toEqual(["app-a"]);
  });

  test("aborts the verifier and preparation before App stop waits for reload", async () => {
    const backend = new FakeBackend();
    const { fetch } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });
    await manager.openViewer("app-a", 7, verifyPreparedViewer);
    let reportVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      reportVerificationStarted = resolve;
    });
    let verifierSignal!: AbortSignal;
    const reload = manager.reloadApp("app-a", async (binding) => {
      verifierSignal = binding.signal;
      reportVerificationStarted();
      await new Promise<void>((_resolve, reject) => {
        binding.signal.addEventListener("abort", () => {
          reject(binding.signal.reason);
        }, { once: true });
      });
    }, publishReloadedViewer);
    await verificationStarted;

    const stopping = manager.stopApp("app-a");
    expect(verifierSignal.aborted).toBe(true);
    expect(backend.abortedPreparations).toContain("preparation-2");
    await expect(reload).rejects.toThrow("stopping");
    await stopping;
    expect(backend.appStops).toEqual(["app-a"]);
  });

  test("issues global backend cancellation before waiting for in-flight launches", async () => {
    const backend = new FakeBackend();
    let reportLaunchStarted!: () => void;
    let rejectLaunch!: (error: Error) => void;
    const launchStarted = new Promise<void>((resolve) => { reportLaunchStarted = resolve; });
    backend.prepareUi = async (spec) => {
      backend.starts.push(spec);
      reportLaunchStarted();
      return await new Promise<{
        preparationId: string;
        instanceId: string;
      }>((_resolve, reject) => {
        rejectLaunch = reject;
      });
    };
    let releaseBackendStop!: () => void;
    const backendStop = new Promise<void>((resolve) => { releaseBackendStop = resolve; });
    backend.stopAll = () => {
      backend.stopAllCalls += 1;
      rejectLaunch(new Error("launch cancelled by stopAll"));
      return backendStop;
    };
    const { fetch } = createFetch();
    const bindings = systemBindings();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...bindings,
    });

    const opening = manager.openViewer("app-a", 7, verifyPreparedViewer);
    const openingFailure = expect(opening).rejects.toThrow("launch cancelled by stopAll");
    await launchStarted;

    const firstStop = manager.stopAll();
    const duplicateStop = manager.stopAll();
    expect(duplicateStop).toBe(firstStop);
    expect(backend.stopAllCalls).toBe(1);
    expect(bindings.unbindSystemSender).toHaveBeenCalledWith(
      backend.starts[0]!.sdkSenderId,
    );

    let stopSettled = false;
    void firstStop.finally(() => { stopSettled = true; });
    await openingFailure;
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseBackendStop();
    await firstStop;
  });

  test("stops locally after control-plane loss without calling the dead Core", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch();
    const bindings = systemBindings();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...bindings,
    });
    await manager.openViewer("app-a", 7, verifyPreparedViewer);
    const callCountBeforeStop = calls.length;

    await manager.stopAll({ controlPlaneLost: true });

    expect(backend.stopAllCalls).toBe(1);
    expect(bindings.unbindSystemSender).toHaveBeenCalled();
    expect(calls.slice(callCountBeforeStop).some((call) => (
      call.init?.method === "DELETE"
    ))).toBe(false);
    await expect(manager.openViewer("app-a", 7, verifyPreparedViewer))
      .resolves.toMatchObject({ appId: "app-a" });
  });

  test("upgrades an in-flight global stop when the control plane is lost", async () => {
    const backend = new FakeBackend();
    const base = createFetch();
    let reportDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      reportDeleteStarted = resolve;
    });
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        reportDeleteStarted();
        return await new Promise<Response>(() => {});
      }
      return await base.fetch(input, init);
    }) as typeof globalThis.fetch;
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });
    await manager.openViewer("app-a", 7, verifyPreparedViewer);

    const stopping = manager.stopAll();
    await deleteStarted;
    const upgraded = manager.stopAll({ controlPlaneLost: true });

    expect(upgraded).toBe(stopping);
    await stopping;
    expect(backend.stopAllCalls).toBe(1);
    await expect(manager.openViewer("app-a", 7, verifyPreparedViewer))
      .resolves.toMatchObject({ appId: "app-a" });
  });

  test("waits for an old UI-loss settlement before reusing the control plane", async () => {
    const backend = new FakeBackend();
    const base = createFetch();
    let deleteCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleteCalls += 1;
        return await new Promise<Response>(() => {});
      }
      return await base.fetch(input, init);
    }) as typeof globalThis.fetch;
    let reportHostCleanupStarted!: () => void;
    const hostCleanupStarted = new Promise<void>((resolve) => {
      reportHostCleanupStarted = resolve;
    });
    let releaseHostCleanup!: () => void;
    const hostCleanup = new Promise<void>((resolve) => {
      releaseHostCleanup = resolve;
    });
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
      onUiLost() {
        reportHostCleanupStarted();
        return hostCleanup;
      },
    });
    const opened = await manager.openViewer("app-a", 7, verifyPreparedViewer);
    backend.uiLostHandler?.({
      instanceId: opened.instanceId,
      appId: opened.appId,
      error: new Error("old UI exited"),
    });
    await hostCleanupStarted;

    let stopSettled = false;
    const stopping = manager.stopAll({ controlPlaneLost: true });
    void stopping.then(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseHostCleanup();
    await stopping;
    expect(deleteCalls).toBe(2);
    await expect(manager.openViewer("app-a", 7, verifyPreparedViewer))
      .resolves.toMatchObject({ appId: "app-a" });
    expect(deleteCalls).toBe(2);
  });

  test("still quarantines a failed backend after control-plane loss", async () => {
    const backend = new FakeBackend();
    backend.stopAll = async () => {
      backend.stopAllCalls += 1;
      throw new Error("backend stop failed");
    };
    const { fetch } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });

    await expect(manager.stopAll({ controlPlaneLost: true })).rejects.toMatchObject({
      name: "CapsuleRestartRequiredError",
      restartRequired: true,
    });
    await expect(manager.status()).resolves.toMatchObject({
      available: false,
      restartRequired: true,
    });
  });

  test("never binds a capability issued after the global stop fence", async () => {
    const backend = new FakeBackend();
    const base = createFetch();
    let reportIssuanceStarted!: () => void;
    let releaseIssuance!: () => void;
    const issuanceStarted = new Promise<void>((resolve) => { reportIssuanceStarted = resolve; });
    const issuanceGate = new Promise<void>((resolve) => { releaseIssuance = resolve; });
    let held = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!held && url.endsWith("/api/app-runtime/channels") && init?.method === "POST") {
        held = true;
        reportIssuanceStarted();
        await issuanceGate;
      }
      return await base.fetch(input, init);
    }) as typeof globalThis.fetch;
    const bindings = systemBindings();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...bindings,
    });

    const opening = manager.openViewer("app-a", 7, verifyPreparedViewer);
    const openingFailure = expect(opening).rejects.toThrow("launch was cancelled");
    await issuanceStarted;
    const stopping = manager.stopAll();
    expect(backend.stopAllCalls).toBe(1);

    releaseIssuance();
    await openingFailure;
    await stopping;

    expect(bindings.bindSystemSender).not.toHaveBeenCalled();
    expect(backend.starts).toEqual([]);
    expect(base.calls.some((call) => (
      call.url.endsWith("/api/app-runtime/apps/app-a/channels")
      && call.init?.method === "DELETE"
    ))).toBe(true);
    expect(base.calls.some((call) => (
      call.url.endsWith("/api/app-runtime/channels/channel-app-a-1")
      && call.init?.method === "DELETE"
    ))).toBe(true);
  });

  test("does not admit App-scoped teardown after the global fence", async () => {
    const backend = new FakeBackend();
    let releaseBackendStop!: () => void;
    backend.stopAll = () => {
      backend.stopAllCalls += 1;
      return new Promise<void>((resolve) => { releaseBackendStop = resolve; });
    };
    const { fetch } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });
    manager.beginAppRetirement("app-a");

    const globalStop = manager.stopAll();
    expect(manager.stopApp("app-b")).toBe(globalStop);
    await expect(manager.retireApp("app-a")).rejects.toThrow("App Capsule is stopping");
    expect(backend.appStops).toEqual([]);
    expect(backend.appRetires).toEqual([]);

    releaseBackendStop();
    await globalStop;
  });

  test("quarantines the Manager when global shutdown does not quiesce", async () => {
    vi.useFakeTimers();
    try {
      const backend = new FakeBackend();
      backend.stopAll = () => new Promise<void>(() => {});
      const { fetch } = createFetch();
      const manager = new CapsuleManager({
        backend,
        workspacePath: () => "/workspace",
        coreBaseUrl: () => "http://127.0.0.1:32100",
        coreToken: "host-token",
        fetch,
        ...systemBindings(),
      });

      const stopping = manager.stopAll();
      const rejected = expect(stopping).rejects.toMatchObject({
        name: "CapsuleRestartRequiredError",
        restartRequired: true,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
      await expect(manager.status()).resolves.toMatchObject({
        available: false,
        restartRequired: true,
      });
      await expect(manager.openViewer("app-a", 7, verifyPreparedViewer)).rejects.toMatchObject({
        restartRequired: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("holds one retirement fence across teardown and blocks new App generations", async () => {
    const backend = new FakeBackend();
    let releaseRetirement!: () => void;
    backend.retireGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    const { fetch, calls } = createFetch();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...systemBindings(),
    });

    manager.beginAppRetirement("app-a");
    await expect(manager.openViewer("app-a", 7, verifyPreparedViewer)).rejects.toThrow("active viewer");
    await expect(manager.reloadApp(
      "app-a",
      verifyPreparedViewer,
      publishReloadedViewer,
    )).rejects.toThrow("stopping");

    const first = manager.retireApp("app-a");
    const duplicate = manager.retireApp("app-a");
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(backend.appRetires).toEqual(["app-a"]));
    expect(calls.some((call) => (
      call.url.endsWith("/api/app-runtime/apps/app-a/channels")
      && call.init?.method === "DELETE"
    ))).toBe(true);

    releaseRetirement();
    await first;
    await expect(manager.openViewer("app-a", 7, verifyPreparedViewer)).rejects.toThrow("active viewer");
    manager.finishAppRetirement("app-a");
    await expect(manager.openViewer("app-a", 7, verifyPreparedViewer)).resolves.toMatchObject({ appId: "app-a" });
  });

  test("rotates runtime and browser channels before replacing a live UI", async () => {
    const backend = new FakeBackend();
    const { fetch, calls } = createFetch();
    const bindings = systemBindings();
    const manager = new CapsuleManager({
      backend,
      workspacePath: () => "/workspace",
      coreBaseUrl: () => "http://127.0.0.1:32100",
      coreToken: "host-token",
      fetch,
      ...bindings,
    });
    const opened = await manager.openViewer("app-a", 7, verifyPreparedViewer);

    const reloaded = await manager.reloadApp(
      "app-a",
      verifyPreparedViewer,
      publishReloadedViewer,
    );

    expect(reloaded).toMatchObject({
      active: true,
      browserBindings: [{
        viewerId: opened.viewerId,
        instanceId: "instance-app-a-replacement",
        channelId: "channel-app-a-4",
        capability: "secret-capability-app-a-4",
      }],
    });
    expect(backend.replacements).toEqual([{
      instanceId: "instance-app-a",
      spec: {
        appId: "app-a",
        manifestGeneration: MANIFEST_GENERATION,
        manifestDigest: MANIFEST_DIGEST,
        packageDir: "/workspace/apps/app-a",
        command: ["npm", "run", "start"],
        port: 3000,
        sdkSenderId: expect.stringMatching(/^capsule_/),
      },
    }]);
    expect(manager.getViewer(opened.viewerId, 7)?.instanceId)
      .toBe("instance-app-a-replacement");
    expect(bindings.unbindSystemSender).toHaveBeenCalledWith(
      backend.starts[0]!.sdkSenderId,
    );
    expect(calls.some((call) => call.url.endsWith("/channels/channel-app-a-1"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/channels/channel-app-a-2"))).toBe(true);
  });
});
