import { describe, expect, test } from "vitest";
import {
  encodeJsonFrame,
  JsonFrameDecoder,
  ProtocolCodecError,
} from "../src/protocol/codec";

describe("length-prefixed JSON protocol codec", () => {
  test("decodes fragmented and coalesced 4-byte big-endian frames", () => {
    const first = encodeJsonFrame({ type: "first", value: 1 });
    const second = encodeJsonFrame(["second", 2]);
    expect(first.readUInt32BE(0)).toBe(first.byteLength - 4);

    const wire = Buffer.concat([first, second]);
    const decoder = new JsonFrameDecoder();
    expect(decoder.push(wire.subarray(0, 2))).toEqual([]);
    expect(decoder.push(wire.subarray(2, first.byteLength + 3))).toEqual([
      { type: "first", value: 1 },
    ]);
    expect(decoder.push(wire.subarray(first.byteLength + 3))).toEqual([["second", 2]]);
    expect(() => decoder.end()).not.toThrow();
  });

  test("rejects an oversized advertised length before accepting payload bytes", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(17, 0);
    const decoder = new JsonFrameDecoder(16);

    expect(() => decoder.push(header)).toThrowError(
      expect.objectContaining<Partial<ProtocolCodecError>>({ code: "FRAME_TOO_LARGE" }),
    );
    expect(() => decoder.push(Buffer.from("{}"))).toThrowError(
      expect.objectContaining<Partial<ProtocolCodecError>>({ code: "DECODER_POISONED" }),
    );
  });

  test("poisons the stream on invalid UTF-8 or JSON", () => {
    const invalidUtf8 = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
    expect(() => new JsonFrameDecoder().push(invalidUtf8)).toThrowError(
      expect.objectContaining<Partial<ProtocolCodecError>>({ code: "FRAME_INVALID_UTF8" }),
    );

    const invalidJson = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("{")]);
    expect(() => new JsonFrameDecoder().push(invalidJson)).toThrowError(
      expect.objectContaining<Partial<ProtocolCodecError>>({ code: "FRAME_INVALID_JSON" }),
    );
  });

  test("fails closed on a truncated transport", () => {
    const frame = encodeJsonFrame({ ok: true });
    const decoder = new JsonFrameDecoder();
    decoder.push(frame.subarray(0, frame.byteLength - 1));
    expect(() => decoder.end()).toThrowError(
      expect.objectContaining<Partial<ProtocolCodecError>>({ code: "FRAME_TRUNCATED" }),
    );
  });

  test("rejects non-JSON and over-limit outbound values", () => {
    expect(() => encodeJsonFrame(undefined)).toThrowError(
      expect.objectContaining<Partial<ProtocolCodecError>>({ code: "FRAME_NOT_SERIALIZABLE" }),
    );
    expect(() => encodeJsonFrame({ value: 1n })).toThrowError(
      expect.objectContaining<Partial<ProtocolCodecError>>({ code: "FRAME_NOT_SERIALIZABLE" }),
    );
    expect(() => encodeJsonFrame("0123456789", 4)).toThrowError(
      expect.objectContaining<Partial<ProtocolCodecError>>({ code: "FRAME_TOO_LARGE" }),
    );
  });
});
