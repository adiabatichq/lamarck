import { Duplex, PassThrough, Readable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  abortableIterable,
  startBlobTransfer,
  transferBlobImport,
  writeIterable,
} from "./macos-backend";
import { CapsuleVmHostStream } from "../capsule-vm/launcher";
import { CapsuleGuestSession } from "./guest-session";
import { correlateBlobImportedEvent } from "./guest-results";
import { encodeJsonFrame } from "../../../capsule/src/protocol/codec";
import { CAPSULE_PROTOCOL_VERSION, type StreamKind } from "../../../capsule/src/protocol/types";

const FAST_POLICY = {
  idleTimeoutMs: 5,
  baseDeadlineMs: 100,
  minimumBytesPerSecond: 1024 * 1024,
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("Host import directional retirement with real session and streams", () => {
  test.each(["package-in", "dependency-in", "artifact-in"] as const)(
    "70 sequential %s imports return to baseline without RESET or the 64-stream failure",
    async (kind) => {
      const h = await importSession();
      try {
        for (let index = 0; index < 70; index++) {
          const item = await h.open(kind);
          expect(h.session.activeDataStreamCount).toBe(1);
          item.stream.once("finish", () => { item.stream.acceptFin(); item.confirm(); });
          await item.transfer();
          await nextTurn();
          expect(item.stream.readableEnded).toBe(true);
          expect(item.stream.writableFinished).toBe(true);
          expect(item.stream.destroyed).toBe(true);
          expect(h.session.activeDataStreamCount).toBe(0);
          expect(h.session.outstandingTicketCount).toBe(0);
        }
        expect(h.session.failure).toBeUndefined();
        expect(h.resets).not.toHaveBeenCalled();
      } finally { h.session.close(); }
    },
  );

  test.each(["guest-fin", "host-fin", "confirmation"])("waits for delayed %s", async (phase) => {
    const h = await importSession();
    let finish!: () => void;
    try {
      const item = await h.open("package-in", phase === "host-fin" ? (callback) => { finish = callback; } : undefined);
      let done = false;
      const importing = item.transfer().then(() => { done = true; });
      await nextTurn();
      if (phase !== "guest-fin") item.stream.acceptFin();
      if (phase !== "confirmation") item.confirm();
      await nextTurn();
      expect(done).toBe(false);
      if (phase === "guest-fin") item.stream.acceptFin();
      else if (phase === "host-fin") finish();
      else item.confirm();
      await importing;
      await nextTurn();
      expect(h.session.activeDataStreamCount).toBe(0);
      expect(h.resets).not.toHaveBeenCalled();
    } finally { h.session.close(); }
  });

  test.each(["cancel", "payload", "transport", "confirmation failure", "missing FIN", "missing Host FIN", "missing confirmation"])(
    "bounds and retires an import on %s",
    async (failure) => {
      const h = await importSession();
      try {
        const item = await h.open("package-in", failure === "missing Host FIN" ? () => {} : undefined);
        const controller = new AbortController();
        vi.useFakeTimers();
        const importing = item.transfer(controller.signal, FAST_POLICY);
        const rejected = expect(importing).rejects.toThrow(
          failure === "payload" ? "unexpected DATA payload"
            : failure.startsWith("missing") ? "idle deadline" : "injected failure",
        );
        await vi.advanceTimersByTimeAsync(0);
        const error = new Error("injected failure");
        if (failure === "cancel") controller.abort(error);
        else if (failure === "payload") item.stream.acceptData(Buffer.from("forbidden"));
        else if (failure === "transport") item.stream.failFromOwner(error);
        else if (failure === "confirmation failure") item.confirmation.reject(error);
        else if (failure === "missing FIN") item.confirm();
        else { item.stream.acceptFin(); if (failure === "missing Host FIN") item.confirm(); }
        await vi.advanceTimersByTimeAsync(6);
        await rejected;
        await vi.advanceTimersByTimeAsync(0);
        expect(item.stream.destroyed).toBe(true);
        expect(h.session.activeDataStreamCount).toBe(0);
        expect(h.session.outstandingTicketCount).toBe(0);
        expect(h.session.failure).toBeUndefined();
      } finally { h.session.close(); }
    },
  );
});

async function importSession() {
  const control = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const sessionId = "S".repeat(43), bootId = "B".repeat(22);
  const session = new CapsuleGuestSession(control, {
    expectedImageDigest: imageDigest, expectedArchitecture: "arm64", expectedSupervisorVersion: "0.1.0",
    expectedFeatures: ["control.v1", "data.v1"], sessionIdFactory: () => sessionId,
  });
  control.push(encodeJsonFrame({ type: "guest.hello", protocolVersion: CAPSULE_PROTOCOL_VERSION,
    bootId, imageDigest, supervisorVersion: "0.1.0", architecture: "arm64", features: ["control.v1", "data.v1"] }));
  await nextTurn();
  control.push(encodeJsonFrame({ type: "guest.ready", protocolVersion: CAPSULE_PROTOCOL_VERSION, bootId, sessionId }));
  await session.waitUntilReady();
  let sequence = 0, id = 0;
  const resets = vi.fn();
  return {
    session, resets,
    async open(kind: StreamKind = "package-in", holdFin?: (callback: () => void) => void) {
      const handle = String(++id).padStart(22, "A");
      const body = { blobHandle: handle, digest: imageDigest, bytes: 5 };
      const confirmation = Promise.withResolvers<void>();
      const receive = (event: Parameters<typeof correlateBlobImportedEvent>[0]) => {
        if (event.type !== "blob.imported" || (event.body as { blobHandle?: string }).blobHandle !== handle) return;
        try { correlateBlobImportedEvent(event, body); confirmation.resolve(); }
        catch (error) { confirmation.reject(error); }
      };
      session.on("event", receive);
      const ticket = session.issueTicket({ kind, appHandle: handle, subjectHandle: handle, ttlMs: 1000 });
      const stream = new CapsuleVmHostStream({
        writeStreamData: (_id: number, _bytes: Buffer, callback: () => void) => callback(),
        finishStream: (_id: number, callback: () => void) => holdFin ? holdFin(callback) : callback(),
        destroyStream: (_id: number, error: unknown, callback: () => void) => { resets(error); callback(); },
        returnReceiveCredit() {},
      } as never, { streamId: id, channel: "data", sourcePort: 1, destinationPort: 2 } as never, {});
      const opening = session.openDataStream(ticket.ticket, kind);
      session.acceptDataStream(stream);
      await opening;
      return {
        stream, confirmation,
        confirm: () => control.push(encodeJsonFrame({ v: CAPSULE_PROTOCOL_VERSION, sessionId, kind: "event",
          eventSeq: ++sequence, type: "blob.imported", body })),
        transfer: (signal = new AbortController().signal, policy?: Parameters<typeof transferBlobImport>[6]) =>
          transferBlobImport(stream, Readable.from([Buffer.from("input")]), 5, signal, confirmation.promise, () => {}, policy)
            .finally(() => session.off("event", receive)),
      };
    },
  };
}

describe("Host blob source cancellation", () => {
  test("aborts a never-yielding AsyncIterator and invokes return at the idle deadline", async () => {
    vi.useFakeTimers();
    const destination = new PassThrough();
    destination.on("error", () => {});
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => await new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: returned,
        };
      },
    };
    const transfer = startBlobTransfer(destination, 1, new AbortController().signal, FAST_POLICY);
    const writing = writeIterable(destination, source, transfer.signal, transfer.progress);
    const rejected = expect(writing).rejects.toThrow(
      "idle deadline (0/1 bytes observed; phase=data)",
    );

    await vi.advanceTimersByTimeAsync(6);
    await rejected;
    expect(returned).toHaveBeenCalledOnce();
  });

  test("destroys a stalled Readable when an inbound transfer deadline fires", async () => {
    vi.useFakeTimers();
    const transport = new PassThrough();
    transport.on("error", () => {});
    const source = new Readable({ read() {} });
    const transfer = startBlobTransfer(transport, 1, new AbortController().signal, FAST_POLICY);
    const consuming = (async () => {
      for await (const _chunk of abortableIterable(source, transfer.signal, transfer.progress)) {
        // A stalled source never reaches this branch.
      }
    })();
    const rejected = expect(consuming).rejects.toThrow(
      "idle deadline (0/1 bytes observed; phase=data)",
    );

    await vi.advanceTimersByTimeAsync(6);
    await rejected;
    expect(source.destroyed).toBe(true);
  });

  test("reports partial byte progress when the next DATA window stalls", async () => {
    vi.useFakeTimers();
    const transport = new PassThrough();
    transport.on("error", () => {});
    const transfer = startBlobTransfer(transport, 2, new AbortController().signal, FAST_POLICY);
    transfer.progress(1);

    await vi.advanceTimersByTimeAsync(6);
    expect(transfer.signal.aborted).toBe(true);
    expect(transfer.signal.reason).toMatchObject({
      message: "Host blob DATA stream made no byte progress before its idle deadline (1/2 bytes observed; phase=data)",
    });
  });
});
