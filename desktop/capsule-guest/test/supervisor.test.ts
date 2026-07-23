import type { Socket } from "node:net";
import { Duplex, Readable } from "node:stream";
import {
  type BlobTransferPolicy,
  CAPSULE_PROTOCOL_VERSION,
  createCapsuleBuildStoragePlan,
  createCapsuleRuntimeStoragePlan,
  JsonFrameDecoder,
  MAX_CONTROL_FRAME_BYTES,
  RuncContainmentError,
  encodeJsonFrame,
  type HostOperation,
  type HostRequest,
  type JsonValue,
  type RuncDriver,
  type RuncExecution,
  type RuncLaunchRequest,
  type WorkloadExit,
} from "@lamarck/capsule";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { GuestBlobStore } from "../src/blob-store";
import type { GuestBuildManager } from "../src/build-manager";
import { BuildContainmentError } from "../src/build-runner";
import type { GuestDataDialer } from "../src/data-dialer";
import type { GuestResourceManager } from "../src/resource-manager";
import {
  GuestResourceAdmission,
  type GuestResourceAdmissionLike,
} from "../src/resource-admission";
import type { GuestProtocolStream } from "../src/lvrm-duplex";
import { BoundedTtlTombstones, CapsuleGuestSupervisor } from "../src/supervisor";

const BOOT_ID = "B".repeat(22);
const SESSION_ID = "S".repeat(43);
const APP = "A".repeat(22);
const WORKLOAD = "W".repeat(22);
const BLOB = "L".repeat(22);
const IMAGE = `sha256:${"a".repeat(64)}`;
const DIGEST = `sha256:${"b".repeat(64)}`;
const SDK_TICKET = "K".repeat(43);
const LOGS_TICKET = "G".repeat(43);
const VIEWER_TICKET = "V".repeat(43);
const OWNER = "a".repeat(64);

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map(async (close) => close()));
});

describe("Capsule Guest supervisor data routing", () => {
  test("returns a cache hit without opening a DATA transport", async () => {
    const harness = await createHarness({ blobPresent: true });
    const response = await harness.request("blob.import.prepare", {
      blobHandle: BLOB,
      blobKind: "package",
      format: "capsule-tree-v1",
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    expect(response).toMatchObject({ ok: true, result: { alreadyPresent: true } });
    expect(harness.dialer.openCount).toBe(0);
  });

  test("prepares a miss immediately and completes only after exact import data", async () => {
    const harness = await createHarness({ blobPresent: false });
    const response = await harness.request("blob.import.prepare", {
      blobHandle: BLOB,
      blobKind: "package",
      format: "capsule-tree-v1",
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    expect(response).toMatchObject({
      ok: true,
      result: { alreadyPresent: false, ready: true },
    });
    expect(harness.received).toEqual([]);

    const data = await harness.dialer.nextHostSocket();
    data.end(Buffer.concat([
      encodeJsonFrame(dataPrelude(SDK_TICKET, "package-in")),
      Buffer.from("abc"),
    ]));
    const imported = await harness.inbox.next((value) => eventType(value) === "blob.imported");
    expect(imported).toMatchObject({
      body: { blobHandle: BLOB, digest: DIGEST, bytes: 3 },
    });
    expect(harness.received).toEqual([Buffer.from("abc")]);
  });

  test("does not report an import before the underlying dual-CLOSE commit", async () => {
    const protocolClose = controllablePromise();
    const harness = await createHarness({
      blobPresent: false,
      dataProtocolClosePromise: protocolClose.promise,
    });
    await harness.request("blob.import.prepare", {
      blobHandle: BLOB,
      blobKind: "package",
      format: "capsule-tree-v1",
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    data.end(Buffer.concat([
      encodeJsonFrame(dataPrelude(SDK_TICKET, "package-in")),
      Buffer.from("abc"),
    ]));

    await eventually(() => expect(harness.received).toEqual([Buffer.from("abc")]));
    expect(harness.inbox.count((value) => eventType(value) === "blob.imported")).toBe(0);
    protocolClose.resolve();

    await expect(
      harness.inbox.next((value) => eventType(value) === "blob.imported"),
    ).resolves.toMatchObject({
      body: { blobHandle: BLOB, digest: DIGEST, bytes: 3 },
    });
  });

  test("keeps the import deadline active while dual-CLOSE is pending", async () => {
    const protocolClose = controllablePromise();
    const harness = await createHarness({
      blobPresent: false,
      dataProtocolClosePromise: protocolClose.promise,
      blobTransferPolicy: {
        idleTimeoutMs: 15,
        baseDeadlineMs: 100,
        minimumBytesPerSecond: 1024 * 1024,
      },
    });
    await harness.request("blob.import.prepare", {
      blobHandle: BLOB,
      blobKind: "package",
      format: "capsule-tree-v1",
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    data.end(Buffer.concat([
      encodeJsonFrame(dataPrelude(SDK_TICKET, "package-in")),
      Buffer.from("abc"),
    ]));

    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain("idle deadline");
    expect(harness.inbox.count((value) => eventType(value) === "blob.imported")).toBe(0);
  });

  test("lets an attached import make byte progress beyond the ticket TTL", async () => {
    const harness = await createHarness({
      blobPresent: false,
      ticketTtlMs: 10,
      blobTransferPolicy: {
        idleTimeoutMs: 30,
        baseDeadlineMs: 100,
        minimumBytesPerSecond: 1024 * 1024,
      },
    });
    await harness.request("blob.import.prepare", {
      blobHandle: BLOB,
      blobKind: "package",
      format: "capsule-tree-v1",
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    data.write(Buffer.concat([
      encodeJsonFrame(dataPrelude(SDK_TICKET, "package-in")),
      Buffer.from("a"),
    ]));
    await delay(8);
    data.write("b");
    await delay(8);
    data.end("c");

    await harness.inbox.next((value) => eventType(value) === "blob.imported");
    await delay(15);
    expect(harness.inbox.count((value) => eventType(value) === "blob.failed")).toBe(0);
    expect(harness.received).toEqual([Buffer.from("abc")]);
  });

  test("fails an attached import once after byte progress goes idle", async () => {
    const harness = await createHarness({
      blobPresent: false,
      blobTransferPolicy: {
        idleTimeoutMs: 15,
        baseDeadlineMs: 100,
        minimumBytesPerSecond: 1024 * 1024,
      },
    });
    await harness.request("blob.import.prepare", {
      blobHandle: BLOB,
      blobKind: "package",
      format: "capsule-tree-v1",
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    data.write(Buffer.concat([
      encodeJsonFrame(dataPrelude(SDK_TICKET, "package-in")),
      Buffer.from("a"),
    ]));

    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain("idle deadline");
    await delay(20);
    expect(harness.inbox.count((value) => eventType(value) === "blob.failed")).toBe(1);
  });

  test("stops a byte trickle at the advertised-size absolute deadline", async () => {
    const harness = await createHarness({
      blobPresent: false,
      blobTransferPolicy: {
        idleTimeoutMs: 40,
        baseDeadlineMs: 25,
        minimumBytesPerSecond: 1_000,
      },
    });
    await harness.request("blob.import.prepare", {
      blobHandle: BLOB,
      blobKind: "package",
      format: "capsule-tree-v1",
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    data.write(Buffer.concat([
      encodeJsonFrame(dataPrelude(SDK_TICKET, "package-in")),
      Buffer.from("a"),
    ]));
    await delay(12);
    data.write("b");

    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain("absolute deadline");
    await delay(20);
    expect(harness.inbox.count((value) => eventType(value) === "blob.failed")).toBe(1);
  });

  test("awaits export completion and reports a source failure exactly once", async () => {
    const sourceError = new Error("artifact source failed");
    const harness = await createHarness({
      blobPresent: true,
      openBlob: async () => new Readable({
        read() {
          this.destroy(sourceError);
        },
      }),
    });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));

    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain(sourceError.message);
    await delay(20);
    expect(harness.inbox.count((value) => eventType(value) === "blob.failed")).toBe(1);
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
  });

  test("exports the exact artifact after its adoption receipt and explicit Host FIN", async () => {
    const harness = await createHarness({ blobPresent: true });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    const output = collectUntilReadableEnd(data);
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));

    expect(await output).toEqual(Buffer.from("abc"));
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
    expect(harness.blobs.releaseExpected).not.toHaveBeenCalledWith(expect.objectContaining({
      referenceId: `export:${BLOB}`,
    }));
    data.end(encodeJsonFrame(artifactAdoptionReceipt()));
    const exported = await harness.inbox.next((value) => eventType(value) === "blob.exported");
    expect(exported).toMatchObject({
      v: CAPSULE_PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      body: { blobHandle: BLOB, digest: DIGEST, bytes: 3 },
    });
    expect(data.writableEnded).toBe(true);
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(1);
    expect(harness.inbox.count((value) => eventType(value) === "blob.failed")).toBe(0);
  });

  test("does not release an export before the underlying dual-CLOSE commit", async () => {
    const protocolClose = controllablePromise();
    const harness = await createHarness({
      blobPresent: true,
      dataProtocolClosePromise: protocolClose.promise,
    });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    const output = collectUntilReadableEnd(data);
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));
    expect(await output).toEqual(Buffer.from("abc"));
    data.end(encodeJsonFrame(artifactAdoptionReceipt()));

    await delay(10);
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
    expect(harness.blobs.releaseExpected).not.toHaveBeenCalledWith(expect.objectContaining({
      referenceId: `export:${BLOB}`,
    }));
    protocolClose.resolve();

    await expect(
      harness.inbox.next((value) => eventType(value) === "blob.exported"),
    ).resolves.toMatchObject({
      body: { blobHandle: BLOB, digest: DIGEST, bytes: 3 },
    });
  });

  test("rejects a clean Host FIN without a durable artifact adoption receipt", async () => {
    const harness = await createHarness({ blobPresent: true });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    const output = collectUntilReadableEnd(data);
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));

    expect(await output).toEqual(Buffer.from("abc"));
    data.end();
    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain("without an artifact adoption receipt");
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
  });

  test.each([
    ["session", { sessionId: "O".repeat(43) }],
    ["ticket", { ticket: "J".repeat(43) }],
    ["digest", { digest: `sha256:${"c".repeat(64)}` }],
    ["byte count", { bytes: 4 }],
  ])("rejects an artifact adoption receipt bound to another %s", async (_field, overrides) => {
    const harness = await createHarness({ blobPresent: true });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    const output = collectUntilReadableEnd(data);
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));

    expect(await output).toEqual(Buffer.from("abc"));
    data.end(encodeJsonFrame(artifactAdoptionReceipt(overrides)));
    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain("does not match this one-use export");
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
  });

  test("fails and releases the exact export reference when receipt arrives without Host FIN", async () => {
    const harness = await createHarness({
      blobPresent: true,
      blobTransferPolicy: {
        idleTimeoutMs: 15,
        baseDeadlineMs: 100,
        minimumBytesPerSecond: 1024 * 1024,
      },
    });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    const output = collectUntilReadableEnd(data);
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));

    expect(await output).toEqual(Buffer.from("abc"));
    data.write(encodeJsonFrame(artifactAdoptionReceipt()));
    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain("idle deadline");
    expect(harness.blobs.releaseExpected).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: `export:${BLOB}`,
    }));
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
  });

  test("rejects an adoption receipt coalesced before verified Guest output and Guest FIN", async () => {
    const harness = await createHarness({ blobPresent: true });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    data.write(Buffer.concat([
      encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")),
      encodeJsonFrame(artifactAdoptionReceipt()),
    ]));

    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain(
      "adoption receipt arrived before verified Guest output and Guest FIN",
    );
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
  });

  test("rejects a Host FIN observed before verified Guest output and Guest FIN flush", async () => {
    const harness = await createHarness({ blobPresent: true });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    const output = collectUntilReadableEnd(data);
    data.end(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));

    expect(await output).toEqual(Buffer.from("abc"));
    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain("Host FIN arrived before verified Guest output");
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
  });

  test("does not report export completion before a slow DATA writer, receipt, and Host FIN", async () => {
    const harness = await createHarness({
      blobPresent: true,
      dataGuestWriteDelayMs: 12,
      openBlob: async () => Readable.from([
        Buffer.from("a"),
        Buffer.from("b"),
        Buffer.from("c"),
      ]),
    });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    const output = collectUntilReadableEnd(data);
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));

    await delay(8);
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
    expect(await output).toEqual(Buffer.from("abc"));
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
    data.end(encodeJsonFrame(artifactAdoptionReceipt()));
    await harness.inbox.next((value) => eventType(value) === "blob.exported");
  });

  test("rejects a short artifact without ambiguous adoption", async () => {
    const harness = await createHarness({
      blobPresent: true,
      openBlob: async () => Readable.from(Buffer.from("ab")),
    });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));

    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain("ended at 2 bytes; expected 3");
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
  });

  test("rejects a Host write failure without reporting export completion", async () => {
    const harness = await createHarness({
      blobPresent: true,
      dataGuestWriteDelayMs: 12,
      openBlob: async () => Readable.from([
        Buffer.from("a"),
        Buffer.from("b"),
        Buffer.from("c"),
      ]),
    });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));
    data.destroy();

    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain("peer is closed");
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
  });

  test("reports a failed exact-reference release instead of an ambiguous export success", async () => {
    const releaseError = new Error("exact export reference release failed");
    const harness = await createHarness({ blobPresent: true });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    harness.blobs.releaseExpected.mockRejectedValueOnce(releaseError);
    const data = await harness.dialer.nextHostSocket();
    const output = collectUntilReadableEnd(data);
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));
    expect(await output).toEqual(Buffer.from("abc"));
    data.end(encodeJsonFrame(artifactAdoptionReceipt()));

    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain(releaseError.message);
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
  });

  test("reports a missing exact export reference instead of an ambiguous export success", async () => {
    const harness = await createHarness({ blobPresent: true });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    harness.blobs.releaseExpected.mockResolvedValueOnce(false);
    const data = await harness.dialer.nextHostSocket();
    const output = collectUntilReadableEnd(data);
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));
    expect(await output).toEqual(Buffer.from("abc"));
    data.end(encodeJsonFrame(artifactAdoptionReceipt()));

    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain("exact artifact export reference is missing");
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
  });

  test("rejects a late CAS digest failure after bytes were written without reporting success", async () => {
    const digestError = new Error("CAS blob digest changed while streaming");
    const harness = await createHarness({
      blobPresent: true,
      openBlob: async () => Readable.from((async function* () {
        yield Buffer.from("abc");
        throw digestError;
      })()),
    });
    await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const data = await harness.dialer.nextHostSocket();
    data.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "artifact-out")));

    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain(digestError.message);
    expect(harness.inbox.count((value) => eventType(value) === "blob.exported")).toBe(0);
  });

  test("does not resurrect an import when DATA dialing resolves after ticket expiry", async () => {
    const harness = await createHarness({ blobPresent: false, ticketTtlMs: 10 });
    const dial = harness.dialer.holdNextOpen();
    const preparing = harness.request("blob.import.prepare", {
      blobHandle: BLOB,
      blobKind: "package",
      format: "capsule-tree-v1",
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });

    await harness.inbox.next((value) => eventType(value) === "blob.failed");
    dial.resolve();
    await expect(preparing).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("expired") },
    });
    await delay(15);
    expect(harness.inbox.count((value) => eventType(value) === "blob.failed")).toBe(1);
  });

  test("emits one export failure when delayed DATA dialing rejects after expiry", async () => {
    const harness = await createHarness({ blobPresent: true, ticketTtlMs: 10 });
    const dial = harness.dialer.holdNextOpen();
    const preparing = harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });

    const failed = await harness.inbox.next((value) => eventType(value) === "blob.failed");
    expect(failed.body.message).toContain("expired");
    dial.reject(new Error("late dial failure"));
    await expect(preparing).resolves.toMatchObject({
      ok: false,
      error: { message: "late dial failure" },
    });
    await delay(15);
    expect(harness.inbox.count((value) => eventType(value) === "blob.failed")).toBe(1);
  });

  test("binds one SDK stream, starts a UI, signals readiness and proxies a viewer", async () => {
    const harness = await createHarness({ blobPresent: true });
    expect(await harness.request("app.prepare", {
      appHandle: APP,
      artifactDigest: DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
    })).toMatchObject({ ok: true });

    const workload = {
      appHandle: APP,
      workloadHandle: WORKLOAD,
      workloadKind: "ui",
      argv: ["node", "server.js"],
      cwd: "/app",
      environment: {},
      sdkTicket: SDK_TICKET,
      uiPort: 3_000,
    };
    const prepared = harness.request("workload.prepare", workload);
    const sdk = await harness.dialer.nextHostSocket();
    sdk.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "sdk")));
    expect(await prepared).toMatchObject({ ok: true, result: { awaitingStreams: true } });
    await eventually(() => expect(harness.supervisor.snapshot().apps[APP]?.workloads[WORKLOAD]?.status).toBe("prepared"));
    expect(await harness.request("workload.prepare", workload)).toMatchObject({
      ok: true,
      result: { awaitingStreams: false, reused: true },
    });

    expect(await harness.request("workload.start", {
      appHandle: APP,
      workloadHandle: WORKLOAD,
    })).toMatchObject({ ok: true });
    const ready = await harness.inbox.next((value) => eventType(value) === "workload.ready");
    expect(ready).toMatchObject({ body: { appHandle: APP, workloadHandle: WORKLOAD, port: 3_000 } });
    expect(harness.runc.launches).toHaveLength(1);
    expect(harness.runc.launches[0]?.sdkChannel.source).toBeInstanceOf(Duplex);

    const attaching = harness.request("viewer.attach", {
      appHandle: APP,
      workloadHandle: WORKLOAD,
      viewerTicket: VIEWER_TICKET,
    });
    const viewer = await harness.dialer.nextHostSocket();
    viewer.write(encodeJsonFrame(dataPrelude(VIEWER_TICKET, "viewer")));
    expect(await attaching).toMatchObject({ ok: true, result: { ready: true } });
    const echoed = new Promise<Buffer>((resolve) => viewer.once("data", resolve));
    viewer.write("viewer bytes");
    expect((await echoed).toString("utf8")).toBe("viewer bytes");

    harness.runc.complete({ exitCode: 0, signal: null });
    const exited = await harness.inbox.next((value) => eventType(value) === "workload.exited");
    expect(exited).toMatchObject({ body: { appHandle: APP, workloadHandle: WORKLOAD, exitCode: 0 } });
  });

  test("keeps the idempotent prepare barrier closed until every declared stream attaches", async () => {
    const harness = await createHarness({ blobPresent: true });
    await harness.request("app.prepare", {
      appHandle: APP,
      artifactDigest: DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
    });
    const workload = {
      appHandle: APP,
      workloadHandle: WORKLOAD,
      workloadKind: "job" as const,
      argv: ["node", "job.js"],
      cwd: "/app",
      environment: {},
      sdkTicket: SDK_TICKET,
      logsTicket: LOGS_TICKET,
    };
    const initial = harness.request("workload.prepare", workload);
    const sdk = await harness.dialer.nextHostSocket();
    const logs = await harness.dialer.nextHostSocket();
    sdk.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "sdk")));
    expect(await initial).toMatchObject({ ok: true, result: { awaitingStreams: true } });
    expect(await harness.request("workload.prepare", workload)).toMatchObject({
      ok: true,
      result: { awaitingStreams: true, reused: true },
    });
    logs.write(encodeJsonFrame(dataPrelude(LOGS_TICKET, "logs")));
    await eventuallyAsync(async () => expect(await harness.request("workload.prepare", workload)).toMatchObject({
      ok: true,
      result: { awaitingStreams: false, reused: true },
    }));
  });

  test("fails closed on a one-use ticket replay and cleans the session", async () => {
    const harness = await createHarness({ blobPresent: false });
    await harness.request("blob.import.prepare", {
      blobHandle: BLOB,
      blobKind: "package",
      format: "capsule-tree-v1",
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    });
    const first = await harness.dialer.nextHostSocket();
    first.end(Buffer.concat([encodeJsonFrame(dataPrelude(SDK_TICKET, "package-in")), Buffer.from("abc")]));
    await harness.inbox.next((value) => eventType(value) === "blob.imported");

    const replayPair = await socketPair();
    harness.supervisor.attachData(replayPair.guest);
    replayPair.host.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "package-in")));
    await eventually(() => expect(harness.dialer.closed).toBe(true));
    expect(harness.resources.drain).toHaveBeenCalled();
    expect(harness.supervisor.snapshot().status).toBe("faulted");
  });

  test("retires stopped App state and permits its proven-free namespace range to be reused", async () => {
    const harness = await createHarness({ blobPresent: true });
    expect(await harness.request("app.prepare", {
      appHandle: APP,
      artifactDigest: DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
    })).toMatchObject({ ok: true });
    expect(await harness.request("app.stop", { appHandle: APP })).toMatchObject({
      ok: true,
      result: { stopped: true },
    });
    expect(harness.supervisor.snapshot().apps[APP]).toBeUndefined();
    expect(await harness.request("app.stop", { appHandle: APP })).toMatchObject({
      ok: true,
      result: { stopped: true, reused: true },
    });

    const replacement = "R".repeat(22);
    expect(await harness.request("app.prepare", {
      appHandle: replacement,
      artifactDigest: DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
    })).toMatchObject({ ok: true });
  });

  test("does not acknowledge App stop when its exact artifact reference is missing", async () => {
    const harness = await createHarness({ blobPresent: true });
    expect(await harness.request("app.prepare", {
      appHandle: APP,
      artifactDigest: DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
    })).toMatchObject({ ok: true });
    harness.blobs.releaseExpected.mockResolvedValueOnce(false);

    expect(await harness.request("app.stop", { appHandle: APP })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("exact App artifact reference is missing") },
    });
    const internals = harness.supervisor as unknown as {
      appBlobReferences: Map<string, unknown>;
      retiredApps: BoundedTtlTombstones;
    };
    expect(internals.appBlobReferences.has(APP)).toBe(true);
    expect(internals.retiredApps.has(APP)).toBe(false);
  });

  test("does not let vm.drain hide a missing exact App artifact reference", async () => {
    const harness = await createHarness({ blobPresent: true });
    expect(await harness.request("app.prepare", {
      appHandle: APP,
      artifactDigest: DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
    })).toMatchObject({ ok: true });
    harness.blobs.releaseExpected.mockResolvedValueOnce(false);

    expect(await harness.request("vm.drain", {})).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("Guest drain was not authoritative"),
      },
    });
    expect(harness.blobs.releaseAll).not.toHaveBeenCalled();
  });

  test("expires unconsumed tickets and their pending side-map records", async () => {
    const harness = await createHarness({ blobPresent: true, ticketTtlMs: 5 });
    expect(await harness.request("blob.export.prepare", {
      blobHandle: BLOB,
      digest: DIGEST,
      bytes: 3,
      streamTicket: SDK_TICKET,
    })).toMatchObject({ ok: true, result: { ready: true } });

    await eventually(() => expect(internalCounts(harness.supervisor)).toMatchObject({
      tickets: 0,
      ticketExpiryTimers: 0,
      pendingExports: 0,
    }));
  });

  test("faults the complete VM session after a fatal Build teardown failure", async () => {
    const harness = await createHarness({ blobPresent: true });
    harness.builds.start.mockRejectedValueOnce(new BuildContainmentError("cgroup remained populated"));
    const response = await harness.request("build.start", {
      appHandle: APP,
      buildHandle: "B".repeat(22),
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "CAPSULE_BUILD_CONTAINMENT_FAILED" },
    });
    await eventually(() => expect(harness.dialer.closed).toBe(true));
    expect(harness.resources.drain).toHaveBeenCalled();
    expect(harness.supervisor.snapshot().status).toBe("faulted");
  });

  test("releases exact package and dependency imports when Build prepare fails", async () => {
    const harness = await createHarness({ blobPresent: true });
    harness.builds.prepare.mockRejectedValueOnce(new Error("injected Build prepare failure"));
    const buildHandle = "B".repeat(22);
    const packageHandle = "P".repeat(22);
    const dependencyHandle = "D".repeat(22);

    expect(await harness.request("build.prepare", {
      ownerKey: OWNER,
      appHandle: APP,
      buildHandle,
      packageDigest: DIGEST,
      packageBytes: 3,
      packageBlobHandle: packageHandle,
      installDigest: DIGEST,
      dependencyDigest: DIGEST,
      dependencyBytes: 3,
      dependencyBlobHandle: dependencyHandle,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
      timeoutMs: 60_000,
      resources: { memoryBytes: 512 * 1024 * 1024, pids: 256, cpuQuotaMicros: 100_000 },
    })).toMatchObject({ ok: false, error: { message: "injected Build prepare failure" } });
    expect(harness.blobs.releaseExpected).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: `import:${packageHandle}`,
      kind: "package",
    }));
    expect(harness.blobs.releaseExpected).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: `import:${dependencyHandle}`,
      kind: "dependency",
    }));
    expect(harness.blobs.release).toHaveBeenCalledWith(`build:${buildHandle}:package`);
    expect(harness.blobs.release).toHaveBeenCalledWith(`build:${buildHandle}:dependency`);
  });

  test("attempts every Build reference cleanup before faulting on a partial prepare teardown", async () => {
    const harness = await createHarness({ blobPresent: true });
    harness.builds.prepare.mockRejectedValueOnce(new Error("injected Build prepare failure"));
    harness.blobs.release.mockImplementation(async (reference: string) => {
      if (reference.endsWith(":package")) throw new Error("injected package release failure");
      return true;
    });
    const buildHandle = "F".repeat(22);
    const packageHandle = "P".repeat(22);
    const dependencyHandle = "D".repeat(22);

    expect(await harness.request("build.prepare", {
      ownerKey: OWNER,
      appHandle: APP,
      buildHandle,
      packageDigest: DIGEST,
      packageBytes: 3,
      packageBlobHandle: packageHandle,
      installDigest: DIGEST,
      dependencyDigest: DIGEST,
      dependencyBytes: 3,
      dependencyBlobHandle: dependencyHandle,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
      timeoutMs: 60_000,
      resources: { memoryBytes: 512 * 1024 * 1024, pids: 256, cpuQuotaMicros: 100_000 },
    })).toMatchObject({
      ok: false,
      error: { code: "CAPSULE_GUEST_CONTAINMENT_FAILED" },
    });
    expect(harness.blobs.release).toHaveBeenCalledWith(`build:${buildHandle}:package`);
    expect(harness.blobs.release).toHaveBeenCalledWith(`build:${buildHandle}:dependency`);
    expect(harness.blobs.releaseExpected).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: `import:${packageHandle}`,
    }));
    expect(harness.blobs.releaseExpected).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: `import:${dependencyHandle}`,
    }));
  });

  test("adopts and idempotently releases the exact warm base artifact reference", async () => {
    const harness = await createHarness({ blobPresent: true });
    const buildHandle = "C".repeat(22);
    const packageHandle = "P".repeat(22);
    const baseHandle = "R".repeat(22);
    expect(await harness.request("build.prepare", {
      ownerKey: OWNER,
      appHandle: APP,
      buildHandle,
      packageDigest: DIGEST,
      packageBytes: 3,
      packageBlobHandle: packageHandle,
      installDigest: DIGEST,
      baseArtifactDigest: DIGEST,
      baseArtifactBytes: 3,
      baseArtifactBlobHandle: baseHandle,
      baseDependencyDigest: DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
      timeoutMs: 60_000,
      resources: { memoryBytes: 512 * 1024 * 1024, pids: 256, cpuQuotaMicros: 100_000 },
    })).toMatchObject({ ok: true, result: { prepared: true } });
    expect(harness.blobs.acquireReference).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: `build:${buildHandle}:base-artifact`,
      kind: "artifact",
      digest: DIGEST,
    }));
    expect(await harness.request("build.cancel", {
      appHandle: APP,
      buildHandle,
      graceMs: 0,
    })).toMatchObject({ ok: true, result: { cancelled: true } });
    expect(harness.blobs.releaseExpected).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: `build:${buildHandle}:base-artifact`,
      kind: "artifact",
    }));
    expect(await harness.request("build.cancel", {
      appHandle: APP,
      buildHandle,
      graceMs: 0,
    })).toMatchObject({ ok: true, result: { cancelled: true } });
    expect(harness.blobs.releaseExpected.mock.calls.filter(([value]) => (
      value.referenceId === `build:${buildHandle}:base-artifact`
    ))).toHaveLength(1);
  });

  test("coalesces distinct-request retries of one Build ownership transition", async () => {
    const harness = await createHarness({ blobPresent: true });
    const buildHandle = "K".repeat(22);
    const body = warmPrepareBody(buildHandle);
    const heldReferences = new Set<string>();
    harness.blobs.acquireReference.mockImplementation(async (rawValue: unknown) => {
      const value = rawValue as { referenceId: string };
      if (heldReferences.has(value.referenceId)) return false;
      heldReferences.add(value.referenceId);
      return true;
    });
    const liveImports = new Set([
      `import:${body.packageBlobHandle}`,
      `import:${body.baseArtifactBlobHandle}`,
    ]);
    harness.blobs.releaseExpected.mockImplementation(async (value: { referenceId: string }) => {
      if (!value.referenceId.startsWith("import:")) return true;
      if (!liveImports.delete(value.referenceId)) return false;
      return true;
    });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    harness.builds.prepare.mockImplementationOnce(async () => await blocked);

    const first = harness.request("build.prepare", body);
    await vi.waitFor(() => expect(harness.builds.prepare).toHaveBeenCalledOnce());
    const retry = harness.request("build.prepare", body);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.blobs.acquireReference).toHaveBeenCalledTimes(2);

    unblock();
    await expect(first).resolves.toMatchObject({ ok: true, result: { prepared: true } });
    await expect(retry).resolves.toMatchObject({ ok: true, result: { prepared: true } });
    expect(harness.builds.prepare).toHaveBeenCalledOnce();
    expect(harness.blobs.acquireReference).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.snapshot().status).not.toBe("faulted");
  });

  test("coalesces the ordinary failure of concurrent identical Build prepares", async () => {
    const harness = await createHarness({ blobPresent: true });
    const buildHandle = "L".repeat(22);
    const body = warmPrepareBody(buildHandle);
    const heldReferences = new Set<string>();
    harness.blobs.acquireReference.mockImplementation(async (rawValue: unknown) => {
      const value = rawValue as { referenceId: string };
      if (heldReferences.has(value.referenceId)) return false;
      heldReferences.add(value.referenceId);
      return true;
    });
    const liveImports = new Set([
      `import:${body.packageBlobHandle}`,
      `import:${body.baseArtifactBlobHandle}`,
    ]);
    harness.blobs.releaseExpected.mockImplementation(async (value: { referenceId: string }) => {
      if (!value.referenceId.startsWith("import:")) return true;
      if (!liveImports.delete(value.referenceId)) return false;
      return true;
    });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    harness.builds.prepare.mockImplementationOnce(async () => {
      await blocked;
      throw new Error("injected ordinary prepare failure");
    });

    const first = harness.request("build.prepare", body);
    await vi.waitFor(() => expect(harness.builds.prepare).toHaveBeenCalledOnce());
    const retry = harness.request("build.prepare", body);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.blobs.acquireReference).toHaveBeenCalledTimes(2);

    unblock();
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { message: "injected ordinary prepare failure" },
    });
    await expect(retry).resolves.toMatchObject({
      ok: false,
      error: { message: "injected ordinary prepare failure" },
    });
    expect(harness.builds.prepare).toHaveBeenCalledOnce();
    expect(harness.blobs.acquireReference).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.snapshot().status).not.toBe("faulted");
  });

  test("drain exactly retires a prepared warm Build before blanket CAS release", async () => {
    const harness = await createHarness({ blobPresent: true });
    const buildHandle = "G".repeat(22);
    expect(await harness.request("build.prepare", {
      ownerKey: OWNER,
      appHandle: APP,
      buildHandle,
      packageDigest: DIGEST,
      packageBytes: 3,
      packageBlobHandle: "P".repeat(22),
      installDigest: DIGEST,
      baseArtifactDigest: DIGEST,
      baseArtifactBytes: 3,
      baseArtifactBlobHandle: "R".repeat(22),
      baseDependencyDigest: DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
      timeoutMs: 60_000,
      resources: { memoryBytes: 512 * 1024 * 1024, pids: 256, cpuQuotaMicros: 100_000 },
    })).toMatchObject({ ok: true });

    expect(await harness.request("vm.drain", {})).toMatchObject({
      ok: true,
      result: { drained: true },
    });
    const exactRelease = harness.blobs.releaseExpected.mock.calls.find(([value]) => (
      value.referenceId === `build:${buildHandle}:base-artifact`
    ));
    expect(exactRelease).toBeDefined();
    expect(harness.blobs.releaseExpected.mock.invocationCallOrder.at(-1))
      .toBeLessThan(harness.blobs.releaseAll.mock.invocationCallOrder[0]!);
  });

  test("drain fences and joins the supervisor-side Build prepare ownership window", async () => {
    const harness = await createHarness({ blobPresent: true });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let firstAcquire = true;
    harness.blobs.acquireReference.mockImplementation(async (_value: unknown) => {
      if (firstAcquire) {
        firstAcquire = false;
        await blocked;
      }
      return true;
    });
    const preparing = harness.request("build.prepare", warmPrepareBody("H".repeat(22)));
    await vi.waitFor(() => expect(harness.blobs.acquireReference).toHaveBeenCalledOnce());

    const draining = harness.request("vm.drain", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.builds.drain).not.toHaveBeenCalled();
    expect(await harness.request("build.prepare", warmPrepareBody("I".repeat(22))))
      .toMatchObject({ ok: false, error: { message: expect.stringMatching(/draining/) } });

    unblock();
    await expect(preparing).resolves.toMatchObject({ ok: true });
    await expect(draining).resolves.toMatchObject({ ok: true, result: { drained: true } });
    expect(harness.blobs.releaseAll).toHaveBeenCalledOnce();
  });

  test("drain never acknowledges a fatal pre-publication Build prepare teardown", async () => {
    const harness = await createHarness({ blobPresent: true });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    harness.blobs.acquireReference.mockImplementationOnce(async (_value: unknown) => {
      await blocked;
      return true;
    });
    harness.builds.prepare.mockRejectedValueOnce(new Error("injected prepare failure"));
    harness.blobs.release.mockRejectedValueOnce(new Error("injected exact release failure"));
    const preparing = harness.request("build.prepare", warmPrepareBody("J".repeat(22)));
    await vi.waitFor(() => expect(harness.blobs.acquireReference).toHaveBeenCalledOnce());
    const draining = harness.request("vm.drain", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.builds.drain).not.toHaveBeenCalled();

    unblock();
    await expect(preparing).resolves.toMatchObject({
      ok: false,
      error: { code: "CAPSULE_GUEST_CONTAINMENT_FAILED" },
    });
    await expect(draining).resolves.toMatchObject({
      ok: false,
      error: { code: "CAPSULE_GUEST_CONTAINMENT_FAILED" },
    });
    expect(harness.blobs.releaseAll).not.toHaveBeenCalled();
  });

  test("releases the exact artifact import when App resource prepare fails", async () => {
    const harness = await createHarness({ blobPresent: true });
    harness.resources.prepareApp.mockRejectedValueOnce(new Error("injected App prepare failure"));

    expect(await harness.request("app.prepare", {
      appHandle: APP,
      artifactDigest: DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
    })).toMatchObject({ ok: false, error: { message: "injected App prepare failure" } });
    expect(harness.blobs.releaseExpected).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: `import:${BLOB}`,
      kind: "artifact",
    }));
    expect(harness.blobs.release).toHaveBeenCalledWith(`app:${APP}:artifact`);
  });

  test("never acknowledges vm.drain when the Build finalizer lost containment", async () => {
    const harness = await createHarness({ blobPresent: true });
    harness.builds.drain.mockRejectedValueOnce(
      new BuildContainmentError("active Build cleanup proof failed"),
    );
    const response = await harness.request("vm.drain", {});
    expect(response).toMatchObject({
      ok: false,
      error: { code: "CAPSULE_GUEST_CONTAINMENT_FAILED" },
    });
    await eventually(() => expect(harness.dialer.closed).toBe(true));
    expect(harness.resources.drain).toHaveBeenCalled();
    expect(harness.supervisor.snapshot().status).toBe("faulted");
  });

  test("enforces the VM-wide memory reserve before launching another workload", async () => {
    const memoryBytes = 512 * 1024 * 1024;
    const admission = new GuestResourceAdmission({
      diskBudgetBytes: 1,
      memoryBudgetBytes: memoryBytes,
    });
    const harness = await createHarness({ blobPresent: true, admission });
    await harness.request("app.prepare", {
      appHandle: APP,
      artifactDigest: DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
    });
    const firstPrepare = harness.request("workload.prepare", {
      appHandle: APP,
      workloadHandle: WORKLOAD,
      workloadKind: "service",
      argv: ["node", "service.js"],
      cwd: "/app",
      environment: {},
      sdkTicket: SDK_TICKET,
    });
    const firstSdk = await harness.dialer.nextHostSocket();
    firstSdk.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "sdk")));
    await firstPrepare;
    await eventually(() => expect(
      harness.supervisor.snapshot().apps[APP]?.workloads[WORKLOAD]?.status,
    ).toBe("prepared"));
    expect(await harness.request("workload.start", {
      appHandle: APP,
      workloadHandle: WORKLOAD,
    })).toMatchObject({ ok: true });

    const secondWorkload = "X".repeat(22);
    const secondTicket = "Y".repeat(43);
    const secondPrepare = harness.request("workload.prepare", {
      appHandle: APP,
      workloadHandle: secondWorkload,
      workloadKind: "job",
      argv: ["node", "job.js"],
      cwd: "/app",
      environment: {},
      sdkTicket: secondTicket,
    });
    const secondSdk = await harness.dialer.nextHostSocket();
    secondSdk.write(encodeJsonFrame(dataPrelude(secondTicket, "sdk")));
    await secondPrepare;
    await eventually(() => expect(
      harness.supervisor.snapshot().apps[APP]?.workloads[secondWorkload]?.status,
    ).toBe("prepared"));
    expect(await harness.request("workload.start", {
      appHandle: APP,
      workloadHandle: secondWorkload,
    })).toMatchObject({
      ok: false,
      error: { code: "CAPSULE_RESOURCE_EXHAUSTED" },
    });
    expect(harness.runc.launches).toHaveLength(1);
    expect(admission.snapshot().reservedMemoryBytes).toBe(memoryBytes);
  });

  test("retains a workload lease until fatal runc rollback receives aggregate cgroup proof", async () => {
    const memoryBytes = 512 * 1024 * 1024;
    const admission = new GuestResourceAdmission({
      diskBudgetBytes: 1,
      memoryBudgetBytes: memoryBytes,
    });
    let proveStopped!: () => void;
    const stopProof = new Promise<void>((resolve) => {
      proveStopped = resolve;
    });
    const harness = await createHarness({
      blobPresent: true,
      admission,
      stopApp: async () => await stopProof,
    });
    await harness.request("app.prepare", {
      appHandle: APP,
      artifactDigest: DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
    });
    const prepared = harness.request("workload.prepare", {
      appHandle: APP,
      workloadHandle: WORKLOAD,
      workloadKind: "job",
      argv: ["node", "job.js"],
      cwd: "/app",
      environment: {},
      sdkTicket: SDK_TICKET,
    });
    const sdk = await harness.dialer.nextHostSocket();
    sdk.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "sdk")));
    await prepared;
    await eventually(() => expect(
      harness.supervisor.snapshot().apps[APP]?.workloads[WORKLOAD]?.status,
    ).toBe("prepared"));
    harness.runc.startError = new RuncContainmentError("rollback could not prove empty cgroup");

    expect(await harness.request("workload.start", {
      appHandle: APP,
      workloadHandle: WORKLOAD,
    })).toMatchObject({
      ok: false,
      error: { code: "CAPSULE_RUNC_CONTAINMENT_FAILED" },
    });
    await eventually(() => expect(harness.resources.stopApp).toHaveBeenCalledOnce());
    expect(admission.snapshot().reservedMemoryBytes).toBe(memoryBytes);

    proveStopped();
    await eventually(() => expect(admission.snapshot().reservedMemoryBytes).toBe(0));
  });

  test("makes direct stop failure fatal and retains its lease until aggregate cgroup proof", async () => {
    const memoryBytes = 512 * 1024 * 1024;
    const admission = new GuestResourceAdmission({
      diskBudgetBytes: 1,
      memoryBudgetBytes: memoryBytes,
    });
    let proveStopped!: () => void;
    const stopProof = new Promise<void>((resolve) => {
      proveStopped = resolve;
    });
    const harness = await createHarness({
      blobPresent: true,
      admission,
      stopApp: async () => await stopProof,
    });
    await prepareAndStartWorkload(harness, { workloadKind: "job" });
    harness.runc.stopError = new Error("runc could not prove populated=0");

    expect(await harness.request("workload.stop", {
      appHandle: APP,
      workloadHandle: WORKLOAD,
      graceMs: 0,
    })).toMatchObject({
      ok: false,
      error: { code: "CAPSULE_GUEST_CONTAINMENT_FAILED" },
    });
    await eventually(() => expect(harness.resources.stopApp).toHaveBeenCalledOnce());
    expect(harness.dialer.closed).toBe(true);
    expect(harness.supervisor.snapshot().status).toBe("faulted");
    expect(admission.snapshot().reservedMemoryBytes).toBe(memoryBytes);

    proveStopped();
    await eventually(() => expect(admission.snapshot().reservedMemoryBytes).toBe(0));
  });

  test("makes readiness stop failure fatal and retains its lease until aggregate cgroup proof", async () => {
    const memoryBytes = 512 * 1024 * 1024;
    const admission = new GuestResourceAdmission({
      diskBudgetBytes: 1,
      memoryBudgetBytes: memoryBytes,
    });
    let rejectReadiness!: (error: Error) => void;
    const readiness = new Promise<void>((_resolve, reject) => {
      rejectReadiness = reject;
    });
    let proveStopped!: () => void;
    const stopProof = new Promise<void>((resolve) => {
      proveStopped = resolve;
    });
    const harness = await createHarness({
      blobPresent: true,
      admission,
      waitForViewerReady: async () => await readiness,
      stopApp: async () => await stopProof,
    });
    await prepareAndStartWorkload(harness, { workloadKind: "ui", uiPort: 3_000 });
    harness.runc.stopError = new Error("runc stop helper failed");
    rejectReadiness(new Error("viewer never became ready"));

    await eventually(() => expect(harness.resources.stopApp).toHaveBeenCalledOnce());
    expect(harness.dialer.closed).toBe(true);
    expect(harness.supervisor.snapshot().status).toBe("faulted");
    expect(admission.snapshot().reservedMemoryBytes).toBe(memoryBytes);

    proveStopped();
    await eventually(() => expect(admission.snapshot().reservedMemoryBytes).toBe(0));
  });
});

describe("bounded Guest authority tombstones", () => {
  test("caps high-volume replay history and expires the retained window", () => {
    let now = 1_000;
    const tombstones = new BoundedTtlTombstones(16, 100, () => now);
    for (let index = 0; index < 10_000; index += 1) tombstones.add(`ticket-${index}`);

    expect(tombstones.size).toBe(16);
    expect(tombstones.has("ticket-0")).toBe(false);
    expect(tombstones.has("ticket-9999")).toBe(true);

    now += 100;
    expect(tombstones.has("ticket-9999")).toBe(false);
    expect(tombstones.size).toBe(0);
  });
});

async function prepareAndStartWorkload(
  harness: Awaited<ReturnType<typeof createHarness>>,
  options: { workloadKind: "ui" | "service" | "job"; uiPort?: number },
): Promise<void> {
  await harness.request("app.prepare", {
    appHandle: APP,
    artifactDigest: DIGEST,
    mappedHostUid: 100_000,
    mappedHostGid: 200_000,
  });
  const body = {
    appHandle: APP,
    workloadHandle: WORKLOAD,
    workloadKind: options.workloadKind,
    argv: ["node", "workload.js"],
    cwd: "/app",
    environment: {},
    sdkTicket: SDK_TICKET,
    ...(options.uiPort === undefined ? {} : { uiPort: options.uiPort }),
  };
  const preparing = harness.request("workload.prepare", body);
  const sdk = await harness.dialer.nextHostSocket();
  sdk.write(encodeJsonFrame(dataPrelude(SDK_TICKET, "sdk")));
  await preparing;
  await eventually(() => expect(
    harness.supervisor.snapshot().apps[APP]?.workloads[WORKLOAD]?.status,
  ).toBe("prepared"));
  expect(await harness.request("workload.start", {
    appHandle: APP,
    workloadHandle: WORKLOAD,
  })).toMatchObject({ ok: true });
}

async function createHarness(options: {
  blobPresent: boolean;
  admission?: GuestResourceAdmissionLike;
  stopApp?: () => Promise<void>;
  waitForViewerReady?: () => Promise<void>;
  ticketTtlMs?: number;
  blobTransferPolicy?: Partial<BlobTransferPolicy>;
  openBlob?: () => Promise<Readable>;
  dataGuestWriteDelayMs?: number;
  dataProtocolClosePromise?: Promise<void>;
}) {
  const received: Buffer[] = [];
  const blobs = {
    has: vi.fn(async () => options.blobPresent),
    receive: vi.fn(async (_kind, _digest, _bytes, source: AsyncIterable<Uint8Array>) => {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      received.push(Buffer.concat(chunks));
      return { digest: DIGEST, bytes: 3, path: "/cas/blob", reused: false };
    }),
    open: vi.fn(options.openBlob ?? (async () => Readable.from(Buffer.from("abc")))),
    acquireReference: vi.fn(async (_value: unknown) => true),
    releaseExpected: vi.fn(async (_value: { referenceId: string }) => true),
    release: vi.fn(async (_reference: string) => true),
    releaseAll: vi.fn(async () => undefined),
  };
  const builds = {
    prepare: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    drain: vi.fn(async () => undefined),
  };
  const resources = {
    prepareApp: vi.fn(async () => ({})),
    stopApp: vi.fn(options.stopApp ?? (async () => undefined)),
    drain: vi.fn(async () => undefined),
    waitForViewerReady: vi.fn(options.waitForViewerReady ?? (async () => undefined)),
    proxyViewer: vi.fn(async (_app, _port, stream: Socket) => {
      stream.on("data", (chunk) => stream.write(chunk));
      stream.resume();
      return {};
    }),
  };
  const runc = new FakeRuncDriver();
  const dialer = new FakeDataDialer(
    options.dataGuestWriteDelayMs ?? 0,
    options.dataProtocolClosePromise,
  );
  const supervisor = new CapsuleGuestSupervisor({
    bootId: BOOT_ID,
    imageDigest: IMAGE,
    architecture: "arm64",
    supervisorVersion: "test",
    blobs: blobs as unknown as GuestBlobStore,
    builds: builds as unknown as GuestBuildManager,
    resources: resources as unknown as GuestResourceManager,
    ...(options.admission === undefined ? {} : { admission: options.admission }),
    ...(options.ticketTtlMs === undefined ? {} : { ticketTtlMs: options.ticketTtlMs }),
    ...(options.blobTransferPolicy === undefined
      ? {}
      : { blobTransferPolicy: options.blobTransferPolicy }),
    runc,
    dataDialer: dialer,
  });
  dialer.supervisor = supervisor;
  const controlPair = await socketPair();
  const inbox = new FrameInbox(controlPair.host);
  supervisor.attachControl(controlPair.guest);
  expect(await inbox.next((value) => isRecord(value) && value.type === "guest.hello")).toMatchObject({
    imageDigest: IMAGE,
  });
  controlPair.host.write(encodeJsonFrame({
    type: "host.initialize",
    protocolVersion: CAPSULE_PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    expectedImageDigest: IMAGE,
    maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
  }));
  expect(await inbox.next((value) => isRecord(value) && value.type === "guest.ready")).toMatchObject({
    sessionId: SESSION_ID,
  });
  let requestSequence = 0;
  const request = async (op: HostOperation, body: JsonValue) => {
    requestSequence += 1;
    const requestId = String(requestSequence).padStart(22, "R");
    const objectBody: Record<string, any> = isRecord(body)
      ? body as Record<string, any>
      : {};
    const runtimeStorage = op === "app.prepare"
      ? createCapsuleRuntimeStoragePlan(
          typeof objectBody.artifactBytes === "number" ? objectBody.artifactBytes : 3,
        )
      : undefined;
    const buildStorage = op === "build.prepare"
      ? objectBody.dependencyBytes !== undefined
        ? createCapsuleBuildStoragePlan({
            mode: "cold",
            packageBytes: objectBody.packageBytes as number,
            dependencyBytes: objectBody.dependencyBytes as number,
          })
        : createCapsuleBuildStoragePlan({
            mode: "warm",
            packageBytes: objectBody.packageBytes as number,
            baseArtifactBytes: objectBody.baseArtifactBytes as number,
          })
      : undefined;
    const authenticatedBody = op === "blob.import.prepare"
      ? { ownerKey: OWNER, ...objectBody }
      : op === "blob.export.prepare"
        ? { ownerKey: OWNER, buildHandle: "B".repeat(22), ...objectBody }
        : op === "app.prepare"
          ? {
              ownerKey: OWNER,
              artifactBytes: 3,
              artifactBlobHandle: BLOB,
              storagePlanVersion: runtimeStorage!.version,
              scratchBytes: runtimeStorage!.scratchBytes,
              ...objectBody,
            }
          : op === "build.prepare"
            ? {
                storagePlanVersion: buildStorage!.version,
                scratchBytes: buildStorage!.scratchBytes,
                artifactOutputBytes: buildStorage!.artifactOutputBytes,
                ...objectBody,
              }
            : body;
    const value = {
      v: CAPSULE_PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      kind: "request",
      requestId,
      op,
      body: authenticatedBody,
    } as HostRequest;
    controlPair.host.write(encodeJsonFrame(value));
    return await inbox.next((candidate) => isRecord(candidate) && candidate.requestId === requestId);
  };
  cleanup.push(async () => {
    dialer.close();
    controlPair.host.destroy();
    controlPair.guest.destroy();
    inbox.close();
  });
  return { supervisor, inbox, request, dialer, received, runc, resources, builds, blobs };
}

function warmPrepareBody(buildHandle: string) {
  return {
    ownerKey: OWNER,
    appHandle: APP,
    buildHandle,
    packageDigest: DIGEST,
    packageBytes: 3,
    packageBlobHandle: "P".repeat(22),
    installDigest: DIGEST,
    baseArtifactDigest: DIGEST,
    baseArtifactBytes: 3,
    baseArtifactBlobHandle: "R".repeat(22),
    baseDependencyDigest: DIGEST,
    mappedHostUid: 100_000,
    mappedHostGid: 200_000,
    timeoutMs: 60_000,
    resources: { memoryBytes: 512 * 1024 * 1024, pids: 256, cpuQuotaMicros: 100_000 },
  };
}

function internalCounts(supervisor: CapsuleGuestSupervisor): {
  tickets: number;
  ticketExpiryTimers: number;
  pendingExports: number;
} {
  const internals = supervisor as unknown as {
    tickets: { size: number };
    ticketExpiryTimers: Map<string, NodeJS.Timeout>;
    pendingExports: Map<string, unknown>;
  };
  return {
    tickets: internals.tickets.size,
    ticketExpiryTimers: internals.ticketExpiryTimers.size,
    pendingExports: internals.pendingExports.size,
  };
}

class FakeDataDialer implements GuestDataDialer {
  supervisor!: CapsuleGuestSupervisor;
  openCount = 0;
  closed = false;
  private sockets: Socket[] = [];
  private waiters: Array<(socket: Socket) => void> = [];
  private nextOpenGate: {
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
  } | undefined;

  constructor(
    private readonly guestWriteDelayMs: number,
    private readonly guestProtocolClosePromise?: Promise<void>,
  ) {}

  async open(): Promise<void> {
    if (this.closed) throw new Error("dialer closed");
    this.openCount += 1;
    const pair = await socketPair({
      guestWriteDelayMs: this.guestWriteDelayMs,
      guestProtocolClosePromise: this.guestProtocolClosePromise,
    });
    this.supervisor.attachData(pair.guest);
    const waiter = this.waiters.shift();
    if (waiter) waiter(pair.host);
    else this.sockets.push(pair.host);
    const gate = this.nextOpenGate;
    this.nextOpenGate = undefined;
    if (gate) await gate.promise;
  }

  holdNextOpen(): { resolve(): void; reject(error: Error): void } {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.nextOpenGate = { promise, resolve, reject };
    return { resolve, reject };
  }

  async nextHostSocket(): Promise<Socket> {
    const socket = this.sockets.shift();
    if (socket) return socket;
    return await new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets = [];
  }
}

class FakeRuncDriver implements RuncDriver {
  readonly available = true;
  readonly launches: RuncLaunchRequest[] = [];
  startError: Error | undefined;
  stopError: Error | undefined;
  private resolveExit!: (exit: WorkloadExit) => void;
  private readonly exit = new Promise<WorkloadExit>((resolve) => {
    this.resolveExit = resolve;
  });

  async start(request: RuncLaunchRequest): Promise<RuncExecution> {
    this.launches.push(request);
    if (this.startError) throw this.startError;
    return { containerId: request.plan.containerId, wait: async () => await this.exit };
  }

  async stop(): Promise<void> {
    if (this.stopError) throw this.stopError;
    this.complete({ exitCode: null, signal: "SIGTERM" });
  }

  async delete(): Promise<void> {}

  complete(exit: WorkloadExit): void {
    this.resolveExit(exit);
  }
}

class FrameInbox {
  private readonly decoder = new JsonFrameDecoder();
  private readonly values: unknown[] = [];
  private readonly seen: unknown[] = [];
  private readonly waiters: Array<{
    predicate(value: unknown): boolean;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      for (const value of this.decoder.push(chunk)) this.push(value);
    });
  }

  async next(predicate: (value: unknown) => boolean): Promise<any> {
    const index = this.values.findIndex(predicate);
    if (index >= 0) return this.values.splice(index, 1)[0];
    return await new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(new Error("timed out waiting for framed control value"));
        }, 3_000),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("frame inbox closed"));
    }
    this.waiters.length = 0;
  }

  count(predicate: (value: unknown) => boolean): number {
    return this.seen.filter(predicate).length;
  }

  private push(value: unknown): void {
    this.seen.push(value);
    const index = this.waiters.findIndex((waiter) => waiter.predicate(value));
    if (index < 0) {
      this.values.push(value);
      return;
    }
    const [waiter] = this.waiters.splice(index, 1);
    clearTimeout(waiter!.timer);
    waiter!.resolve(value);
  }
}

async function socketPair(options: {
  guestWriteDelayMs?: number;
  hostWriteDelayMs?: number;
  guestProtocolClosePromise?: Promise<void>;
} = {}): Promise<{ guest: Socket & GuestProtocolStream; host: Socket }> {
  const guestMemory = new MemorySocket(
    options.guestWriteDelayMs ?? 0,
    options.guestProtocolClosePromise,
  );
  const hostMemory = new MemorySocket(options.hostWriteDelayMs ?? 0);
  guestMemory.peer = hostMemory;
  hostMemory.peer = guestMemory;
  guestMemory.on("error", () => undefined);
  hostMemory.on("error", () => undefined);
  const guest = guestMemory as unknown as Socket & GuestProtocolStream;
  const host = hostMemory as unknown as Socket;
  cleanup.push(() => {
    host.destroy();
    guest.destroy();
  });
  return { guest, host };
}

class MemorySocket extends Duplex {
  peer?: MemorySocket;
  private idleTimeoutMs = 0;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly writeDelayMs = 0,
    private readonly protocolClosePromise = Promise.resolve(),
  ) {
    super({ allowHalfOpen: true, autoDestroy: false });
  }

  setNoDelay(): this {
    return this;
  }

  setTimeout(timeout: number, callback?: () => void): this {
    this.idleTimeoutMs = timeout;
    if (callback) this.once("timeout", callback);
    this.refreshIdleTimer();
    return this;
  }

  async waitForProtocolClose(): Promise<void> {
    if (this.destroyed) {
      throw new Error("memory protocol stream closed before its close commit");
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.off("error", onError);
        this.off("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onClose = () => finish(new Error(
        "memory protocol stream closed before its close commit",
      ));
      this.once("error", onError);
      this.once("close", onClose);
      void this.protocolClosePromise.then(
        () => finish(),
        (error: unknown) => finish(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    });
  }

  override _read(): void {}

  override _write(
    chunk: Buffer | Uint8Array | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.peer || this.peer.destroyed) {
      callback(new Error("memory socket peer is closed"));
      return;
    }
    const deliver = () => {
      if (!this.peer || this.peer.destroyed) {
        callback(new Error("memory socket peer is closed"));
        return;
      }
      this.refreshIdleTimer();
      this.peer.refreshIdleTimer();
      this.peer.push(Buffer.from(chunk as Uint8Array));
      callback();
    };
    if (this.writeDelayMs > 0) setTimeout(deliver, this.writeDelayMs);
    else deliver();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.peer?.push(null);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.peer?.push(null);
    callback(error);
  }

  private refreshIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.idleTimeoutMs <= 0 || this.destroyed) return;
    this.idleTimer = setTimeout(() => this.emit("timeout"), this.idleTimeoutMs);
  }
}

async function collectUntilReadableEnd(socket: Socket): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => chunks.push(Buffer.from(chunk));
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => {
      if (!socket.readableEnded) finish(new Error("DATA socket closed before a clean Guest FIN"));
    };
    const finish = (error?: Error) => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

function dataPrelude(ticket: string, kind: string) {
  return { protocolVersion: CAPSULE_PROTOCOL_VERSION, sessionId: SESSION_ID, ticket, kind };
}

function artifactAdoptionReceipt(
  overrides: Partial<{
    type: "artifact.adopted";
    protocolVersion: typeof CAPSULE_PROTOCOL_VERSION;
    sessionId: string;
    ticket: string;
    digest: string;
    bytes: number;
  }> = {},
) {
  return {
    type: "artifact.adopted" as const,
    protocolVersion: CAPSULE_PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    ticket: SDK_TICKET,
    digest: DIGEST,
    bytes: 3,
    ...overrides,
  };
}

function eventType(value: unknown): unknown {
  return isRecord(value) ? value.type : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function eventuallyAsync(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function controllablePromise(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
