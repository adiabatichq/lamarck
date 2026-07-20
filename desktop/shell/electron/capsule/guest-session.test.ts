import { Duplex } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  JsonFrameDecoder,
  MAX_CONTROL_FRAME_BYTES,
  MAX_DATA_PRELUDE_BYTES,
  encodeJsonFrame,
} from "../../../capsule/src/protocol/codec";
import { assertConsumedTicketBinding } from "../../../capsule/src/protocol/tickets";
import {
  CAPSULE_PROTOCOL_VERSION,
  type DataStreamPrelude,
} from "../../../capsule/src/protocol/types";
import { parseDataStreamPrelude } from "../../../capsule/src/protocol/validate";
import {
  CapsuleGuestRequestError,
  CapsuleGuestSession,
  type CapsuleGuestSessionOptions,
} from "./guest-session";

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const BOOT_ID = "B".repeat(22);
const SESSION_ID = "S".repeat(43);
const OTHER_SESSION_ID = "T".repeat(43);
const APP_HANDLE = "A".repeat(22);
const SUBJECT_HANDLE = "W".repeat(22);
const UNKNOWN_REQUEST_ID = "U".repeat(22);
const FEATURES = ["control.v1", "data.v1"] as const;

describe("Host Guest control/data session", () => {
  test("binds exact GuestHello to a random HostInitialize and exact GuestReady", async () => {
    const { host, guest } = duplexPair();
    const control = new ControlPeer(guest);
    const session = new CapsuleGuestSession(host, baseOptions({ sessionIdFactory: undefined }));

    control.send(hello());
    const initialize = await control.next() as Record<string, unknown>;
    expect(initialize).toEqual({
      type: "host.initialize",
      protocolVersion: CAPSULE_PROTOCOL_VERSION,
      sessionId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expectedImageDigest: IMAGE_DIGEST,
      maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
    });
    expect(initialize.sessionId).not.toBe(SESSION_ID);

    control.send({
      type: "guest.ready",
      protocolVersion: CAPSULE_PROTOCOL_VERSION,
      bootId: BOOT_ID,
      sessionId: initialize.sessionId,
    });
    await expect(session.waitUntilReady()).resolves.toMatchObject({
      bootId: BOOT_ID,
      sessionId: initialize.sessionId,
      hello: hello(),
    });
    expect(session.state).toBe("ready");
    session.close();
  });

  test.each([
    ["digest", { imageDigest: OTHER_DIGEST }],
    ["architecture", { architecture: "x64" }],
    ["supervisor version", { supervisorVersion: "0.2.0" }],
    ["missing feature", { features: ["control.v1"] }],
    ["extra feature", { features: [...FEATURES, "viewer.v1"] }],
    ["noncanonical feature order", { features: [...FEATURES].reverse() }],
  ])("fails the complete session on a GuestHello %s mismatch", async (_label, patch) => {
    const { host, guest } = duplexPair();
    const control = new ControlPeer(guest);
    const session = new CapsuleGuestSession(host, baseOptions());
    const fatal = nextFatal(session);

    control.send({ ...hello(), ...patch });

    await expect(fatal).resolves.toMatchObject({ code: "HANDSHAKE_MISMATCH" });
    await expect(session.waitUntilReady()).rejects.toMatchObject({ code: "HANDSHAKE_MISMATCH" });
    expect(host.destroyed).toBe(true);
  });

  test("requires GuestReady to bind the exact boot and random Host session", async () => {
    const { host, guest } = duplexPair();
    const control = new ControlPeer(guest);
    const session = new CapsuleGuestSession(host, baseOptions());
    control.send(hello());
    await control.next();
    const fatal = nextFatal(session);

    control.send({
      type: "guest.ready",
      protocolVersion: CAPSULE_PROTOCOL_VERSION,
      bootId: BOOT_ID,
      sessionId: OTHER_SESSION_ID,
      guestSelectedApp: APP_HANDLE,
    });

    await expect(fatal).resolves.toMatchObject({ code: "GUEST_PROTOCOL_ERROR" });
    expect(host.destroyed).toBe(true);
  });

  test.each([
    ["unknown Hello field", encodeJsonFrame({ ...hello(), appId: "forged" })],
    ["invalid UTF-8", Buffer.from([0, 0, 0, 2, 0xc3, 0x28])],
    ["oversized advertised frame", advertisedLength(MAX_CONTROL_FRAME_BYTES + 1)],
  ])("poisons the strict control decoder on %s", async (_label, input) => {
    const { host, guest } = duplexPair();
    const session = new CapsuleGuestSession(host, baseOptions());
    const fatal = nextFatal(session);
    guest.write(input);

    await expect(fatal).resolves.toMatchObject({ code: "GUEST_PROTOCOL_ERROR" });
    expect(host.destroyed).toBe(true);
  });

  test("correlates requests and enforces strictly increasing Guest eventSeq", async () => {
    const { session, control } = await readySession();
    const events: number[] = [];
    session.on("event", (event) => events.push(event.eventSeq));

    const result = session.request("ping", { nonce: 7 });
    const request = await control.next() as Record<string, unknown>;
    expect(request).toMatchObject({
      v: CAPSULE_PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      kind: "request",
      op: "ping",
      body: { nonce: 7 },
    });
    control.send(successResponse(String(request.requestId), { nonce: 7 }));
    await expect(result).resolves.toEqual({ nonce: 7 });

    control.send(event(1, "workload.started"));
    control.send(event(3, "workload.ready"));
    expect(events).toEqual([1, 3]);

    const fatal = nextFatal(session);
    control.send(event(3, "workload.exited"));
    await expect(fatal).resolves.toMatchObject({ code: "EVENT_SEQUENCE_INVALID" });
    expect(session.state).toBe("closed");
  });

  test("rejects replayed and unknown Guest responses as fatal ambiguity", async () => {
    const replayHarness = await readySession();
    const result = replayHarness.session.request("ping", { nonce: 1 });
    const request = await replayHarness.control.next() as Record<string, unknown>;
    const response = successResponse(String(request.requestId), null);
    replayHarness.control.send(response);
    await expect(result).resolves.toBeNull();
    const replayFatal = nextFatal(replayHarness.session);
    replayHarness.control.send(response);
    await expect(replayFatal).resolves.toMatchObject({ code: "UNKNOWN_RESPONSE" });

    const unknownHarness = await readySession();
    const unknownFatal = nextFatal(unknownHarness.session);
    unknownHarness.control.send(successResponse(UNKNOWN_REQUEST_ID, null));
    await expect(unknownFatal).resolves.toMatchObject({ code: "UNKNOWN_RESPONSE" });
  });

  test("never reuses a Host request ID within one boot session", async () => {
    const requestId = "R".repeat(22);
    const { session, control } = await readySession({
      requestIdFactory: () => requestId,
      maxPendingRequests: 2,
    });
    const first = session.request("ping", { nonce: 1 });
    const request = await control.next() as Record<string, unknown>;
    await expect(session.request("ping", { nonce: 2 })).rejects.toMatchObject({
      code: "REQUEST_ID_REUSED",
    });
    control.send(successResponse(String(request.requestId), true));
    await expect(first).resolves.toBe(true);
    expect(session.state).toBe("ready");
    session.close();
  });

  test("bounds pending requests, makes timeout fatal, and revokes request tickets", async () => {
    const { session, control } = await readySession({
      maxPendingRequests: 1,
      requestTimeoutMs: 20,
    });
    const dataTicket = session.issueTicket({
      kind: "viewer",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
      ttlMs: 1_000,
    });
    const { host: dataHost, guest: dataGuest } = duplexPair();
    const openedPromise = session.openDataStream(dataTicket.ticket, "viewer");
    session.acceptDataStream(dataHost);
    await readGuestPrelude(dataGuest);
    const opened = await openedPromise;

    const requestTicket = session.issueTicket({
      kind: "logs",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
      ttlMs: 1_000,
    });
    const first = session.request(
      "ping",
      { nonce: 1 },
      { revokeTicketsOnFailure: [requestTicket.ticket] },
    );
    await control.next();
    await expect(session.request("ping", { nonce: 2 })).rejects.toMatchObject({
      code: "PENDING_REQUEST_LIMIT",
    });
    const fatal = nextFatal(session);

    await expect(first).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await expect(fatal).resolves.toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(session.pendingRequestCount).toBe(0);
    expect(session.outstandingTicketCount).toBe(0);
    expect(opened.stream.destroyed).toBe(true);
  });

  test("allows a build.start request-specific timeout through the ten-minute protocol bound", async () => {
    const { session, control } = await readySession();
    const result = session.request(
      "build.start",
      { appHandle: APP_HANDLE, buildHandle: SUBJECT_HANDLE },
      { timeoutMs: 600_000 },
    );
    const request = await control.next() as Record<string, unknown>;
    expect(request).toMatchObject({
      op: "build.start",
      body: { appHandle: APP_HANDLE, buildHandle: SUBJECT_HANDLE },
    });
    control.send(successResponse(String(request.requestId), { started: true }));
    await expect(result).resolves.toEqual({ started: true });
    session.close();
  });

  test("Host writes the exact DATA prelude, consumes one ticket, and preserves later bytes", async () => {
    const { session } = await readySession();
    const ticket = session.issueTicket({
      kind: "viewer",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
      ttlMs: 1_000,
    });
    const { host, guest } = duplexPair();
    const openedPromise = session.openDataStream(ticket.ticket, "viewer");
    session.acceptDataStream(host);
    const opened = await openedPromise;
    const HostPayload = Buffer.from("GET / HTTP/1.1\r\n\r\n");
    opened.stream.write(HostPayload);
    const prelude = await readGuestPrelude(guest);

    expect(prelude).toEqual({
      protocolVersion: CAPSULE_PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      ticket: ticket.ticket,
      kind: "viewer",
    });
    expect(opened.prelude).toEqual(prelude);
    expect(opened.binding).toMatchObject({
      sessionId: SESSION_ID,
      kind: "viewer",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
    });
    expect(() => assertConsumedTicketBinding(opened.binding)).not.toThrow();
    expect(session.outstandingTicketCount).toBe(0);
    expect(guest.readableFlowing).toBe(false);
    expect(await readRawBytes(guest)).toEqual(HostPayload);

    const GuestPayload = Buffer.from("HTTP/1.1 200 OK\r\n\r\n");
    guest.write(GuestPayload);
    expect(opened.stream.readableFlowing).not.toBe(true);
    expect(await readRawBytes(opened.stream)).toEqual(GuestPayload);
    await expect(session.openDataStream(ticket.ticket, "viewer")).rejects.toMatchObject({
      code: "TICKET_NOT_OWNED",
    });
    expect(session.state).toBe("ready");
    session.close();
  });

  test("supports both DATA scheduling races without deadlock", async () => {
    const { session } = await readySession();
    const waiterFirst = session.issueTicket({
      kind: "sdk",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
      ttlMs: 1_000,
    });
    const firstOpen = session.openDataStream(waiterFirst.ticket, "sdk");
    let firstSettled = false;
    void firstOpen.then(() => { firstSettled = true; });
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    const firstPair = duplexPair();
    session.acceptDataStream(firstPair.host);
    expect((await readGuestPrelude(firstPair.guest)).ticket).toBe(waiterFirst.ticket);
    await firstOpen;

    const streamFirst = session.issueTicket({
      kind: "logs",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
      ttlMs: 1_000,
    });
    const secondPair = duplexPair();
    session.acceptDataStream(secondPair.host);
    const secondOpen = session.openDataStream(streamFirst.ticket, "logs");
    expect((await readGuestPrelude(secondPair.guest)).ticket).toBe(streamFirst.ticket);
    await secondOpen;
    session.close();
  });

  test("does not expose a DATA stream until the prelude write callback clears backpressure", async () => {
    const { session } = await readySession();
    const ticket = session.issueTicket({
      kind: "artifact-out",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
      ttlMs: 1_000,
    });
    const { host, guest } = duplexPair();
    host.deferWriteCallbacks = true;
    const opened = session.openDataStream(ticket.ticket, "artifact-out");
    let resolved = false;
    void opened.then(() => { resolved = true; });
    session.acceptDataStream(host);

    expect((await readGuestPrelude(guest)).ticket).toBe(ticket.ticket);
    await Promise.resolve();
    expect(resolved).toBe(false);
    host.releaseNextWrite();
    await expect(opened).resolves.toMatchObject({ prelude: { kind: "artifact-out" } });
    session.close();
  });

  test("rejects a caller-selected kind without consuming the Host-issued ticket", async () => {
    const { session } = await readySession();
    const ticket = session.issueTicket({
      kind: "sdk",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
      ttlMs: 1_000,
    });
    await expect(session.openDataStream(ticket.ticket, "viewer")).rejects.toMatchObject({
      code: "TICKET_NOT_OWNED",
    });
    expect(session.outstandingTicketCount).toBe(1);
    expect(session.revokeTicket(ticket.ticket)).toBe(true);
    session.close();
  });

  test("revokes associated tickets when the Guest rejects a control request", async () => {
    const { session, control } = await readySession();
    const ticket = session.issueTicket({
      kind: "logs",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
      ttlMs: 1_000,
    });
    const opened = session.openDataStream(ticket.ticket, "logs");
    const requestPromise = session.request(
      "ping",
      { nonce: 9 },
      { revokeTicketsOnFailure: [ticket.ticket] },
    );
    const request = await control.next() as Record<string, unknown>;
    control.send({
      v: CAPSULE_PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      kind: "response",
      requestId: request.requestId,
      ok: false,
      error: { code: "GUEST_REJECTED", message: "not accepted" },
    });

    await expect(requestPromise).rejects.toEqual(
      expect.objectContaining<Partial<CapsuleGuestRequestError>>({ code: "GUEST_REJECTED" }),
    );
    await expect(opened).rejects.toMatchObject({ code: "TICKET_NOT_OWNED" });
    expect(session.outstandingTicketCount).toBe(0);
    expect(session.state).toBe("ready");
    session.close();
  });

  test("treats bytes on an unassigned neutral DATA stream as fatal Guest input", async () => {
    const { session } = await readySession();
    const pair = duplexPair();
    session.acceptDataStream(pair.host);
    const fatal = nextFatal(session);
    pair.guest.write(Buffer.from("caller-selected identity"));

    await expect(fatal).resolves.toMatchObject({ code: "DATA_STREAM_PROTOCOL" });
    expect(pair.host.destroyed).toBe(true);
    expect(session.state).toBe("closed");
  });

  test("bounds a missing on-demand DATA dial and revokes the whole ambiguous session", async () => {
    const { session } = await readySession({ dataStreamTimeoutMs: 20 });
    const ticket = session.issueTicket({
      kind: "viewer",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
      ttlMs: 1_000,
    });
    const opened = session.openDataStream(ticket.ticket, "viewer");
    const fatal = nextFatal(session);

    await expect(opened).rejects.toMatchObject({ code: "DATA_STREAM_TIMEOUT" });
    await expect(fatal).resolves.toMatchObject({ code: "DATA_STREAM_TIMEOUT" });
    expect(session.outstandingTicketCount).toBe(0);
  });

  test("malformed Guest control input closes opened and waiting DATA streams", async () => {
    const { session, control } = await readySession();
    const openedTicket = session.issueTicket({
      kind: "viewer",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
      ttlMs: 1_000,
    });
    const openedPair = duplexPair();
    const openedPromise = session.openDataStream(openedTicket.ticket, "viewer");
    session.acceptDataStream(openedPair.host);
    await readGuestPrelude(openedPair.guest);
    const opened = await openedPromise;

    const waitingTicket = session.issueTicket({
      kind: "sdk",
      appHandle: APP_HANDLE,
      subjectHandle: SUBJECT_HANDLE,
      ttlMs: 1_000,
    });
    const waiting = session.openDataStream(waitingTicket.ticket, "sdk");
    const fatal = nextFatal(session);
    control.send(successResponse(UNKNOWN_REQUEST_ID, null));

    await expect(fatal).resolves.toMatchObject({ code: "UNKNOWN_RESPONSE" });
    await expect(waiting).rejects.toMatchObject({ code: "UNKNOWN_RESPONSE" });
    expect(opened.stream.destroyed).toBe(true);
    expect(session.activeDataStreamCount).toBe(0);
    expect(session.outstandingTicketCount).toBe(0);
  });
});

function baseOptions(
  overrides: Partial<CapsuleGuestSessionOptions> = {},
): CapsuleGuestSessionOptions {
  return {
    expectedImageDigest: IMAGE_DIGEST,
    expectedArchitecture: "arm64",
    expectedSupervisorVersion: "0.1.0",
    expectedFeatures: FEATURES,
    sessionIdFactory: () => SESSION_ID,
    ...overrides,
  };
}

function hello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "guest.hello",
    protocolVersion: CAPSULE_PROTOCOL_VERSION,
    bootId: BOOT_ID,
    imageDigest: IMAGE_DIGEST,
    supervisorVersion: "0.1.0",
    architecture: "arm64",
    features: [...FEATURES],
    ...overrides,
  };
}

async function readySession(
  overrides: Partial<CapsuleGuestSessionOptions> = {},
): Promise<{ session: CapsuleGuestSession; control: ControlPeer; host: Duplex; guest: Duplex }> {
  const { host, guest } = duplexPair();
  const control = new ControlPeer(guest);
  const session = new CapsuleGuestSession(host, baseOptions(overrides));
  control.send(hello());
  const initialize = await control.next() as Record<string, unknown>;
  control.send({
    type: "guest.ready",
    protocolVersion: CAPSULE_PROTOCOL_VERSION,
    bootId: BOOT_ID,
    sessionId: initialize.sessionId,
  });
  await session.waitUntilReady();
  return { session, control, host, guest };
}

function successResponse(requestId: string, result: unknown): Record<string, unknown> {
  return {
    v: CAPSULE_PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    kind: "response",
    requestId,
    ok: true,
    result,
  };
}

function event(eventSeq: number, type: string): Record<string, unknown> {
  return {
    v: CAPSULE_PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    kind: "event",
    eventSeq,
    type,
    body: { workloadHandle: SUBJECT_HANDLE },
  };
}

function advertisedLength(length: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(length, 0);
  return header;
}

function nextFatal(session: CapsuleGuestSession): Promise<Error> {
  if (session.failure) return Promise.resolve(session.failure);
  return new Promise((resolve) => session.once("fatal", resolve));
}

class ControlPeer {
  readonly #decoder = new JsonFrameDecoder();
  readonly #values: unknown[] = [];

  constructor(readonly stream: Duplex) {
    stream.on("error", () => {});
    stream.on("data", (chunk: Buffer | Uint8Array) => {
      this.#values.push(...this.#decoder.push(Buffer.from(chunk)));
    });
  }

  send(value: unknown): void {
    this.stream.write(encodeJsonFrame(value));
  }

  async next(): Promise<unknown> {
    return waitFor(() => this.#values.shift());
  }
}

function duplexPair(): { host: MemoryDuplex; guest: MemoryDuplex } {
  const host = new MemoryDuplex();
  const guest = new MemoryDuplex();
  host.peer = guest;
  guest.peer = host;
  guest.on("error", () => {});
  return { host, guest };
}

class MemoryDuplex extends Duplex {
  peer: MemoryDuplex | undefined;
  deferWriteCallbacks = false;
  readonly #writeCallbacks: Array<(error?: Error | null) => void> = [];

  _read(): void {}

  _write(
    chunk: Buffer | Uint8Array | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.peer || this.peer.destroyed) {
      callback(new Error("peer closed"));
      return;
    }
    this.peer.push(Buffer.from(chunk));
    if (this.deferWriteCallbacks) this.#writeCallbacks.push(callback);
    else callback();
  }

  releaseNextWrite(): void {
    const callback = this.#writeCallbacks.shift();
    if (!callback) throw new Error("No deferred write callback is pending");
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    this.peer?.push(null);
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.peer?.push(null);
    callback(error);
  }
}

async function readGuestPrelude(stream: Duplex): Promise<DataStreamPrelude> {
  return await new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let expectedBytes: number | undefined;
    const onData = (chunk: Buffer | Uint8Array | string) => {
      stream.pause();
      buffered = Buffer.concat([
        buffered,
        typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
      ]);
      if (expectedBytes === undefined && buffered.byteLength >= 4) {
        const payloadBytes = buffered.readUInt32BE(0);
        if (payloadBytes < 1 || payloadBytes > MAX_DATA_PRELUDE_BYTES) {
          finish(new Error("Host prelude length is outside the protocol bound"));
          return;
        }
        expectedBytes = 4 + payloadBytes;
      }
      if (expectedBytes === undefined || buffered.byteLength < expectedBytes) {
        stream.resume();
        return;
      }
      try {
        const decoder = new JsonFrameDecoder(MAX_DATA_PRELUDE_BYTES);
        const values = decoder.push(buffered.subarray(0, expectedBytes));
        decoder.end();
        if (values.length !== 1) throw new Error("Host did not write exactly one prelude frame");
        const prelude = parseDataStreamPrelude(values[0]);
        const leftover = buffered.subarray(expectedBytes);
        cleanup();
        if (leftover.byteLength > 0) stream.unshift(leftover);
        resolve(prelude);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onEnd = () => finish(new Error("DATA stream ended before Host prelude"));
    const onError = (error: Error) => finish(error);
    const finish = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.resume();
  });
}

async function readRawBytes(stream: Duplex): Promise<Buffer> {
  return await waitFor(() => {
    const value = stream.read();
    return value === null ? undefined : Buffer.from(value as Buffer | Uint8Array | string);
  });
}

async function waitFor<T>(operation: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = operation();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition");
}
