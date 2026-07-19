import type { ChildProcess } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { cleanupBuildResources } from "../src/build-manager";
import {
  runAuthoritativeBuildRunCleanup,
  runAuthoritativeBuildTeardown,
} from "../src/build-runner";

const CONTAINER = `b-${"a".repeat(32)}`;
const CGROUP = `/sys/fs/cgroup/lamarck/builds/${CONTAINER}`;

describe("authoritative Build teardown", () => {
  test("proves cgroup empty and deletes runc state before privileged resources", async () => {
    const order: string[] = [];
    await runAuthoritativeBuildTeardown({
      containerId: CONTAINER,
      cgroupPath: CGROUP,
      child: {} as ChildProcess,
      cleanupTimeoutMs: 5_000,
      operations: {
        killCgroup: vi.fn(async () => { order.push("cgroup.kill"); }),
        waitCgroupEmpty: vi.fn(async () => { order.push("cgroup.empty"); }),
        stopForeground: vi.fn(async () => { order.push("foreground.stop"); }),
        deleteContainer: vi.fn(async () => { order.push("runc.delete"); }),
      },
    });
    await cleanupBuildResources({
      buildHandle: "B".repeat(22),
      netnsPath: "/run/lamarck/netns/build",
      volumeImage: "/var/lib/lamarck/builds/build.ext4",
      root: "/var/lib/lamarck/builds/build",
      cgroupPath: CGROUP,
      networkAttempted: true,
      volumeAttempted: true,
      storageMayBeInUse: false,
      operations: {
        deleteNetworkNamespace: vi.fn(async () => { order.push("netns.delete"); }),
        destroyVolume: vi.fn(async () => { order.push("volume.destroy"); }),
        removeCgroupTree: vi.fn(async () => { order.push("cgroup.remove"); }),
      },
    });
    expect(order).toEqual([
      "foreground.stop",
      "cgroup.kill",
      "cgroup.empty",
      "runc.delete",
      "netns.delete",
      "volume.destroy",
      "cgroup.remove",
    ]);
  });

  test("stops the creator before the final cgroup proof can be repopulated", async () => {
    let creatorAlive = true;
    let populated = true;
    await runAuthoritativeBuildTeardown({
      containerId: CONTAINER,
      cgroupPath: CGROUP,
      child: {} as ChildProcess,
      cleanupTimeoutMs: 5_000,
      operations: {
        stopForeground: vi.fn(async () => { creatorAlive = false; }),
        killCgroup: vi.fn(async () => { populated = false; }),
        waitCgroupEmpty: vi.fn(async () => {
          // Models a runc launch which can still create the container after an
          // earlier cgroup.kill. The authoritative ordering must make this
          // branch unreachable before accepting populated=0.
          if (creatorAlive) populated = true;
          if (populated) throw new Error("cgroup was repopulated");
        }),
        deleteContainer: vi.fn(async () => undefined),
      },
    });
  });

  test.each([
    "foreground.stop",
    "cgroup.kill",
    "cgroup.empty",
    "runc.delete",
  ] as const)("attempts every containment stage and rejects a %s failure", async (failedStage) => {
    const order: string[] = [];
    const stage = async (name: string) => {
      order.push(name);
      if (name === failedStage) throw new Error(`${name} failed`);
    };
    await expect(runAuthoritativeBuildTeardown({
      containerId: CONTAINER,
      cgroupPath: CGROUP,
      child: {} as ChildProcess,
      cleanupTimeoutMs: 5_000,
      operations: {
        stopForeground: vi.fn(async () => stage("foreground.stop")),
        killCgroup: vi.fn(async () => stage("cgroup.kill")),
        waitCgroupEmpty: vi.fn(async () => stage("cgroup.empty")),
        deleteContainer: vi.fn(async () => stage("runc.delete")),
      },
    })).rejects.toMatchObject({
      code: "CAPSULE_BUILD_CONTAINMENT_FAILED",
      fatalGuest: true,
      storageMayBeInUse: true,
      message: expect.stringMatching(/containment cleanup failed/),
    });
    expect(order).toEqual([
      "foreground.stop",
      "cgroup.kill",
      "cgroup.empty",
      "runc.delete",
    ]);
  });

  test("marks netns, volume, or cgroup cleanup failure fatal and retains unsafe storage", async () => {
    const removeCgroup = vi.fn(async () => undefined);
    await expect(cleanupBuildResources({
      buildHandle: "B".repeat(22),
      netnsPath: "/run/lamarck/netns/build",
      volumeImage: "/var/lib/lamarck/builds/build.ext4",
      root: "/var/lib/lamarck/builds/build",
      cgroupPath: CGROUP,
      networkAttempted: true,
      volumeAttempted: true,
      storageMayBeInUse: false,
      operations: {
        deleteNetworkNamespace: vi.fn(async () => { throw new Error("netns busy"); }),
        destroyVolume: vi.fn(async () => { throw new Error("umount busy"); }),
        removeCgroupTree: removeCgroup,
      },
    })).rejects.toMatchObject({
      code: "CAPSULE_BUILD_CONTAINMENT_FAILED",
      fatalGuest: true,
      storageMayBeInUse: true,
    });
    expect(removeCgroup).toHaveBeenCalledOnce();

    const destroyVolume = vi.fn(async () => undefined);
    const unsafeCgroupRemove = vi.fn(async () => undefined);
    await cleanupBuildResources({
      buildHandle: "C".repeat(22),
      netnsPath: "/run/lamarck/netns/build",
      volumeImage: "/var/lib/lamarck/builds/build.ext4",
      root: "/var/lib/lamarck/builds/build",
      cgroupPath: CGROUP,
      networkAttempted: true,
      volumeAttempted: true,
      storageMayBeInUse: true,
      operations: {
        deleteNetworkNamespace: vi.fn(async () => undefined),
        destroyVolume,
        removeCgroupTree: unsafeCgroupRemove,
      },
    });
    expect(destroyVolume).not.toHaveBeenCalled();
    expect(unsafeCgroupRemove).not.toHaveBeenCalled();
  });

  test("removes a prepared bundle even when no runc child was created", async () => {
    const removeBundle = vi.fn(async () => undefined);
    const teardown = vi.fn(async () => undefined);
    await runAuthoritativeBuildRunCleanup({
      containerId: CONTAINER,
      bundlePath: `/run/lamarck/bundles/${CONTAINER}`,
      cgroupPath: CGROUP,
      operationError: new Error("aborted before spawn"),
      operations: { teardown, removeBundle },
    });
    expect(teardown).not.toHaveBeenCalled();
    expect(removeBundle).toHaveBeenCalledWith(`/run/lamarck/bundles/${CONTAINER}`);
  });

  test("makes final bundle removal failure containment-fatal after teardown", async () => {
    const order: string[] = [];
    await expect(runAuthoritativeBuildRunCleanup({
      containerId: CONTAINER,
      bundlePath: `/run/lamarck/bundles/${CONTAINER}`,
      cgroupPath: CGROUP,
      child: {} as ChildProcess,
      operationError: new Error("launch failed"),
      operations: {
        teardown: vi.fn(async () => { order.push("teardown"); }),
        removeBundle: vi.fn(async () => {
          order.push("bundle.remove");
          throw new Error("bundle remained");
        }),
      },
    })).rejects.toMatchObject({
      code: "CAPSULE_BUILD_CONTAINMENT_FAILED",
      fatalGuest: true,
      storageMayBeInUse: true,
      message: expect.stringMatching(/could not be proven retired/),
    });
    expect(order).toEqual(["teardown", "bundle.remove"]);
  });
});
