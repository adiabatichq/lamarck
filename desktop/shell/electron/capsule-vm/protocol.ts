export const CAPSULE_VM_PROTOCOL_VERSION = 1;
export const CAPSULE_VM_HEADER_BYTES = 16;
export const CAPSULE_VM_MAX_PAYLOAD_BYTES = 1_048_576;
export const CAPSULE_VM_STREAM_CHUNK_BYTES = 64 * 1024;
export const CAPSULE_VM_MAX_OPEN_STREAMS = 64;

export const CAPSULE_VM_REQUEST_STREAM_ID_MIN = 1;
export const CAPSULE_VM_REQUEST_STREAM_ID_MAX = 0x7fff_ffff;
export const CAPSULE_VM_HELPER_STREAM_ID_MIN = 0x8000_0000;
export const CAPSULE_VM_HELPER_STREAM_ID_MAX = 0xffff_fffe;

export const CAPSULE_VM_CONTROL_VSOCK_PORT = 40_001;
export const CAPSULE_VM_DATA_VSOCK_PORT = 40_002;

const MAGIC = new Uint8Array([0x4c, 0x43, 0x56, 0x4d]); // LCVM

export enum CapsuleVmFrameKind {
  Request = 1,
  Response = 2,
  Event = 3,
  StreamData = 4,
  StreamEnd = 5,
}

const VALID_KINDS = new Set<number>([
  CapsuleVmFrameKind.Request,
  CapsuleVmFrameKind.Response,
  CapsuleVmFrameKind.Event,
  CapsuleVmFrameKind.StreamData,
  CapsuleVmFrameKind.StreamEnd,
]);

export interface CapsuleVmFrame {
  kind: CapsuleVmFrameKind;
  streamId: number;
  payload: Uint8Array;
}

export type CapsuleVmLifecycleState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface CapsuleVmStateEvent {
  type: "vm.state";
  state: CapsuleVmLifecycleState;
}

export interface CapsuleVmFailureEvent {
  type: "vm.failure";
  code: string;
  message: string;
}

export interface CapsuleVmStreamOpenEvent {
  type: "stream.open";
  channel: "control" | "data";
  sourcePort: number;
  destinationPort: number;
}

export type CapsuleVmEvent =
  | CapsuleVmStateEvent
  | CapsuleVmFailureEvent
  | CapsuleVmStreamOpenEvent;

export class CapsuleVmProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapsuleVmProtocolError";
  }
}

export function encodeCapsuleVmFrame(frame: CapsuleVmFrame): Uint8Array {
  assertUint32(frame.streamId, "streamId");
  if (!VALID_KINDS.has(frame.kind)) {
    throw new CapsuleVmProtocolError("invalid_kind", `Unknown frame kind ${frame.kind}`);
  }
  if (frame.payload.byteLength > CAPSULE_VM_MAX_PAYLOAD_BYTES) {
    throw new CapsuleVmProtocolError(
      "payload_too_large",
      `Frame payload exceeds ${CAPSULE_VM_MAX_PAYLOAD_BYTES} bytes`,
    );
  }

  const encoded = new Uint8Array(CAPSULE_VM_HEADER_BYTES + frame.payload.byteLength);
  encoded.set(MAGIC, 0);
  const view = new DataView(encoded.buffer);
  view.setUint16(4, CAPSULE_VM_PROTOCOL_VERSION, false);
  view.setUint16(6, frame.kind, false);
  view.setUint32(8, frame.streamId, false);
  view.setUint32(12, frame.payload.byteLength, false);
  encoded.set(frame.payload, CAPSULE_VM_HEADER_BYTES);
  return encoded;
}

export class CapsuleVmFrameDecoder {
  private buffered = new Uint8Array();

  push(chunk: Uint8Array): CapsuleVmFrame[] {
    if (chunk.byteLength > 0) {
      const joined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
      joined.set(this.buffered, 0);
      joined.set(chunk, this.buffered.byteLength);
      this.buffered = joined;
    }

    const frames: CapsuleVmFrame[] = [];
    let offset = 0;
    while (this.buffered.byteLength - offset >= CAPSULE_VM_HEADER_BYTES) {
      for (let index = 0; index < MAGIC.byteLength; index += 1) {
        if (this.buffered[offset + index] !== MAGIC[index]) {
          throw new CapsuleVmProtocolError("invalid_magic", "Frame magic is not LCVM");
        }
      }

      const view = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset + offset,
        CAPSULE_VM_HEADER_BYTES,
      );
      const version = view.getUint16(4, false);
      if (version !== CAPSULE_VM_PROTOCOL_VERSION) {
        throw new CapsuleVmProtocolError(
          "unsupported_version",
          `Unsupported protocol version ${version}`,
        );
      }

      const kind = view.getUint16(6, false);
      if (!VALID_KINDS.has(kind)) {
        throw new CapsuleVmProtocolError("invalid_kind", `Unknown frame kind ${kind}`);
      }

      const streamId = view.getUint32(8, false);
      const payloadBytes = view.getUint32(12, false);
      if (payloadBytes > CAPSULE_VM_MAX_PAYLOAD_BYTES) {
        throw new CapsuleVmProtocolError(
          "payload_too_large",
          `Frame payload exceeds ${CAPSULE_VM_MAX_PAYLOAD_BYTES} bytes`,
        );
      }

      const frameBytes = CAPSULE_VM_HEADER_BYTES + payloadBytes;
      if (this.buffered.byteLength - offset < frameBytes) break;

      frames.push({
        kind: kind as CapsuleVmFrameKind,
        streamId,
        payload: this.buffered.slice(
          offset + CAPSULE_VM_HEADER_BYTES,
          offset + frameBytes,
        ),
      });
      offset += frameBytes;
    }

    if (offset > 0) this.buffered = this.buffered.slice(offset);
    return frames;
  }

  finish(): void {
    if (this.buffered.byteLength !== 0) {
      throw new CapsuleVmProtocolError(
        "truncated_frame",
        "Input ended in the middle of a frame",
      );
    }
  }
}

export function encodeCapsuleVmJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeCapsuleVmJson(payload: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new CapsuleVmProtocolError("invalid_json", "Frame payload is not valid UTF-8 JSON");
  }
}

export function decodeCapsuleVmEvent(payload: Uint8Array): CapsuleVmEvent {
  const value = decodeCapsuleVmJson(payload);
  if (!isPlainObject(value) || typeof value.type !== "string") {
    throw new CapsuleVmProtocolError("invalid_event", "Helper event must be an object with a type");
  }

  switch (value.type) {
    case "vm.state": {
      assertExactKeys(value, ["type", "state"], "vm.state event");
      if (!["starting", "running", "stopping", "stopped", "failed"].includes(
        value.state as string,
      )) {
        throw new CapsuleVmProtocolError("invalid_event", "Helper VM state is invalid");
      }
      return {
        type: "vm.state",
        state: value.state as CapsuleVmLifecycleState,
      };
    }

    case "vm.failure": {
      assertExactKeys(value, ["type", "code", "message"], "vm.failure event");
      if (typeof value.code !== "string" || value.code.length === 0
        || typeof value.message !== "string" || value.message.length === 0) {
        throw new CapsuleVmProtocolError("invalid_event", "Helper VM failure is invalid");
      }
      return { type: "vm.failure", code: value.code, message: value.message };
    }

    case "stream.open": {
      assertExactKeys(
        value,
        ["type", "channel", "sourcePort", "destinationPort"],
        "stream.open event",
      );
      if (value.channel !== "control" && value.channel !== "data") {
        throw new CapsuleVmProtocolError("invalid_event", "Helper stream channel is invalid");
      }
      assertUint32(value.sourcePort, "sourcePort");
      assertUint32(value.destinationPort, "destinationPort");
      const expectedPort = value.channel === "control"
        ? CAPSULE_VM_CONTROL_VSOCK_PORT
        : CAPSULE_VM_DATA_VSOCK_PORT;
      if (value.destinationPort !== expectedPort) {
        throw new CapsuleVmProtocolError(
          "invalid_event",
          `Helper ${value.channel} stream used unexpected destination port`,
        );
      }
      return {
        type: "stream.open",
        channel: value.channel,
        sourcePort: value.sourcePort,
        destinationPort: value.destinationPort,
      };
    }

    default:
      throw new CapsuleVmProtocolError(
        "invalid_event",
        `Unknown helper event ${JSON.stringify(value.type)}`,
      );
  }
}

export function isRequestStreamId(value: number): boolean {
  return Number.isInteger(value)
    && value >= CAPSULE_VM_REQUEST_STREAM_ID_MIN
    && value <= CAPSULE_VM_REQUEST_STREAM_ID_MAX;
}

export function isHelperStreamId(value: number): boolean {
  return Number.isInteger(value)
    && value >= CAPSULE_VM_HELPER_STREAM_ID_MIN
    && value <= CAPSULE_VM_HELPER_STREAM_ID_MAX;
}

function assertUint32(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new CapsuleVmProtocolError("invalid_uint32", `${name} must be a uint32`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new CapsuleVmProtocolError("invalid_event", `${label} contains unknown or missing fields`);
  }
}
