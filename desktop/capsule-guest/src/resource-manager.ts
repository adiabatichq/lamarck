import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import type { AppPrepareBody } from "@lamarck/capsule";
import { validateArtifactDigest, validateOpaqueId } from "@lamarck/capsule";
import type { Duplex } from "node:stream";
import { GuestBlobStore } from "./blob-store";
import { DEFAULT_GUEST_PATHS, type GuestFilesystemPaths } from "./config";
import { fixedCommandEnvironment, runFixedCommand } from "./fixed-command";
import { createBoundedVolume, destroyBoundedVolume } from "./bounded-volume";
import { GuestContainmentError } from "./containment-error";
import {
  GuestResourceAdmissionError,
  UNBOUNDED_GUEST_RESOURCE_ADMISSION,
  type GuestResourceAdmissionLike,
  type GuestResourceLease,
} from "./resource-admission";

const MAX_VIEWER_PROXIES_PER_APP = 8;
const MAX_VIEWER_PROXIES_PER_GUEST = 64;
const VIEWER_PROXY_TERM_MS = 500;
const VIEWER_PROXY_KILL_MS = 3_000;
const MAX_ARTIFACT_MOUNTS_PER_GUEST = 64;

interface ArtifactMountRecord {
  readonly digest: string;
  readonly mountRoot: string;
  references: number;
}

export interface ArtifactMountLease {
  readonly digest: string;
  readonly mountRoot: string;
  release(): Promise<void>;
}

export interface ArtifactMountRegistryOptions {
  maxMounts?: number;
  mount(digest: string): Promise<string>;
  unmount(digest: string, mountRoot: string): Promise<void>;
}

/**
 * Serializes Guest-wide loop-mount ownership. One digest is mounted once and
 * remains mounted only while at least one prepared App or active Build owns a lease.
 */
export class ArtifactMountRegistry {
  private readonly records = new Map<string, ArtifactMountRecord>();
  private readonly maxMounts: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ArtifactMountRegistryOptions) {
    const maxMounts = options.maxMounts ?? MAX_ARTIFACT_MOUNTS_PER_GUEST;
    if (!Number.isSafeInteger(maxMounts) || maxMounts < 1 || maxMounts > 4_096) {
      throw new Error("artifact mount admission cap is invalid");
    }
    this.maxMounts = maxMounts;
  }

  async acquire(digestValue: string): Promise<ArtifactMountLease> {
    const digest = validateArtifactDigest(digestValue, "artifactDigest");
    const record = await this.exclusive(async () => {
      const existing = this.records.get(digest);
      if (existing) {
        existing.references += 1;
        return existing;
      }
      // Reject before mkdir, loop allocation, or mount. Same-digest waiters are
      // serialized above and reuse the first completed record.
      if (this.records.size >= this.maxMounts) {
        throw new GuestResourceAdmissionError(
          `Guest artifact mount admission denied ${digest}: cap ${this.maxMounts} reached`,
        );
      }
      const mountRoot = await this.options.mount(digest);
      const mounted: ArtifactMountRecord = { digest, mountRoot, references: 1 };
      this.records.set(digest, mounted);
      return mounted;
    });

    let released = false;
    let releasePromise: Promise<void> | undefined;
    return Object.freeze({
      digest,
      mountRoot: record.mountRoot,
      release: async () => {
        if (released) return;
        if (!releasePromise) {
          releasePromise = this.release(digest).then(() => {
            released = true;
          }).finally(() => {
            if (!released) releasePromise = undefined;
          });
        }
        await releasePromise;
      },
    });
  }

  snapshot(): Readonly<{ mounts: number; references: number }> {
    return Object.freeze({
      mounts: this.records.size,
      references: [...this.records.values()].reduce((sum, record) => sum + record.references, 0),
    });
  }

  async assertDrained(): Promise<void> {
    await this.exclusive(async () => {
      if (this.records.size !== 0) {
        throw new GuestContainmentError(
          `Guest drain retained ${this.records.size} referenced artifact mount(s)`,
        );
      }
    });
  }

  private async release(digest: string): Promise<void> {
    await this.exclusive(async () => {
      const record = this.records.get(digest);
      if (!record || record.references < 1) {
        throw new GuestContainmentError(`artifact mount lease disappeared for ${digest}`);
      }
      if (record.references > 1) {
        record.references -= 1;
        return;
      }
      try {
        await this.options.unmount(digest, record.mountRoot);
      } catch (cause) {
        if (cause instanceof GuestContainmentError) throw cause;
        throw new GuestContainmentError(
          `artifact mount ${digest} could not be authoritatively removed`,
          { cause },
        );
      }
      this.records.delete(digest);
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>((resolveUnlock) => {
      unlock = resolveUnlock;
    });
    await prior;
    try {
      return await operation();
    } finally {
      unlock();
    }
  }
}

interface PreparedApp {
  appHandle: string;
  appKey: string;
  artifactDigest: string;
  mappedHostUid: number;
  mappedHostGid: number;
  runtimeRoot: string;
  netnsPath: string;
  cgroupPath: string;
  scratchBytes: number;
  scratchImage: string;
}

export interface ResourceManagerOptions {
  paths?: GuestFilesystemPaths;
  manageOwnership?: boolean;
  mountBinary?: string;
  umountBinary?: string;
  admission?: GuestResourceAdmissionLike;
  maxArtifactMounts?: number;
  artifactMountRegistry?: ArtifactMountRegistry;
  operations?: Partial<ResourceManagerOperations>;
}

export interface ResourceManagerOperations {
  isMountPoint(path: string): Promise<boolean>;
  destroyVolume(options: Parameters<typeof destroyBoundedVolume>[0]): Promise<void>;
}

/**
 * Owns the bidirectional byte pipes for one already-admitted viewer proxy.
 *
 * ChildProcess `exit` is intentionally not a stream-completion signal: Node
 * can emit it before the child's stdout has closed and before its final bytes
 * have drained through `pipe()`. The stdout pipe owns the clean DATA-stream
 * half-close; destroying the stream from `exit` can truncate a compact HTTP
 * or WebSocket response that the helper wrote immediately before exiting.
 */
export function attachViewerProxyStreams(
  child: ChildProcessWithoutNullStreams,
  stream: Duplex,
  releaseProxy: () => void,
): void {
  let childClosed = false;
  let outputClosed = false;
  let released = false;

  const killChild = () => {
    try {
      if (!hasExited(child) && !child.killed) child.kill("SIGKILL");
    } catch {
      // Registry teardown retains this child and will fail closed if it cannot
      // subsequently prove process exit plus transport drain.
    }
  };
  const destroyStream = (error?: Error) => {
    try {
      if (!stream.destroyed) stream.destroy(error);
    } catch {
      // The registry lease remains live until a real terminal event arrives.
    }
  };
  const releaseWhenDrained = () => {
    if (released || !childClosed || !outputClosed) return;
    released = true;
    child.removeListener("error", onChildError);
    child.stdin.removeListener("error", onStdinError);
    child.stdout.removeListener("error", onStdoutError);
    child.stderr.removeListener("error", onStderrError);
    stream.removeListener("close", onStreamClose);
    stream.removeListener("finish", onStreamFinish);
    releaseProxy();
  };
  const closeOutput = () => {
    outputClosed = true;
    releaseWhenDrained();
  };
  const onStreamFinish = () => {
    closeOutput();
  };
  const onStreamClose = () => {
    outputClosed = true;
    killChild();
    releaseWhenDrained();
  };
  const onStreamError = () => {
    // Duplex errors belong to this one viewer. Keep a listener installed so
    // they cannot become an uncaught shared-supervisor error, then let close
    // establish the transport terminal state.
    killChild();
    destroyStream();
  };
  const onChildError = (error: Error) => {
    // A spawn/process error makes this viewer unusable, but must never take
    // down the shared Guest supervisor.
    destroyStream(error);
  };
  const onStdinError = (error: NodeJS.ErrnoException) => {
    // EPIPE is expected when the helper closes its request side before its
    // final response has drained. Stop forwarding requests without touching
    // stdout. Unexpected stdin failures terminate only this helper and still
    // allow any already-buffered stdout to drain.
    try {
      stream.unpipe(child.stdin);
    } catch {
      // An already-detached pipe is terminal for the request direction only.
    }
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
      killChild();
    }
  };
  const onStdoutError = (error: Error) => {
    // An errored response cannot be represented as a clean DATA half-close.
    // Fail this transport locally and retain registry ownership until both the
    // child and transport have reached terminal states.
    try {
      child.stdout.unpipe(stream);
    } catch {
      // The failed stdout direction is already unusable.
    }
    killChild();
    destroyStream(error);
  };
  const onStderrError = () => {
    // stderr is diagnostic-only. Its failure cannot be allowed to surface as
    // an uncaught EventEmitter "error" in the shared supervisor.
    killChild();
  };

  stream.once("finish", onStreamFinish);
  stream.once("close", onStreamClose);
  stream.on("error", onStreamError);
  child.on("error", onChildError);
  child.stdin.on("error", onStdinError);
  child.stdout.on("error", onStdoutError);
  child.stderr.on("error", onStderrError);
  child.once("close", () => {
    childClosed = true;
    releaseWhenDrained();
  });

  stream.pipe(child.stdin);
  child.stdout.pipe(stream);
}

interface ViewerProxyRecord {
  readonly child: ChildProcess;
  readonly released: Promise<void>;
}

/** Per-App ownership and bounded teardown for privileged viewer proxy helpers. */
export class AppViewerProxyRegistry {
  private readonly byApp = new Map<string, Set<ViewerProxyRecord>>();
  private total = 0;

  register(appHandle: string, child: ChildProcess): () => void {
    let proxies = this.byApp.get(appHandle);
    if ((proxies?.size ?? 0) >= MAX_VIEWER_PROXIES_PER_APP) {
      throw new Error(`App ${appHandle} has reached its viewer proxy limit`);
    }
    if (this.total >= MAX_VIEWER_PROXIES_PER_GUEST) {
      throw new Error("Guest has reached its viewer proxy limit");
    }
    if (!proxies) {
      proxies = new Set();
      this.byApp.set(appHandle, proxies);
    }
    let resolveReleased!: () => void;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const record: ViewerProxyRecord = { child, released };
    proxies.add(record);
    this.total += 1;
    let registered = true;
    const release = () => {
      if (!registered) return;
      registered = false;
      proxies!.delete(record);
      this.total -= 1;
      if (proxies!.size === 0) this.byApp.delete(appHandle);
      resolveReleased();
    };
    return release;
  }

  async stopApp(appHandle: string): Promise<void> {
    const records = [...(this.byApp.get(appHandle) ?? [])];
    if (records.length === 0) return;
    const failures: unknown[] = [];
    for (const { child } of records) {
      try {
        if (!hasExited(child)) child.kill("SIGTERM");
      } catch (error) {
        failures.push(error);
      }
    }
    await Promise.all(records.map(async ({ child }) => {
      if (await waitForProxyExit(child, VIEWER_PROXY_TERM_MS)) return;
      try {
        child.kill("SIGKILL");
      } catch (error) {
        failures.push(error);
      }
      if (!await waitForProxyExit(child, VIEWER_PROXY_KILL_MS)) {
        failures.push(new Error(`viewer proxy ${child.pid ?? "unknown"} did not exit after SIGKILL`));
      }
    }));
    await Promise.all(records.map(async (record) => {
      if (!await waitForProxyRelease(record, VIEWER_PROXY_KILL_MS)) {
        failures.push(new Error(
          `viewer proxy ${record.child.pid ?? "unknown"} transport ownership did not drain`,
        ));
      }
    }));
    if (failures.length > 0) {
      throw new AggregateError(failures, `App ${appHandle} viewer proxies could not be stopped`);
    }
  }

  async drain(): Promise<void> {
    const results = await Promise.allSettled([...this.byApp.keys()].map(async (app) => this.stopApp(app)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map((failure) => failure.reason), "viewer proxy drain failed");
    }
  }
}

/** Owns all privileged resources beneath one Guest; no App-controlled path enters it. */
export class GuestResourceManager {
  private readonly paths: GuestFilesystemPaths;
  private readonly manageOwnership: boolean;
  private readonly mountBinary: string;
  private readonly umountBinary: string;
  private readonly admission: GuestResourceAdmissionLike;
  private readonly isMountPoint: ResourceManagerOperations["isMountPoint"];
  private readonly destroyVolume: ResourceManagerOperations["destroyVolume"];
  private readonly apps = new Map<string, PreparedApp>();
  private readonly appLeases = new Map<string, GuestResourceLease>();
  private readonly artifactLeases = new Map<string, ArtifactMountLease>();
  /** Shared with Build so one digest has one Guest-wide loop mount ledger. */
  readonly artifactMountRegistry: ArtifactMountRegistry;
  private readonly viewerProxies = new AppViewerProxyRegistry();

  constructor(
    private readonly blobs: GuestBlobStore,
    options: ResourceManagerOptions = {},
  ) {
    this.paths = options.paths ?? DEFAULT_GUEST_PATHS;
    this.manageOwnership = options.manageOwnership ?? true;
    this.mountBinary = options.mountBinary ?? "/bin/mount";
    this.umountBinary = options.umountBinary ?? "/bin/umount";
    this.admission = options.admission ?? UNBOUNDED_GUEST_RESOURCE_ADMISSION;
    this.isMountPoint = options.operations?.isMountPoint ?? isMountPoint;
    this.destroyVolume = options.operations?.destroyVolume ?? destroyBoundedVolume;
    this.artifactMountRegistry = options.artifactMountRegistry ?? new ArtifactMountRegistry({
      maxMounts: options.maxArtifactMounts,
      mount: async (digest) => await this.mountArtifact(digest),
      unmount: async (digest, mountRoot) => await this.unmountArtifact(digest, mountRoot),
    });
  }

  getApp(appHandleValue: string): Readonly<PreparedApp> {
    const appHandle = validateOpaqueId(appHandleValue, "appHandle");
    const app = this.apps.get(appHandle);
    if (!app) throw new Error(`App ${appHandle} is not prepared`);
    return app;
  }

  async prepareApp(body: AppPrepareBody): Promise<Readonly<PreparedApp>> {
    const appHandle = validateOpaqueId(body.appHandle, "appHandle");
    const artifactDigest = validateArtifactDigest(body.artifactDigest, "artifactDigest");
    const existing = this.apps.get(appHandle);
    if (existing) {
      if (
        existing.artifactDigest === artifactDigest
        && existing.mappedHostUid === body.mappedHostUid
        && existing.mappedHostGid === body.mappedHostGid
      ) return existing;
      throw new Error(`App handle ${appHandle} cannot be rebound`);
    }
    if (!await this.blobs.has("artifact", artifactDigest)) {
      throw new Error(`sealed artifact ${artifactDigest} has not been imported`);
    }
    const appKey = `a-${opaqueKey(appHandle)}`;
    const runtimeRoot = `${this.paths.runtimeRoot}/${appKey}`;
    const netnsPath = `${this.paths.netnsRoot}/${appKey}`;
    const cgroupPath = `${this.paths.cgroupRoot}/apps/${appKey}`;
    const scratchImage = `${this.paths.runtimeRoot}/${appKey}.scratch.ext4`;
    const app: PreparedApp = {
      appHandle,
      appKey,
      artifactDigest,
      mappedHostUid: body.mappedHostUid,
      mappedHostGid: body.mappedHostGid,
      runtimeRoot,
      netnsPath,
      cgroupPath,
      scratchBytes: body.scratchBytes ?? 1024 * 1024 * 1024,
      scratchImage,
    };

    const reservationKey = `app:${appKey}`;
    const resourceLease = await this.admission.reserve(reservationKey, {
      diskBytes: app.scratchBytes,
    });
    let artifactLease: ArtifactMountLease | undefined;
    let appResourcesTouched = false;
    try {
      artifactLease = await this.artifactMountRegistry.acquire(artifactDigest);
      appResourcesTouched = true;
      await rm(runtimeRoot, { recursive: true, force: true });
      await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
      const appUid = body.mappedHostUid + 1_000;
      const appGid = body.mappedHostGid + 1_000;
      const upper = `${runtimeRoot}/upper`;
      const work = `${runtimeRoot}/work`;
      const merged = `${runtimeRoot}/merged`;
      const home = `${runtimeRoot}/home`;
      const run = `${runtimeRoot}/run`;
      await createBoundedVolume({
        imagePath: scratchImage,
        mountPath: runtimeRoot,
        bytes: app.scratchBytes,
        label: `LAPP${appKey.slice(2, 10).toUpperCase()}`,
      });
      for (const path of [upper, work, merged, home, run]) {
        await mkdir(path, { mode: path === merged ? 0o755 : 0o700 });
      }
      if (this.manageOwnership) {
        for (const path of [upper, work, home, run]) await chown(path, appUid, appGid);
      }
      await this.createOverlay(artifactLease.mountRoot, upper, work, merged);
      if (this.manageOwnership) {
        // Copy up the overlay root as the mapped App user. Inner artifact
        // entries are normalized writable inside the same-App boundary; the
        // sealed EROFS lower remains immutable and shared safely.
        await chown(merged, appUid, appGid);
        await chmod(merged, 0o755);
      }
      await mkdir(this.paths.netnsRoot, { recursive: true, mode: 0o700 });
      await runFixedCommand(this.paths.netHelperPath, ["create", netnsPath]);
      await this.prepareAppCgroup(cgroupPath, app.scratchBytes);
      this.artifactLeases.set(appHandle, artifactLease);
      this.appLeases.set(appHandle, resourceLease);
      this.apps.set(appHandle, app);
      return app;
    } catch (error) {
      try {
        if (appResourcesTouched) await this.cleanupPartialApp(app);
        await artifactLease?.release();
        resourceLease.release();
      } catch (cleanupError) {
        throw new GuestContainmentError(
          `App ${appHandle} prepare cleanup was not authoritative; Guest must be terminated`,
          { cause: new AggregateError([error, cleanupError], `App ${appHandle} prepare cleanup failed`) },
        );
      }
      throw error;
    }
  }

  async stopApp(appHandle: string): Promise<void> {
    const app = this.getApp(appHandle);
    const artifactLease = this.artifactLeases.get(appHandle);
    const resourceLease = this.appLeases.get(appHandle);
    const failures: unknown[] = [];
    if (!artifactLease) failures.push(new Error(`App ${appHandle} has no artifact mount lease`));
    if (!resourceLease) failures.push(new Error(`App ${appHandle} has no resource admission lease`));
    try {
      await this.viewerProxies.stopApp(appHandle);
    } catch (error) {
      failures.push(error);
    }
    try {
      await killCgroup(app.cgroupPath);
    } catch (error) {
      failures.push(error);
    }
    let cgroupEmpty = false;
    try {
      await waitCgroupEmpty(app.cgroupPath, 5_000);
      cgroupEmpty = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      await runFixedCommand(this.paths.netHelperPath, ["delete", app.netnsPath], {
        allowExitCodes: [0, 2],
      });
    } catch (error) {
      failures.push(error);
    }
    if (cgroupEmpty) {
      let runtimeRemoved = false;
      try {
        if (await this.isMountPoint(`${app.runtimeRoot}/merged`)) {
          await runFixedCommand(this.umountBinary, ["--", `${app.runtimeRoot}/merged`]);
        }
        await this.destroyVolume({
          imagePath: app.scratchImage,
          mountPath: app.runtimeRoot,
          umountPathBinary: this.umountBinary,
        });
        runtimeRemoved = true;
      } catch (error) {
        failures.push(error);
      }
      if (runtimeRemoved && artifactLease) {
        try {
          // The lower EROFS mount cannot be released until this App's overlay
          // and containing scratch volume are both proven gone.
          await artifactLease.release();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await removeCgroupTree(app.cgroupPath);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new GuestContainmentError(
        `App ${appHandle} teardown was not authoritative; Guest must be terminated`,
        { cause: new AggregateError(failures, `App ${appHandle} resource teardown failed`) },
      );
    }
    try {
      resourceLease!.release();
    } catch (cause) {
      throw new GuestContainmentError(
        `App ${appHandle} resource admission lease could not be released`,
        { cause },
      );
    }
    this.appLeases.delete(appHandle);
    this.artifactLeases.delete(appHandle);
    this.apps.delete(appHandle);
  }

  async waitForViewerReady(appHandle: string, port: number, timeoutMs: number): Promise<void> {
    const app = this.getApp(appHandle);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid viewer port");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new Error("invalid viewer readiness timeout");
    }
    await runFixedCommand(this.paths.netHelperPath, [
      "probe",
      app.netnsPath,
      String(port),
      String(timeoutMs),
    ], { timeoutMs: timeoutMs + 1_000 });
  }

  async proxyViewer(appHandle: string, port: number, stream: Duplex): Promise<ChildProcess> {
    const app = this.getApp(appHandle);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid viewer port");
    const child = spawn(this.paths.netHelperPath, ["proxy", app.netnsPath, String(port)], {
      cwd: "/",
      env: fixedCommandEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let releaseProxy: () => void;
    try {
      releaseProxy = this.viewerProxies.register(appHandle, child);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
    let readinessBuffer = "";
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("viewer proxy did not connect within 3000ms"));
      }, 3_000);
      const onData = (chunk: Buffer) => {
        readinessBuffer += chunk.toString("utf8");
        if (readinessBuffer.length > 4_096) {
          clearTimeout(timer);
          reject(new Error("viewer proxy emitted an oversized diagnostic"));
          return;
        }
        if (readinessBuffer.startsWith("READY\n")) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stderr.on("data", onData);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (!readinessBuffer.startsWith("READY\n")) {
          reject(new Error(`viewer proxy exited ${code ?? 255}: ${readinessBuffer.trim()}`));
        }
      });
    });
    attachViewerProxyStreams(child, stream, releaseProxy);
    await ready;
    return child;
  }

  async drain(): Promise<void> {
    const handles = [...this.apps.keys()];
    const stopped = await Promise.allSettled(handles.map(async (handle) => this.stopApp(handle)));
    const failures: unknown[] = stopped
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((failure) => failure.reason);
    try {
      await this.viewerProxies.drain();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 0) {
      try {
        await this.artifactMountRegistry.assertDrained();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new GuestContainmentError(
        "App resource drain was not authoritative; Guest must be terminated",
        { cause: new AggregateError(failures, "App resource drain failed") },
      );
    }
  }

  private async mountArtifact(digest: string): Promise<string> {
    const hex = digest.slice("sha256:".length);
    const mountDirectory = `${this.paths.artifactMountRoot}/${hex}`;
    const mountRoot = `${mountDirectory}/root`;
    await mkdir(mountRoot, { recursive: true, mode: 0o755 });
    try {
      if (!await this.isMountPoint(mountRoot)) {
        await runFixedCommand(this.mountBinary, [
          "-t",
          "erofs",
          "-o",
          "loop,ro,nosuid,nodev",
          "--",
          this.blobs.path("artifact", digest),
          mountRoot,
        ]);
      }
      if (!await this.isMountPoint(mountRoot)) {
        throw new Error(`artifact mount did not appear at ${mountRoot}`);
      }
      return mountRoot;
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      try {
        if (await this.isMountPoint(mountRoot)) {
          await runFixedCommand(this.umountBinary, ["--", mountRoot]);
        }
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      try {
        await rm(mountDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (cleanupFailures.length > 0) {
        throw new GuestContainmentError(
          `failed artifact mount ${digest} could not be authoritatively cleaned`,
          { cause: new AggregateError([error, ...cleanupFailures], "artifact mount cleanup failed") },
        );
      }
      throw error;
    }
  }

  private async unmountArtifact(digest: string, mountRoot: string): Promise<void> {
    const hex = digest.slice("sha256:".length);
    const mountDirectory = `${this.paths.artifactMountRoot}/${hex}`;
    const expectedRoot = `${mountDirectory}/root`;
    if (mountRoot !== expectedRoot || !await this.isMountPoint(mountRoot)) {
      throw new GuestContainmentError(`artifact mount state is inconsistent for ${digest}`);
    }
    await runFixedCommand(this.umountBinary, ["--", mountRoot]);
    if (await this.isMountPoint(mountRoot)) {
      throw new GuestContainmentError(`artifact mount remained active for ${digest}`);
    }
    try {
      await rm(mountDirectory, { recursive: true });
    } catch (cause) {
      throw new GuestContainmentError(`artifact mount directory remained for ${digest}`, { cause });
    }
  }

  private async createOverlay(lower: string, upper: string, work: string, merged: string) {
    await runFixedCommand(this.mountBinary, [
      "-t",
      "overlay",
      "overlay",
      "-o",
      `lowerdir=${lower},upperdir=${upper},workdir=${work},nosuid,nodev`,
      "--",
      merged,
    ]);
  }

  private async prepareAppCgroup(path: string, _scratchBytes: number): Promise<void> {
    await prepareAppCgroupHierarchy(this.paths.cgroupRoot, path);
  }

  private async cleanupPartialApp(app: PreparedApp): Promise<void> {
    const failures: unknown[] = [];
    try {
      if (await this.isMountPoint(`${app.runtimeRoot}/merged`)) {
        await runFixedCommand(this.umountBinary, ["--", `${app.runtimeRoot}/merged`], {
          allowExitCodes: [0, 1, 32],
        });
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await runFixedCommand(this.paths.netHelperPath, ["delete", app.netnsPath], {
        allowExitCodes: [0, 2],
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.destroyVolume({
        imagePath: app.scratchImage,
        mountPath: app.runtimeRoot,
        umountPathBinary: this.umountBinary,
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await removeCgroupTree(app.cgroupPath);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new GuestContainmentError(
        `Partial App ${app.appHandle} resources could not be removed`,
        { cause: new AggregateError(failures, "partial App cleanup failed") },
      );
    }
  }
}

/** @internal Exported only for a filesystem-level cgroup-v2 contract test. */
export async function prepareAppCgroupHierarchy(root: string, path: string): Promise<void> {
  const controllers = ["cpu", "memory", "pids"] as const;
  const apps = `${root}/apps`;
  const workloads = `${path}/workloads`;
  await mkdir(apps, { recursive: true, mode: 0o755 });
  await enableControllers(root, controllers);
  await enableControllers(apps, controllers);
  await mkdir(workloads, { recursive: true, mode: 0o755 });
  await writeFile(`${path}/memory.max`, String(2 * 1024 * 1024 * 1024));
  await writeFile(`${path}/pids.max`, "1024");
  await writeFile(`${path}/cpu.max`, "400000 100000");
  await enableControllers(path, controllers);
  // Workload cgroups are grandchildren of the App cgroup. Cgroup v2 makes a
  // controller available to a child only when its immediate parent enables
  // that controller in cgroup.subtree_control. Enabling the App node alone is
  // therefore insufficient for runc's .../workloads/<workload> cgroup.
  await enableControllers(workloads, controllers);
}

async function enableControllers(path: string, controllers: readonly string[]): Promise<void> {
  const available = new Set((await readFile(`${path}/cgroup.controllers`, "utf8")).trim().split(/\s+/));
  const enabled = controllers.filter((controller) => available.has(controller));
  if (enabled.length > 0) {
    await writeFile(`${path}/cgroup.subtree_control`, enabled.map((item) => `+${item}`).join(" "));
  }
}

async function killCgroup(path: string): Promise<void> {
  try {
    await writeFile(`${path}/cgroup.kill`, "1\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function waitCgroupEmpty(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const events = await readFile(`${path}/cgroup.events`, "utf8");
      if (/^populated 0$/m.test(events)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`cgroup ${path} remained populated after ${timeoutMs}ms`);
}

async function removeCgroupTree(path: string): Promise<void> {
  await removeCgroupDirectories(path);
}

async function removeCgroupDirectories(path: string): Promise<void> {
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
  for (const child of children) await removeCgroupDirectories(child);
  try {
    await rmdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForProxyExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(value);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    if (hasExited(child)) finish(true);
  });
}

async function waitForProxyRelease(record: ViewerProxyRecord, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void record.released.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function isMountPoint(path: string): Promise<boolean> {
  const resolved = resolve(path);
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  return mountInfo.split("\n").some((line) => {
    const fields = line.split(" ");
    return fields.length > 4 && decodeMountInfoPath(fields[4]!) === resolved;
  });
}

function decodeMountInfoPath(path: string): string {
  return path.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\134/g, "\\");
}

function opaqueKey(handle: string): string {
  return createHash("sha256").update(handle, "utf8").digest("hex").slice(0, 32);
}
