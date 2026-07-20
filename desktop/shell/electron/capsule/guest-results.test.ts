import { describe, expect, test } from "vitest";
import type { GuestEvent, GuestEventType, JsonValue } from "../../../capsule/src/protocol/types";
import {
  CapsuleGuestResultError,
  correlateBlobExportedEvent,
  correlateBlobFailedEvent,
  correlateBlobImportedEvent,
  correlateBuildCompletedEvent,
  correlateBuildFailedEvent,
  correlateBuildProgressEvent,
  correlateWorkloadExitedEvent,
  correlateWorkloadFaultedEvent,
  correlateWorkloadReadyEvent,
  correlateWorkloadStartedEvent,
  parseAppPrepareResult,
  parseAppStopResult,
  parseBlobExportPrepareResult,
  parseBlobImportPrepareResult,
  parseBuildCancelResult,
  parseBuildDescriptor,
  parseBuildPrepareResult,
  parsePingResult,
  parseViewerAttachResult,
  parseViewerDetachResult,
  parseVmDrainResult,
  parseWorkloadPrepareResult,
  parseWorkloadStartResult,
  parseWorkloadStopResult,
  type BuildDescriptorExpectation,
  type SealedGuestArtifactDescriptor,
} from "./guest-results";

const SESSION = "S".repeat(43);
const APP = "A".repeat(22);
const OTHER_APP = "B".repeat(22);
const WORKLOAD = "W".repeat(22);
const BUILD = "U".repeat(22);
const BLOB = "L".repeat(22);
const ARTIFACT = `sha256:${"a".repeat(64)}`;
const IMAGE = `sha256:${"b".repeat(64)}`;
const SOURCE = `sha256:${"c".repeat(64)}`;
const DEPENDENCY = `sha256:${"d".repeat(64)}`;

describe("strict Guest operation results", () => {
  test("accepts only the two exact blob import prepare variants", () => {
    expect(parseBlobImportPrepareResult({ alreadyPresent: true })).toEqual({ alreadyPresent: true });
    expect(parseBlobImportPrepareResult({ alreadyPresent: false, ready: true })).toEqual({
      alreadyPresent: false,
      ready: true,
    });
    expect(() => parseBlobImportPrepareResult({ alreadyPresent: true, ready: true })).toThrow(
      CapsuleGuestResultError,
    );
    expect(() => parseBlobImportPrepareResult({ alreadyPresent: false, ready: false })).toThrow(
      CapsuleGuestResultError,
    );
  });

  test("validates all lifecycle acknowledgements with no ambient fields", () => {
    expect(parseBlobExportPrepareResult({ ready: true })).toEqual({ ready: true });
    expect(parseBuildPrepareResult({ prepared: true })).toEqual({ prepared: true });
    expect(parseBuildCancelResult({ cancelled: true })).toEqual({ cancelled: true });
    expect(parseAppPrepareResult({ prepared: true })).toEqual({ prepared: true });
    expect(parseAppPrepareResult({ prepared: true, reused: true })).toEqual({ prepared: true, reused: true });
    expect(parseAppStopResult({ stopped: true })).toEqual({ stopped: true });
    expect(parseWorkloadPrepareResult({ awaitingStreams: true })).toEqual({ awaitingStreams: true });
    expect(parseWorkloadPrepareResult({ awaitingStreams: false, reused: true })).toEqual({
      awaitingStreams: false,
      reused: true,
    });
    expect(parseWorkloadStartResult({ started: true })).toEqual({ started: true });
    expect(parseWorkloadStopResult({ stopped: true })).toEqual({ stopped: true });
    expect(parseViewerAttachResult({ ready: true })).toEqual({ ready: true });
    expect(parseViewerDetachResult({ detached: true })).toEqual({ detached: true });
    expect(parseVmDrainResult({ drained: true })).toEqual({ drained: true });

    expect(() => parseWorkloadPrepareResult({ awaitingStreams: false })).toThrow(CapsuleGuestResultError);
    expect(() => parseWorkloadStartResult({ started: true, pid: 123 })).toThrow(CapsuleGuestResultError);
    expect(() => parseAppStopResult({ stopped: true, reused: false })).toThrow(CapsuleGuestResultError);
  });

  test("correlates ping nonce exactly", () => {
    expect(parsePingResult({ nonce: 42 }, 42)).toEqual({ nonce: 42 });
    expect(() => parsePingResult({ nonce: 41 }, 42)).toThrow(CapsuleGuestResultError);
    expect(() => parsePingResult({ nonce: 42, bootId: "guest" }, 42)).toThrow(CapsuleGuestResultError);
  });
});

describe("sealed build descriptor provenance", () => {
  test("accepts an exact descriptor matching image, source, dependencies, and native ABI", () => {
    expect(parseBuildDescriptor(descriptor(), expectation())).toEqual(descriptor());
    expect(correlateBuildCompletedEvent(
      event("build.completed", descriptor()),
      expectation(),
    )).toEqual(descriptor());
  });

  test("rejects unknown fields, malformed values, missing dependency provenance, and mismatches", () => {
    expect(() => parseBuildDescriptor(
      { ...descriptor(), executable: "/app/server.js" },
      expectation(),
    )).toThrow(CapsuleGuestResultError);
    expect(() => parseBuildDescriptor(
      { ...descriptor(), digest: `sha256:${"A".repeat(64)}` },
      expectation(),
    )).toThrow(CapsuleGuestResultError);
    const withoutDependency = { ...descriptor() } as Record<string, JsonValue>;
    delete withoutDependency.dependencyDigest;
    expect(() => parseBuildDescriptor(withoutDependency, expectation())).toThrow(CapsuleGuestResultError);

    const mismatchedExpectations: BuildDescriptorExpectation[] = [
      { ...expectation(), imageDigest: ARTIFACT },
      { ...expectation(), architecture: "x64" },
      { ...expectation(), runtimeAbi: "capsule-node-v1", nodeVersion: "24.11.0" },
      { ...expectation(), nodeModulesAbi: "138" },
      { ...expectation(), libc: "glibc-2.42" },
      { ...expectation(), sourceDigest: ARTIFACT },
      { ...expectation(), dependencyDigest: ARTIFACT },
    ];
    for (const expected of mismatchedExpectations) {
      expect(() => parseBuildDescriptor(descriptor(), expected)).toThrow(CapsuleGuestResultError);
    }
  });

  test("requires absence of dependency provenance for dependency-free builds", () => {
    const value = { ...descriptor() } as Record<string, JsonValue>;
    delete value.dependencyDigest;
    const expected = { ...expectation() };
    delete expected.dependencyDigest;
    expect(parseBuildDescriptor(value, expected).dependencyDigest).toBeUndefined();
    expect(() => parseBuildDescriptor(descriptor(), expected)).toThrow(CapsuleGuestResultError);
  });
});

describe("strict Guest event correlation", () => {
  test("correlates imported, exported, and failed blobs by handle, digest, and byte count", () => {
    const expected = { blobHandle: BLOB, digest: ARTIFACT, bytes: 4096 };
    expect(correlateBlobImportedEvent(event("blob.imported", expected), expected)).toEqual(expected);
    expect(correlateBlobExportedEvent(event("blob.exported", expected), expected)).toEqual(expected);
    expect(correlateBlobFailedEvent(
      event("blob.failed", { ...expected, message: "digest mismatch" }),
      expected,
    )).toEqual({ ...expected, message: "digest mismatch" });

    expect(() => correlateBlobImportedEvent(
      event("blob.imported", { ...expected, bytes: 4097 }),
      expected,
    )).toThrow(CapsuleGuestResultError);
    expect(() => correlateBlobImportedEvent(
      event("blob.imported", { ...expected, path: "/var/lib/guest" }),
      expected,
    )).toThrow(CapsuleGuestResultError);
    expect(() => correlateBlobImportedEvent(event("blob.exported", expected), expected)).toThrow(
      CapsuleGuestResultError,
    );
  });

  test("correlates build progress and failure by both App and build handles", () => {
    const expected = { appHandle: APP, buildHandle: BUILD };
    expect(correlateBuildProgressEvent(
      event("build.progress", { ...expected, phase: "materializing" }),
      expected,
    )).toEqual({ ...expected, phase: "materializing" });
    expect(correlateBuildFailedEvent(
      event("build.failed", { ...expected, message: "npm failed" }),
      expected,
    )).toEqual({ ...expected, message: "npm failed" });
    expect(() => correlateBuildFailedEvent(
      event("build.failed", { ...expected, appHandle: OTHER_APP, message: "wrong App" }),
      expected,
    )).toThrow(CapsuleGuestResultError);
  });

  test("correlates workload started, ready, faulted, and exited events", () => {
    const expected = { appHandle: APP, workloadHandle: WORKLOAD };
    expect(correlateWorkloadStartedEvent(event("workload.started", expected), expected)).toEqual(expected);
    expect(correlateWorkloadReadyEvent(
      event("workload.ready", { ...expected, port: 3000 }),
      { ...expected, port: 3000 },
    )).toEqual({ ...expected, port: 3000 });
    expect(correlateWorkloadFaultedEvent(
      event("workload.faulted", { ...expected, message: "port never opened" }),
      expected,
    )).toEqual({ ...expected, message: "port never opened" });
    expect(correlateWorkloadExitedEvent(
      event("workload.exited", { ...expected, exitCode: 0, signal: null }),
      expected,
    )).toEqual({ ...expected, exitCode: 0, signal: null });
    expect(correlateWorkloadExitedEvent(
      event("workload.exited", { ...expected, exitCode: null, signal: "SIGTERM" }),
      expected,
    )).toEqual({ ...expected, exitCode: null, signal: "SIGTERM" });

    expect(() => correlateWorkloadReadyEvent(
      event("workload.ready", { ...expected, port: 3001 }),
      { ...expected, port: 3000 },
    )).toThrow(CapsuleGuestResultError);
    expect(() => correlateWorkloadFaultedEvent(
      event("workload.faulted", { ...expected, appHandle: OTHER_APP, message: "wrong App" }),
      expected,
    )).toThrow(CapsuleGuestResultError);
    expect(() => correlateWorkloadExitedEvent(
      event("workload.exited", { ...expected, exitCode: null, signal: null }),
      expected,
    )).toThrow(CapsuleGuestResultError);
  });
});

function descriptor(): SealedGuestArtifactDescriptor {
  return {
    format: "erofs-v1",
    digest: ARTIFACT,
    bytes: 8192,
    imageDigest: IMAGE,
    runtimeAbi: "capsule-node-v1",
    architecture: "arm64",
    libc: "glibc-2.43",
    nodeVersion: "24.10.0",
    nodeModulesAbi: "137",
    sourceDigest: SOURCE,
    installDigest: `sha256:${"d".repeat(64)}`,
    dependencyDigest: DEPENDENCY,
    fileCount: 17,
  };
}

function expectation(): BuildDescriptorExpectation {
  return {
    imageDigest: IMAGE,
    runtimeAbi: "capsule-node-v1",
    architecture: "arm64",
    libc: "glibc-2.43",
    nodeVersion: "24.10.0",
    nodeModulesAbi: "137",
    sourceDigest: SOURCE,
    installDigest: `sha256:${"d".repeat(64)}`,
    dependencyDigest: DEPENDENCY,
  };
}

function event(type: GuestEventType, body: unknown): GuestEvent {
  return {
    v: 1,
    sessionId: SESSION,
    kind: "event",
    eventSeq: 1,
    type,
    body: body as JsonValue,
  };
}
