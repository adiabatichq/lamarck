import { describe, expect, test } from "vitest";
import { MAX_CONTROL_FRAME_BYTES } from "../src/protocol/codec";
import {
  DEFAULT_BLOB_TRANSFER_POLICY,
  blobTransferAbsoluteDeadlineMs,
  normalizeBlobTransferPolicy,
} from "../src/protocol/blob-transfer";
import { GuestHandshake, HandshakeError } from "../src/protocol/handshake";
import { TicketError, TicketRegistry } from "../src/protocol/tickets";
import {
  parseControlResponse,
  parseDataStreamPrelude,
  parseHostInitialize,
  parseHostRequest,
  parseHostRequestForSession,
  ProtocolValidationError,
} from "../src/protocol/validate";
import { FakeClock } from "../src/testing/fakes";

const BOOT_ID = "B".repeat(22);
const APP_HANDLE = "A".repeat(22);
const WORKLOAD_HANDLE = "W".repeat(22);
const REQUEST_ID = "R".repeat(22);
const SESSION_ID = "S".repeat(43);
const OTHER_SESSION_ID = "O".repeat(43);
const SDK_TICKET = "T".repeat(43);
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const OWNER_KEY = "b".repeat(64);
const BLOB_HANDLE = "L".repeat(22);
const BUILD_HANDLE = "D".repeat(22);

describe("Capsule protocol validation", () => {
  test("bounds active blob transfers by progress and advertised size", () => {
    expect(blobTransferAbsoluteDeadlineMs(8 * 1024 * 1024)).toBe(68_000);
    expect(normalizeBlobTransferPolicy({ idleTimeoutMs: 5 })).toEqual({
      ...DEFAULT_BLOB_TRANSFER_POLICY,
      idleTimeoutMs: 5,
    });
    expect(() => blobTransferAbsoluteDeadlineMs(8 * 1024 * 1024 * 1024 + 1))
      .toThrow("blob bytes");
    expect(() => normalizeBlobTransferPolicy({ minimumBytesPerSecond: 0 }))
      .toThrow("minimumBytesPerSecond");
  });

  test("performs a strict image-bound handshake exactly once", () => {
    const handshake = new GuestHandshake({
      bootId: BOOT_ID,
      imageDigest: IMAGE_DIGEST,
      supervisorVersion: "0.1.0",
      architecture: "arm64",
      features: ["tickets", "oci-plan"],
    });
    expect(handshake.hello()).toEqual({
      type: "guest.hello",
      protocolVersion: 1,
      bootId: BOOT_ID,
      imageDigest: IMAGE_DIGEST,
      supervisorVersion: "0.1.0",
      architecture: "arm64",
      features: ["oci-plan", "tickets"],
    });
    expect(handshake.initialize(initialization())).toEqual({
      type: "guest.ready",
      protocolVersion: 1,
      bootId: BOOT_ID,
      sessionId: SESSION_ID,
    });
    expect(handshake.maxControlFrameBytes).toBe(MAX_CONTROL_FRAME_BYTES);
    expect(() => handshake.initialize(initialization())).toThrowError(
      expect.objectContaining<Partial<HandshakeError>>({ code: "HANDSHAKE_INVALID_STATE" }),
    );
  });

  test("rejects a mismatched verified image and unknown handshake fields", () => {
    const handshake = new GuestHandshake({
      bootId: BOOT_ID,
      imageDigest: IMAGE_DIGEST,
      supervisorVersion: "0.1.0",
      architecture: "x64",
    });
    expect(() => handshake.initialize({
      ...initialization(),
      expectedImageDigest: `sha256:${"b".repeat(64)}`,
    })).toThrowError(
      expect.objectContaining<Partial<HandshakeError>>({ code: "HANDSHAKE_IMAGE_MISMATCH" }),
    );
    expect(() => parseHostInitialize({ ...initialization(), callerAppId: "forged" })).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: "PROTOCOL_UNKNOWN_FIELD" }),
    );
  });

  test("strictly validates workload launch messages and reserved environment", () => {
    const request = parseHostRequest(workloadPrepareRequest());
    expect(request.op).toBe("workload.prepare");
    if (request.op === "workload.prepare") {
      expect(request.body).toMatchObject({
        appHandle: APP_HANDLE,
        workloadHandle: WORKLOAD_HANDLE,
        workloadKind: "ui",
        uiPort: 3_000,
      });
    }

    expect(() => parseHostRequest({
      ...workloadPrepareRequest(),
      body: { ...workloadPrepareRequest().body, callerAppId: "forged" },
    })).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: "PROTOCOL_UNKNOWN_FIELD" }),
    );
    expect(() => parseHostRequest({
      ...workloadPrepareRequest(),
      body: {
        ...workloadPrepareRequest().body,
        environment: { LAMARCK_GUARD_TOKEN: "secret" },
      },
    })).toThrowError(/reserved Host environment key/);
    const pollutedEnvironment = JSON.parse('{"__proto__":"polluted"}') as Record<string, unknown>;
    expect(() => parseHostRequest({
      ...workloadPrepareRequest(),
      body: {
        ...workloadPrepareRequest().body,
        environment: pollutedEnvironment,
      },
    })).toThrowError(/reserved object key/);
    expect(() => parseHostRequest({
      ...workloadPrepareRequest(),
      body: { ...workloadPrepareRequest().body, workloadKind: "service" },
    })).toThrowError(/only UI workloads may declare a port/);
    expect(() => parseHostRequestForSession(
      { ...workloadPrepareRequest(), sessionId: OTHER_SESSION_ID },
      SESSION_ID,
    )).toThrowError(/another Guest session/);
    expect(parseHostRequest({
      ...workloadPrepareRequest(),
      op: "workload.start",
      body: { appHandle: APP_HANDLE, workloadHandle: WORKLOAD_HANDLE },
    })).toMatchObject({
      op: "workload.start",
      body: { appHandle: APP_HANDLE, workloadHandle: WORKLOAD_HANDLE },
    });
    expect(() => parseHostRequest({
      ...workloadPrepareRequest(),
      op: "workload.stop",
      body: { workloadHandle: WORKLOAD_HANDLE, graceMs: 100 },
    })).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: "PROTOCOL_MISSING_FIELD" }),
    );
  });

  test("strictly validates stream preludes and responses", () => {
    expect(parseDataStreamPrelude({
      protocolVersion: 1,
      sessionId: SESSION_ID,
      ticket: SDK_TICKET,
      kind: "sdk",
    })).toMatchObject({ kind: "sdk", ticket: SDK_TICKET });
    expect(() => parseDataStreamPrelude({
      protocolVersion: 1,
      sessionId: SESSION_ID,
      ticket: SDK_TICKET,
      kind: "sdk",
      appId: "caller-selected",
    })).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: "PROTOCOL_UNKNOWN_FIELD" }),
    );

    expect(parseControlResponse({
      v: 1,
      sessionId: SESSION_ID,
      kind: "response",
      requestId: REQUEST_ID,
      ok: false,
      error: { code: "CAPSULE_STATE_CONFLICT", message: "invalid transition" },
    })).toMatchObject({ ok: false });
  });

  test("keeps import and export ownership schemas exact and distinct", () => {
    const base = {
      v: 1,
      sessionId: SESSION_ID,
      kind: "request",
      requestId: REQUEST_ID,
    };
    const imported = parseHostRequest({
      ...base,
      op: "blob.import.prepare",
      body: {
        ownerKey: OWNER_KEY,
        blobHandle: BLOB_HANDLE,
        blobKind: "package",
        format: "capsule-tree-v1",
        digest: IMAGE_DIGEST,
        bytes: 3,
        streamTicket: SDK_TICKET,
      },
    });
    expect(imported).toMatchObject({ op: "blob.import.prepare", body: { ownerKey: OWNER_KEY } });
    expect(() => parseHostRequest({
      ...base,
      op: "blob.import.prepare",
      body: { ...imported.body, buildHandle: BUILD_HANDLE },
    })).toThrowError(expect.objectContaining<Partial<ProtocolValidationError>>({
      code: "PROTOCOL_UNKNOWN_FIELD",
    }));

    const exported = parseHostRequest({
      ...base,
      op: "blob.export.prepare",
      body: {
        ownerKey: OWNER_KEY,
        buildHandle: BUILD_HANDLE,
        blobHandle: BLOB_HANDLE,
        digest: IMAGE_DIGEST,
        bytes: 3,
        streamTicket: SDK_TICKET,
      },
    });
    expect(exported).toMatchObject({
      op: "blob.export.prepare",
      body: { ownerKey: OWNER_KEY, buildHandle: BUILD_HANDLE },
    });
    if (exported.op !== "blob.export.prepare") throw new Error("unexpected parsed operation");
    const { buildHandle: _omitted, ...missingBuildHandle } = exported.body;
    expect(() => parseHostRequest({ ...base, op: "blob.export.prepare", body: missingBuildHandle }))
      .toThrowError(expect.objectContaining<Partial<ProtocolValidationError>>({
        code: "PROTOCOL_MISSING_FIELD",
      }));
  });

  test("validates cold and warm Build inputs as mutually exclusive exact tuples", () => {
    const base = {
      v: 1 as const,
      sessionId: SESSION_ID,
      kind: "request" as const,
      requestId: REQUEST_ID,
      op: "build.prepare" as const,
    };
    const body = {
      ownerKey: OWNER_KEY,
      appHandle: APP_HANDLE,
      buildHandle: BUILD_HANDLE,
      packageDigest: IMAGE_DIGEST,
      packageBytes: 3,
      packageBlobHandle: BLOB_HANDLE,
      installDigest: IMAGE_DIGEST,
      mappedHostUid: 131_072,
      mappedHostGid: 196_608,
      timeoutMs: 60_000,
      resources: {
        memoryBytes: 512 * 1024 * 1024,
        pids: 256,
        cpuQuotaMicros: 100_000,
      },
    };
    expect(parseHostRequest({
      ...base,
      body: {
        ...body,
        dependencyDigest: IMAGE_DIGEST,
        dependencyBytes: 3,
        dependencyBlobHandle: "C".repeat(22),
      },
    })).toMatchObject({ op: "build.prepare", body: { installDigest: IMAGE_DIGEST } });
    expect(parseHostRequest({
      ...base,
      body: {
        ...body,
        baseArtifactDigest: IMAGE_DIGEST,
        baseArtifactBytes: 4_096,
        baseArtifactBlobHandle: "E".repeat(22),
        baseDependencyDigest: `sha256:${"c".repeat(64)}`,
      },
    })).toMatchObject({
      op: "build.prepare",
      body: { baseArtifactDigest: IMAGE_DIGEST },
    });
    expect(() => parseHostRequest({
      ...base,
      body: { ...body, baseArtifactDigest: IMAGE_DIGEST },
    })).toThrowError(/appear together/);
    expect(() => parseHostRequest({
      ...base,
      body: {
        ...body,
        dependencyDigest: IMAGE_DIGEST,
        dependencyBytes: 3,
        dependencyBlobHandle: "C".repeat(22),
        baseArtifactDigest: IMAGE_DIGEST,
        baseArtifactBytes: 4_096,
        baseArtifactBlobHandle: "E".repeat(22),
        baseDependencyDigest: IMAGE_DIGEST,
      },
    })).toThrowError(/mutually exclusive/);
    expect(() => parseHostRequest({
      ...base,
      body: { ...body, installDigest: "not-a-digest" },
    })).toThrowError(/installDigest/);
  });
});

describe("single-use stream tickets", () => {
  test("binds a ticket to one session, kind, and subject", () => {
    const clock = new FakeClock(1_000);
    const tickets = new TicketRegistry(clock);
    const issued = tickets.issue({
      sessionId: SESSION_ID,
      kind: "sdk",
      appHandle: APP_HANDLE,
      subjectHandle: WORKLOAD_HANDLE,
      ttlMs: 10_000,
      ticket: SDK_TICKET,
    });
    expect(issued.expiresAt).toBe(11_000);

    expect(() => tickets.consume(SDK_TICKET, OTHER_SESSION_ID, "sdk")).toThrowError(
      expect.objectContaining<Partial<TicketError>>({ code: "TICKET_SESSION_MISMATCH" }),
    );
    expect(() => tickets.consume(SDK_TICKET, SESSION_ID, "viewer")).toThrowError(
      expect.objectContaining<Partial<TicketError>>({ code: "TICKET_KIND_MISMATCH" }),
    );
    expect(tickets.consume(SDK_TICKET, SESSION_ID, "sdk")).toMatchObject({
      subjectHandle: WORKLOAD_HANDLE,
      kind: "sdk",
    });
    expect(() => tickets.consume(SDK_TICKET, SESSION_ID, "sdk")).toThrowError(
      expect.objectContaining<Partial<TicketError>>({ code: "TICKET_UNKNOWN" }),
    );
  });

  test("expires and revokes outstanding tickets fail closed", () => {
    const clock = new FakeClock(0);
    const tickets = new TicketRegistry(clock);
    tickets.issue({
      sessionId: SESSION_ID,
      kind: "logs",
      appHandle: APP_HANDLE,
      subjectHandle: WORKLOAD_HANDLE,
      ttlMs: 5,
      ticket: SDK_TICKET,
    });
    clock.advance(5);
    expect(() => tickets.consume(SDK_TICKET, SESSION_ID, "logs")).toThrowError(
      expect.objectContaining<Partial<TicketError>>({ code: "TICKET_EXPIRED" }),
    );

    tickets.issue({
      sessionId: SESSION_ID,
      kind: "viewer",
      appHandle: APP_HANDLE,
      subjectHandle: APP_HANDLE,
      ttlMs: 10,
      ticket: SDK_TICKET,
    });
    expect(tickets.revokeSession(SESSION_ID)).toBe(1);
    expect(tickets.size).toBe(0);
  });

  test("strictly revokes one exact unconsumed ticket", () => {
    const tickets = new TicketRegistry(new FakeClock(0));
    tickets.issue({
      sessionId: SESSION_ID,
      kind: "viewer",
      appHandle: APP_HANDLE,
      subjectHandle: WORKLOAD_HANDLE,
      ttlMs: 1_000,
      ticket: SDK_TICKET,
    });
    expect(tickets.revoke(SDK_TICKET)).toBe(true);
    expect(tickets.revoke(SDK_TICKET)).toBe(false);
    expect(() => tickets.consume(SDK_TICKET, SESSION_ID, "viewer")).toThrowError(
      expect.objectContaining<Partial<TicketError>>({ code: "TICKET_UNKNOWN" }),
    );
    expect(() => tickets.revoke("short")).toThrow(/invalid stream ticket/);
  });
});

function initialization() {
  return {
    type: "host.initialize",
    protocolVersion: 1,
    sessionId: SESSION_ID,
    expectedImageDigest: IMAGE_DIGEST,
    maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
  };
}

function workloadPrepareRequest() {
  return {
    v: 1,
    sessionId: SESSION_ID,
    kind: "request",
    requestId: REQUEST_ID,
    op: "workload.prepare",
    body: {
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
      workloadKind: "ui",
      argv: ["npm", "run", "start"],
      cwd: "/app",
      environment: { NODE_ENV: "production" },
      sdkTicket: SDK_TICKET,
      uiPort: 3_000,
    },
  };
}
