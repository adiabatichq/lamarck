import { createHash } from "node:crypto";
import {
  validateArtifactDigest,
  validateMappedHostId,
  validateOpaqueId,
} from "../protocol/validate";
import type { OciMount } from "./plan";

const BUILD_ROOTFS = "/opt/lamarck/rootfs/build-node24";
const BUILD_STATE_ROOT = "/var/lib/lamarck/builds";
const BUNDLE_ROOT = "/run/lamarck/bundles";
const NETNS_ROOT = "/run/lamarck/netns";
const EMPTY_RESOLV_CONF = "/opt/lamarck/config/empty-resolv.conf";
const LOOPBACK_HOSTS = "/opt/lamarck/config/loopback-hosts";

const BUILD_DANGEROUS_SYSCALLS = [
  "bpf",
  "delete_module",
  "fanotify_init",
  "finit_module",
  "fsconfig",
  "fsmount",
  "fsopen",
  "init_module",
  "io_uring_enter",
  "io_uring_register",
  "io_uring_setup",
  "kexec_file_load",
  "kexec_load",
  "keyctl",
  "mount",
  "mount_setattr",
  "move_mount",
  "open_by_handle_at",
  "open_tree",
  "perf_event_open",
  "process_vm_readv",
  "process_vm_writev",
  "ptrace",
  "reboot",
  "setns",
  "swapoff",
  "swapon",
  "umount2",
  "unshare",
] as const;

export interface BuildOciPlanInput {
  appHandle: string;
  buildHandle: string;
  packageDigest: string;
  dependencyDigest?: string;
  mappedHostUid: number;
  mappedHostGid: number;
  resources: {
    memoryBytes: number;
    pids: number;
    cpuQuotaMicros: number;
  };
}

export interface BuildOciBundlePlan {
  policyVersion: 1;
  containerId: string;
  bundlePath: string;
  buildRoot: string;
  networkNamespacePath: string;
  config: {
    ociVersion: "1.1.0";
    root: { path: typeof BUILD_ROOTFS; readonly: true };
    hostname: string;
    process: {
      terminal: false;
      user: { uid: 1_000; gid: 1_000; umask: 0o022; additionalGids: [] };
      args: string[];
      cwd: "/workspace";
      env: string[];
      noNewPrivileges: true;
      capabilities: {
        ambient: [];
        bounding: [];
        effective: [];
        inheritable: [];
        permitted: [];
      };
      rlimits: Array<{ type: "RLIMIT_CORE" | "RLIMIT_NOFILE"; hard: number; soft: number }>;
    };
    mounts: OciMount[];
    linux: {
      cgroupsPath: string;
      rootfsPropagation: "private";
      namespaces: Array<{ type: string; path?: string }>;
      uidMappings: Array<{ containerID: 0; hostID: number; size: 65_536 }>;
      gidMappings: Array<{ containerID: 0; hostID: number; size: 65_536 }>;
      maskedPaths: string[];
      readonlyPaths: string[];
      devices: Array<{
        path: string;
        type: "c";
        major: number;
        minor: number;
        fileMode: number;
        uid: 0;
        gid: 0;
      }>;
      resources: {
        devices: Array<{
          allow: boolean;
          type?: "c";
          major?: number;
          minor?: number;
          access: "rwm";
        }>;
        memory: { limit: number };
        pids: { limit: number };
        cpu: { period: 100_000; quota: number };
      };
      seccomp: {
        defaultAction: "SCMP_ACT_ALLOW";
        syscalls: Array<{
          names: string[];
          action: "SCMP_ACT_ERRNO";
          errnoRet: 1;
          args?: Array<{ index: 0; value: number; op: "SCMP_CMP_EQ" }>;
        }>;
      };
    };
    annotations: Record<string, string>;
  };
}

function compileBuildOciBundlePlan(raw: BuildOciPlanInput): BuildOciBundlePlan {
  const appHandle = validateOpaqueId(raw.appHandle, "appHandle");
  const buildHandle = validateOpaqueId(raw.buildHandle, "buildHandle");
  const packageDigest = validateArtifactDigest(raw.packageDigest, "packageDigest");
  const dependencyDigest = raw.dependencyDigest === undefined
    ? undefined
    : validateArtifactDigest(raw.dependencyDigest, "dependencyDigest");
  const mappedHostUid = validateMappedHostId(raw.mappedHostUid, "mappedHostUid");
  const mappedHostGid = validateMappedHostId(raw.mappedHostGid, "mappedHostGid");
  const memoryBytes = bounded(raw.resources.memoryBytes, 64 * 1024 * 1024, 8 * 1024 * 1024 * 1024, "memoryBytes");
  const pids = bounded(raw.resources.pids, 16, 4_096, "pids");
  const cpuQuotaMicros = bounded(raw.resources.cpuQuotaMicros, 1_000, 6_400_000, "cpuQuotaMicros");
  const buildKey = `b-${opaqueKey(buildHandle)}`;
  const buildRoot = `${BUILD_STATE_ROOT}/${buildKey}`;
  const networkNamespacePath = `${NETNS_ROOT}/${buildKey}`;
  const devices = fixedBuildDevices();
  const npmArgs = [
    "/usr/libexec/lamarck-offline-npm",
    "/workspace/package-lock.json",
    "/dependencies/manifest.json",
  ];
  const plan: BuildOciBundlePlan = {
    policyVersion: 1,
    containerId: buildKey,
    bundlePath: `${BUNDLE_ROOT}/${buildKey}`,
    buildRoot,
    networkNamespacePath,
    config: {
      ociVersion: "1.1.0",
      root: { path: BUILD_ROOTFS, readonly: true },
      hostname: `build-${buildKey.slice(2, 10)}`,
      process: {
        terminal: false,
        user: { uid: 1_000, gid: 1_000, umask: 0o022, additionalGids: [] },
        args: npmArgs,
        cwd: "/workspace",
        env: [
          "AR=/usr/bin/ar",
          "CC=/usr/bin/cc",
          "CXX=/usr/bin/c++",
          "HOME=/home/build",
          "LANG=C.UTF-8",
          "LD_LIBRARY_PATH=/opt/lamarck/toolchain/lib",
          "NPM_CONFIG_AUDIT=false",
          "NPM_CONFIG_CACHE=/home/build/.npm",
          "NPM_CONFIG_FUND=false",
          "NPM_CONFIG_UPDATE_NOTIFIER=false",
          "PKG_CONFIG_LIBDIR=/opt/lamarck/toolchain/aarch64-buildroot-linux-gnu/sysroot/usr/lib/pkgconfig:/opt/lamarck/toolchain/aarch64-buildroot-linux-gnu/sysroot/usr/share/pkgconfig",
          "PKG_CONFIG_SYSROOT_DIR=/opt/lamarck/toolchain/aarch64-buildroot-linux-gnu/sysroot",
          "PATH=/usr/local/bin:/usr/bin:/bin",
          "PYTHON=/usr/bin/python3",
          "TMPDIR=/tmp",
          "npm_config_nodedir=/usr/local",
          "npm_config_python=/usr/bin/python3",
        ],
        noNewPrivileges: true,
        capabilities: {
          ambient: [],
          bounding: [],
          effective: [],
          inheritable: [],
          permitted: [],
        },
        rlimits: [
          { type: "RLIMIT_CORE", hard: 0, soft: 0 },
          { type: "RLIMIT_NOFILE", hard: 4_096, soft: 4_096 },
        ],
      },
      mounts: fixedBuildMounts(buildRoot),
      linux: {
        cgroupsPath: `lamarck/builds/${buildKey}`,
        rootfsPropagation: "private",
        namespaces: [
          ...["user", "mount", "pid", "ipc", "uts", "cgroup"].map((type) => ({ type })),
          { type: "network", path: networkNamespacePath },
        ],
        uidMappings: [{ containerID: 0, hostID: mappedHostUid, size: 65_536 }],
        gidMappings: [{ containerID: 0, hostID: mappedHostGid, size: 65_536 }],
        maskedPaths: [
          "/proc/acpi",
          "/proc/asound",
          "/proc/kcore",
          "/proc/keys",
          "/proc/sched_debug",
          "/sys/firmware",
        ],
        readonlyPaths: ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
        devices,
        resources: {
          devices: [
            { allow: false, access: "rwm" },
            ...devices.map((device) => ({
              allow: true,
              type: "c" as const,
              major: device.major,
              minor: device.minor,
              access: "rwm" as const,
            })),
          ],
          memory: { limit: memoryBytes },
          pids: { limit: pids },
          cpu: { period: 100_000, quota: cpuQuotaMicros },
        },
        seccomp: {
          defaultAction: "SCMP_ACT_ALLOW",
          syscalls: [
            { names: [...BUILD_DANGEROUS_SYSCALLS], action: "SCMP_ACT_ERRNO", errnoRet: 1 },
            { names: ["socket"], action: "SCMP_ACT_ERRNO", errnoRet: 1, args: [{ index: 0, value: 40, op: "SCMP_CMP_EQ" }] },
            { names: ["socket"], action: "SCMP_ACT_ERRNO", errnoRet: 1, args: [{ index: 0, value: 17, op: "SCMP_CMP_EQ" }] },
          ],
        },
      },
      annotations: {
        "ai.lamarck.build-policy-version": "1",
        "ai.lamarck.package-digest": packageDigest,
        "ai.lamarck.dependency-digest": dependencyDigest ?? "none",
        "ai.lamarck.app-key": `a-${opaqueKey(appHandle)}`,
      },
    },
  };
  return plan;
}

export function createBuildOciBundlePlan(raw: BuildOciPlanInput): BuildOciBundlePlan {
  const plan = compileBuildOciBundlePlan(raw);
  assertBuildOciSecurityInvariants(plan, raw);
  return deepFreeze(plan);
}

export function assertBuildOciSecurityInvariants(
  value: unknown,
  expected: BuildOciPlanInput,
): asserts value is BuildOciBundlePlan {
  const regenerated = compileBuildOciBundlePlan(expected);
  if (JSON.stringify(value) !== JSON.stringify(regenerated)) {
    throw new Error("Build OCI plan differs from the closed Build Capsule policy");
  }
}

function fixedBuildMounts(root: string): OciMount[] {
  return [
    { destination: "/proc", type: "proc", source: "proc", options: ["nosuid", "noexec", "nodev"] },
    { destination: "/dev", type: "tmpfs", source: "tmpfs", options: ["nosuid", "noexec", "mode=755", "size=65536k"] },
    { destination: "/dev/pts", type: "devpts", source: "devpts", options: ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620", "gid=5"] },
    { destination: "/dev/shm", type: "tmpfs", source: "shm", options: ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"] },
    { destination: "/workspace", type: "bind", source: `${root}/workspace`, options: ["rbind", "rw", "nosuid", "nodev"] },
    { destination: "/dependencies", type: "bind", source: `${root}/dependencies`, options: ["rbind", "ro", "nosuid", "nodev", "noexec"] },
    { destination: "/home/build", type: "bind", source: `${root}/home`, options: ["rbind", "rw", "nosuid", "nodev", "noexec"] },
    { destination: "/tmp", type: "tmpfs", source: "tmpfs", options: ["nosuid", "nodev", "mode=1777", "size=524288k"] },
    { destination: "/etc/resolv.conf", type: "bind", source: EMPTY_RESOLV_CONF, options: ["bind", "ro", "nosuid", "nodev", "noexec"] },
    { destination: "/etc/hosts", type: "bind", source: LOOPBACK_HOSTS, options: ["bind", "ro", "nosuid", "nodev", "noexec"] },
  ];
}

function fixedBuildDevices(): BuildOciBundlePlan["config"]["linux"]["devices"] {
  return [
    { path: "/dev/null", type: "c", major: 1, minor: 3, fileMode: 0o666, uid: 0, gid: 0 },
    { path: "/dev/zero", type: "c", major: 1, minor: 5, fileMode: 0o666, uid: 0, gid: 0 },
    { path: "/dev/full", type: "c", major: 1, minor: 7, fileMode: 0o666, uid: 0, gid: 0 },
    { path: "/dev/random", type: "c", major: 1, minor: 8, fileMode: 0o666, uid: 0, gid: 0 },
    { path: "/dev/urandom", type: "c", major: 1, minor: 9, fileMode: 0o666, uid: 0, gid: 0 },
    { path: "/dev/tty", type: "c", major: 5, minor: 0, fileMode: 0o666, uid: 0, gid: 0 },
  ];
}

function opaqueKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
