const UINT32_MAX = 0xffff_ffff;

export const MAX_CONTROL_FRAME_BYTES = 256 * 1024;
export const MAX_DATA_PRELUDE_BYTES = 4 * 1024;

export type ProtocolCodecErrorCode =
  | "FRAME_INVALID_LIMIT"
  | "FRAME_EMPTY"
  | "FRAME_TOO_LARGE"
  | "FRAME_INVALID_UTF8"
  | "FRAME_INVALID_JSON"
  | "FRAME_NOT_SERIALIZABLE"
  | "FRAME_TRUNCATED"
  | "DECODER_POISONED";

export class ProtocolCodecError extends Error {
  readonly code: ProtocolCodecErrorCode;

  constructor(code: ProtocolCodecErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolCodecError";
    this.code = code;
  }
}

/** Encode one JSON value as a 4-byte big-endian length-prefixed frame. */
export function encodeJsonFrame(
  value: unknown,
  maxFrameBytes = MAX_CONTROL_FRAME_BYTES,
): Buffer {
  assertFrameLimit(maxFrameBytes);

  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new ProtocolCodecError(
      "FRAME_NOT_SERIALIZABLE",
      "Protocol value is not JSON-serializable",
      { cause: error },
    );
  }
  if (json === undefined) {
    throw new ProtocolCodecError(
      "FRAME_NOT_SERIALIZABLE",
      "Protocol value is not JSON-serializable",
    );
  }

  const payload = Buffer.from(json, "utf8");
  if (payload.byteLength === 0) {
    throw new ProtocolCodecError("FRAME_EMPTY", "Protocol frames cannot be empty");
  }
  if (payload.byteLength > maxFrameBytes) {
    throw new ProtocolCodecError(
      "FRAME_TOO_LARGE",
      `Protocol frame exceeds ${maxFrameBytes} bytes`,
    );
  }

  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

/**
 * Incremental frame decoder that bounds allocation from the advertised length.
 * Any malformed frame poisons the decoder; callers must close the transport.
 */
export class JsonFrameDecoder {
  private readonly header = Buffer.allocUnsafe(4);
  private headerBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;
  private poisoned = false;

  constructor(readonly maxFrameBytes = MAX_CONTROL_FRAME_BYTES) {
    assertFrameLimit(maxFrameBytes);
  }

  push(chunk: Uint8Array): unknown[] {
    if (this.poisoned) {
      throw new ProtocolCodecError(
        "DECODER_POISONED",
        "Protocol decoder cannot be reused after a malformed frame",
      );
    }

    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const values: unknown[] = [];
    let offset = 0;

    try {
      while (offset < input.byteLength) {
        if (!this.payload) {
          const headerRemaining = 4 - this.headerBytes;
          const copied = Math.min(headerRemaining, input.byteLength - offset);
          input.copy(this.header, this.headerBytes, offset, offset + copied);
          this.headerBytes += copied;
          offset += copied;
          if (this.headerBytes < 4) continue;

          const length = this.header.readUInt32BE(0);
          if (length === 0) {
            throw new ProtocolCodecError("FRAME_EMPTY", "Protocol frames cannot be empty");
          }
          if (length > this.maxFrameBytes) {
            throw new ProtocolCodecError(
              "FRAME_TOO_LARGE",
              `Protocol frame advertises ${length} bytes; limit is ${this.maxFrameBytes}`,
            );
          }
          this.payload = Buffer.allocUnsafe(length);
          this.payloadBytes = 0;
        }

        const payloadRemaining = this.payload.byteLength - this.payloadBytes;
        const copied = Math.min(payloadRemaining, input.byteLength - offset);
        input.copy(this.payload, this.payloadBytes, offset, offset + copied);
        this.payloadBytes += copied;
        offset += copied;
        if (this.payloadBytes < this.payload.byteLength) continue;

        values.push(decodePayload(this.payload));
        this.payload = undefined;
        this.payloadBytes = 0;
        this.headerBytes = 0;
      }
    } catch (error) {
      this.poisoned = true;
      if (error instanceof ProtocolCodecError) throw error;
      throw new ProtocolCodecError("FRAME_INVALID_JSON", "Malformed protocol frame", {
        cause: error,
      });
    }

    return values;
  }

  end(): void {
    if (this.poisoned) return;
    if (this.headerBytes !== 0 || this.payload !== undefined) {
      this.poisoned = true;
      throw new ProtocolCodecError(
        "FRAME_TRUNCATED",
        "Protocol transport ended with a partial frame",
      );
    }
  }
}

function decodePayload(payload: Buffer): unknown {
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch (error) {
    throw new ProtocolCodecError("FRAME_INVALID_UTF8", "Protocol frame is not valid UTF-8", {
      cause: error,
    });
  }

  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new ProtocolCodecError("FRAME_INVALID_JSON", "Protocol frame is not valid JSON", {
      cause: error,
    });
  }
}

function assertFrameLimit(maxFrameBytes: number): void {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > UINT32_MAX) {
    throw new ProtocolCodecError(
      "FRAME_INVALID_LIMIT",
      "Frame limit must be a positive uint32",
    );
  }
}
