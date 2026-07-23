import { Readable } from "node:stream";
import { cp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPSULE_TREE_MAGIC,
  CAPSULE_ARTIFACT_OUTPUT_MIN_BYTES,
  encodeCapsuleTreeHeader,
  encodeCapsuleTreePath,
  createCapsuleBuildStoragePlan,
  evaluateNpmInstallInput,
  type BuildPrepareBody,
} from "@lamarck/capsule";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { GuestBlobStore } from "../src/blob-store";
import {
  GuestBuildManager,
  type ArtifactSealer,
} from "../src/build-manager";
import { BuildContainmentError } from "../src/build-runner";
import { ArtifactMountRegistry } from "../src/resource-manager";

const APP = "A".repeat(22);
const BUILD = "B".repeat(22);
const PACKAGE = `sha256:${"a".repeat(64)}`;
const BASE = `sha256:${"b".repeat(64)}`;
const DEPENDENCY = `sha256:${"c".repeat(64)}`;
const IMAGE = `sha256:${"d".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("dependency-stable Guest warm Build", () => {
  test("reseals new source with sealed base dependencies and retires mounts before storage", async () => {
    const fixture = await createWarmFixture();
    await fixture.manager.prepare(fixture.body);
    await expect(fixture.manager.start(APP, BUILD)).resolves.toMatchObject({
      sourceDigest: PACKAGE,
      installDigest: fixture.installDigest,
      dependencyDigest: DEPENDENCY,
    });
    expect(fixture.runner.run).not.toHaveBeenCalled();
    expect(fixture.sealer.seal).toHaveBeenCalledOnce();
    expect(fixture.events).toEqual([
      "artifact-acquire",
      "bind",
      "seal",
      "unbind",
      "artifact-release",
      "volume-destroy",
    ]);
    expect(fixture.registry.snapshot()).toEqual({ mounts: 0, references: 0 });
  });

  test("returns a typed warm miss only after a structurally unsuitable base is fully retired", async () => {
    const fixture = await createWarmFixture({ includeNodeModules: false });
    await fixture.manager.prepare(fixture.body);
    await expect(fixture.manager.start(APP, BUILD)).rejects.toMatchObject({
      code: "WARM_REBUILD_UNAVAILABLE",
    });
    expect(fixture.runner.run).not.toHaveBeenCalled();
    expect(fixture.sealer.seal).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      "artifact-acquire",
      "artifact-release",
      "volume-destroy",
    ]);
    expect(fixture.registry.snapshot()).toEqual({ mounts: 0, references: 0 });
    await expect(fixture.manager.drain()).resolves.toBeUndefined();
  });

  test("latches containment failure and retains storage when warm detach is ambiguous", async () => {
    const fixture = await createWarmFixture({ failDetach: true });
    await fixture.manager.prepare(fixture.body);
    await expect(fixture.manager.start(APP, BUILD)).rejects.toBeInstanceOf(BuildContainmentError);
    expect(fixture.events).toEqual([
      "artifact-acquire",
      "bind",
      "seal",
      "unbind",
    ]);
    expect(fixture.registry.snapshot()).toEqual({ mounts: 1, references: 1 });
    await expect(fixture.manager.drain()).rejects.toBeInstanceOf(BuildContainmentError);
  });

  test("retains the base lease and storage when a partial warm attach is ambiguous", async () => {
    const fixture = await createWarmFixture({ failAttachContainment: true });
    await fixture.manager.prepare(fixture.body);
    await expect(fixture.manager.start(APP, BUILD)).rejects.toBeInstanceOf(BuildContainmentError);
    expect(fixture.events).toEqual([
      "artifact-acquire",
      "bind",
      "unbind",
    ]);
    expect(fixture.sealer.seal).not.toHaveBeenCalled();
    expect(fixture.registry.snapshot()).toEqual({ mounts: 1, references: 1 });
    await expect(fixture.manager.drain()).rejects.toBeInstanceOf(BuildContainmentError);
  });

  test("rejects a sealed artifact beyond the planned ceiling before Guest CAS import", async () => {
    const fixture = await createWarmFixture({ oversizedOutput: true });
    await fixture.manager.prepare(fixture.body);
    await expect(fixture.manager.start(APP, BUILD)).rejects.toThrow(/Build output ceiling/);
    expect(fixture.importLocalFile).not.toHaveBeenCalled();
    expect(fixture.registry.snapshot()).toEqual({ mounts: 0, references: 0 });
  });
});

async function createWarmFixture(options: {
  includeNodeModules?: boolean;
  failAttachContainment?: boolean;
  failDetach?: boolean;
  oversizedOutput?: boolean;
} = {}) {
  const root = join(
    tmpdir(),
    `lamarck-warm-build-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  roots.push(root);
  const baseRoot = join(root, "base");
  const buildRoot = join(root, "builds");
  const packageJson = Buffer.from(JSON.stringify({ name: "fixture", version: "1.0.0" }));
  const packageLock = Buffer.from(JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    packages: { "": { name: "fixture", version: "1.0.0" } },
  }));
  await mkdir(baseRoot, { recursive: true });
  await writeFile(join(baseRoot, "package.json"), packageJson);
  await writeFile(join(baseRoot, "package-lock.json"), packageLock);
  await writeFile(join(baseRoot, "old-source.js"), "must-not-leak");
  if (options.includeNodeModules !== false) {
    await mkdir(join(baseRoot, "node_modules", "dependency"), { recursive: true });
    await writeFile(
      join(baseRoot, "node_modules", "dependency", "index.js"),
      "sealed-dependency",
    );
  }

  const packageTree = tree([
    ["package-lock.json", packageLock],
    ["package.json", packageJson],
    ["source.js", Buffer.from("new-source")],
  ]);
  const events: string[] = [];
  const registry = new ArtifactMountRegistry({
    mount: async () => { events.push("artifact-acquire"); return baseRoot; },
    unmount: async () => { events.push("artifact-release"); },
  });
  const runner = { run: vi.fn() };
  const sealer: ArtifactSealer = {
    seal: vi.fn(async (workspace, output, _signal, sealOptions) => {
      events.push("seal");
      expect(sealOptions).toEqual({ readonlyNodeModules: true });
      expect(await readFile(join(workspace, "source.js"), "utf8")).toBe("new-source");
      expect(await readFile(
        join(workspace, "node_modules", "dependency", "index.js"),
        "utf8",
      )).toBe("sealed-dependency");
      await expect(readFile(join(workspace, "old-source.js")))
        .rejects.toMatchObject({ code: "ENOENT" });
      if (options.oversizedOutput) {
        const artifact = await open(output, "w", 0o600);
        try {
          await artifact.truncate(CAPSULE_ARTIFACT_OUTPUT_MIN_BYTES + 1);
        } finally {
          await artifact.close();
        }
      } else {
        await writeFile(output, Buffer.alloc(4_096));
      }
      return { fileCount: 5 };
    }),
  };
  const importLocalFile = vi.fn(async () => ({
    digest: `sha256:${"e".repeat(64)}`,
    bytes: 4_096,
  }));
  const blobs = {
    has: vi.fn(async () => true),
    open: vi.fn(async (kind: string) => {
      if (kind !== "package") throw new Error(`unexpected blob kind ${kind}`);
      return Readable.from([packageTree]);
    }),
    importLocalFile,
  } as unknown as GuestBlobStore;
  const manager = new GuestBuildManager(blobs, {
    imageDigest: IMAGE,
    manageOwnership: false,
    artifactMountRegistry: registry,
    runner: runner as never,
    sealer,
    paths: paths(root, buildRoot),
    warmMounts: {
      attach: async (source, destination) => {
        events.push("bind");
        await cp(source, destination, { recursive: true });
        if (options.failAttachContainment) {
          throw new BuildContainmentError("injected partial warm attach ambiguity");
        }
      },
      detach: async (destination) => {
        events.push("unbind");
        if (options.failDetach) throw new Error("injected warm detach ambiguity");
        await rm(destination, { recursive: true });
      },
    },
    volumeOperations: {
      create: async ({ mountPath, bytes }) => {
        expect(bytes).toBe(createCapsuleBuildStoragePlan({
          mode: "warm",
          packageBytes: packageTree.byteLength,
          baseArtifactBytes: 4_096,
        }).scratchBytes);
        await mkdir(mountPath, { recursive: true });
      },
      destroy: async ({ mountPath }) => {
        events.push("volume-destroy");
        await rm(mountPath, { recursive: true, force: true });
      },
    },
  });
  const installDigest = evaluateNpmInstallInput({
    packageJson,
    packageLock,
    hasBindingGyp: false,
    hasShrinkwrap: false,
  }).digest;
  return {
    manager,
    body: warmBody(packageTree.byteLength, installDigest),
    installDigest,
    events,
    registry,
    runner,
    sealer,
    importLocalFile,
  };
}

function warmBody(packageBytes: number, installDigest: string): BuildPrepareBody {
  const storage = createCapsuleBuildStoragePlan({
    mode: "warm",
    packageBytes,
    baseArtifactBytes: 4_096,
  });
  return {
    ownerKey: "f".repeat(64),
    appHandle: APP,
    buildHandle: BUILD,
    packageDigest: PACKAGE,
    packageBytes,
    packageBlobHandle: "P".repeat(22),
    installDigest,
    baseArtifactDigest: BASE,
    baseArtifactBytes: 4_096,
    baseArtifactBlobHandle: "R".repeat(22),
    baseDependencyDigest: DEPENDENCY,
    mappedHostUid: 131_072,
    mappedHostGid: 196_608,
    storagePlanVersion: storage.version,
    scratchBytes: storage.scratchBytes,
    artifactOutputBytes: storage.artifactOutputBytes,
    timeoutMs: 60_000,
    resources: {
      memoryBytes: 512 * 1024 * 1024,
      pids: 256,
      cpuQuotaMicros: 100_000,
    },
  };
}

function paths(root: string, buildRoot: string) {
  return {
    blobRoot: join(root, "blobs"),
    artifactMountRoot: join(root, "mounts"),
    runtimeRoot: join(root, "runtime"),
    buildRoot,
    cgroupRoot: join(root, "cgroup"),
    netnsRoot: join(root, "netns"),
    appRootfs: join(root, "app-rootfs"),
    buildRootfs: join(root, "build-rootfs"),
    netHelperPath: join(root, "net-helper"),
    mkfsErofsPath: join(root, "mkfs.erofs"),
  };
}

function tree(files: Array<[string, Buffer]>): Buffer {
  const chunks: Buffer[] = [CAPSULE_TREE_MAGIC];
  for (const [path, content] of files.sort(([left], [right]) => (
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  ))) {
    const pathBytes = encodeCapsuleTreePath(path);
    chunks.push(encodeCapsuleTreeHeader({
      type: "file",
      mode: 0o644,
      pathLength: pathBytes.byteLength,
      contentLength: content.byteLength,
    }), pathBytes, content);
  }
  chunks.push(encodeCapsuleTreeHeader({ type: "end", mode: 0, pathLength: 0, contentLength: 0 }));
  return Buffer.concat(chunks);
}
