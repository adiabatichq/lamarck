import { describe, expect, test } from "vitest";
import {
  CAPSULE_VM_HEADER_BYTES,
  CAPSULE_VM_CONTROL_VSOCK_PORT,
  CAPSULE_VM_DATA_VSOCK_PORT,
  CAPSULE_VM_HELPER_STREAM_ID_MIN,
  CAPSULE_VM_MAX_PAYLOAD_BYTES,
  CAPSULE_VM_REQUEST_STREAM_ID_MAX,
  CapsuleVmFrameDecoder,
  CapsuleVmFrameKind,
  CapsuleVmProtocolError,
  decodeCapsuleVmEvent,
  encodeCapsuleVmFrame,
  encodeCapsuleVmJson,
  isHelperStreamId,
  isRequestStreamId,
} from "./protocol";

describe("Capsule VM framed protocol", () => {
  test("round-trips fragmented and adjacent frames", () => {
    const first = encodeCapsuleVmFrame({
      kind: CapsuleVmFrameKind.Request,
      streamId: 1,
      payload: encodeCapsuleVmJson({ method: "probe" }),
    });
    const second = encodeCapsuleVmFrame({
      kind: CapsuleVmFrameKind.StreamEnd,
      streamId: 2,
      payload: new Uint8Array(),
    });
    const bytes = new Uint8Array(first.byteLength + second.byteLength);
    bytes.set(first);
    bytes.set(second, first.byteLength);

    const decoder = new CapsuleVmFrameDecoder();
    expect(decoder.push(bytes.slice(0, 7))).toEqual([]);
    const frames = decoder.push(bytes.slice(7));

    expect(frames).toHaveLength(2);
    expect(frames[0].streamId).toBe(1);
    expect(frames[1]).toEqual({
      kind: CapsuleVmFrameKind.StreamEnd,
      streamId: 2,
      payload: new Uint8Array(),
    });
    expect(() => decoder.finish()).not.toThrow();
  });

  test("uses the fixed cross-language wire header", () => {
    const encoded = encodeCapsuleVmFrame({
      kind: CapsuleVmFrameKind.Request,
      streamId: 42,
      payload: new Uint8Array([0x7b, 0x7d]),
    });

    expect(Buffer.from(encoded).toString("hex")).toBe(
      "4c43564d000100010000002a000000027b7d",
    );
  });

  test("rejects unsupported versions before allocating the payload", () => {
    const bytes = encodeCapsuleVmFrame({
      kind: CapsuleVmFrameKind.Request,
      streamId: 1,
      payload: new Uint8Array(),
    });
    bytes[5] = 2;

    const decoder = new CapsuleVmFrameDecoder();
    expectProtocolError(() => decoder.push(bytes), "unsupported_version");
  });

  test("rejects oversized payload headers without waiting for the body", () => {
    const bytes = encodeCapsuleVmFrame({
      kind: CapsuleVmFrameKind.Request,
      streamId: 1,
      payload: new Uint8Array(),
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, CAPSULE_VM_HEADER_BYTES);
    view.setUint32(12, CAPSULE_VM_MAX_PAYLOAD_BYTES + 1, false);

    const decoder = new CapsuleVmFrameDecoder();
    expectProtocolError(() => decoder.push(bytes), "payload_too_large");
  });

  test("fails closed on truncated EOF", () => {
    const decoder = new CapsuleVmFrameDecoder();
    decoder.push(new Uint8Array([0x4c, 0x43]));

    expectProtocolError(() => decoder.finish(), "truncated_frame");
  });

  test("keeps Host requests and helper streams in disjoint ID spaces", () => {
    expect(isRequestStreamId(0)).toBe(false);
    expect(isRequestStreamId(1)).toBe(true);
    expect(isRequestStreamId(CAPSULE_VM_REQUEST_STREAM_ID_MAX)).toBe(true);
    expect(isRequestStreamId(CAPSULE_VM_HELPER_STREAM_ID_MIN)).toBe(false);
    expect(isHelperStreamId(CAPSULE_VM_HELPER_STREAM_ID_MIN)).toBe(true);
    expect(isHelperStreamId(0xffff_fffe)).toBe(true);
    expect(isHelperStreamId(0xffff_ffff)).toBe(false);
  });

  test("strictly decodes only fixed control and data vsock events", () => {
    expect(decodeCapsuleVmEvent(encodeCapsuleVmJson({
      type: "stream.open",
      channel: "control",
      sourcePort: 50_000,
      destinationPort: CAPSULE_VM_CONTROL_VSOCK_PORT,
    }))).toEqual({
      type: "stream.open",
      channel: "control",
      sourcePort: 50_000,
      destinationPort: CAPSULE_VM_CONTROL_VSOCK_PORT,
    });
    expect(decodeCapsuleVmEvent(encodeCapsuleVmJson({
      type: "vm.state",
      state: "running",
    }))).toEqual({ type: "vm.state", state: "running" });

    expectProtocolError(() => decodeCapsuleVmEvent(encodeCapsuleVmJson({
      type: "stream.open",
      channel: "data",
      sourcePort: 50_001,
      destinationPort: CAPSULE_VM_DATA_VSOCK_PORT,
      appId: "caller-selected",
    })), "invalid_event");
    expectProtocolError(() => decodeCapsuleVmEvent(encodeCapsuleVmJson({
      type: "stream.open",
      channel: "data",
      sourcePort: 50_001,
      destinationPort: 80,
    })), "invalid_event");
  });
});

function expectProtocolError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected CapsuleVmProtocolError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CapsuleVmProtocolError);
    expect((error as CapsuleVmProtocolError).code).toBe(code);
  }
}
