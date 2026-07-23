import { describe, expect, test, vi } from "vitest";
import type { Duplex } from "node:stream";
import type {
  CapsuleBackend,
  CapsuleUiInstance,
  CapsuleUiSpec,
} from "./backend";
import { CapsuleRestartRequiredError } from "./backend";
import { CapsuleManager } from "./manager";

const MANIFEST_GENERATION = 7;
const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_MANIFEST_DIGEST = `sha256:${"b".repeat(64)}`;

class FakeBackend implements CapsuleBackend {
  starts: CapsuleUiSpec[] = [];
  stops: string[] = [];
  appStops: string[] = [];
  appRetires: string[] = [];
  replacements: Array<{ instanceId: string; spec: CapsuleUiSpec }> = [];
  stopAllCalls = 0;
  failStopUi = false;
  rebuildGate: Promise<void> | undefined;
  retireGate: Promise<void> | undefined;
  loseReplacementBeforeReturn = false;
  boundaryLostHandler: ((error: unknown) => void) | undefined;
  uiLostHandler: ((event: { instanceId: string; appId: string; error: Error }) => void) | undefined;
  setBoundaryLostHandler(handler: (error: unknown) => void) {
    this.boundaryLostHandler = handler;
  }
  setUiLostHandler(handler: (event: { instanceId: string; appId: string; error: Error }) => void) {
    this.uiLostHandler = handler;
  }
  async status() { return { available: true, backend: "fake" }; }
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
  async openUiStream(): Promise<Duplex> { throw new Error("stream fixture not connected"); }
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

    const viewer = await manager.openViewer("app-a", 7);
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

    await expect(manager.openViewer("app-a", 7))
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
    const viewer = await manager.openViewer("app-a", 7);

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

    await expect(manager.openViewer("app-a", 7)).rejects.toThrow("no verified image");
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

    await expect(manager.openViewer("app-a", 7))
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
    const viewerA = await manager.openViewer("app-a", 7);
    const viewerB = await manager.openViewer("app-b", 8);
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
    const viewer = await manager.openViewer("app-a", 7);

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
    const viewer = await manager.openViewer("app-a", 7);

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

    const opening = manager.openViewer("app-a", 7);
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
    expect(await manager.reloadApp("app-a")).toEqual({ active: false, browserBindings: [] });
    expect(backend.stops).toContain("instance-app-a");
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
    const opened = await manager.openViewer("app-a", 7);
    backend.loseReplacementBeforeReturn = true;

    await expect(manager.reloadApp("app-a")).rejects.toThrow(
      "replacement exited before publication",
    );

    expect(manager.getViewer(opened.viewerId, 7)).toBeNull();
    expect(onUiLost).toHaveBeenCalledWith(expect.objectContaining({
      viewerId: opened.viewerId,
      instanceId: "instance-app-a-replacement",
    }));
    expect(backend.stops).toContain("instance-app-a-replacement");
    for (const channel of [1, 2, 3, 4]) {
      expect(base.calls.some((call) => call.url.endsWith(`/channels/channel-app-a-${channel}`)))
        .toBe(true);
    }
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
    let held = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!held && init?.method === "DELETE" && url.endsWith("/channels/channel-app-a-1")) {
        held = true;
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
    const opened = await manager.openViewer("app-a", 7);

    const reload = manager.reloadApp("app-a");
    await oldChannelRetirementStarted;
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

    await expect(manager.openViewer("app-a", 7)).rejects.toThrow("declares services");
    await expect(manager.openViewer("app-b", 7)).rejects.toThrow("declares jobs");
    expect(backend.starts).toEqual([]);
    expect(calls.filter((call) => call.url.endsWith("/api/app-runtime/channels")))
      .toEqual([]);
  });

  test("serializes stop behind an in-flight rebuild", async () => {
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
    await manager.openViewer("app-a", 7);

    const rebuild = manager.reloadApp("app-a");
    await Promise.resolve();
    const stop = manager.stopApp("app-a");
    await Promise.resolve();
    expect(backend.appStops).toEqual([]);

    releaseRebuild();
    await expect(rebuild).rejects.toThrow("reload was cancelled");
    await stop;
    expect(backend.appStops).toEqual(["app-a"]);
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
    await expect(manager.openViewer("app-a", 7)).rejects.toThrow("active viewer");
    await expect(manager.reloadApp("app-a")).rejects.toThrow("stopping");

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
    await expect(manager.openViewer("app-a", 7)).rejects.toThrow("active viewer");
    manager.finishAppRetirement("app-a");
    await expect(manager.openViewer("app-a", 7)).resolves.toMatchObject({ appId: "app-a" });
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
    const opened = await manager.openViewer("app-a", 7);

    const reloaded = await manager.reloadApp("app-a");

    expect(reloaded).toMatchObject({
      active: true,
      browserBindings: [{
        viewerId: opened.viewerId,
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
