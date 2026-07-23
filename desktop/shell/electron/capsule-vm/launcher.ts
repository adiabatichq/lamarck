import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import { Duplex, type DuplexOptions } from "node:stream";
import {
  CAPSULE_STATE_CAPACITY_MAX_BYTES,
  CAPSULE_STATE_CAPACITY_MIN_BYTES,
  CAPSULE_STORAGE_ALIGNMENT_BYTES,
} from "../../../capsule/src/storage-plan";
import {
  CAPSULE_VM_MAX_OPEN_STREAMS,
  CAPSULE_VM_MAX_PENDING_REQUESTS,
  CAPSULE_VM_MAX_RESET_TOMBSTONES,
  CAPSULE_VM_PROTOCOL_VERSION,
  CAPSULE_VM_REQUEST_STREAM_ID_MAX,
  CAPSULE_VM_REQUEST_STREAM_ID_MIN,
  CAPSULE_VM_STREAM_CHUNK_BYTES,
  CAPSULE_VM_STREAM_WINDOW_BYTES,
  CapsuleVmFrameDecoder,
  CapsuleVmFrameKind,
  type CapsuleVmEvent,
  type CapsuleVmFrame,
  type CapsuleVmStreamOpenEvent,
  CapsuleVmProtocolError,
  decodeCapsuleVmEvent,
  decodeCapsuleVmJson,
  decodeCapsuleVmWindowUpdate,
  encodeCapsuleVmFrame,
  encodeCapsuleVmJson,
  encodeCapsuleVmWindowUpdate,
  isHelperStreamId,
  isRequestStreamId,
} from "./protocol";

const MINIMUM_VM_MEMORY_BYTES = 512 * 1024 * 1024;
const MAXIMUM_VM_MEMORY_BYTES = 64 * 1024 * 1024 * 1024;
const MAXIMUM_VM_CPU_COUNT = 64;
const MAXIMUM_RESET_PAYLOAD_BYTES = 4 * 1024;
const VM_START_BASE_TIMEOUT_MS = 60_000;
const VM_START_TIMEOUT_PER_GIBIBYTE_MS = 15_000;
const GIBIBYTE = 1024 * 1024 * 1024;

type LocalDirectionState = "open" | "fin-queued" | "fin-sent" | "reset-queued";
type RemoteDirectionState = "open" | "fin-received" | "reset-received";

interface PendingStreamWrite {
  bytes: Buffer;
  offset: number;
  callback: (error?: Error | null) => void;
}

interface ActiveStreamState {
  stream: CapsuleVmHostStream;
  local: LocalDirectionState;
  remote: RemoteDirectionState;
  sendCreditBytes: number;
  receiveCreditBytes: number;
  pendingWindowUpdateBytes: number;
  pendingWrite: PendingStreamWrite | null;
  remoteResetSeen: boolean;
}

interface ResetTombstone {
  awaitingAck: boolean;
  remoteResetSeen: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

interface ScheduledFrame {
  frame: CapsuleVmFrame;
  complete: (error?: Error | null) => void;
}

interface ResponseEnvelope {
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface CapsuleVmProbeResult {
  protocolVersion: number;
  hostArchitecture: string;
  virtualizationSupported: boolean;
}

/** Trusted Host descriptor. Artifact filenames are selected only by the signed manifest. */
export interface CapsuleVmGuestImageBase {
  imageBundlePath: string;
  stateDirectory: string;
  expectedManifestDigest: string;
  /** Base64-encoded 32-byte Ed25519 public key pinned by the trusted Host release descriptor. */
  manifestPublicKey: string;
  cpuCount: number;
  memorySizeBytes: number;
}

/** Complete trusted start descriptor. Capacity is selected by Host admission. */
export interface CapsuleVmGuestImage extends CapsuleVmGuestImageBase {
  stateDiskBytes: number;
  statePreparationId: string;
}

export interface CapsuleVmStatePreparationResult {
  preparationId: string;
  stateDiskBytes: number;
  existingPhysicalBytes: number;
  additionalPhysicalBytes: number;
  peakPhysicalBytes: number;
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

export interface CapsuleVmHostClientOptions {
  requestTimeoutMs?: number;
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

  private terminalFromOwner = false;
  private readonly emittedCreditDuringRead: number[] = [];

  constructor(
    private readonly owner: CapsuleVmHostClient,
    info: CapsuleVmStreamOpenEvent & { streamId: number },
    options: DuplexOptions,
  ) {
    super({
      ...options,
      allowHalfOpen: true,
      // LCVM FIN is directional. Node's default async iterator destroys a
      // Readable when its iterator completes, which would turn a clean Guest
      // FIN into RESET before the Host has sent its own FIN. Retire explicitly
      // only after both Duplex directions have completed instead.
      autoDestroy: false,
      readableHighWaterMark: CAPSULE_VM_STREAM_WINDOW_BYTES,
      writableHighWaterMark: CAPSULE_VM_STREAM_WINDOW_BYTES,
    });
    this.streamId = info.streamId;
    this.channel = info.channel;
    this.sourcePort = info.sourcePort;
    this.destinationPort = info.destinationPort;
    // A Guest reset must not crash Electron if the consumer has not attached
    // an error listener to a newly opened, untrusted stream yet.
    this.on("error", () => {});
    this.once("end", () => this.destroyAfterDirectionalFinish());
    this.once("finish", () => this.destroyAfterDirectionalFinish());
  }

  override read(size?: number): any {
    this.emittedCreditDuringRead.push(0);
    let value: any;
    let emittedBytes: number;
    try {
      value = super.read(size);
    } finally {
      emittedBytes = this.emittedCreditDuringRead.pop() ?? 0;
    }
    if (value !== null) {
      const consumedBytes = typeof value === "string"
        ? Buffer.byteLength(value)
        : value.byteLength;
      const uncreditedBytes = consumedBytes - emittedBytes;
      if (uncreditedBytes > 0) this.owner.returnReceiveCredit(this.streamId, uncreditedBytes);
    }
    return value;
  }

  override emit(eventName: string | symbol, ...args: any[]): boolean {
    if (eventName !== "data") return super.emit(eventName, ...args);
    const value = args[0];
    const consumedBytes = typeof value === "string"
      ? Buffer.byteLength(value)
      : value instanceof Uint8Array
        ? value.byteLength
        : 0;
    const emitted = super.emit(eventName, ...args);
    if (emitted && consumedBytes > 0) {
      const readIndex = this.emittedCreditDuringRead.length - 1;
      if (readIndex >= 0) this.emittedCreditDuringRead[readIndex] += consumedBytes;
      this.owner.returnReceiveCredit(this.streamId, consumedBytes);
    }
    return emitted;
  }

  _read(): void {
    // Consumption is accounted by read() for paused/manual consumers and by
    // emit("data") after flowing consumers accept a pushed chunk. Merely
    // parsing or buffering DATA never returns credit to the helper.
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
    this.owner.finishStream(this.streamId, callback);
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.terminalFromOwner) {
      callback();
      return;
    }
    this.owner.destroyStream(this.streamId, error ?? undefined, callback);
  }

  acceptData(payload: Uint8Array): void {
    if (!this.destroyed) this.push(Buffer.from(payload));
  }

  acceptFin(): void {
    if (!this.destroyed) this.push(null);
  }

  acceptReset(error: CapsuleVmHostError): void {
    this.terminalFromOwner = true;
    this.destroy(error);
  }

  failFromOwner(error: Error): void {
    this.terminalFromOwner = true;
    this.destroy(error);
  }

  private destroyAfterDirectionalFinish(): void {
    if (this.destroyed || !this.readableEnded || !this.writableFinished) return;
    this.terminalFromOwner = true;
    this.destroy();
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
  private readonly streams = new Map<number, ActiveStreamState>();
  private readonly resetTombstones = new Map<number, ResetTombstone>();
  private readonly urgentFrames: ScheduledFrame[] = [];
  private readonly requestTimeoutMs: number;
  private nextRequestStreamId = CAPSULE_VM_REQUEST_STREAM_ID_MIN;
  private nextWindowStreamIndex = 0;
  private nextDataStreamIndex = 0;
  private controlStreamSeen = false;
  private outputWriteInFlight: ScheduledFrame | null = null;
  private closedError: Error | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: CapsuleVmHostClientOptions = {},
  ) {
    super();
    this.requestTimeoutMs = boundedTimeout(options.requestTimeoutMs ?? 10_000, "requestTimeoutMs");

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
      this.fail(new CapsuleVmHostError(
        "helper_exited",
        `VM helper exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      ));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", options.onLog ?? (() => {}));
  }

  get openStreamCount(): number {
    return this.streams.size;
  }

  async probe(): Promise<CapsuleVmProbeResult> {
    const value = await this.request("probe");
    if (!isProbeResult(value)) {
      throw new CapsuleVmProtocolError("invalid_probe_response", "Helper returned an invalid probe result");
    }
    return value;
  }

  async prepareState(options: {
    stateDirectory: string;
    stateDiskBytes: number;
  }): Promise<CapsuleVmStatePreparationResult> {
    if (!hasCompleteStatePreparationRequest(options)) {
      throw new CapsuleVmHostError(
        "state_preparation_required",
        "Preparing the Capsule VM state disk requires an absolute path and bounded aligned size",
      );
    }
    const value = await this.request("prepareState", options);
    if (!isStatePreparationResult(value) || value.stateDiskBytes !== options.stateDiskBytes) {
      throw new CapsuleVmProtocolError(
        "invalid_state_preparation_response",
        "Helper returned invalid state-disk admission requirements",
      );
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
    const {
      stateDirectory: _stateDirectory,
      stateDiskBytes: _stateDiskBytes,
      ...preparedImage
    } = image;
    const value = await this.request(
      "start",
      preparedImage,
      stateMaterializationTimeoutMs(image.stateDiskBytes),
    );
    if (!isStartResult(value) || value.imageDigest !== image.expectedManifestDigest) {
      throw new CapsuleVmProtocolError(
        "invalid_start_response",
        "Helper returned an invalid or image-mismatched Guest start result",
      );
    }
    return value;
  }

  async cancelStatePreparation(preparationId: string): Promise<void> {
    if (!isCanonicalPreparationId(preparationId)) {
      throw new CapsuleVmHostError(
        "state_preparation_required",
        "Cancelling state preparation requires its canonical opaque ID",
      );
    }
    const value = await this.request("cancelStatePreparation", { preparationId });
    if (!isPlainObject(value) || !hasExactKeys(value, ["state"]) || value.state !== "cancelled") {
      throw new CapsuleVmProtocolError(
        "invalid_state_preparation_response",
        "Helper returned an invalid state-preparation cancellation result",
      );
    }
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
    const state = this.streams.get(streamId);
    if (this.closedError || !state || state.local !== "open") {
      callback(this.closedError ?? new CapsuleVmHostError(
        "stream_closed",
        `VM helper stream ${streamId} is not open for DATA`,
      ));
      return;
    }
    if (payload.byteLength === 0) {
      callback();
      return;
    }
    if (payload.byteLength > CAPSULE_VM_STREAM_WINDOW_BYTES) {
      callback(new CapsuleVmHostError(
        "stream_write_too_large",
        `One stream write may not exceed ${CAPSULE_VM_STREAM_WINDOW_BYTES} bytes`,
      ));
      return;
    }
    if (state.pendingWrite) {
      callback(new CapsuleVmHostError(
        "stream_write_queue_invariant",
        `VM helper stream ${streamId} already has a pending write`,
      ));
      return;
    }
    state.pendingWrite = {
      bytes: Buffer.from(payload),
      offset: 0,
      callback: onceCallback(callback),
    };
    this.pumpOutput();
  }

  finishStream(streamId: number, callback: (error?: Error | null) => void): void {
    const state = this.streams.get(streamId);
    if (this.closedError || !state || state.local !== "open" || state.pendingWrite) {
      callback(this.closedError ?? new CapsuleVmHostError(
        "stream_closed",
        `VM helper stream ${streamId} cannot send FIN`,
      ));
      return;
    }
    state.local = "fin-queued";
    this.enqueueUrgent(
      { kind: CapsuleVmFrameKind.Fin, streamId, payload: new Uint8Array() },
      (error) => {
        if (!error) {
          const current = this.streams.get(streamId);
          if (current?.local === "fin-queued") {
            current.local = "fin-sent";
            this.retireNormallyFinishedStream(streamId);
          }
        }
        callback(error);
      },
    );
  }

  destroyStream(
    streamId: number,
    error: Error | undefined,
    callback: (error?: Error | null) => void,
  ): void {
    const state = this.streams.get(streamId);
    if (!state) {
      callback();
      return;
    }
    if (state.local === "fin-sent" && state.remote === "fin-received") {
      this.retireNormallyFinishedStream(streamId);
      callback();
      return;
    }
    if (!error && state.local === "fin-queued" && state.remote === "fin-received") {
      // A clean owner close after both application-facing directions finished
      // must not revoke the FIN already requested by _final(). The helper may
      // have physically applied that FIN and begun its irrevocable LVRM CLOSE
      // before Node runs the stdin completion callback which advances this
      // state to fin-sent. Preserve the queued/in-flight FIN; its completion
      // and the exact applied-DATA credit drain retire the LCVM stream.
      callback();
      return;
    }
    if (state.local === "reset-queued") {
      callback();
      return;
    }

    state.local = "reset-queued";
    const resetError = error ?? new CapsuleVmHostError(
      "host_stream_aborted",
      "Host destroyed stream before both directions reached FIN",
    );
    if (state.pendingWrite) {
      state.pendingWrite.callback(resetError);
      state.pendingWrite = null;
    }
    // RESET may overtake only a FIN which has already entered the physical
    // writer. A merely queued FIN is still local intent and must be withdrawn,
    // otherwise the peer observes a terminal FIN followed by RESET.
    this.cancelQueuedFin(streamId, resetError);
    this.enqueueUrgent(
      {
        kind: CapsuleVmFrameKind.Reset,
        streamId,
        payload: encodeResetPayload("host_stream_aborted", resetError.message),
      },
      (writeError) => {
        // Keep reset-queued authority and credit state until RESET_ACK. Swift
        // may still return credit or finish one frame already on the wire.
        callback(writeError);
      },
    );
  }

  returnReceiveCredit(streamId: number, consumedBytes: number): void {
    const state = this.streams.get(streamId);
    // Once the peer has sent FIN or RESET it cannot send more DATA, so returning
    // credit would be useless and could race retirement of the stream.
    if (!state || state.remote !== "open" || state.local === "reset-queued") return;
    const outstanding = CAPSULE_VM_STREAM_WINDOW_BYTES
      - state.receiveCreditBytes
      - state.pendingWindowUpdateBytes;
    if (!Number.isSafeInteger(consumedBytes) || consumedBytes < 1 || consumedBytes > outstanding) {
      this.fail(new CapsuleVmProtocolError(
        "receive_credit_overflow",
        `Node consumed invalid credit for stream ${streamId}`,
      ));
      return;
    }
    state.pendingWindowUpdateBytes += consumedBytes;
    this.pumpOutput();
  }

  private request(
    method: string,
    params?: unknown,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (this.pending.size >= CAPSULE_VM_MAX_PENDING_REQUESTS) {
      return Promise.reject(new CapsuleVmHostError(
        "too_many_pending_requests",
        `VM helper client already has ${CAPSULE_VM_MAX_PENDING_REQUESTS} pending requests`,
      ));
    }

    const streamId = this.allocateRequestStreamId();
    const payload = encodeCapsuleVmJson(params === undefined ? { method } : { method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(streamId, { resolve, reject });
      this.enqueueUrgent(
        { kind: CapsuleVmFrameKind.Request, streamId, payload },
        (error) => {
          if (error) {
            this.fail(error);
            return;
          }
          // Queueing is not a request deadline. Arm it only after Node has
          // confirmed that the complete REQUEST frame left the Host writer;
          // otherwise a congested DATA stream could time out CONTROL work
          // which the helper has not received yet.
          const pending = this.pending.get(streamId);
          if (!pending) return;
          pending.timeout = setTimeout(() => {
            this.fail(new CapsuleVmHostError(
              "request_timeout",
              `VM helper request ${method} timed out`,
            ));
          }, timeoutMs);
        },
      );
    });
  }

  private acceptFrame(frame: CapsuleVmFrame): void {
    switch (frame.kind) {
      case CapsuleVmFrameKind.Response:
        this.acceptResponse(frame.streamId, frame.payload);
        return;
      case CapsuleVmFrameKind.Event:
        this.acceptEvent(frame.streamId, frame.payload);
        return;
      case CapsuleVmFrameKind.Data:
        this.acceptStreamData(frame.streamId, frame.payload);
        return;
      case CapsuleVmFrameKind.WindowUpdate:
        this.acceptWindowUpdate(frame.streamId, frame.payload);
        return;
      case CapsuleVmFrameKind.Fin:
        this.acceptFin(frame.streamId, frame.payload);
        return;
      case CapsuleVmFrameKind.Reset:
        this.acceptReset(frame.streamId, frame.payload);
        return;
      case CapsuleVmFrameKind.ResetAck:
        this.acceptResetAck(frame.streamId, frame.payload);
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
      throw new CapsuleVmProtocolError("unknown_stream_id", `Response references unknown request ${streamId}`);
    }
    const envelope = decodeCapsuleVmJson(payload);
    if (!isResponseEnvelope(envelope)) {
      throw new CapsuleVmProtocolError("invalid_response", "Helper response does not match the response envelope");
    }
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pending.delete(streamId);
    if (envelope.ok) pending.resolve(envelope.result);
    else pending.reject(new CapsuleVmHostError(envelope.error!.code, envelope.error!.message));
  }

  private acceptEvent(streamId: number, payload: Uint8Array): void {
    const event = decodeCapsuleVmEvent(payload);
    if (event.type !== "stream.open") {
      if (streamId !== 0) {
        throw new CapsuleVmProtocolError("invalid_stream_id", "VM lifecycle event must use stream 0");
      }
      if (event.type === "vm.state" && event.state === "starting") {
        this.controlStreamSeen = false;
      }
      this.emit("event", event);
      return;
    }

    if (!isHelperStreamId(streamId)) {
      throw new CapsuleVmProtocolError("invalid_stream_id", "Opened stream did not use a helper stream ID");
    }
    if (this.streams.has(streamId) || this.resetTombstones.has(streamId)) {
      throw new CapsuleVmProtocolError("duplicate_stream_id", `Helper reused stream ${streamId}`);
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
    const stream = new CapsuleVmHostStream(this, { ...event, streamId }, {});
    this.streams.set(streamId, {
      stream,
      local: "open",
      remote: "open",
      sendCreditBytes: CAPSULE_VM_STREAM_WINDOW_BYTES,
      receiveCreditBytes: CAPSULE_VM_STREAM_WINDOW_BYTES,
      pendingWindowUpdateBytes: 0,
      pendingWrite: null,
      remoteResetSeen: false,
    });
    this.emit("stream", stream);
  }

  private acceptStreamData(streamId: number, payload: Uint8Array): void {
    this.assertLiveHelperStreamId(streamId);
    const state = this.streams.get(streamId)!;
    if (payload.byteLength < 1 || payload.byteLength > CAPSULE_VM_STREAM_CHUNK_BYTES) {
      throw new CapsuleVmProtocolError(
        "invalid_data_size",
        `DATA must contain 1..${CAPSULE_VM_STREAM_CHUNK_BYTES} bytes`,
      );
    }
    if (state.remote !== "open") {
      throw new CapsuleVmProtocolError("data_after_fin", `Helper sent DATA after terminal state on stream ${streamId}`);
    }
    if (payload.byteLength > state.receiveCreditBytes) {
      throw new CapsuleVmProtocolError(
        "receive_window_exceeded",
        `Helper exceeded the ${CAPSULE_VM_STREAM_WINDOW_BYTES}-byte receive window on stream ${streamId}`,
      );
    }
    state.receiveCreditBytes -= payload.byteLength;
    if (state.local !== "reset-queued") state.stream.acceptData(payload);
  }

  private acceptWindowUpdate(streamId: number, payload: Uint8Array): void {
    this.assertLiveHelperStreamId(streamId);
    const state = this.streams.get(streamId)!;
    const creditBytes = decodeCapsuleVmWindowUpdate(payload);
    if (creditBytes > CAPSULE_VM_STREAM_WINDOW_BYTES - state.sendCreditBytes) {
      throw new CapsuleVmProtocolError(
        "send_credit_overflow",
        `WINDOW_UPDATE overflowed stream ${streamId} send credit`,
      );
    }
    state.sendCreditBytes += creditBytes;
    // RESET may overtake credit already earned by DATA physically applied in
    // Swift. Keep the exact ledger live through RESET_ACK, but never use that
    // late bookkeeping to resume a reset direction.
    if (state.local === "reset-queued") return;
    this.retireNormallyFinishedStream(streamId);
    this.pumpOutput();
  }

  private acceptFin(streamId: number, payload: Uint8Array): void {
    this.assertLiveHelperStreamId(streamId);
    if (payload.byteLength !== 0) {
      throw new CapsuleVmProtocolError("invalid_fin", "FIN payload must be empty");
    }
    const state = this.streams.get(streamId)!;
    if (state.remote !== "open") {
      throw new CapsuleVmProtocolError("duplicate_fin", `Helper sent duplicate FIN on stream ${streamId}`);
    }
    state.remote = "fin-received";
    if (state.local !== "reset-queued") state.stream.acceptFin();
    this.retireNormallyFinishedStream(streamId);
  }

  private acceptReset(streamId: number, payload: Uint8Array): void {
    this.assertHelperStreamId(streamId);
    const resetError = parseResetError(payload);
    const tombstone = this.resetTombstones.get(streamId);
    if (tombstone) {
      if (tombstone.remoteResetSeen) {
        throw new CapsuleVmProtocolError("duplicate_reset", `Helper sent duplicate RESET on stream ${streamId}`);
      }
      tombstone.remoteResetSeen = true;
      this.enqueueUrgent(
        { kind: CapsuleVmFrameKind.ResetAck, streamId, payload: new Uint8Array() },
        () => {},
      );
      return;
    }

    const state = this.streams.get(streamId);
    if (!state) {
      throw new CapsuleVmProtocolError("unknown_stream_id", `RESET references unknown stream ${streamId}`);
    }
    if (state.remoteResetSeen || state.remote === "reset-received") {
      throw new CapsuleVmProtocolError("duplicate_reset", `Helper sent duplicate RESET on stream ${streamId}`);
    }
    state.remoteResetSeen = true;
    state.remote = "reset-received";
    state.stream.acceptReset(resetError);
    if (state.pendingWrite) {
      state.pendingWrite.callback(resetError);
      state.pendingWrite = null;
    }
    this.cancelQueuedFin(streamId, resetError);

    if (state.local === "reset-queued") {
      this.enqueueUrgent(
        { kind: CapsuleVmFrameKind.ResetAck, streamId, payload: new Uint8Array() },
        () => {},
      );
    } else {
      this.streams.delete(streamId);
      this.addResetTombstone(streamId, { awaitingAck: false, remoteResetSeen: true });
      this.enqueueUrgent(
        { kind: CapsuleVmFrameKind.ResetAck, streamId, payload: new Uint8Array() },
        () => {},
      );
    }
  }

  private acceptResetAck(streamId: number, payload: Uint8Array): void {
    this.assertHelperStreamId(streamId);
    if (payload.byteLength !== 0) {
      throw new CapsuleVmProtocolError("invalid_reset_ack", "RESET_ACK payload must be empty");
    }
    let tombstone = this.resetTombstones.get(streamId);
    if (!tombstone) {
      const active = this.streams.get(streamId);
      if (active?.local === "reset-queued") {
        this.streams.delete(streamId);
        this.addResetTombstone(streamId, {
          awaitingAck: true,
          remoteResetSeen: active.remoteResetSeen,
        });
        tombstone = this.resetTombstones.get(streamId);
      }
    }
    if (!tombstone || !tombstone.awaitingAck) {
      throw new CapsuleVmProtocolError("unexpected_reset_ack", `Unexpected RESET_ACK on stream ${streamId}`);
    }
    tombstone.awaitingAck = false;
  }

  private enqueueUrgent(
    frame: CapsuleVmFrame,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.closedError) {
      callback(this.closedError);
      return;
    }
    this.urgentFrames.push({ frame, complete: onceCallback(callback) });
    this.pumpOutput();
  }

  private pumpOutput(): void {
    if (this.closedError || this.outputWriteInFlight) return;
    let scheduled: ScheduledFrame | undefined;
    try {
      scheduled = this.takeNextFrame();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!scheduled) return;

    let encoded: Uint8Array;
    try {
      encoded = encodeCapsuleVmFrame(scheduled.frame);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      scheduled.complete(failure);
      this.fail(failure);
      return;
    }

    this.outputWriteInFlight = scheduled;
    this.child.stdin.write(encoded, (error) => {
      if (this.outputWriteInFlight === scheduled) this.outputWriteInFlight = null;
      scheduled.complete(error);
      if (error) {
        this.fail(error);
      } else {
        this.pumpOutput();
      }
    });
  }

  private takeNextFrame(): ScheduledFrame | undefined {
    const urgent = this.urgentFrames.shift();
    if (urgent) return urgent;

    const windowState = this.findRoundRobinState(
      (state) => state.pendingWindowUpdateBytes > 0 && state.local !== "reset-queued",
      "window",
    );
    if (windowState) {
      const [streamId, state] = windowState;
      const creditBytes = state.pendingWindowUpdateBytes;
      state.pendingWindowUpdateBytes = 0;
      state.receiveCreditBytes += creditBytes;
      if (state.receiveCreditBytes > CAPSULE_VM_STREAM_WINDOW_BYTES) {
        throw new CapsuleVmProtocolError("receive_credit_overflow", `Receive credit overflow on stream ${streamId}`);
      }
      return {
        frame: {
          kind: CapsuleVmFrameKind.WindowUpdate,
          streamId,
          payload: encodeCapsuleVmWindowUpdate(creditBytes),
        },
        complete: () => {},
      };
    }

    const dataState = this.findRoundRobinState(
      (state) => state.local === "open"
        && state.sendCreditBytes > 0
        && state.pendingWrite !== null,
      "data",
    );
    if (!dataState) return undefined;
    const [streamId, state] = dataState;
    const pending = state.pendingWrite!;
    const bytes = Math.min(
      CAPSULE_VM_STREAM_CHUNK_BYTES,
      state.sendCreditBytes,
      pending.bytes.byteLength - pending.offset,
    );
    const payload = pending.bytes.subarray(pending.offset, pending.offset + bytes);
    pending.offset += bytes;
    state.sendCreditBytes -= bytes;
    return {
      frame: { kind: CapsuleVmFrameKind.Data, streamId, payload },
      complete: (error) => {
        if (error) return;
        const current = this.streams.get(streamId);
        if (!current || current.pendingWrite !== pending) return;
        if (pending.offset === pending.bytes.byteLength) {
          current.pendingWrite = null;
          pending.callback();
        }
      },
    };
  }

  private findRoundRobinState(
    predicate: (state: ActiveStreamState) => boolean,
    kind: "window" | "data",
  ): [number, ActiveStreamState] | undefined {
    const entries = [...this.streams.entries()];
    if (entries.length === 0) return undefined;
    const cursor = kind === "window" ? this.nextWindowStreamIndex : this.nextDataStreamIndex;
    for (let attempt = 0; attempt < entries.length; attempt += 1) {
      const index = (cursor + attempt) % entries.length;
      const entry = entries[index];
      if (!predicate(entry[1])) continue;
      if (kind === "window") this.nextWindowStreamIndex = (index + 1) % entries.length;
      else this.nextDataStreamIndex = (index + 1) % entries.length;
      return entry;
    }
    return undefined;
  }

  private retireNormallyFinishedStream(streamId: number): void {
    const state = this.streams.get(streamId);
    if (state?.local === "fin-sent"
      && state.remote === "fin-received"
      && state.sendCreditBytes === CAPSULE_VM_STREAM_WINDOW_BYTES) {
      this.streams.delete(streamId);
    }
  }

  private cancelQueuedFin(streamId: number, error: Error): void {
    for (let index = this.urgentFrames.length - 1; index >= 0; index -= 1) {
      const scheduled = this.urgentFrames[index];
      if (scheduled.frame.streamId !== streamId
        || scheduled.frame.kind !== CapsuleVmFrameKind.Fin) continue;
      this.urgentFrames.splice(index, 1);
      scheduled.complete(error);
    }
  }

  private addResetTombstone(streamId: number, tombstone: ResetTombstone): void {
    if (!this.resetTombstones.has(streamId)
      && this.resetTombstones.size >= CAPSULE_VM_MAX_RESET_TOMBSTONES) {
      this.fail(new CapsuleVmProtocolError(
        "too_many_reset_tombstones",
        `Helper exceeded ${CAPSULE_VM_MAX_RESET_TOMBSTONES} reset tombstones`,
      ));
      return;
    }
    this.resetTombstones.set(streamId, tombstone);
  }

  private assertLiveHelperStreamId(streamId: number): void {
    this.assertHelperStreamId(streamId);
    if (this.resetTombstones.has(streamId)) {
      throw new CapsuleVmProtocolError("frame_after_reset", `Frame followed RESET on stream ${streamId}`);
    }
    if (!this.streams.has(streamId)) {
      throw new CapsuleVmProtocolError("unknown_stream_id", `Frame references unknown stream ${streamId}`);
    }
  }

  private assertHelperStreamId(streamId: number): void {
    if (!isHelperStreamId(streamId)) {
      throw new CapsuleVmProtocolError("invalid_stream_id", "Stream frame did not use a helper stream ID");
    }
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
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const scheduled of this.urgentFrames.splice(0)) scheduled.complete(error);
    this.outputWriteInFlight?.complete(error);
    this.outputWriteInFlight = null;
    for (const state of this.streams.values()) {
      state.stream.failFromOwner(error);
      state.pendingWrite?.callback(error);
      state.pendingWrite = null;
    }
    this.streams.clear();
    this.resetTombstones.clear();
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
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
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

function isStatePreparationResult(value: unknown): value is CapsuleVmStatePreparationResult {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "preparationId",
    "stateDiskBytes",
    "existingPhysicalBytes",
    "additionalPhysicalBytes",
    "peakPhysicalBytes",
  ])) return false;
  if (!isCanonicalPreparationId(value.preparationId)
    || !isValidStateDiskBytes(value.stateDiskBytes)
    || !isNonnegativeSafeInteger(value.existingPhysicalBytes)
    || !isNonnegativeSafeInteger(value.additionalPhysicalBytes)
    || !isNonnegativeSafeInteger(value.peakPhysicalBytes)) return false;
  return value.existingPhysicalBytes + value.additionalPhysicalBytes
    === value.peakPhysicalBytes;
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
    && image.memorySizeBytes <= MAXIMUM_VM_MEMORY_BYTES
    && Number.isSafeInteger(image.stateDiskBytes)
    && image.stateDiskBytes >= CAPSULE_STATE_CAPACITY_MIN_BYTES
    && image.stateDiskBytes <= CAPSULE_STATE_CAPACITY_MAX_BYTES
    && image.stateDiskBytes % CAPSULE_STORAGE_ALIGNMENT_BYTES === 0
    && isCanonicalPreparationId(image.statePreparationId);
}

function hasCompleteStatePreparationRequest(options: {
  stateDirectory: string;
  stateDiskBytes: number;
}): boolean {
  return isAbsolute(options.stateDirectory) && isValidStateDiskBytes(options.stateDiskBytes);
}

function isValidStateDiskBytes(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= CAPSULE_STATE_CAPACITY_MIN_BYTES
    && (value as number) <= CAPSULE_STATE_CAPACITY_MAX_BYTES
    && (value as number) % CAPSULE_STORAGE_ALIGNMENT_BYTES === 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCanonicalPreparationId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function boundedTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60_000) {
    throw new Error(`${label} must be between 1 ms and 1 hour`);
  }
  return value;
}

function stateMaterializationTimeoutMs(stateDiskBytes: number): number {
  const gibibytes = Math.ceil(stateDiskBytes / GIBIBYTE);
  return boundedTimeout(
    VM_START_BASE_TIMEOUT_MS + gibibytes * VM_START_TIMEOUT_PER_GIBIBYTE_MS,
    "derived VM start timeout",
  );
}

function encodeResetPayload(code: string, message: string): Uint8Array {
  const payload = encodeCapsuleVmJson({ code, message });
  if (payload.byteLength > MAXIMUM_RESET_PAYLOAD_BYTES) {
    return encodeCapsuleVmJson({ code: "host_stream_aborted", message: "Host aborted stream" });
  }
  return payload;
}

function parseResetError(payload: Uint8Array): CapsuleVmHostError {
  if (payload.byteLength < 1 || payload.byteLength > MAXIMUM_RESET_PAYLOAD_BYTES) {
    throw new CapsuleVmProtocolError("invalid_reset", "RESET payload size is invalid");
  }
  const value = decodeCapsuleVmJson(payload);
  if (!isPlainObject(value) || !hasExactKeys(value, ["code", "message"])
    || typeof value.code !== "string" || value.code.length === 0
    || typeof value.message !== "string" || value.message.length === 0) {
    throw new CapsuleVmProtocolError("invalid_reset", "RESET error is invalid");
  }
  return new CapsuleVmHostError(value.code, value.message);
}

function onceCallback(
  callback: (error?: Error | null) => void,
): (error?: Error | null) => void {
  let called = false;
  return (error) => {
    if (called) return;
    called = true;
    callback(error);
  };
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
