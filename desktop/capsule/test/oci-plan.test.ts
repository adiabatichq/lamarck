import { describe, expect, test } from "vitest";
import {
  assertOciSecurityInvariants,
  createOciBundlePlan,
  OciSecurityError,
  type OciBundlePlan,
  type OciExpectedIdentity,
  type OciPlanInput,
} from "../src/oci/plan";

const APP_HANDLE = "A".repeat(22);
const WORKLOAD_HANDLE = "W".repeat(22);
const ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}`;

describe("deterministic OCI bundle planning", () => {
  test("derives only opaque Guest paths and fixed security policy", () => {
    const first = createOciBundlePlan(input());
    const second = createOciBundlePlan(input());
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.config.linux.seccomp.syscalls)).toBe(true);
    expect(JSON.stringify(first)).not.toContain(APP_HANDLE);
    expect(JSON.stringify(first)).not.toContain(WORKLOAD_HANDLE);
    expect(first.containerId).toMatch(/^w-[a-f0-9]{32}$/);
    expect(first.config.root).toEqual({ path: "/opt/lamarck/rootfs/node24", readonly: true });
    expect(first.config.process.noNewPrivileges).toBe(true);
    expect(Object.values(first.config.process.capabilities).every((set) => set.length === 0)).toBe(true);
    expect(first.config.process.env).toContain(
      "LAMARCK_SDK_SOCKET=/run/lamarck/system.sock",
    );
    expect(first.sdkBridgeRoot).toMatch(/^\/run\/lamarck\/sdk-bridges\/w-[a-f0-9]{32}$/);
    expect(first.sdkSocketHostPath).toBe(`${first.sdkBridgeRoot}/system.sock`);
    expect(first.cliSocketHostPath).toBe(`${first.sdkBridgeRoot}/cli.sock`);
    expect(first.appEditRoot).toMatch(/^\/var\/lib\/lamarck\/app-edits\/w-[a-f0-9]{32}$/);
    expect(first.config.mounts).toContainEqual({
      destination: "/run/lamarck",
      type: "bind",
      source: first.sdkBridgeRoot,
      options: ["rbind", "ro", "nosuid", "nodev", "noexec"],
    });
    expect(first.config.mounts).toContainEqual({
      destination: "/mnt/lamarck-apps",
      type: "bind",
      source: first.appEditRoot,
      options: ["rbind", "rw", "nosuid", "nodev"],
    });
    expect(first.config.mounts).toContainEqual({
      destination: "/mnt/lamarck-apps-lower",
      type: "bind",
      source: "/mnt/lamarck-apps-lower",
      options: ["rbind", "ro", "nosuid", "nodev", "noexec"],
    });
    expect(first.config.mounts).toContainEqual({
      destination: "/mnt/lamarck-files",
      type: "bind",
      source: "/mnt/lamarck-files",
      options: ["rbind", "ro", "nosuid", "nodev", "noexec"],
    });
    expect(first.config.linux.namespaces).toContainEqual({
      type: "network",
      path: first.networkNamespacePath,
    });
    expect(first.config.linux.uidMappings).toEqual([
      { containerID: 0, hostID: 100_000, size: 65_536 },
    ]);
    expect(first.config.mounts.some((mount) => mount.destination === "/sys")).toBe(false);
    expect(first.config.mounts.some((mount) => mount.source.includes("/workspace/apps"))).toBe(false);
    expect(first.config.process.env.some((entry) => entry.includes("CORE_TOKEN"))).toBe(false);
    expect(() => assertOciSecurityInvariants(first, expectedIdentity())).not.toThrow();
  });

  test("sorts supplied environment without inheriting Host capabilities", () => {
    const plan = createOciBundlePlan(input({
      environment: { Z_LAST: "z", NODE_ENV: "production", A_FIRST: "a" },
    }));
    expect(plan.config.process.env).toEqual([...plan.config.process.env].sort());
    expect(plan.config.process.env).toContain("NODE_ENV=production");
    expect(plan.config.process.env.filter((entry) => entry.startsWith("LAMARCK_"))).toEqual([
      "LAMARCK_SDK_SOCKET=/run/lamarck/system.sock",
    ]);

    expect(() => createOciBundlePlan(input({
      environment: { LAMARCK_GUARD_TOKEN: "secret" },
    }))).toThrowError(/reserved Host environment key/);
    expect(() => createOciBundlePlan(input({
      environment: { LAMARCK_SDK_SOCKET: "/run/app/forged.sock" },
    }))).toThrowError(/reserved Host environment key/);
    expect(() => createOciBundlePlan(input({
      environment: { HOME: "/attacker" },
    }))).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "environment" }),
    );
  });

  test("rejects traversal before generating a bundle", () => {
    expect(() => createOciBundlePlan(input({ cwd: "/app/../host" }))).toThrowError(
      /traversal segments/,
    );
  });

  test("detects privilege, namespace, mount, and vsock-policy regressions", () => {
    const withCapability = copyPlan();
    (withCapability.config.process.capabilities.effective as string[]).push("CAP_SYS_ADMIN");
    expect(() => assertOciSecurityInvariants(withCapability, expectedIdentity())).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "capabilities" }),
    );

    const ambientNetwork = copyPlan();
    ambientNetwork.config.linux.namespaces.find((item) => item.type === "network")!.path = "/proc/1/ns/net";
    expect(() => assertOciSecurityInvariants(ambientNetwork, expectedIdentity())).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "network-namespace" }),
    );

    const hostMount = copyPlan();
    hostMount.config.mounts.push({
      destination: "/host",
      type: "bind",
      source: "/Users/example",
      options: ["rbind", "rw"],
    });
    expect(() => assertOciSecurityInvariants(hostMount, expectedIdentity())).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "mounts" }),
    );

    const writableSdkBridge = copyPlan();
    writableSdkBridge.config.mounts.find(
      (mount) => mount.destination === "/run/lamarck",
    )!.options = ["rbind", "rw"];
    expect(() => assertOciSecurityInvariants(writableSdkBridge, expectedIdentity())).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "mounts" }),
    );

    const writableAppLower = copyPlan();
    writableAppLower.config.mounts.find(
      (mount) => mount.destination === "/mnt/lamarck-apps-lower",
    )!.options = ["rbind", "rw"];
    expect(() => assertOciSecurityInvariants(writableAppLower, expectedIdentity())).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "mounts" }),
    );

    const replacedProc = copyPlan();
    replacedProc.config.mounts.find((mount) => mount.destination === "/proc")!.source = "/host/proc";
    expect(() => assertOciSecurityInvariants(replacedProc, expectedIdentity())).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "mounts" }),
    );

    const extraDevice = copyPlan();
    extraDevice.config.linux.devices.push({
      path: "/dev/sda",
      type: "c",
      major: 8,
      minor: 0,
      fileMode: 0o660,
      uid: 0,
      gid: 0,
    });
    expect(() => assertOciSecurityInvariants(extraDevice, expectedIdentity())).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "devices" }),
    );

    const hooks = copyPlan() as OciBundlePlan & { config: OciBundlePlan["config"] & { hooks: {} } };
    hooks.config.hooks = {};
    expect(() => assertOciSecurityInvariants(hooks, expectedIdentity())).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "hooks" }),
    );

    const vsock = copyPlan();
    vsock.config.linux.seccomp.syscalls = vsock.config.linux.seccomp.syscalls.filter(
      (rule) => !rule.args?.some((argument) => argument.value === 40),
    );
    expect(() => assertOciSecurityInvariants(vsock, expectedIdentity())).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "seccomp" }),
    );

    const ioUring = copyPlan();
    ioUring.config.linux.seccomp.syscalls[0]!.names =
      ioUring.config.linux.seccomp.syscalls[0]!.names.filter(
        (name) => name !== "io_uring_setup",
      );
    expect(() => assertOciSecurityInvariants(ioUring, expectedIdentity())).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "seccomp" }),
    );
  });

  test("rejects coordinated path relabeling against trusted launch identity", () => {
    const relabeledRuntime = copyPlan();
    const otherAppKey = `a-${"f".repeat(32)}`;
    relabeledRuntime.runtimeRoot = `/var/lib/lamarck/runtime/${otherAppKey}`;
    for (const mount of relabeledRuntime.config.mounts) {
      if (mount.source.startsWith("/var/lib/lamarck/runtime/")) {
        mount.source = mount.source.replace(/a-[a-f0-9]{32}/, otherAppKey);
      }
    }
    relabeledRuntime.networkNamespacePath = `/run/lamarck/netns/${otherAppKey}`;
    relabeledRuntime.config.linux.namespaces.find((item) => item.type === "network")!.path =
      relabeledRuntime.networkNamespacePath;
    relabeledRuntime.config.linux.cgroupsPath =
      `lamarck/apps/${otherAppKey}/workloads/${relabeledRuntime.containerId}`;
    expect(() => assertOciSecurityInvariants(
      relabeledRuntime,
      expectedIdentity(),
    )).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "runtime-path" }),
    );

    const relabeledArtifact = copyPlan();
    relabeledArtifact.artifactRoot =
      `/var/lib/lamarck/artifacts/sha256/${"b".repeat(64)}/root`;
    expect(() => assertOciSecurityInvariants(
      relabeledArtifact,
      expectedIdentity(),
    )).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "artifact-path" }),
    );

    const relabeledBridge = copyPlan();
    relabeledBridge.sdkBridgeRoot = `/run/lamarck/sdk-bridges/w-${"e".repeat(32)}`;
    relabeledBridge.sdkSocketHostPath = `${relabeledBridge.sdkBridgeRoot}/system.sock`;
    relabeledBridge.config.mounts.find(
      (mount) => mount.destination === "/run/lamarck",
    )!.source = relabeledBridge.sdkBridgeRoot;
    expect(() => assertOciSecurityInvariants(
      relabeledBridge,
      expectedIdentity(),
    )).toThrowError(
      expect.objectContaining<Partial<OciSecurityError>>({ invariant: "sdk-bridge-path" }),
    );
  });
});

function input(overrides: Partial<OciPlanInput> = {}): OciPlanInput {
  return {
    appHandle: APP_HANDLE,
    workloadHandle: WORKLOAD_HANDLE,
    workloadKind: "ui",
    artifactDigest: ARTIFACT_DIGEST,
    mappedHostUid: 100_000,
    mappedHostGid: 200_000,
    argv: ["npm", "run", "start"],
    cwd: "/app",
    environment: {},
    ...overrides,
  };
}

function copyPlan(): OciBundlePlan {
  return structuredClone(createOciBundlePlan(input()));
}

function expectedIdentity(): OciExpectedIdentity {
  const value = input();
  return {
    appHandle: value.appHandle,
    workloadHandle: value.workloadHandle,
    workloadKind: value.workloadKind,
    artifactDigest: value.artifactDigest,
    mappedHostUid: value.mappedHostUid,
    mappedHostGid: value.mappedHostGid,
    argv: value.argv,
    cwd: value.cwd,
    environment: value.environment ?? {},
    resources: {
      memoryBytes: value.resources?.memoryBytes ?? 512 * 1024 * 1024,
      pids: value.resources?.pids ?? 256,
      cpuQuotaMicros: value.resources?.cpuQuotaMicros ?? 100_000,
    },
  };
}
