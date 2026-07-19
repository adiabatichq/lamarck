import { describe, expect, test } from "vitest";
import {
  assertBuildOciSecurityInvariants,
  createBuildOciBundlePlan,
  type BuildOciPlanInput,
} from "../src/oci/build-plan";

const input: BuildOciPlanInput = {
  appHandle: "A".repeat(22),
  buildHandle: "B".repeat(22),
  packageDigest: `sha256:${"a".repeat(64)}`,
  mappedHostUid: 100_000,
  mappedHostGid: 200_000,
  resources: {
    memoryBytes: 512 * 1024 * 1024,
    pids: 256,
    cpuQuotaMicros: 100_000,
  },
};

describe("Build Capsule native toolchain environment", () => {
  test("binds npm lifecycle scripts to the sealed arm64 compiler and Node headers", () => {
    const plan = createBuildOciBundlePlan(input);
    expect(plan.config.root).toEqual({
      path: "/opt/lamarck/rootfs/build-node24",
      readonly: true,
    });
    expect(plan.config.process.env).toEqual(expect.arrayContaining([
      "AR=/usr/bin/ar",
      "CC=/usr/bin/cc",
      "CXX=/usr/bin/c++",
      "LD_LIBRARY_PATH=/opt/lamarck/toolchain/lib",
      "PYTHON=/usr/bin/python3",
      "npm_config_nodedir=/usr/local",
      "npm_config_python=/usr/bin/python3",
    ]));
    expect(plan.config.process.env.some((entry) => entry.includes("/work/output"))).toBe(false);
    expect(plan.config.linux.seccomp.syscalls[0]!.names).toEqual(expect.arrayContaining([
      "io_uring_enter",
      "io_uring_register",
      "io_uring_setup",
    ]));

    const weakened = structuredClone(plan);
    weakened.config.linux.seccomp.syscalls[0]!.names =
      weakened.config.linux.seccomp.syscalls[0]!.names.filter(
        (name) => name !== "io_uring_setup",
      );
    expect(() => assertBuildOciSecurityInvariants(weakened, input)).toThrowError(
      /closed Build Capsule policy/,
    );
  });
});
