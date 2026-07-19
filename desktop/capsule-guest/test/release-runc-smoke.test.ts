import { describe, expect, test } from "vitest";
import { assertOciSecurityInvariants } from "@lamarck/capsule";
import {
  createReleaseRuncSmokePlan,
  formatReleaseRuncSmokeError,
  generateReleaseRuncSmokeSessionId,
  RELEASE_RUNC_SMOKE_COW,
  RELEASE_RUNC_SMOKE_MARKER,
  RELEASE_RUNC_SMOKE_PACKAGE_SOURCE,
  RELEASE_RUNC_SMOKE_WORKLOAD_SOURCE,
} from "../src/release-runc-smoke";

describe("signed Guest release runc smoke", () => {
  test("reports every nested release-gate failure", () => {
    const failure = new AggregateError([
      new Error("primary runc failure", { cause: new Error("runc stderr") }),
      new Error("cleanup failure"),
    ], "release gate failed");
    const formatted = formatReleaseRuncSmokeError(failure);
    expect(formatted).toContain("release gate failed");
    expect(formatted).toContain("aggregate[0]");
    expect(formatted).toContain("primary runc failure");
    expect(formatted).toContain("cause:");
    expect(formatted).toContain("runc stderr");
    expect(formatted).toContain("aggregate[1]");
    expect(formatted).toContain("cleanup failure");
  });

  test("issues a protocol-valid 256-bit Guest session identity", () => {
    expect(generateReleaseRuncSmokeSessionId()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("compiles through the exact production OCI policy", () => {
    const appHandle = "AAAAAAAAAAAAAAAAAAAAAA";
    const workloadHandle = "BBBBBBBBBBBBBBBBBBBBBB";
    const artifactDigest = `sha256:${"d".repeat(64)}`;
    const { plan, expectedIdentity } = createReleaseRuncSmokePlan({
      appHandle,
      workloadHandle,
      artifactDigest,
    });

    expect(() => assertOciSecurityInvariants(plan, expectedIdentity)).not.toThrow();
    expect(plan.config.root).toEqual({
      path: "/opt/lamarck/rootfs/node24",
      readonly: true,
    });
    expect(plan.config.process.args).toEqual([
      "npm",
      "run",
      "start",
    ]);
    expect(plan.config.process.env).toContain(
      "LAMARCK_SDK_SOCKET=/run/lamarck/system.sock",
    );
    expect(plan.config.linux.cgroupsPath).toMatch(
      /^lamarck\/apps\/a-[a-f0-9]{32}\/workloads\/w-[a-f0-9]{32}$/,
    );
    expect(plan.config.linux.namespaces).toContainEqual({
      type: "network",
      path: expect.stringMatching(/^\/run\/lamarck\/netns\/a-[a-f0-9]{32}$/),
    });
  });

  test("npm descendant proves ABI, mapped user, writable overlay, and the SDK Unix socket", () => {
    expect(RELEASE_RUNC_SMOKE_PACKAGE_SOURCE).toContain('"start": "node release-runc-smoke.mjs"');
    expect(RELEASE_RUNC_SMOKE_WORKLOAD_SOURCE).toContain("process.version");
    expect(RELEASE_RUNC_SMOKE_WORKLOAD_SOURCE).toContain("glibcVersionRuntime");
    expect(RELEASE_RUNC_SMOKE_WORKLOAD_SOURCE).toContain("process.getuid?.() !== 1_000");
    expect(RELEASE_RUNC_SMOKE_WORKLOAD_SOURCE).toContain(`/app/${RELEASE_RUNC_SMOKE_COW}`);
    expect(RELEASE_RUNC_SMOKE_WORKLOAD_SOURCE).toContain("process.env.LAMARCK_SDK_SOCKET");
    expect(RELEASE_RUNC_SMOKE_WORKLOAD_SOURCE).toContain(
      `sdk.end(${JSON.stringify(`${RELEASE_RUNC_SMOKE_MARKER}\n`)}`,
    );
  });
});
