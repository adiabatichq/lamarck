import { createHash } from "node:crypto";
import {
  validateArgv,
  validateArtifactDigest,
  validateCapsuleCwd,
  validateEnvironment,
  validateMappedHostId,
  validateOpaqueId,
} from "../protocol/validate";
import type { WorkloadKind } from "../protocol/types";
import { MANAGED_APP_EDIT_ROOT } from "@lamarck/cli";

export const OCI_POLICY_VERSION = 1;
export const LAMARCK_SDK_SOCKET_ENV = "LAMARCK_SDK_SOCKET" as const;
export const LAMARCK_SDK_SOCKET_PATH = "/run/lamarck/system.sock" as const;
export const LAMARCK_FILES_ROOT_PATH = "/mnt/lamarck-files" as const;
export const APP_EDIT_LOWER_ROOT_PATH = "/mnt/lamarck-apps-lower" as const;

const NODE_ROOTFS = "/opt/lamarck/rootfs/node24";
const ARTIFACT_ROOT = "/var/lib/lamarck/artifacts/sha256";
const RUNTIME_ROOT = "/var/lib/lamarck/runtime";
const BUNDLE_ROOT = "/run/lamarck/bundles";
const NETNS_ROOT = "/run/lamarck/netns";
const SDK_BRIDGE_ROOT = "/run/lamarck/sdk-bridges";
const APP_EDIT_GUEST_ROOT = "/var/lib/lamarck/app-edits";
const EMPTY_RESOLV_CONF = "/opt/lamarck/config/empty-resolv.conf";
const LOOPBACK_HOSTS = "/opt/lamarck/config/loopback-hosts";

const DEFAULT_ENVIRONMENT: Record<string, string> = {
  HOME: "/home/app",
  LANG: "C.UTF-8",
  PATH: "/usr/local/bin:/usr/bin:/bin:/app/node_modules/.bin",
  TMPDIR: "/tmp",
  XDG_RUNTIME_DIR: "/run/app",
};

const DANGEROUS_SYSCALLS = [
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

const MASKED_PATHS = [
  "/proc/acpi",
  "/proc/asound",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/sched_debug",
  "/proc/timer_list",
  "/proc/timer_stats",
  "/sys/devices/virtual/powercap",
  "/sys/firmware",
] as const;

const READONLY_PATHS = [
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/sys",
  "/proc/sysrq-trigger",
] as const;

export interface OciPlanInput {
  appHandle: string;
  workloadHandle: string;
  workloadKind: WorkloadKind;
  artifactDigest: string;
  mappedHostUid: number;
  mappedHostGid: number;
  argv: string[];
  cwd: string;
  environment?: Record<string, string>;
  resources?: {
    memoryBytes?: number;
    pids?: number;
    cpuQuotaMicros?: number;
  };
}

/** Trusted request identity retained outside any persisted/generated OCI plan. */
export interface OciExpectedIdentity {
  appHandle: string;
  workloadHandle: string;
  workloadKind: WorkloadKind;
  artifactDigest: string;
  mappedHostUid: number;
  mappedHostGid: number;
  argv: string[];
  cwd: string;
  environment: Record<string, string>;
  resources: {
    memoryBytes: number;
    pids: number;
    cpuQuotaMicros: number;
  };
}

export interface OciMount {
  destination: string;
  type: string;
  source: string;
  options: string[];
}

export interface OciBundlePlan {
  policyVersion: typeof OCI_POLICY_VERSION;
  containerId: string;
  bundlePath: string;
  artifactRoot: string;
  runtimeRoot: string;
  networkNamespacePath: string;
  sdkBridgeRoot: string;
  sdkSocketHostPath: string;
  cliSocketHostPath: string;
  appEditRoot: string;
  config: {
    ociVersion: "1.1.0";
    root: { path: string; readonly: true };
    hostname: string;
    process: {
      terminal: false;
      user: { uid: 1_000; gid: 1_000; umask: 0o022; additionalGids: [] };
      args: string[];
      cwd: string;
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
      uidMappings: Array<{ containerID: number; hostID: number; size: number }>;
      gidMappings: Array<{ containerID: number; hostID: number; size: number }>;
      maskedPaths: string[];
      readonlyPaths: string[];
      devices: Array<{
        path: string;
        type: "c";
        major: number;
        minor: number;
        fileMode: number;
        uid: number;
        gid: number;
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
        cpu: { period: number; quota: number };
      };
      seccomp: {
        defaultAction: "SCMP_ACT_ALLOW";
        syscalls: Array<{
          names: string[];
          action: "SCMP_ACT_ERRNO";
          errnoRet: number;
          args?: Array<{ index: number; value: number; op: "SCMP_CMP_EQ" }>;
        }>;
      };
    };
    annotations: Record<string, string>;
  };
}

export class OciSecurityError extends Error {
  readonly code = "CAPSULE_OCI_INVARIANT";
  readonly invariant: string;

  constructor(invariant: string, message: string) {
    super(`${invariant}: ${message}`);
    this.name = "OciSecurityError";
    this.invariant = invariant;
  }
}

/** Deterministically compile a trusted launch specification into an OCI bundle plan. */
export function createOciBundlePlan(rawInput: OciPlanInput): OciBundlePlan {
  const appHandle = validateOpaqueId(rawInput.appHandle, "appHandle");
  const workloadHandle = validateOpaqueId(rawInput.workloadHandle, "workloadHandle");
  const artifactDigest = validateArtifactDigest(rawInput.artifactDigest, "artifactDigest");
  const mappedHostUid = validateMappedHostId(rawInput.mappedHostUid, "mappedHostUid");
  const mappedHostGid = validateMappedHostId(rawInput.mappedHostGid, "mappedHostGid");
  const argv = validateArgv(rawInput.argv, "argv");
  const cwd = validateCapsuleCwd(rawInput.cwd, "cwd");
  const suppliedEnvironment = validateEnvironment(rawInput.environment ?? {}, "environment");
  if (!(["ui", "service", "job"] as const).includes(rawInput.workloadKind)) {
    invariant("workload-kind", "unknown workload kind");
  }
  for (const key of Object.keys(suppliedEnvironment)) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_ENVIRONMENT, key)) {
      invariant("environment", `App launch environment cannot override ${key}`);
    }
  }

  const memoryBytes = boundedResource(
    rawInput.resources?.memoryBytes ?? 512 * 1024 * 1024,
    "memoryBytes",
    16 * 1024 * 1024,
    16 * 1024 * 1024 * 1024,
  );
  const pids = boundedResource(rawInput.resources?.pids ?? 256, "pids", 8, 65_536);
  const cpuQuotaMicros = boundedResource(
    rawInput.resources?.cpuQuotaMicros ?? 100_000,
    "cpuQuotaMicros",
    1_000,
    6_400_000,
  );
  const expectedIdentity: OciExpectedIdentity = {
    appHandle,
    workloadHandle,
    workloadKind: rawInput.workloadKind,
    artifactDigest,
    mappedHostUid,
    mappedHostGid,
    argv,
    cwd,
    environment: suppliedEnvironment,
    resources: { memoryBytes, pids, cpuQuotaMicros },
  };

  const appKey = `a-${opaqueKey(appHandle)}`;
  const workloadKey = `w-${opaqueKey(workloadHandle)}`;
  const runtimeRoot = `${RUNTIME_ROOT}/${appKey}`;
  const artifactHex = artifactDigest.slice("sha256:".length);
  const networkNamespacePath = `${NETNS_ROOT}/${appKey}`;
  const sdkBridgeRoot = `${SDK_BRIDGE_ROOT}/${workloadKey}`;
  const sdkSocketHostPath = `${sdkBridgeRoot}/system.sock`;
  const cliSocketHostPath = `${sdkBridgeRoot}/cli.sock`;
  const appEditRoot = `${APP_EDIT_GUEST_ROOT}/${workloadKey}`;
  const environment = Object.entries({
    ...DEFAULT_ENVIRONMENT,
    [LAMARCK_SDK_SOCKET_ENV]: LAMARCK_SDK_SOCKET_PATH,
    ...suppliedEnvironment,
  })
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`);

  const devices = fixedDevices();

  const plan: OciBundlePlan = {
    policyVersion: OCI_POLICY_VERSION,
    containerId: workloadKey,
    bundlePath: `${BUNDLE_ROOT}/${workloadKey}`,
    artifactRoot: `${ARTIFACT_ROOT}/${artifactHex}/root`,
    runtimeRoot,
    networkNamespacePath,
    sdkBridgeRoot,
    sdkSocketHostPath,
    cliSocketHostPath,
    appEditRoot,
    config: {
      ociVersion: "1.1.0",
      root: { path: NODE_ROOTFS, readonly: true },
      hostname: `capsule-${appKey.slice(2, 10)}`,
      process: {
        terminal: false,
        user: { uid: 1_000, gid: 1_000, umask: 0o022, additionalGids: [] },
        args: [...argv],
        cwd,
        env: environment,
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
      mounts: fixedMounts(runtimeRoot, sdkBridgeRoot, appEditRoot),
      linux: {
        cgroupsPath: `lamarck/apps/${appKey}/workloads/${workloadKey}`,
        rootfsPropagation: "private",
        namespaces: [
          { type: "user" },
          { type: "mount" },
          { type: "pid" },
          { type: "ipc" },
          { type: "uts" },
          { type: "cgroup" },
          { type: "network", path: networkNamespacePath },
        ],
        uidMappings: [{ containerID: 0, hostID: mappedHostUid, size: 65_536 }],
        gidMappings: [{ containerID: 0, hostID: mappedHostGid, size: 65_536 }],
        maskedPaths: [...MASKED_PATHS],
        readonlyPaths: [...READONLY_PATHS],
        devices,
        resources: {
          devices: fixedDeviceRules(devices),
          memory: { limit: memoryBytes },
          pids: { limit: pids },
          cpu: { period: 100_000, quota: cpuQuotaMicros },
        },
        seccomp: fixedSeccompProfile(),
      },
      annotations: {
        "ai.lamarck.oci-policy-version": String(OCI_POLICY_VERSION),
        "ai.lamarck.workload-kind": rawInput.workloadKind,
      },
    },
  };

  assertOciSecurityInvariants(plan, expectedIdentity);
  return deepFreeze(plan);
}

/** Fail closed if a generated or persisted plan violates the fixed V1 policy. */
export function assertOciSecurityInvariants(
  value: unknown,
  rawExpectedIdentity: OciExpectedIdentity,
): asserts value is OciBundlePlan {
  const expectedIdentity = normalizeExpectedIdentity(rawExpectedIdentity);
  const expectedAppKey = `a-${opaqueKey(expectedIdentity.appHandle)}`;
  const expectedWorkloadKey = `w-${opaqueKey(expectedIdentity.workloadHandle)}`;
  const expectedArtifactHex = expectedIdentity.artifactDigest.slice("sha256:".length);
  const expectedRuntimeRoot = `${RUNTIME_ROOT}/${expectedAppKey}`;
  const expectedNetworkNamespacePath = `${NETNS_ROOT}/${expectedAppKey}`;
  const expectedSdkBridgeRoot = `${SDK_BRIDGE_ROOT}/${expectedWorkloadKey}`;
  const expectedSdkSocketHostPath = `${expectedSdkBridgeRoot}/system.sock`;
  const expectedCliSocketHostPath = `${expectedSdkBridgeRoot}/cli.sock`;
  const expectedAppEditRoot = `${APP_EDIT_GUEST_ROOT}/${expectedWorkloadKey}`;
  const plan = value as Partial<OciBundlePlan>;
  if (plan.policyVersion !== OCI_POLICY_VERSION) invariant("policy-version", "unknown OCI policy");
  if (plan.containerId !== expectedWorkloadKey) {
    invariant("container-id", "container ID is not bound to the trusted workload handle");
  }
  if (plan.bundlePath !== `${BUNDLE_ROOT}/${plan.containerId}`) invariant("bundle-path", "bundle path is not Host-derived");
  if (plan.artifactRoot !== `${ARTIFACT_ROOT}/${expectedArtifactHex}/root`) {
    invariant("artifact-path", "artifact path is not bound to the trusted digest");
  }
  if (plan.runtimeRoot !== expectedRuntimeRoot) {
    invariant("runtime-path", "runtime path is not bound to the trusted App handle");
  }
  if (plan.networkNamespacePath !== expectedNetworkNamespacePath) {
    invariant("network-namespace", "network namespace is not bound to the trusted App handle");
  }
  if (plan.sdkBridgeRoot !== expectedSdkBridgeRoot) {
    invariant("sdk-bridge-path", "SDK bridge root is not bound to the trusted workload handle");
  }
  if (plan.sdkSocketHostPath !== expectedSdkSocketHostPath) {
    invariant("sdk-bridge-path", "SDK socket path is not bound to the trusted workload handle");
  }
  if (plan.cliSocketHostPath !== expectedCliSocketHostPath) {
    invariant("cli-bridge-path", "App CLI socket path is not bound to the trusted workload handle");
  }
  if (plan.appEditRoot !== expectedAppEditRoot) {
    invariant("app-edit-path", "App edit root is not bound to the trusted workload handle");
  }

  const config = plan.config as (OciBundlePlan["config"] & { hooks?: unknown }) | undefined;
  if (!config) invariant("config", "OCI config is missing");
  if ("hooks" in config) invariant("hooks", "OCI hooks are forbidden");
  if (config.ociVersion !== "1.1.0") invariant("oci-version", "unsupported OCI version");
  if (config.root.path !== NODE_ROOTFS || config.root.readonly !== true) {
    invariant("rootfs", "workload rootfs must be the fixed read-only Node image");
  }
  if (config.hostname !== `capsule-${expectedAppKey.slice(2, 10)}`) {
    invariant("hostname", "hostname is not bound to the trusted App handle");
  }
  if (config.process.terminal !== false || config.process.noNewPrivileges !== true) {
    invariant("process-privilege", "terminal/no_new_privs policy changed");
  }
  if (config.process.user.uid !== 1_000 || config.process.user.gid !== 1_000) {
    invariant("process-user", "workload must run as the mapped App user");
  }
  if (config.process.user.umask !== 0o022) {
    invariant("process-user", "workload umask must remain 0022");
  }
  if (!structurallyEqual(config.process.args, expectedIdentity.argv)) {
    invariant("process-args", "process argv differs from the trusted launch specification");
  }
  if (config.process.cwd !== expectedIdentity.cwd) {
    invariant("process-cwd", "process cwd differs from the trusted launch specification");
  }
  for (const [set, capabilities] of Object.entries(config.process.capabilities)) {
    if (!Array.isArray(capabilities) || capabilities.length !== 0) {
      invariant("capabilities", `${set} capability set must be empty`);
    }
  }

  const environmentKeys = new Set<string>();
  let sdkSocketEntries = 0;
  for (const entry of config.process.env) {
    const separator = entry.indexOf("=");
    if (separator < 1) invariant("environment", "malformed environment entry");
    const key = entry.slice(0, separator);
    if (environmentKeys.has(key)) invariant("environment", `duplicate environment key ${key}`);
    environmentKeys.add(key);
    if (key.startsWith("LAMARCK_") && key !== LAMARCK_SDK_SOCKET_ENV) {
      invariant("environment", "unknown reserved runtime environment key");
    }
    if (entry === `${LAMARCK_SDK_SOCKET_ENV}=${LAMARCK_SDK_SOCKET_PATH}`) {
      sdkSocketEntries += 1;
    }
  }
  if (sdkSocketEntries !== 1) {
    invariant("sdk-socket", "exactly one fixed workload SDK socket is required");
  }
  const expectedEnvironment = Object.entries({
    ...DEFAULT_ENVIRONMENT,
    [LAMARCK_SDK_SOCKET_ENV]: LAMARCK_SDK_SOCKET_PATH,
    ...expectedIdentity.environment,
  })
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`);
  if (!structurallyEqual(config.process.env, expectedEnvironment)) {
    invariant("environment", "process environment differs from the trusted launch specification");
  }

  if (!structurallyEqual(config.mounts, fixedMounts(
    expectedRuntimeRoot,
    expectedSdkBridgeRoot,
    expectedAppEditRoot,
  ))) {
    invariant("mounts", "mount table differs from the closed policy");
  }

  const namespaceTypes = new Set<string>();
  for (const namespace of config.linux.namespaces) {
    if (namespaceTypes.has(namespace.type)) invariant("namespaces", `duplicate ${namespace.type} namespace`);
    namespaceTypes.add(namespace.type);
    if (namespace.type === "network") {
      if (namespace.path !== expectedNetworkNamespacePath) {
        invariant("network-namespace", "workload did not join its pinned App namespace");
      }
    } else if (namespace.path !== undefined) {
      invariant("namespaces", `${namespace.type} cannot join an ambient namespace`);
    }
  }
  for (const required of ["user", "mount", "pid", "ipc", "uts", "cgroup", "network"]) {
    if (!namespaceTypes.has(required)) invariant("namespaces", `missing ${required} namespace`);
  }
  if (
    config.linux.cgroupsPath
    !== `lamarck/apps/${expectedAppKey}/workloads/${expectedWorkloadKey}`
  ) {
    invariant("cgroup", "workload cgroup is not bound to the trusted launch identity");
  }
  if (config.linux.rootfsPropagation !== "private") {
    invariant("rootfs-propagation", "rootfs propagation must remain private");
  }
  if (config.linux.uidMappings.length !== 1 || config.linux.gidMappings.length !== 1) {
    invariant("user-namespace", "exactly one App UID/GID mapping is required");
  }
  const uid = config.linux.uidMappings[0]!;
  const gid = config.linux.gidMappings[0]!;
  if (
    uid.containerID !== 0
    || uid.size !== 65_536
    || uid.hostID !== expectedIdentity.mappedHostUid
  ) {
    invariant("user-namespace", "invalid UID mapping");
  }
  if (
    gid.containerID !== 0
    || gid.size !== 65_536
    || gid.hostID !== expectedIdentity.mappedHostGid
  ) {
    invariant("user-namespace", "invalid GID mapping");
  }

  if (!structurallyEqual(config.linux.maskedPaths, [...MASKED_PATHS])) {
    invariant("masked-paths", "masked proc/sys policy changed");
  }
  if (!structurallyEqual(config.linux.readonlyPaths, [...READONLY_PATHS])) {
    invariant("readonly-paths", "read-only proc policy changed");
  }
  const devices = fixedDevices();
  if (!structurallyEqual(config.linux.devices, devices)) {
    invariant("devices", "device node policy differs from the closed policy");
  }
  if (!structurallyEqual(config.linux.resources.devices, fixedDeviceRules(devices))) {
    invariant("devices", "device cgroup policy differs from the closed policy");
  }
  if (!structurallyEqual(config.linux.seccomp, fixedSeccompProfile())) {
    invariant("seccomp", "seccomp profile differs from the fixed policy");
  }
  if (!structurallyEqual(config.process.rlimits, [
    { type: "RLIMIT_CORE", hard: 0, soft: 0 },
    { type: "RLIMIT_NOFILE", hard: 4_096, soft: 4_096 },
  ])) {
    invariant("rlimits", "process limits differ from the fixed policy");
  }
  boundedResource(config.linux.resources.memory.limit, "memory.limit", 16 * 1024 * 1024, 16 * 1024 * 1024 * 1024);
  boundedResource(config.linux.resources.pids.limit, "pids.limit", 8, 65_536);
  boundedResource(config.linux.resources.cpu.quota, "cpu.quota", 1_000, 6_400_000);
  if (config.linux.resources.cpu.period !== 100_000) invariant("resources", "CPU period changed");
  if (!structurallyEqual(config.linux.resources, {
    devices: fixedDeviceRules(devices),
    memory: { limit: expectedIdentity.resources.memoryBytes },
    pids: { limit: expectedIdentity.resources.pids },
    cpu: { period: 100_000, quota: expectedIdentity.resources.cpuQuotaMicros },
  })) {
    invariant("resources", "resource limits differ from the trusted launch specification");
  }
  if (!structurallyEqual(config.annotations, {
    "ai.lamarck.oci-policy-version": String(OCI_POLICY_VERSION),
    "ai.lamarck.workload-kind": expectedIdentity.workloadKind,
  })) {
    invariant("annotations", "OCI annotations are not bound to the trusted workload kind");
  }
}

function normalizeExpectedIdentity(raw: OciExpectedIdentity): OciExpectedIdentity {
  if (!(["ui", "service", "job"] as const).includes(raw.workloadKind)) {
    invariant("workload-kind", "unknown expected workload kind");
  }
  const environment = validateEnvironment(raw.environment, "expected.environment");
  return {
    appHandle: validateOpaqueId(raw.appHandle, "expected.appHandle"),
    workloadHandle: validateOpaqueId(raw.workloadHandle, "expected.workloadHandle"),
    workloadKind: raw.workloadKind,
    artifactDigest: validateArtifactDigest(raw.artifactDigest, "expected.artifactDigest"),
    mappedHostUid: validateMappedHostId(raw.mappedHostUid, "expected.mappedHostUid"),
    mappedHostGid: validateMappedHostId(raw.mappedHostGid, "expected.mappedHostGid"),
    argv: validateArgv(raw.argv, "expected.argv"),
    cwd: validateCapsuleCwd(raw.cwd, "expected.cwd"),
    environment,
    resources: {
      memoryBytes: boundedResource(raw.resources.memoryBytes, "expected.memoryBytes", 16 * 1024 * 1024, 16 * 1024 * 1024 * 1024),
      pids: boundedResource(raw.resources.pids, "expected.pids", 8, 65_536),
      cpuQuotaMicros: boundedResource(raw.resources.cpuQuotaMicros, "expected.cpuQuotaMicros", 1_000, 6_400_000),
    },
  };
}

function fixedMounts(runtimeRoot: string, sdkBridgeRoot: string, appEditRoot: string): OciMount[] {
  return [
    { destination: "/proc", type: "proc", source: "proc", options: ["nosuid", "noexec", "nodev"] },
    { destination: "/dev", type: "tmpfs", source: "tmpfs", options: ["nosuid", "noexec", "mode=755", "size=65536k"] },
    { destination: "/dev/pts", type: "devpts", source: "devpts", options: ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620", "gid=5"] },
    { destination: "/dev/shm", type: "tmpfs", source: "shm", options: ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"] },
    { destination: "/dev/mqueue", type: "mqueue", source: "mqueue", options: ["nosuid", "noexec", "nodev"] },
    { destination: "/app", type: "bind", source: `${runtimeRoot}/merged`, options: ["rbind", "rw", "nosuid", "nodev"] },
    { destination: "/home/app", type: "bind", source: `${runtimeRoot}/home`, options: ["rbind", "rw", "nosuid", "nodev"] },
    { destination: "/run/app", type: "bind", source: `${runtimeRoot}/run`, options: ["rbind", "rw", "nosuid", "nodev"] },
    { destination: "/run/lamarck", type: "bind", source: sdkBridgeRoot, options: ["rbind", "ro", "nosuid", "nodev", "noexec"] },
    { destination: MANAGED_APP_EDIT_ROOT, type: "bind", source: appEditRoot, options: ["rbind", "rw", "nosuid", "nodev"] },
    { destination: APP_EDIT_LOWER_ROOT_PATH, type: "bind", source: APP_EDIT_LOWER_ROOT_PATH, options: ["rbind", "ro", "nosuid", "nodev", "noexec"] },
    { destination: LAMARCK_FILES_ROOT_PATH, type: "bind", source: LAMARCK_FILES_ROOT_PATH, options: ["rbind", "ro", "nosuid", "nodev", "noexec"] },
    { destination: "/tmp", type: "tmpfs", source: "tmpfs", options: ["nosuid", "nodev", "mode=1777", "size=262144k"] },
    { destination: "/etc/resolv.conf", type: "bind", source: EMPTY_RESOLV_CONF, options: ["bind", "ro", "nosuid", "nodev", "noexec"] },
    { destination: "/etc/hosts", type: "bind", source: LOOPBACK_HOSTS, options: ["bind", "ro", "nosuid", "nodev", "noexec"] },
  ];
}

function fixedDevices(): OciBundlePlan["config"]["linux"]["devices"] {
  return [
    { path: "/dev/null", type: "c", major: 1, minor: 3, fileMode: 0o666, uid: 0, gid: 0 },
    { path: "/dev/zero", type: "c", major: 1, minor: 5, fileMode: 0o666, uid: 0, gid: 0 },
    { path: "/dev/full", type: "c", major: 1, minor: 7, fileMode: 0o666, uid: 0, gid: 0 },
    { path: "/dev/random", type: "c", major: 1, minor: 8, fileMode: 0o666, uid: 0, gid: 0 },
    { path: "/dev/urandom", type: "c", major: 1, minor: 9, fileMode: 0o666, uid: 0, gid: 0 },
    { path: "/dev/tty", type: "c", major: 5, minor: 0, fileMode: 0o666, uid: 0, gid: 0 },
  ];
}

function fixedDeviceRules(
  devices: OciBundlePlan["config"]["linux"]["devices"],
): OciBundlePlan["config"]["linux"]["resources"]["devices"] {
  return [
    { allow: false, access: "rwm" },
    ...devices.map((device) => ({
      allow: true,
      type: "c" as const,
      major: device.major,
      minor: device.minor,
      access: "rwm" as const,
    })),
  ];
}

function fixedSeccompProfile(): OciBundlePlan["config"]["linux"]["seccomp"] {
  return {
    defaultAction: "SCMP_ACT_ALLOW",
    syscalls: [
      {
        names: [...DANGEROUS_SYSCALLS],
        action: "SCMP_ACT_ERRNO",
        errnoRet: 1,
      },
      {
        names: ["socket"],
        action: "SCMP_ACT_ERRNO",
        errnoRet: 1,
        args: [{ index: 0, value: 40, op: "SCMP_CMP_EQ" }],
      },
      {
        names: ["socket"],
        action: "SCMP_ACT_ERRNO",
        errnoRet: 1,
        args: [{ index: 0, value: 17, op: "SCMP_CMP_EQ" }],
      },
    ],
  };
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function opaqueKey(handle: string): string {
  return createHash("sha256").update(handle, "utf8").digest("hex").slice(0, 32);
}

function boundedResource(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invariant("resources", `${name} must be between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function invariant(name: string, message: string): never {
  throw new OciSecurityError(name, message);
}
