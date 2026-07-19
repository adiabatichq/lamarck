import { mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildPrepareBody } from "@lamarck/capsule";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { GuestBlobStore } from "../src/blob-store";
import {
  GuestBuildManager,
  BUILD_MEMORY_ADMISSION_FLOOR_BYTES,
  MAX_BUILD_HANDLES_PER_BOOT,
  MAX_LIVE_BUILDS,
  MAX_PREPARING_BUILDS,
  MAX_PACKAGE_JSON_BYTES,
  MAX_PACKAGE_LOCK_BYTES,
  MAX_TERMINAL_BUILD_RESULTS,
  TERMINAL_BUILD_RESULT_TTL_MS,
  buildAdmissionRequest,
  readBoundedJsonFile,
  type SealedArtifactDescriptor,
} from "../src/build-manager";
import { BuildContainmentError } from "../src/build-runner";
import {
  MAX_DEPENDENCY_MANIFEST_BYTES,
  validateDependencyBundle,
} from "../src/dependency-bundle";
import { materializeCapsuleTree } from "../src/tree-materializer";

const APP = "A".repeat(22);
const PACKAGE = `sha256:${"a".repeat(64)}`;
const IMAGE = `sha256:${"b".repeat(64)}`;
const INSTALL = `sha256:${"d".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("Guest Build lifecycle authority", () => {
  test("shares one lifecycle and publishes completion only after its finalizer settles", async () => {
    const manager = createManager();
    const body = buildBody(buildHandle(1));
    await manager.prepare(body);
    const execution = deferred<SealedArtifactDescriptor>();
    installExecutor(manager, async () => await execution.promise);

    const first = manager.start(APP, body.buildHandle);
    const duplicate = manager.start(APP, body.buildHandle);
    expect(duplicate).toBe(first);
    expect(internals(manager).terminalBuilds.size).toBe(0);
    expect(internals(manager).builds.size).toBe(1);

    execution.resolve(descriptor());
    await expect(first).resolves.toEqual(descriptor());
    await expect(duplicate).resolves.toEqual(descriptor());
    expect(internals(manager).builds.size).toBe(0);
    expect(internals(manager).terminalBuilds.get(body.buildHandle)?.state).toBe("completed");
    await expect(manager.start(APP, body.buildHandle)).resolves.toEqual(descriptor());
  });

  test("makes cancel and drain wait for the exact lifecycle cleanup barrier", async () => {
    const manager = createManager();
    const body = buildBody(buildHandle(2));
    await manager.prepare(body);
    const cleanup = deferred<SealedArtifactDescriptor>();
    let signal!: AbortSignal;
    installExecutor(manager, async (_record, controller) => {
      signal = controller.signal;
      return await cleanup.promise;
    });
    const started = manager.start(APP, body.buildHandle);
    const cancelling = manager.cancel(APP, body.buildHandle, 123);
    expect(signal.aborted).toBe(true);
    let cancelled = false;
    void cancelling.then(() => { cancelled = true; });
    await Promise.resolve();
    expect(cancelled).toBe(false);

    cleanup.reject(signal.reason as Error);
    await expect(started).rejects.toThrow(/cancelled/i);
    await expect(cancelling).resolves.toBeUndefined();
    expect(internals(manager).terminalBuilds.get(body.buildHandle)?.state).toBe("cancelled");

    const second = buildBody(buildHandle(3));
    await manager.prepare(second);
    const drainCleanup = deferred<SealedArtifactDescriptor>();
    installExecutor(manager, async (_record, controller) => {
      signal = controller.signal;
      return await drainCleanup.promise;
    });
    const secondStart = manager.start(APP, second.buildHandle);
    const draining = manager.drain();
    expect(signal.aborted).toBe(true);
    expect(() => manager.prepare(buildBody(buildHandle(4)))).toThrow(/draining/);
    let drained = false;
    void draining.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    drainCleanup.reject(signal.reason as Error);
    await expect(secondStart).rejects.toThrow(/revoked during drain/i);
    await expect(draining).resolves.toBeUndefined();
  });

  test("lets cancellation win after execution resolves but before completion publication", async () => {
    const manager = createManager();
    const body = buildBody(buildHandle(40_000));
    await manager.prepare(body);
    const execution = deferred<SealedArtifactDescriptor>();
    installExecutor(manager, async () => await execution.promise);
    const started = manager.start(APP, body.buildHandle);

    execution.resolve(descriptor());
    // Promise callbacks have not run yet: cancellation must remain observable
    // by the post-finalizer publication check.
    const cancelling = manager.cancel(APP, body.buildHandle, 0);
    await expect(started).rejects.toThrow(/cancelled/i);
    await expect(cancelling).resolves.toBeUndefined();
    expect(internals(manager).terminalBuilds.get(body.buildHandle)?.state).toBe("cancelled");
    await expect(manager.start(APP, body.buildHandle)).rejects.toThrow(/retired/);
  });

  test("does not publish a prepare which was blocked when drain fenced admission", async () => {
    const has = deferred<boolean>();
    const blobs = { has: vi.fn(async () => await has.promise) } as unknown as GuestBlobStore;
    const manager = new GuestBuildManager(blobs, { imageDigest: IMAGE });
    const preparations: Promise<void>[] = [];
    for (let index = 0; index < MAX_PREPARING_BUILDS; index += 1) {
      const body = buildBody(buildHandle(40_001 + index));
      const preparing = manager.prepare(body);
      preparations.push(preparing);
      if (index === 0) expect(manager.prepare(body)).toBe(preparing);
    }
    await expect(manager.prepare(buildBody(buildHandle(50_000)))).rejects.toThrow(
      /prepare admission/,
    );
    const draining = manager.drain();
    let drained = false;
    void draining.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    has.resolve(true);

    const settled = await Promise.allSettled(preparations);
    expect(settled.every((result) => (
      result.status === "rejected" && /draining/.test(String(result.reason))
    ))).toBe(true);
    await expect(draining).resolves.toBeUndefined();
    expect(internals(manager).builds.size).toBe(0);
    expect(internals(manager).seenBuildHandles.size).toBe(0);
  });

  test("latches a finalizer containment failure permanently across retirement and drain", async () => {
    const manager = createManager();
    const body = buildBody(buildHandle(5));
    await manager.prepare(body);
    const fatal = new BuildContainmentError("cleanup proof failed");
    installExecutor(manager, async () => { throw fatal; });

    await expect(manager.start(APP, body.buildHandle)).rejects.toBe(fatal);
    expect(internals(manager).builds.size).toBe(0);
    await expect(manager.drain()).rejects.toBe(fatal);
    expect(() => manager.start(APP, body.buildHandle)).toThrow(/cleanup proof failed/);
  });

  test("strictly bounds live, lifetime, and expiring terminal result state", async () => {
    let now = 1_000;
    const manager = createManager(() => now);
    for (let index = 0; index < MAX_LIVE_BUILDS; index += 1) {
      await manager.prepare(buildBody(buildHandle(index + 10)));
    }
    await expect(manager.prepare(buildBody(buildHandle(10_000)))).rejects.toThrow(/live Build admission/);

    for (let index = 0; index < MAX_LIVE_BUILDS; index += 1) {
      await manager.cancel(APP, buildHandle(index + 10), 0);
    }
    for (let index = MAX_LIVE_BUILDS; index < MAX_BUILD_HANDLES_PER_BOOT; index += 1) {
      const handle = buildHandle(index + 10);
      await manager.prepare(buildBody(handle));
      await manager.cancel(APP, handle, 0);
    }
    expect(internals(manager).seenBuildHandles.size).toBe(MAX_BUILD_HANDLES_PER_BOOT);
    expect(internals(manager).terminalBuilds.size).toBe(MAX_TERMINAL_BUILD_RESULTS);
    await expect(manager.prepare(buildBody(buildHandle(20_000)))).rejects.toThrow(/identity budget/);

    now += TERMINAL_BUILD_RESULT_TTL_MS;
    // TTL bounds diagnostic/result memory; the permanent seen-handle set still
    // rejects ABA reuse for this complete Guest boot.
    expect(internals(manager).getTerminalBuild(buildHandle(MAX_BUILD_HANDLES_PER_BOOT + 9))).toBeUndefined();
    await expect(manager.cancel(
      APP,
      buildHandle(MAX_BUILD_HANDLES_PER_BOOT + 9),
      0,
    )).resolves.toBeUndefined();
    await expect(manager.cancel(
      "Z".repeat(22),
      buildHandle(MAX_BUILD_HANDLES_PER_BOOT + 9),
      0,
    )).rejects.toThrow(/retired/);
    await expect(manager.prepare(buildBody(buildHandle(10)))).rejects.toThrow(/Retired Build handle/);
  });
});

describe("Guest Build parser and iterator bounds", () => {
  test("charges the fixed supervisor-memory floor even for a small cgroup request", () => {
    const body = buildBody(buildHandle(30_000));
    body.resources.memoryBytes = 64 * 1024 * 1024;
    expect(buildAdmissionRequest(body).memoryBytes).toBe(BUILD_MEMORY_ADMISSION_FLOOR_BYTES);
    body.resources.memoryBytes = BUILD_MEMORY_ADMISSION_FLOOR_BYTES * 2;
    expect(buildAdmissionRequest(body).memoryBytes).toBe(BUILD_MEMORY_ADMISSION_FLOOR_BYTES * 2);
  });

  test("rejects oversized JSON by stat before allocating/parsing it", async () => {
    const root = join(tmpdir(), `lamarck-build-json-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const path = join(root, "package.json");
    const handle = await open(path, "w", 0o600);
    await handle.truncate(MAX_PACKAGE_JSON_BYTES + 1);
    await handle.close();
    await expect(readBoundedJsonFile(
      path,
      MAX_PACKAGE_JSON_BYTES,
      "package.json",
    )).rejects.toThrow(/parse bound/);

    const lock = join(root, "package-lock.json");
    const lockHandle = await open(lock, "w", 0o600);
    await lockHandle.truncate(MAX_PACKAGE_LOCK_BYTES + 1);
    await lockHandle.close();
    await expect(readBoundedJsonFile(
      lock,
      MAX_PACKAGE_LOCK_BYTES,
      "package-lock.json",
    )).rejects.toThrow(/parse bound/);

    const dependencyRoot = join(root, "dependencies");
    await mkdir(dependencyRoot, { recursive: true });
    const manifest = await open(join(dependencyRoot, "manifest.json"), "w", 0o600);
    await manifest.truncate(MAX_DEPENDENCY_MANIFEST_BYTES + 1);
    await manifest.close();
    await expect(validateDependencyBundle(dependencyRoot)).rejects.toThrow(/parse bound/);
  });

  test("closes the source iterator on malformed input and abort", async () => {
    const root = join(tmpdir(), `lamarck-build-tree-${process.pid}-${Date.now()}`);
    roots.push(root);
    let malformedClosed = false;
    async function* malformed() {
      try {
        yield Buffer.from("not-a-capsule-tree");
        await new Promise(() => undefined);
      } finally {
        malformedClosed = true;
      }
    }
    await expect(materializeCapsuleTree(malformed(), join(root, "malformed"))).rejects.toThrow();
    expect(malformedClosed).toBe(true);

    let abortedClosed = false;
    const controller = new AbortController();
    async function* aborting() {
      try {
        controller.abort(new Error("cancel tree"));
        yield Buffer.alloc(64);
      } finally {
        abortedClosed = true;
      }
    }
    await expect(materializeCapsuleTree(
      aborting(),
      join(root, "aborted"),
      controller.signal,
    )).rejects.toThrow(/cancel tree/);
    expect(abortedClosed).toBe(true);
  });
});

function createManager(now: () => number = Date.now): GuestBuildManager {
  const blobs = { has: vi.fn(async () => true) } as unknown as GuestBlobStore;
  return new GuestBuildManager(blobs, { imageDigest: IMAGE, now });
}

function installExecutor(
  manager: GuestBuildManager,
  executor: (
    record: { body: BuildPrepareBody },
    controller: AbortController,
  ) => Promise<SealedArtifactDescriptor>,
): void {
  (manager as unknown as {
    executeBuild: typeof executor;
  }).executeBuild = executor;
}

function internals(manager: GuestBuildManager) {
  return manager as unknown as {
    builds: Map<string, unknown>;
    seenBuildHandles: Map<string, string>;
    terminalBuilds: Map<string, { state: string }>;
    getTerminalBuild(handle: string): unknown;
  };
}

function buildBody(buildHandleValue: string): BuildPrepareBody {
  return {
    ownerKey: "a".repeat(64),
    appHandle: APP,
    buildHandle: buildHandleValue,
    packageDigest: PACKAGE,
    packageBytes: 1,
    packageBlobHandle: "L".repeat(22),
    installDigest: INSTALL,
    mappedHostUid: 100_000,
    mappedHostGid: 200_000,
    timeoutMs: 60_000,
    resources: {
      memoryBytes: 512 * 1024 * 1024,
      pids: 256,
      cpuQuotaMicros: 100_000,
    },
  };
}

function buildHandle(index: number): string {
  return index.toString(36).padStart(22, "B");
}

function descriptor(): SealedArtifactDescriptor {
  return {
    format: "erofs-v1",
    digest: `sha256:${"c".repeat(64)}`,
    bytes: 4_096,
    imageDigest: IMAGE,
    runtimeAbi: "capsule-node-v1",
    architecture: process.arch,
    libc: "glibc-test",
    nodeVersion: process.versions.node,
    nodeModulesAbi: process.versions.modules,
    sourceDigest: PACKAGE,
    installDigest: INSTALL,
    fileCount: 3,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
