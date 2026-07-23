import { once } from "node:events";
import { Duplex } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  LVRM_HEADER_BYTES,
  LVRM_MAX_DATA_BYTES,
  LvrmDuplex,
  LvrmProtocolError,
  LvrmResetError,
} from "../src/lvrm-duplex";

const DATA = 1;
const FIN = 2;
const RESET = 3;
const CLOSE = 4;

describe("LVRM Guest Duplex", () => {
  test("decodes fragmented DATA at Host FIN but commits only after dual CLOSE", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const output = collectReadable(relay);
    let protocolClosed = false;
    void relay.waitForProtocolClose().then(() => {
      protocolClosed = true;
    });
    const encoded = Buffer.concat([
      record(DATA, Buffer.from("fragmented ")),
      record(DATA, Buffer.from("records")),
      record(FIN),
    ]);

    for (let offset = 0; offset < encoded.byteLength;) {
      const bytes = Math.min((offset % 7) + 1, encoded.byteLength - offset);
      raw.inject(encoded.subarray(offset, offset + bytes));
      offset += bytes;
    }

    expect((await output).toString("utf8")).toBe("fragmented records");
    expect(protocolClosed).toBe(false);

    relay.end();
    await once(relay, "finish");
    await waitForGuestKind(raw, CLOSE);
    raw.inject(record(CLOSE));

    await relay.waitForProtocolClose();
    expect(protocolClosed).toBe(true);
    expect(guestKinds(raw)).toEqual([FIN, CLOSE]);
  });

  test("maps explicit RESET to a typed reset error", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const error = nextError(relay);

    raw.inject(record(RESET));

    const failure = await error;
    expect(failure).toBeInstanceOf(LvrmResetError);
    expect(failure).toMatchObject({
      name: "LvrmResetError",
      code: "LVRM_RESET",
      reason: "explicit-reset",
    });
    await waitForGuestKind(raw, RESET);
  });

  test("delivers preceding DATA but never mistakes a following RESET for FIN", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const chunks: Buffer[] = [];
    relay.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const error = nextError(relay);

    raw.inject(Buffer.concat([
      record(DATA, Buffer.from("adoption receipt")),
      record(RESET),
    ]));

    await expect(error).resolves.toMatchObject({
      name: "LvrmResetError",
      code: "LVRM_RESET",
      reason: "explicit-reset",
    });
    expect(Buffer.concat(chunks).toString("utf8")).toBe("adoption receipt");
  });

  test("a RESET following Host FIN still overrides normal completion", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const error = nextError(relay);

    relay.end();
    await once(relay, "finish");
    raw.inject(Buffer.concat([record(FIN), record(RESET)]));

    await expect(error).resolves.toMatchObject({
      name: "LvrmResetError",
      reason: "explicit-reset",
    });
  });

  test("treats physical EOF before CLOSE completion as RESET", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const error = nextError(relay);

    raw.endHostDirection();

    await expect(error).resolves.toMatchObject({
      name: "LvrmResetError",
      code: "LVRM_RESET",
      reason: "physical-eof",
    });
    await waitForGuestKind(raw, RESET);
  });

  test("treats physical close before CLOSE completion as RESET", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const error = nextError(relay);

    raw.destroy();

    await expect(error).resolves.toMatchObject({
      name: "LvrmResetError",
      code: "LVRM_RESET",
      reason: "physical-close",
    });
  });

  test("Host FIN ends only the readable direction and physical EOF cannot commit it", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const ended = once(relay, "end");
    relay.resume();

    raw.inject(record(FIN));
    await ended;
    expect(relay.readableEnded).toBe(true);

    const error = nextError(relay);
    raw.endHostDirection();
    await expect(error).resolves.toMatchObject({ reason: "physical-eof" });
    await expect(relay.waitForProtocolClose()).rejects.toMatchObject({
      reason: "physical-eof",
    });
  });

  test("tears down the physical socket normally after the complete CLOSE handshake", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const errors: Error[] = [];
    relay.on("error", (error) => errors.push(error));
    const ended = once(relay, "end");
    relay.resume();

    raw.inject(record(FIN));
    relay.end();
    await once(relay, "finish");
    await waitForGuestKind(raw, CLOSE);
    raw.inject(record(CLOSE));
    await relay.waitForProtocolClose();
    await ended;
    await waitFor(() => raw.destroyed);

    expect(errors).toEqual([]);
  });

  test("does not misclassify native EOF racing the queued Guest CLOSE callback", async () => {
    const raw = new DelayedCloseRawSocket();
    const relay = new LvrmDuplex(raw);
    const errors: Error[] = [];
    relay.on("error", (error) => errors.push(error));
    const ended = once(relay, "end");
    relay.resume();

    raw.inject(record(FIN));
    relay.end();
    await once(relay, "finish");
    await waitFor(() => raw.closeCallbackPending);
    raw.inject(record(CLOSE));
    raw.endHostDirection();
    await nextTurn();

    expect(errors).toEqual([]);
    expect(relay.readableEnded).toBe(true);
    let protocolClosed = false;
    void relay.waitForProtocolClose().then(() => {
      protocolClosed = true;
    });
    await nextTurn();
    expect(protocolClosed).toBe(false);
    raw.flushClose();
    await relay.waitForProtocolClose();
    await ended;
    expect(errors).toEqual([]);
  });

  test.each([
    ["magic", header({ magic: "NOPE", kind: DATA, length: 1 }), "invalid_magic"],
    ["version", header({ version: 1, kind: DATA, length: 1 }), "unsupported_version"],
    ["kind", header({ kind: 99, length: 0 }), "invalid_kind"],
    ["empty DATA", header({ kind: DATA, length: 0 }), "invalid_data_length"],
    [
      "oversized DATA",
      header({ kind: DATA, length: LVRM_MAX_DATA_BYTES + 1 }),
      "invalid_data_length",
    ],
    ["FIN payload", header({ kind: FIN, length: 1 }), "invalid_terminal_length"],
    ["RESET payload", header({ kind: RESET, length: 1 }), "invalid_terminal_length"],
    ["CLOSE payload", header({ kind: CLOSE, length: 1 }), "invalid_terminal_length"],
  ])("rejects malformed %s records", async (_name, malformed, code) => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const error = nextError(relay);

    raw.inject(malformed);

    const failure = await error;
    expect(failure).toBeInstanceOf(LvrmProtocolError);
    expect(failure).toMatchObject({
      name: "LvrmProtocolError",
      code,
    });
  });

  test("rejects a record truncated by physical EOF", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const error = nextError(relay);

    raw.inject(record(DATA, Buffer.from("truncated")).subarray(0, LVRM_HEADER_BYTES + 2));
    raw.endHostDirection();

    await expect(error).resolves.toMatchObject({
      name: "LvrmProtocolError",
      code: "truncated_record",
    });
  });

  test.each([
    ["duplicate FIN", Buffer.concat([record(FIN), record(FIN)]), "duplicate_fin"],
    [
      "DATA after FIN",
      Buffer.concat([record(FIN), record(DATA, Buffer.from("late"))]),
      "data_after_fin",
    ],
    ["early CLOSE", record(CLOSE), "early_close"],
  ])("rejects %s", async (_name, encoded, code) => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const error = nextError(relay);

    raw.inject(encoded);

    await expect(error).resolves.toMatchObject({
      name: "LvrmProtocolError",
      code,
    });
  });

  test("rejects duplicate CLOSE even when both FIN records were valid", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const error = nextError(relay);

    relay.end();
    await once(relay, "finish");
    raw.inject(record(FIN));
    await waitForGuestKind(raw, CLOSE);
    raw.inject(Buffer.concat([record(CLOSE), record(CLOSE)]));

    await expect(error).resolves.toMatchObject({
      name: "LvrmProtocolError",
      code: "duplicate_close",
    });
  });

  test("stops pulling complete records when the readable side applies backpressure", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw, { readableHighWaterMark: 4 });
    const first = record(DATA, Buffer.from("1234"));
    const second = record(DATA, Buffer.from("5678"));
    const terminal = record(FIN);

    raw.inject(Buffer.concat([first, second, terminal]));
    await nextTurn();

    expect(relay.readableLength).toBe(4);
    expect(raw.readableLength).toBe(second.byteLength + terminal.byteLength);

    expect(relay.read(4)).toEqual(Buffer.from("1234"));
    const remainder = collectReadable(relay);
    relay.end();
    await once(relay, "finish");
    await waitForGuestKind(raw, CLOSE);
    raw.inject(record(CLOSE));
    expect((await remainder).toString("utf8")).toBe("5678");
  });

  test("frames Guest DATA in bounded records and sends explicit FIN and CLOSE", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    const payload = Buffer.alloc(LVRM_MAX_DATA_BYTES + 17, 0x5a);
    const ended = once(relay, "end");
    relay.resume();

    relay.end(payload);
    await once(relay, "finish");
    expect(guestRecords(raw).map((item) => item.kind)).toEqual([DATA, DATA, FIN]);
    expect(Buffer.concat(
      guestRecords(raw)
        .filter((item) => item.kind === DATA)
        .map((item) => item.payload),
    )).toEqual(payload);

    raw.inject(record(FIN));
    await waitForGuestKind(raw, CLOSE);
    raw.inject(record(CLOSE));
    await relay.waitForProtocolClose();
    await ended;

    expect(guestKinds(raw)).toEqual([DATA, DATA, FIN, CLOSE]);
    await waitFor(() => raw.guestWriteEnded);
  });

  test("an application-side destroy emits RESET instead of FIN", async () => {
    const raw = new MemoryRawSocket();
    const relay = new LvrmDuplex(raw);
    relay.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => relay.once("close", resolve));

    relay.destroy(new Error("application failed"));
    await closed;

    expect(guestKinds(raw)).toEqual([RESET]);
    expect(raw.guestWriteEnded).toBe(true);
  });
});

class MemoryRawSocket extends Duplex {
  readonly guestWrites: Buffer[] = [];
  guestWriteEnded = false;

  override _read(): void {}

  override _write(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.guestWrites.push(
      typeof chunk === "string"
        ? Buffer.from(chunk, encoding)
        : Buffer.from(chunk),
    );
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.guestWriteEnded = true;
    callback();
  }

  setNoDelay(_noDelay = true): this {
    return this;
  }

  setTimeout(_timeout: number, callback?: () => void): this {
    if (callback) this.once("timeout", callback);
    return this;
  }

  inject(bytes: Buffer): void {
    this.push(bytes);
  }

  endHostDirection(): void {
    this.push(null);
  }
}

class DelayedCloseRawSocket extends MemoryRawSocket {
  private pendingCloseCallback: ((error?: Error | null) => void) | undefined;

  get closeCallbackPending(): boolean {
    return this.pendingCloseCallback !== undefined;
  }

  override _write(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = typeof chunk === "string"
      ? Buffer.from(chunk, encoding)
      : Buffer.from(chunk);
    if (bytes.readUInt16BE(6) !== CLOSE) {
      super._write(bytes, encoding, callback);
      return;
    }
    this.guestWrites.push(bytes);
    this.pendingCloseCallback = callback;
  }

  flushClose(): void {
    const callback = this.pendingCloseCallback;
    if (!callback) throw new Error("Guest CLOSE callback is not pending");
    this.pendingCloseCallback = undefined;
    callback();
  }
}

function record(kind: number, payload = Buffer.alloc(0)): Buffer {
  return Buffer.concat([
    header({ kind, length: payload.byteLength }),
    payload,
  ]);
}

function header(options: {
  magic?: string;
  version?: number;
  kind: number;
  length: number;
}): Buffer {
  const value = Buffer.alloc(LVRM_HEADER_BYTES);
  value.write(options.magic ?? "LVRM", 0, "ascii");
  value.writeUInt16BE(options.version ?? 2, 4);
  value.writeUInt16BE(options.kind, 6);
  value.writeUInt32BE(options.length, 8);
  return value;
}

function guestRecords(raw: MemoryRawSocket): Array<{ kind: number; payload: Buffer }> {
  const bytes = Buffer.concat(raw.guestWrites);
  const records: Array<{ kind: number; payload: Buffer }> = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < LVRM_HEADER_BYTES) {
      throw new Error("Guest wrote a truncated LVRM header");
    }
    const payloadBytes = bytes.readUInt32BE(offset + 8);
    const end = offset + LVRM_HEADER_BYTES + payloadBytes;
    if (end > bytes.byteLength) throw new Error("Guest wrote a truncated LVRM payload");
    records.push({
      kind: bytes.readUInt16BE(offset + 6),
      payload: bytes.subarray(offset + LVRM_HEADER_BYTES, end),
    });
    offset = end;
  }
  return records;
}

function guestKinds(raw: MemoryRawSocket): number[] {
  return guestRecords(raw).map((item) => item.kind);
}

async function waitForGuestKind(raw: MemoryRawSocket, kind: number): Promise<void> {
  await waitFor(() => guestKinds(raw).includes(kind));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error("condition did not become true");
}

async function collectReadable(stream: Duplex): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
    stream.resume();
  });
}

async function nextError(stream: Duplex): Promise<Error> {
  return await new Promise((resolve) => stream.once("error", resolve));
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
