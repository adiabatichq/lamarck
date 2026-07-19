import { EventEmitter } from "node:events";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { GuestBlobStore } from "../src/blob-store";
import type { GuestFilesystemPaths } from "../src/config";
import { GuestContainmentError } from "../src/containment-error";
import { GuestResourceAdmissionError } from "../src/resource-admission";
import {
  AppViewerProxyRegistry,
  ArtifactMountRegistry,
  attachViewerProxyStreams,
  GuestResourceManager,
  prepareAppCgroupHierarchy,
} from "../src/resource-manager";

const APP = "A".repeat(22);
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

describe("App viewer proxy ownership", () => {
  test("caps each App independently and retains capacity until transport ownership releases", () => {
    const registry = new AppViewerProxyRegistry();
    const children = Array.from({ length: 8 }, (_, index) => new FakeChild(index + 1));
    const releases = children.map((child) => (
      registry.register(APP, child as unknown as ChildProcess)
    ));
    expect(() => registry.register(APP, new FakeChild(9) as unknown as ChildProcess)).toThrow(
      /viewer proxy limit/,
    );
    children[0]!.exit("SIGTERM");
    expect(() => registry.register(APP, new FakeChild(10) as unknown as ChildProcess)).toThrow(
      /viewer proxy limit/,
    );
    releases[0]!();
    expect(() => registry.register(APP, new FakeChild(10) as unknown as ChildProcess)).not.toThrow();
  });

  test("stopApp terminates every proxy in only that App, escalating to SIGKILL", async () => {
    const registry = new AppViewerProxyRegistry();
    const graceful = new FakeChild(1, "TERM");
    const stubborn = new FakeChild(2, "KILL");
    const other = new FakeChild(3, "TERM");
    releaseOnExit(graceful, registry.register(APP, graceful as unknown as ChildProcess));
    releaseOnExit(stubborn, registry.register(APP, stubborn as unknown as ChildProcess));
    releaseOnExit(other, registry.register("B".repeat(22), other as unknown as ChildProcess));

    await registry.stopApp(APP);
    expect(graceful.signals).toEqual(["SIGTERM"]);
    expect(stubborn.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(other.signals).toEqual([]);
  });

  test.each(["stopApp", "drain"] as const)(
    "%s waits for final proxy stdout emitted after child exit",
    async (operation) => {
      const registry = new AppViewerProxyRegistry();
      const child = new FakeProxyChild();
      const stream = new RecordingDuplex();
      const release = registry.register(APP, child as unknown as ChildProcess);
      attachViewerProxyStreams(
        child as unknown as ChildProcessWithoutNullStreams,
        stream,
        release,
      );

      // Node documents that `exit` may precede child stdio closing. A short
      // WebSocket response makes this ordering especially easy to hit.
      child.exit(0);
      const teardown = operation === "stopApp" ? registry.stopApp(APP) : registry.drain();
      let settled = false;
      void teardown.then(
        () => { settled = true; },
        () => undefined,
      );
      await turn();
      expect(settled).toBe(false);

      child.stdout.end("HTTP/1.1 101 Switching Protocols\r\n\r\n\u0081\u0002OK", "latin1");
      child.close(0);
      await teardown;

      expect(Buffer.concat(stream.writes).toString("latin1"))
        .toBe("HTTP/1.1 101 Switching Protocols\r\n\r\n\u0081\u0002OK");
      stream.destroy();
    },
  );

  test("absorbs child stdin EPIPE without truncating final stdout", async () => {
    const child = new FakeProxyChild();
    const stream = new RecordingDuplex();
    let releases = 0;
    attachViewerProxyStreams(
      child as unknown as ChildProcessWithoutNullStreams,
      stream,
      () => { releases += 1; },
    );

    child.stdin.emit("error", Object.assign(new Error("broken request pipe"), { code: "EPIPE" }));
    expect(stream.destroyed).toBe(false);
    expect(child.killed).toBe(false);

    child.exit(0);
    child.stdout.end("HTTP/1.1 200 OK\r\n\r\nOK", "latin1");
    child.close(0);
    await streamFinished(stream);

    expect(releases).toBe(1);
    expect(Buffer.concat(stream.writes).toString("latin1"))
      .toBe("HTTP/1.1 200 OK\r\n\r\nOK");
    stream.destroy();
  });

  test("contains child stdout errors to only that viewer", async () => {
    const child = new FakeProxyChild();
    const stream = new RecordingDuplex();
    let releases = 0;
    attachViewerProxyStreams(
      child as unknown as ChildProcessWithoutNullStreams,
      stream,
      () => { releases += 1; },
    );
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));

    child.stdout.emit("error", new Error("response pipe failed"));
    child.exit(1);
    child.close(1);
    await closed;

    expect(child.killed).toBe(true);
    expect(releases).toBe(1);
  });
});

describe("artifact mount ownership", () => {
  test("single-flights concurrent same-digest acquire and unmounts only after the final release", async () => {
    let allowMount!: () => void;
    const mountGate = new Promise<void>((resolve) => {
      allowMount = resolve;
    });
    let mountStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      mountStarted = resolve;
    });
    const mounted: string[] = [];
    const unmounted: string[] = [];
    const registry = new ArtifactMountRegistry({
      maxMounts: 2,
      mount: async (digest) => {
        mounted.push(digest);
        mountStarted();
        await mountGate;
        return `/artifacts/${digest.slice(7)}/root`;
      },
      unmount: async (digest) => {
        unmounted.push(digest);
      },
    });

    const firstPending = registry.acquire(DIGEST_A);
    await started;
    const secondPending = registry.acquire(DIGEST_A);
    allowMount();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(mounted).toEqual([DIGEST_A]);
    expect(registry.snapshot()).toEqual({ mounts: 1, references: 2 });
    await first.release();
    expect(unmounted).toEqual([]);
    expect(registry.snapshot()).toEqual({ mounts: 1, references: 1 });
    await second.release();
    expect(unmounted).toEqual([DIGEST_A]);
    expect(registry.snapshot()).toEqual({ mounts: 0, references: 0 });
    await registry.assertDrained();
  });

  test("rejects a new digest at the cap before invoking the mount operation", async () => {
    const mounted: string[] = [];
    const registry = new ArtifactMountRegistry({
      maxMounts: 1,
      mount: async (digest) => {
        mounted.push(digest);
        return `/artifacts/${digest.slice(7)}/root`;
      },
      unmount: async () => {},
    });
    const first = await registry.acquire(DIGEST_A);
    await expect(registry.acquire(DIGEST_B)).rejects.toBeInstanceOf(GuestResourceAdmissionError);
    expect(mounted).toEqual([DIGEST_A]);
    await first.release();
    const second = await registry.acquire(DIGEST_B);
    expect(mounted).toEqual([DIGEST_A, DIGEST_B]);
    await second.release();
  });

  test("retains authority state and fails the Guest boundary when final unmount fails", async () => {
    const registry = new ArtifactMountRegistry({
      mount: async (digest) => `/artifacts/${digest.slice(7)}/root`,
      unmount: async () => {
        throw new Error("busy");
      },
    });
    const lease = await registry.acquire(DIGEST_A);
    await expect(lease.release()).rejects.toBeInstanceOf(GuestContainmentError);
    expect(registry.snapshot()).toEqual({ mounts: 1, references: 1 });
    await expect(registry.assertDrained()).rejects.toBeInstanceOf(GuestContainmentError);
  });

  test("partial App prepare releases its acquired lower only after scratch cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-artifact-lease-"));
    const paths = fixturePaths(root);
    let runtimePresentAtRelease = true;
    const registry = new ArtifactMountRegistry({
      mount: async (digest) => `${paths.artifactMountRoot}/${digest.slice(7)}/root`,
      unmount: async () => {
        runtimePresentAtRelease = await exists(`${paths.runtimeRoot}/a-${opaqueAppKey(APP)}`);
      },
    });
    const blobs = {
      has: async () => true,
    } as unknown as GuestBlobStore;
    const manager = new GuestResourceManager(blobs, {
      paths,
      manageOwnership: false,
      umountBinary: "/usr/bin/true",
      artifactMountRegistry: registry,
      operations: {
        isMountPoint: async () => false,
        destroyVolume: async ({ imagePath, mountPath }) => {
          await rm(mountPath, { recursive: true, force: true });
          await rm(imagePath, { force: true });
        },
      },
    });
    try {
      await expect(manager.prepareApp({
        ownerKey: "a".repeat(64),
        appHandle: APP,
        artifactDigest: DIGEST_A,
        artifactBytes: 1,
        artifactBlobHandle: "L".repeat(22),
        mappedHostUid: 100_000,
        mappedHostGid: 200_000,
        // Protocol V1 still accepts this value, while the ext4 implementation
        // rejects it before executing a privileged formatter or mount.
        scratchBytes: 16 * 1024 * 1024,
      })).rejects.toThrow(/bounded volume size/);
      expect(runtimePresentAtRelease).toBe(false);
      expect(registry.snapshot()).toEqual({ mounts: 0, references: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("App cgroup hierarchy", () => {
  test("delegates controllers through the intermediate workloads cgroup", async () => {
    const root = await mkdtemp(join(tmpdir(), "capsule-app-cgroup-"));
    const apps = `${root}/apps`;
    const app = `${apps}/a-${"a".repeat(32)}`;
    const workloads = `${app}/workloads`;
    try {
      for (const path of [root, apps, app, workloads]) {
        await mkdir(path, { recursive: true });
        await writeFile(`${path}/cgroup.controllers`, "cpu memory pids\n");
        await writeFile(`${path}/cgroup.subtree_control`, "");
      }

      await prepareAppCgroupHierarchy(root, app);

      for (const path of [root, apps, app, workloads]) {
        expect(await readFile(`${path}/cgroup.subtree_control`, "utf8"))
          .toBe("+cpu +memory +pids");
      }
      expect(await readFile(`${app}/memory.max`, "utf8"))
        .toBe(String(2 * 1024 * 1024 * 1024));
      expect(await readFile(`${app}/pids.max`, "utf8")).toBe("1024");
      expect(await readFile(`${app}/cpu.max`, "utf8")).toBe("400000 100000");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fixturePaths(root: string): GuestFilesystemPaths {
  return {
    blobRoot: `${root}/blobs`,
    artifactMountRoot: `${root}/artifacts`,
    runtimeRoot: `${root}/runtime`,
    buildRoot: `${root}/builds`,
    cgroupRoot: `${root}/cgroups`,
    netnsRoot: `${root}/netns`,
    appRootfs: `${root}/app-rootfs`,
    buildRootfs: `${root}/build-rootfs`,
    netHelperPath: "/usr/bin/true",
    mkfsErofsPath: "/usr/bin/true",
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function opaqueAppKey(handle: string): string {
  return createHash("sha256").update(handle, "utf8").digest("hex").slice(0, 32);
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  constructor(
    readonly pid: number,
    private readonly exitsOn: "TERM" | "KILL" = "TERM",
  ) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (
      (this.exitsOn === "TERM" && signal === "SIGTERM")
      || (this.exitsOn === "KILL" && signal === "SIGKILL")
    ) queueMicrotask(() => this.exit(signal));
    return true;
  }

  exit(signal: NodeJS.Signals): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.emit("exit", null, signal);
  }
}

class FakeProxyChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 99;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signalCode = signal;
    return true;
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  close(code: number): void {
    this.emit("close", code, this.signalCode);
  }
}

class RecordingDuplex extends Duplex {
  readonly writes: Buffer[] = [];

  _read(): void {}

  _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
    callback();
  }
}

function releaseOnExit(child: FakeChild, release: () => void): void {
  child.once("exit", release);
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function streamFinished(stream: Duplex): Promise<void> {
  if (stream.writableFinished) return;
  await new Promise<void>((resolve) => stream.once("finish", resolve));
}
