import { Duplex, type DuplexOptions } from "node:stream";

export const LVRM_HEADER_BYTES = 12;
export const LVRM_MAX_DATA_BYTES = 64 * 1024;

const LVRM_MAGIC = Buffer.from("LVRM", "ascii");
const LVRM_VERSION = 2;
const LVRM_KIND_DATA = 1;
const LVRM_KIND_FIN = 2;
const LVRM_KIND_RESET = 3;
const LVRM_KIND_CLOSE = 4;
const LVRM_RESET_FLUSH_TIMEOUT_MS = 1_000;

export type LvrmResetReason =
  | "explicit-reset"
  | "physical-eof"
  | "physical-close"
  | "socket-error";

export class LvrmResetError extends Error {
  readonly code = "LVRM_RESET";

  constructor(
    readonly reason: LvrmResetReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LvrmResetError";
  }
}

export class LvrmProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LvrmProtocolError";
  }
}

export type GuestProtocolStream = Duplex & {
  setNoDelay(noDelay?: boolean): unknown;
  setTimeout(timeout: number, callback?: () => void): unknown;
  waitForProtocolClose(): Promise<void>;
};

type RawRelaySocket = Duplex & {
  setNoDelay(noDelay?: boolean): unknown;
  setTimeout(timeout: number, callback?: () => void): unknown;
};

type LvrmDuplexOptions = Pick<
  DuplexOptions,
  "readableHighWaterMark" | "writableHighWaterMark"
>;

/**
 * Presents the Guest supervisor with an ordinary directional byte stream while
 * retaining explicit Host terminal semantics on the native-relay Unix hop.
 *
 * Both directions use LVRM v2 records across the Guest-local Unix socket.
 * Directional FIN remains distinct from connection-terminal RESET, and normal
 * completion requires both endpoints to exchange CLOSE after both FIN records.
 * A validated Host FIN ends only the adapter's readable direction; callers use
 * `waitForProtocolClose()` when operation success requires the subsequent
 * dual-CLOSE commit. Physical Unix-socket EOF is therefore never interpreted
 * as FIN or normal protocol completion.
 *
 * Parsing retains at most one 64 KiB DATA payload plus its fixed 12-byte
 * header. Once the supervisor's readable queue applies backpressure, no
 * further record is removed from the underlying socket.
 */
export class LvrmDuplex extends Duplex {
  private readonly header = Buffer.allocUnsafe(LVRM_HEADER_BYTES);
  private headerBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;
  private hostFinReceived = false;
  private hostCloseReceived = false;
  private guestFinQueued = false;
  private guestFinFlushed = false;
  private guestCloseQueued = false;
  private guestCloseFlushed = false;
  private protocolComplete = false;
  private resetQueued = false;
  private readBackpressured = false;
  private draining = false;
  private rawEnded = false;
  private rawClosed = false;
  private failed = false;
  private protocolCloseSettled = false;
  private readonly protocolClosePromise: Promise<void>;
  private readonly resolveProtocolClose: () => void;
  private readonly rejectProtocolClose: (error: Error) => void;

  constructor(
    private readonly raw: RawRelaySocket,
    options: LvrmDuplexOptions = {},
  ) {
    super({
      allowHalfOpen: true,
      // Host FIN completes only the readable direction. Node must not destroy
      // the adapter after both application-facing halves finish because the
      // explicit dual-CLOSE protocol may still be in flight underneath.
      autoDestroy: false,
      readableHighWaterMark: options.readableHighWaterMark ?? LVRM_MAX_DATA_BYTES,
      writableHighWaterMark: options.writableHighWaterMark,
    });
    let resolveProtocolClose!: () => void;
    let rejectProtocolClose!: (error: Error) => void;
    this.protocolClosePromise = new Promise<void>((resolve, reject) => {
      resolveProtocolClose = resolve;
      rejectProtocolClose = reject;
    });
    this.resolveProtocolClose = resolveProtocolClose;
    this.rejectProtocolClose = rejectProtocolClose;
    // A stream may be used for a long-lived control or workload channel whose
    // owner observes ordinary stream errors instead of joining this promise.
    // Keep a later protocol failure handled until an operation elects to wait.
    void this.protocolClosePromise.catch(() => undefined);

    // A `readable` listener keeps the raw socket paused. We pull only the
    // precise number of bytes required for the current header or payload.
    raw.pause();
    raw.on("readable", this.onRawReadable);
    raw.once("end", this.onRawEnd);
    raw.once("error", this.onRawError);
    raw.once("close", this.onRawClose);
    raw.on("timeout", this.onRawTimeout);
    this.once("end", this.retireAfterProtocolClose);
    this.once("finish", this.retireAfterProtocolClose);

    queueMicrotask(() => this.drainInput());
  }

  override _read(): void {
    this.readBackpressured = false;
    this.drainInput();
  }

  override _write(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.raw.destroyed || !this.raw.writable || this.raw.writableEnded) {
      callback(new LvrmResetError(
        "physical-close",
        "native relay closed before the Guest write completed",
      ));
      return;
    }
    const bytes = typeof chunk === "string"
      ? Buffer.from(chunk, encoding)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.writeGuestData(bytes, 0, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.raw.destroyed || !this.raw.writable || this.raw.writableEnded) {
      callback(new LvrmResetError(
        "physical-close",
        "native relay closed before the Guest FIN",
      ));
      return;
    }
    this.guestFinQueued = true;
    this.writeRawRecord(LVRM_KIND_FIN, Buffer.alloc(0), (error) => {
      if (error) {
        callback(error);
        return;
      }
      this.guestFinFlushed = true;
      callback();
      this.maybeSendGuestClose();
    });
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.cleanupRawListeners();
    if (this.protocolComplete) {
      this.finishRawNormally(error, callback);
      return;
    }
    this.settleProtocolFailure(error ?? new LvrmResetError(
      "physical-close",
      "LVRM stream was destroyed before protocol completion",
    ));
    this.flushResetAndDestroy(error, callback);
  }

  setNoDelay(noDelay = true): this {
    this.raw.setNoDelay(noDelay);
    return this;
  }

  setTimeout(timeout: number, callback?: () => void): this {
    if (callback) this.once("timeout", callback);
    this.raw.setTimeout(timeout);
    return this;
  }

  waitForProtocolClose(): Promise<void> {
    return this.protocolClosePromise;
  }

  private readonly onRawReadable = () => {
    this.drainInput();
  };

  private readonly onRawEnd = () => {
    this.rawEnded = true;
    this.drainInput();
    this.verifyPhysicalTermination();
  };

  private readonly onRawError = (error: Error) => {
    this.fail(new LvrmResetError(
      "socket-error",
      "native relay socket failed before protocol completion",
      { cause: error },
    ));
  };

  private readonly onRawClose = () => {
    this.rawClosed = true;
    this.drainInput();
    this.verifyPhysicalTermination();
  };

  private readonly onRawTimeout = () => {
    this.emit("timeout");
  };

  private drainInput(): void {
    if (this.draining || this.failed || this.destroyed || this.readBackpressured) return;
    this.draining = true;
    try {
      while (!this.failed && !this.destroyed && !this.readBackpressured) {
        const target = this.payload ?? this.header;
        const filled = this.payload ? this.payloadBytes : this.headerBytes;
        const remaining = target.byteLength - filled;
        const available = this.raw.readableLength;
        if (available === 0) {
          // In readable mode Node emits `end` only after the consumer performs
          // the boundary read which observes the queued EOF.
          this.raw.read();
          break;
        }

        const chunk = this.raw.read(Math.min(remaining, available));
        if (chunk === null) break;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes.byteLength === 0 || bytes.byteLength > remaining) {
          throw new LvrmProtocolError(
            "invalid_native_read",
            "native relay returned an invalid bounded read",
          );
        }
        bytes.copy(target, filled);

        if (this.payload) {
          this.payloadBytes += bytes.byteLength;
          if (this.payloadBytes === this.payload.byteLength) {
            const payload = this.payload;
            this.resetFrame();
            if (!this.push(payload)) this.readBackpressured = true;
          }
          continue;
        }

        this.headerBytes += bytes.byteLength;
        if (this.headerBytes === LVRM_HEADER_BYTES) this.acceptHeader();
      }
    } catch (error) {
      this.fail(asError(error));
    } finally {
      this.draining = false;
      this.verifyPhysicalTermination();
    }
  }

  private acceptHeader(): void {
    if (!this.header.subarray(0, LVRM_MAGIC.byteLength).equals(LVRM_MAGIC)) {
      throw new LvrmProtocolError(
        "invalid_magic",
        "native relay record magic is not LVRM",
      );
    }
    const version = this.header.readUInt16BE(4);
    if (version !== LVRM_VERSION) {
      throw new LvrmProtocolError(
        "unsupported_version",
        `unsupported native relay record version ${version}`,
      );
    }

    const kind = this.header.readUInt16BE(6);
    const payloadBytes = this.header.readUInt32BE(8);
    if (kind === LVRM_KIND_DATA) {
      if (payloadBytes < 1 || payloadBytes > LVRM_MAX_DATA_BYTES) {
        throw new LvrmProtocolError(
          "invalid_data_length",
          "LVRM DATA payload length is outside policy",
        );
      }
      if (this.hostFinReceived || this.hostCloseReceived) {
        throw new LvrmProtocolError(
          "data_after_fin",
          "native relay sent LVRM DATA after its directional FIN",
        );
      }
      this.payload = Buffer.allocUnsafe(payloadBytes);
      this.payloadBytes = 0;
      return;
    }

    if (
      kind !== LVRM_KIND_FIN
      && kind !== LVRM_KIND_RESET
      && kind !== LVRM_KIND_CLOSE
    ) {
      throw new LvrmProtocolError(
        "invalid_kind",
        `unknown native relay record kind ${kind}`,
      );
    }
    if (payloadBytes !== 0) {
      throw new LvrmProtocolError(
        "invalid_terminal_length",
        "LVRM terminal records must have an empty payload",
      );
    }

    this.resetFrame();
    if (kind === LVRM_KIND_RESET) {
      throw new LvrmResetError(
        "explicit-reset",
        "Host reset the native relay direction",
      );
    }

    if (kind === LVRM_KIND_FIN) {
      if (this.hostFinReceived) {
        throw new LvrmProtocolError(
          "duplicate_fin",
          "native relay sent LVRM FIN more than once",
        );
      }
      if (this.hostCloseReceived) {
        throw new LvrmProtocolError(
          "fin_after_close",
          "native relay sent LVRM FIN after CLOSE",
        );
      }
      this.hostFinReceived = true;
      // LVRM FIN is the authenticated directional terminal signal. Expose it
      // immediately so consumers such as an exact blob receiver can finish
      // reading and send the opposite FIN. Overall operation success remains
      // gated by `waitForProtocolClose()`.
      this.push(null);
      this.maybeSendGuestClose();
      return;
    }

    if (this.hostCloseReceived) {
      throw new LvrmProtocolError(
        "duplicate_close",
        "native relay sent LVRM CLOSE more than once",
      );
    }
    if (!this.hostFinReceived || !this.guestFinQueued) {
      throw new LvrmProtocolError(
        "early_close",
        "native relay sent LVRM CLOSE before both directional FIN records",
      );
    }
    this.hostCloseReceived = true;
    this.maybeFinishProtocol();
  }

  private writeGuestData(
    bytes: Buffer,
    offset: number,
    callback: (error?: Error | null) => void,
  ): void {
    if (offset === bytes.byteLength) {
      callback();
      return;
    }
    if (this.destroyed || this.failed || this.resetQueued) {
      callback(new LvrmResetError(
        "physical-close",
        "Guest DATA write was interrupted by relay termination",
      ));
      return;
    }
    const end = Math.min(offset + LVRM_MAX_DATA_BYTES, bytes.byteLength);
    this.writeRawRecord(LVRM_KIND_DATA, bytes.subarray(offset, end), (error) => {
      if (error) {
        callback(error);
        return;
      }
      this.writeGuestData(bytes, end, callback);
    });
  }

  private writeRawRecord(
    kind: number,
    payload: Buffer,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.raw.destroyed || !this.raw.writable || this.raw.writableEnded) {
      callback(new LvrmResetError(
        "physical-close",
        "native relay closed before an LVRM record was flushed",
      ));
      return;
    }
    const frame = encodeRecord(kind, payload);
    try {
      this.raw.write(frame, callback);
    } catch (error) {
      callback(asError(error));
    }
  }

  private maybeSendGuestClose(): void {
    if (
      this.failed
      || this.destroyed
      || this.resetQueued
      || this.guestCloseQueued
      || !this.hostFinReceived
      || !this.guestFinFlushed
    ) {
      return;
    }
    this.guestCloseQueued = true;
    this.writeRawRecord(LVRM_KIND_CLOSE, Buffer.alloc(0), (error) => {
      if (error) {
        this.fail(error);
        return;
      }
      this.guestCloseFlushed = true;
      this.maybeFinishProtocol();
    });
  }

  private maybeFinishProtocol(): void {
    if (
      this.protocolComplete
      || this.failed
      || !this.hostCloseReceived
      || !this.guestCloseFlushed
    ) {
      return;
    }
    this.protocolComplete = true;
    this.protocolCloseSettled = true;
    this.resolveProtocolClose();
    this.retireAfterProtocolClose();
  }

  private resetFrame(): void {
    this.headerBytes = 0;
    this.payload = undefined;
    this.payloadBytes = 0;
  }

  private verifyPhysicalTermination(): void {
    if (
      this.failed
      || this.destroyed
      || this.draining
      || (!this.rawEnded && !this.rawClosed)
      || this.raw.readableLength > 0
    ) {
      return;
    }
    if (this.headerBytes !== 0 || this.payload !== undefined) {
      this.fail(new LvrmProtocolError(
        "truncated_record",
        "native relay closed with a partial LVRM record",
      ));
      return;
    }
    if (
      this.hostCloseReceived
      && this.guestCloseQueued
      && !this.guestCloseFlushed
    ) {
      // A normal native exit can close the UDS immediately after forwarding
      // both CLOSE records, before Node schedules the callback for our already
      // queued Guest CLOSE. The pending write callback is the authority: it
      // will either complete the commit or fail the stream.
      return;
    }
    if (!this.protocolComplete) {
      this.fail(new LvrmResetError(
        this.rawEnded ? "physical-eof" : "physical-close",
        "native relay closed before the dual-FIN CLOSE handshake completed",
      ));
    }
  }

  private fail(error: Error): void {
    if (this.failed || this.destroyed) return;
    this.failed = true;
    this.settleProtocolFailure(error);
    this.destroy(error);
  }

  private settleProtocolFailure(error: Error): void {
    if (this.protocolCloseSettled) return;
    this.protocolCloseSettled = true;
    this.rejectProtocolClose(error);
  }

  private readonly retireAfterProtocolClose = () => {
    if (
      !this.protocolComplete
      || this.destroyed
      || !this.readableEnded
      || !this.writableFinished
    ) {
      return;
    }
    this.destroy();
  };

  private finishRawNormally(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.raw.destroyed || this.raw.writableFinished) {
      if (!this.raw.destroyed) this.raw.destroy();
      callback(error);
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.raw.off("finish", finish);
      this.raw.off("close", finish);
      this.raw.off("error", finish);
      if (!this.raw.destroyed) this.raw.destroy();
      callback(error);
    };
    const timer = setTimeout(finish, LVRM_RESET_FLUSH_TIMEOUT_MS);
    timer.unref();
    this.raw.once("finish", finish);
    this.raw.once("close", finish);
    this.raw.once("error", finish);
    try {
      this.raw.end();
    } catch {
      finish();
    }
  }

  private flushResetAndDestroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (
      this.resetQueued
      || this.guestCloseQueued
      || this.raw.destroyed
      || !this.raw.writable
      || this.raw.writableEnded
    ) {
      if (!this.raw.destroyed) this.raw.destroy();
      callback(error);
      return;
    }
    this.resetQueued = true;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.raw.off("error", finish);
      this.raw.off("close", finish);
      if (!this.raw.destroyed) this.raw.destroy();
      callback(error);
    };
    const timer = setTimeout(finish, LVRM_RESET_FLUSH_TIMEOUT_MS);
    timer.unref();
    this.raw.once("error", finish);
    this.raw.once("close", finish);
    this.writeRawRecord(LVRM_KIND_RESET, Buffer.alloc(0), () => {
      if (!this.raw.destroyed && !this.raw.writableEnded) {
        try {
          this.raw.end(finish);
          return;
        } catch {
          // Fall through to the bounded teardown below.
        }
      }
      finish();
    });
  }

  private cleanupRawListeners(): void {
    this.raw.off("readable", this.onRawReadable);
    this.raw.off("end", this.onRawEnd);
    this.raw.off("error", this.onRawError);
    this.raw.off("close", this.onRawClose);
    this.raw.off("timeout", this.onRawTimeout);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function encodeRecord(kind: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(LVRM_HEADER_BYTES + payload.byteLength);
  LVRM_MAGIC.copy(frame, 0);
  frame.writeUInt16BE(LVRM_VERSION, 4);
  frame.writeUInt16BE(kind, 6);
  frame.writeUInt32BE(payload.byteLength, 8);
  if (payload.byteLength > 0) payload.copy(frame, LVRM_HEADER_BYTES);
  return frame;
}
