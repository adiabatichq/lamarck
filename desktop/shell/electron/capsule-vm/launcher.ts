import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import { Duplex, type DuplexOptions } from "node:stream";
import {
  CAPSULE_VM_MAX_OPEN_STREAMS,
  CAPSULE_VM_PROTOCOL_VERSION,
  CAPSULE_VM_REQUEST_STREAM_ID_MAX,
  CAPSULE_VM_REQUEST_STREAM_ID_MIN,
  CAPSULE_VM_STREAM_CHUNK_BYTES,
  CapsuleVmFrameDecoder,
  CapsuleVmFrameKind,
  type CapsuleVmEvent,
  type CapsuleVmStreamOpenEvent,
  CapsuleVmProtocolError,
  decodeCapsuleVmEvent,
  decodeCapsuleVmJson,
  encodeCapsuleVmFrame,
  encodeCapsuleVmJson,
  isHelperStreamId,
  isRequestStreamId,
} from "./protocol";

const MINIMUM_VM_MEMORY_BYTES = 512 * 1024 * 1024;
const MAXIMUM_VM_MEMORY_BYTES = 64 * 1024 * 1024 * 1024;
const MAXIMUM_VM_CPU_COUNT = 64;
const MAXIMUM_STREAM_END_PAYLOAD_BYTES = 4 * 1024;

export interface CapsuleVmProbeResult {
  protocolVersion: number;
  hostArchitecture: string;
  virtualizationSupported: boolean;
}

/** Trusted Host descriptor. Artifact filenames are selected only by the signed manifest. */
export interface CapsuleVmGuestImage {
  imageBundlePath: string;
  stateDirectory: string;
  expectedManifestDigest: string;
  /** Base64-encoded 32-byte Ed25519 public key pinned by the trusted Host release descriptor. */
  manifestPublicKey: string;
  cpuCount: number;
  memorySizeBytes: number;
}

export interface CapsuleVmStartResult {
  protocolVersion: number;
  state: "running";
  imageDigest: string;
  architecture: "arm64" | "x86_64";
}

export interface CapsuleVmStopResult {
  state: "stopped";
}

interface ResponseEnvelope {
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface CapsuleVmHostClientOptions {
  requestTimeoutMs?: number;
  streamHighWaterMarkBytes?: number;
  onLog?: (message: string) => void;
}

export class CapsuleVmHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapsuleVmHostError";
  }
}

export class CapsuleVmHostStream extends Duplex {
  readonly streamId: number;
  readonly channel: "control" | "data";
  readonly sourcePort: number;
  readonly destinationPort: number;

  private localEnded = false;
  private remoteEnded = false;

  constructor(
    private readonly owner: CapsuleVmHostClient,
    info: CapsuleVmStreamOpenEvent & { streamId: number },
    options: DuplexOptions,
  ) {
    super({ ...options, allowHalfOpen: true, autoDestroy: true });
    this.streamId = info.streamId;
    this.channel = info.channel;
    this.sourcePort = info.sourcePort;
    this.destinationPort = info.destinationPort;
    // Guest failure must not crash Electron merely because a newly opened
    // hostile stream has not yet been claimed by a consumer.
    this.on("error", () => {});
  }

  _read(): void {
    // LCVM multiplexes every Guest stream and control response over one helper
    // stdout. Pausing that global pipe for one slow App would let it block all
    // other Apps. Each stream is bounded independently in acceptData instead.
  }

  _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    this.owner.writeStreamData(this.streamId, bytes, callback);
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.localEnded) {
      callback();
      return;
    }
    this.localEnded = true;
    this.owner.endStream(this.streamId, undefined, callback);
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const notifyHelper = !this.localEnded;
    this.localEnded = true;
    this.owner.releaseStream(
      this.streamId,
      notifyHelper,
      notifyHelper ? error ?? undefined : undefined,
      callback,
    );
  }

  acceptData(payload: Uint8Array): void {
    if (this.remoteEnded || this.destroyed) {
      throw new CapsuleVmProtocolError(
        "stream_after_end",
        `Helper sent data after stream ${this.streamId} ended`,
      );
    }
    if (this.readableLength + payload.byteLength > this.owner.streamBufferLimitBytes) {
      this.destroy(new CapsuleVmHostError(
        "stream_buffer_limit",
        `Guest stream ${this.streamId} exceeded its Host receive buffer`,
      ));
      return;
    }
    this.push(Buffer.from(payload));
  }

  acceptEnd(error?: CapsuleVmHostError): void {
    if (this.remoteEnded) {
      throw new CapsuleVmProtocolError(
        "duplicate_stream_end",
        `Helper ended stream ${this.streamId} more than once`,
      );
    }
    this.remoteEnded = true;
    if (error) {
      // A non-empty StreamEnd is a terminal helper-side abort, not a clean
      // read-side half-close. The helper closes the relay after emitting it,
      // so do not send an abort back for the already-terminal stream.
      this.localEnded = true;
      this.destroy(error);
    } else {
      this.push(null);
    }
  }

  failFromOwner(error: Error): void {
    this.localEnded = true;
    this.remoteEnded = true;
    this.destroy(error);
  }
}

export interface CapsuleVmHostClient {
  on(event: "stream", listener: (stream: CapsuleVmHostStream) => void): this;
  on(event: "event", listener: (event: CapsuleVmEvent) => void): this;
  on(event: "close", listener: (error: Error) => void): this;
  once(event: "stream", listener: (stream: CapsuleVmHostStream) => void): this;
  once(event: "event", listener: (event: CapsuleVmEvent) => void): this;
  once(event: "close", listener: (error: Error) => void): this;
}

export class CapsuleVmHostClient extends EventEmitter {
  private readonly decoder = new CapsuleVmFrameDecoder();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly streams = new Map<number, CapsuleVmHostStream>();
  private readonly drainingStreams = new Set<number>();
  private readonly requestTimeoutMs: number;
  private readonly streamHighWaterMarkBytes: number;
  private nextRequestStreamId = CAPSULE_VM_REQUEST_STREAM_ID_MIN;
  private controlStreamSeen = false;
  private closedError: Error | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: CapsuleVmHostClientOptions = {},
  ) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.streamHighWaterMarkBytes = options.streamHighWaterMarkBytes ?? 256 * 1024;
    if (!Number.isSafeInteger(this.streamHighWaterMarkBytes) || this.streamHighWaterMarkBytes < 1) {
      throw new CapsuleVmHostError(
        "invalid_stream_high_water_mark",
        "Stream high-water mark must be a positive safe integer",
      );
    }

    child.stdout.on("data", (chunk: Uint8Array) => {
      if (this.closedError) return;
      try {
        for (const frame of this.decoder.push(chunk)) this.acceptFrame(frame);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdout.on("end", () => {
      if (this.closedError) return;
      try {
        this.decoder.finish();
        this.fail(new CapsuleVmHostError("helper_output_closed", "VM helper output closed"));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      this.fail(
        new CapsuleVmHostError(
          "helper_exited",
          `VM helper exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", options.onLog ?? (() => {}));
  }

  get openStreamCount(): number {
    return this.streams.size;
  }

  get streamBufferLimitBytes(): number {
    return this.streamHighWaterMarkBytes;
  }

  async probe(): Promise<CapsuleVmProbeResult> {
    const value = await this.request("probe");
    if (!isProbeResult(value)) {
      throw new CapsuleVmProtocolError("invalid_probe_response", "Helper returned an invalid probe result");
    }
    return value;
  }

  async startGuest(image?: CapsuleVmGuestImage): Promise<CapsuleVmStartResult> {
    if (!image || !hasCompleteGuestImage(image)) {
      throw new CapsuleVmHostError(
        "guest_image_required",
        "Starting the Capsule VM requires a complete signed Guest image descriptor",
      );
    }
    const value = await this.request("start", image);
    if (!isStartResult(value) || value.imageDigest !== image.expectedManifestDigest) {
      throw new CapsuleVmProtocolError(
        "invalid_start_response",
        "Helper returned an invalid or image-mismatched Guest start result",
      );
    }
    return value;
  }

  async stopGuest(): Promise<void> {
    const value = await this.request("stop");
    if (!isStopResult(value)) {
      throw new CapsuleVmProtocolError("invalid_stop_response", "Helper returned an invalid stop result");
    }
  }

  close(): void {
    this.fail(new CapsuleVmHostError("helper_closed", "VM helper client closed"));
  }

  writeStreamData(
    streamId: number,
    payload: Uint8Array,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.streams.has(streamId)) {
      callback(new CapsuleVmHostError("stream_closed", `VM helper stream ${streamId} is closed`));
      return;
    }
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < payload.byteLength; offset += CAPSULE_VM_STREAM_CHUNK_BYTES) {
      chunks.push(payload.subarray(offset, offset + CAPSULE_VM_STREAM_CHUNK_BYTES));
    }
    this.writeStreamChunks(streamId, chunks, 0, callback);
  }

  endStream(
    streamId: number,
    error: Error | undefined,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.closedError || !this.streams.has(streamId)) {
      callback(this.closedError ?? new CapsuleVmHostError("stream_closed", `VM helper stream ${streamId} is closed`));
      return;
    }
    const payload = error
      ? encodeCapsuleVmJson({ code: "host_stream_error", message: error.message })
      : new Uint8Array();
    this.writeFrame({ kind: CapsuleVmFrameKind.StreamEnd, streamId, payload }, callback);
  }

  releaseStream(
    streamId: number,
    notifyHelper: boolean,
    error: Error | undefined,
    callback: (error?: Error | null) => void,
  ): void {
    if (!notifyHelper) {
      this.streams.delete(streamId);
      this.drainingStreams.delete(streamId);
      callback();
      return;
    }
    this.drainingStreams.add(streamId);
    if (this.closedError) {
      callback();
      return;
    }
    const payload = error
      ? encodeCapsuleVmJson({ code: "host_stream_error", message: error.message })
      : encodeCapsuleVmJson({ code: "host_stream_aborted", message: "Host destroyed stream" });
    this.writeFrame({ kind: CapsuleVmFrameKind.StreamEnd, streamId, payload }, callback);
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);

    const streamId = this.allocateRequestStreamId();
    const payload = encodeCapsuleVmJson(params === undefined ? { method } : { method, params });
    const encoded = encodeCapsuleVmFrame({
      kind: CapsuleVmFrameKind.Request,
      streamId,
      payload,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(
          new CapsuleVmHostError("request_timeout", `VM helper request ${method} timed out`),
        );
      }, this.requestTimeoutMs);
      this.pending.set(streamId, { resolve, reject, timeout });
      this.child.stdin.write(encoded, (error) => {
        if (!error) return;
        this.fail(error);
      });
    });
  }

  private acceptFrame(frame: {
    kind: CapsuleVmFrameKind;
    streamId: number;
    payload: Uint8Array;
  }): void {
    switch (frame.kind) {
      case CapsuleVmFrameKind.Response:
        this.acceptResponse(frame.streamId, frame.payload);
        return;

      case CapsuleVmFrameKind.Event:
        this.acceptEvent(frame.streamId, frame.payload);
        return;

      case CapsuleVmFrameKind.StreamData:
        this.acceptStreamData(frame.streamId, frame.payload);
        return;

      case CapsuleVmFrameKind.StreamEnd:
        this.acceptStreamEnd(frame.streamId, frame.payload);
        return;

      default:
        throw new CapsuleVmProtocolError(
          "unexpected_frame_kind",
          `Unexpected helper frame kind ${frame.kind}`,
        );
    }
  }

  private acceptResponse(streamId: number, payload: Uint8Array): void {
    if (!isRequestStreamId(streamId)) {
      throw new CapsuleVmProtocolError("invalid_stream_id", "Response did not use a Host request stream ID");
    }
    const pending = this.pending.get(streamId);
    if (!pending) {
      throw new CapsuleVmProtocolError(
        "unknown_stream_id",
        `Response references unknown request ${streamId}`,
      );
    }

    const envelope = decodeCapsuleVmJson(payload);
    if (!isResponseEnvelope(envelope)) {
      throw new CapsuleVmProtocolError(
        "invalid_response",
        "Helper response does not match the response envelope",
      );
    }

    clearTimeout(pending.timeout);
    this.pending.delete(streamId);
    if (envelope.ok) {
      pending.resolve(envelope.result);
    } else {
      pending.reject(new CapsuleVmHostError(envelope.error!.code, envelope.error!.message));
    }
  }

  private acceptEvent(streamId: number, payload: Uint8Array): void {
    const event = decodeCapsuleVmEvent(payload);
    if (event.type !== "stream.open") {
      if (streamId !== 0) {
        throw new CapsuleVmProtocolError("invalid_stream_id", "VM lifecycle event must use stream 0");
      }
      if (event.type === "vm.state" && event.state === "starting") {
        // CONTROL is single-use within one Guest boot, not across the helper's
        // full lifetime. A new Host-observed boot starts a fresh admission epoch.
        this.controlStreamSeen = false;
      }
      this.emit("event", event);
      return;
    }

    if (!isHelperStreamId(streamId)) {
      throw new CapsuleVmProtocolError("invalid_stream_id", "Opened stream did not use a helper stream ID");
    }
    if (this.streams.has(streamId)) {
      throw new CapsuleVmProtocolError("duplicate_stream_id", `Helper reused open stream ${streamId}`);
    }
    if (this.streams.size >= CAPSULE_VM_MAX_OPEN_STREAMS) {
      throw new CapsuleVmProtocolError(
        "too_many_streams",
        `Helper exceeded ${CAPSULE_VM_MAX_OPEN_STREAMS} open streams`,
      );
    }
    if (event.channel === "control") {
      if (this.controlStreamSeen) {
        throw new CapsuleVmProtocolError(
          "duplicate_control_stream",
          "Helper opened more than one control stream in one boot",
        );
      }
      this.controlStreamSeen = true;
    }
    const stream = new CapsuleVmHostStream(
      this,
      { ...event, streamId },
      { readableHighWaterMark: this.streamHighWaterMarkBytes },
    );
    this.streams.set(streamId, stream);
    this.emit("stream", stream);
  }

  private acceptStreamData(streamId: number, payload: Uint8Array): void {
    if (!isHelperStreamId(streamId)) {
      throw new CapsuleVmProtocolError("invalid_stream_id", "Stream data did not use a helper stream ID");
    }
    if (payload.byteLength > CAPSULE_VM_STREAM_CHUNK_BYTES) {
      throw new CapsuleVmProtocolError(
        "stream_chunk_too_large",
        `Stream chunk exceeds ${CAPSULE_VM_STREAM_CHUNK_BYTES} bytes`,
      );
    }
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new CapsuleVmProtocolError("unknown_stream_id", `Data references unknown stream ${streamId}`);
    }
    if (this.drainingStreams.has(streamId)) return;
    stream.acceptData(payload);
  }

  private acceptStreamEnd(streamId: number, payload: Uint8Array): void {
    if (!isHelperStreamId(streamId)) {
      throw new CapsuleVmProtocolError("invalid_stream_id", "Stream end did not use a helper stream ID");
    }
    if (payload.byteLength > MAXIMUM_STREAM_END_PAYLOAD_BYTES) {
      throw new CapsuleVmProtocolError("invalid_stream_end", "Stream end payload is too large");
    }
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new CapsuleVmProtocolError("unknown_stream_id", `End references unknown stream ${streamId}`);
    }
    if (this.drainingStreams.delete(streamId)) {
      this.streams.delete(streamId);
      return;
    }
    stream.acceptEnd(parseStreamEndError(payload));
  }

  private writeStreamChunks(
    streamId: number,
    chunks: Uint8Array[],
    index: number,
    callback: (error?: Error | null) => void,
  ): void {
    if (index >= chunks.length) {
      callback();
      return;
    }
    this.writeFrame(
      { kind: CapsuleVmFrameKind.StreamData, streamId, payload: chunks[index] },
      (error) => {
        if (error) {
          callback(error);
        } else {
          this.writeStreamChunks(streamId, chunks, index + 1, callback);
        }
      },
    );
  }

  private writeFrame(
    frame: { kind: CapsuleVmFrameKind; streamId: number; payload: Uint8Array },
    callback: (error?: Error | null) => void,
  ): void {
    if (this.closedError) {
      callback(this.closedError);
      return;
    }
    let encoded: Uint8Array;
    try {
      encoded = encodeCapsuleVmFrame(frame);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.child.stdin.write(encoded, (error) => {
      if (error) this.fail(error);
      callback(error);
    });
  }

  private allocateRequestStreamId(): number {
    const requestIdCount = CAPSULE_VM_REQUEST_STREAM_ID_MAX - CAPSULE_VM_REQUEST_STREAM_ID_MIN + 1;
    for (let attempts = 0; attempts < requestIdCount; attempts += 1) {
      const candidate = this.nextRequestStreamId;
      this.nextRequestStreamId = candidate === CAPSULE_VM_REQUEST_STREAM_ID_MAX
        ? CAPSULE_VM_REQUEST_STREAM_ID_MIN
        : candidate + 1;
      if (!this.pending.has(candidate)) return candidate;
    }
    throw new CapsuleVmHostError("stream_id_exhausted", "No helper request stream IDs remain");
  }

  private fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const stream of this.streams.values()) stream.failFromOwner(error);
    this.streams.clear();
    this.drainingStreams.clear();
    this.child.stdin.destroy();
    if (!this.child.killed) this.child.kill();
    this.emit("close", error);
  }
}

export interface LaunchCapsuleVmHostOptions extends CapsuleVmHostClientOptions {
  executablePath: string;
  spawnProcess?: typeof spawn;
}

export function launchCapsuleVmHost(options: LaunchCapsuleVmHostOptions): CapsuleVmHostClient {
  if (!isAbsolute(options.executablePath)) {
    throw new CapsuleVmHostError(
      "invalid_helper_path",
      "VM helper executable path must be absolute",
    );
  }

  const spawnProcess = options.spawnProcess ?? spawn;
  const spawnOptions: SpawnOptions = {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
  };
  const child = spawnProcess(options.executablePath, [], spawnOptions);
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new CapsuleVmHostError("invalid_helper_stdio", "VM helper did not expose piped stdio");
  }
  return new CapsuleVmHostClient(child as ChildProcessWithoutNullStreams, options);
}

function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (!isPlainObject(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) return hasExactKeys(value, ["ok", "result"]);
  if (!hasExactKeys(value, ["ok", "error"]) || !isPlainObject(value.error)) return false;
  return hasExactKeys(value.error, ["code", "message"])
    && typeof value.error.code === "string"
    && value.error.code.length > 0
    && typeof value.error.message === "string"
    && value.error.message.length > 0;
}

function isProbeResult(value: unknown): value is CapsuleVmProbeResult {
  if (!isPlainObject(value) || !hasExactKeys(
    value,
    ["protocolVersion", "hostArchitecture", "virtualizationSupported"],
  )) return false;
  return value.protocolVersion === CAPSULE_VM_PROTOCOL_VERSION
    && typeof value.hostArchitecture === "string"
    && typeof value.virtualizationSupported === "boolean";
}

function isStartResult(value: unknown): value is CapsuleVmStartResult {
  if (!isPlainObject(value) || !hasExactKeys(
    value,
    ["protocolVersion", "state", "imageDigest", "architecture"],
  )) return false;
  return value.protocolVersion === CAPSULE_VM_PROTOCOL_VERSION
    && value.state === "running"
    && typeof value.imageDigest === "string"
    && (value.architecture === "arm64" || value.architecture === "x86_64");
}

function isStopResult(value: unknown): value is CapsuleVmStopResult {
  return isPlainObject(value) && hasExactKeys(value, ["state"]) && value.state === "stopped";
}

function hasCompleteGuestImage(image: CapsuleVmGuestImage): boolean {
  return isAbsolute(image.imageBundlePath)
    && isAbsolute(image.stateDirectory)
    && /^sha256:[0-9a-f]{64}$/.test(image.expectedManifestDigest)
    && /^[A-Za-z0-9+/]{43}=$/.test(image.manifestPublicKey)
    && Number.isSafeInteger(image.cpuCount)
    && image.cpuCount >= 1
    && image.cpuCount <= MAXIMUM_VM_CPU_COUNT
    && Number.isSafeInteger(image.memorySizeBytes)
    && image.memorySizeBytes >= MINIMUM_VM_MEMORY_BYTES
    && image.memorySizeBytes <= MAXIMUM_VM_MEMORY_BYTES;
}

function parseStreamEndError(payload: Uint8Array): CapsuleVmHostError | undefined {
  if (payload.byteLength === 0) return undefined;
  const value = decodeCapsuleVmJson(payload);
  if (!isPlainObject(value) || !hasExactKeys(value, ["code", "message"])
    || typeof value.code !== "string" || value.code.length === 0
    || typeof value.message !== "string" || value.message.length === 0) {
    throw new CapsuleVmProtocolError("invalid_stream_end", "Stream end error is invalid");
  }
  return new CapsuleVmHostError(value.code, value.message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
