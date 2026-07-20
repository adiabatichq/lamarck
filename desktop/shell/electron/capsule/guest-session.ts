import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import {
  JsonFrameDecoder,
  MAX_CONTROL_FRAME_BYTES,
  MAX_DATA_PRELUDE_BYTES,
  encodeJsonFrame,
} from "../../../capsule/src/protocol/codec";
import {
  TicketRegistry,
  generateOpaqueId,
  type ConsumedTicketBinding,
  type TicketBinding,
} from "../../../capsule/src/protocol/tickets";
import {
  CAPSULE_PROTOCOL_VERSION,
  type GuestArchitecture,
  type GuestEvent,
  type GuestEventType,
  type GuestHello,
  type HostOperation,
  type HostRequest,
  type JsonValue,
  type StreamKind,
} from "../../../capsule/src/protocol/types";
import {
  parseControlResponse,
  parseDataStreamPrelude,
  parseGuestHello,
  parseGuestReady,
  parseHostInitialize,
  parseHostRequestForSession,
  validateOpaqueId,
  validateSessionId,
  validateStreamTicket,
} from "../../../capsule/src/protocol/validate";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_DATA_STREAM_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING_REQUESTS = 32;
const DEFAULT_MAX_REQUESTS_PER_SESSION = 100_000;
const DEFAULT_MAX_DATA_STREAMS = 64;
const MAXIMUM_PROTOCOL_TIMEOUT_MS = 60_000;
const MAXIMUM_REQUEST_TIMEOUT_MS = 600_000;
const MAXIMUM_PENDING_REQUESTS = 1_024;
const MAXIMUM_REQUESTS_PER_SESSION = 1_000_000;
const MAXIMUM_DATA_STREAMS = 64;

const GUEST_EVENT_TYPES: ReadonlySet<string> = new Set<GuestEventType>([
  "blob.imported",
  "blob.exported",
  "blob.failed",
  "build.progress",
  "build.completed",
  "build.failed",
  "workload.started",
  "workload.ready",
  "workload.exited",
  "workload.faulted",
  "app.faulted",
  "vm.faulted",
]);

export type CapsuleGuestSessionState =
  | "waiting-hello"
  | "waiting-ready"
  | "ready"
  | "closed";

export type CapsuleGuestSessionErrorCode =
  | "SESSION_CLOSED"
  | "HANDSHAKE_TIMEOUT"
  | "HANDSHAKE_MISMATCH"
  | "CONTROL_TRANSPORT_CLOSED"
  | "GUEST_PROTOCOL_ERROR"
  | "EVENT_SEQUENCE_INVALID"
  | "UNKNOWN_RESPONSE"
  | "REQUEST_TIMEOUT"
  | "PENDING_REQUEST_LIMIT"
  | "REQUEST_LIMIT"
  | "REQUEST_ID_REUSED"
  | "DATA_STREAM_LIMIT"
  | "DATA_STREAM_TIMEOUT"
  | "DATA_STREAM_PROTOCOL"
  | "TICKET_NOT_OWNED";

export class CapsuleGuestSessionError extends Error {
  constructor(
    readonly code: CapsuleGuestSessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CapsuleGuestSessionError";
  }
}

export class CapsuleGuestRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapsuleGuestRequestError";
  }
}

export interface CapsuleGuestSessionOptions {
  expectedImageDigest: string;
  expectedArchitecture: GuestArchitecture;
  /** Exact supervisor version pinned by the Host-signed release descriptor. */
  expectedSupervisorVersion: string;
  /** Exact canonical feature list. The Host sorts it; the Guest must send that sorted list. */
  expectedFeatures: readonly string[];
  maxControlFrameBytes?: number;
  maxPendingRequests?: number;
  maxRequestsPerSession?: number;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Bounds both an unmatched neutral DATA stream and an open-data waiter. */
  dataStreamTimeoutMs?: number;
  maxDataStreams?: number;
  /** Test seam. Production uses 256 random bits encoded as canonical base64url. */
  sessionIdFactory?: () => string;
  /** Test seam. Production uses 128 random bits encoded as canonical base64url. */
  requestIdFactory?: () => string;
}

export interface CapsuleGuestReadySession {
  sessionId: string;
  bootId: string;
  hello: GuestHello;
}

export interface IssueGuestStreamTicketOptions {
  kind: StreamKind;
  appHandle: string;
  subjectHandle: string;
  ttlMs: number;
}

export interface CapsuleGuestControlRequestOptions {
  timeoutMs?: number;
  /** Tickets named in this request are revoked if validation, transport, or Guest execution fails. */
  revokeTicketsOnFailure?: readonly string[];
}

export type RequestBodyFor<TOperation extends HostOperation> = Extract<
  HostRequest,
  { op: TOperation }
>["body"];

export interface OpenedGuestDataStream {
  stream: Duplex;
  prelude: {
    protocolVersion: typeof CAPSULE_PROTOCOL_VERSION;
    sessionId: string;
    ticket: string;
    kind: StreamKind;
  };
  /** The branded, Host-created one-use binding recovered from the opaque ticket. */
  binding: ConsumedTicketBinding;
}

interface PendingRequest {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  revokeTicketsOnFailure: ReadonlySet<string>;
}

interface PendingDataOpen {
  ticket: string;
  kind: StreamKind;
  prelude: OpenedGuestDataStream["prelude"];
  resolve(value: OpenedGuestDataStream): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  paired: boolean;
  settled: boolean;
  abort(error: Error): void;
}

interface QueuedDataStream {
  stream: Duplex;
  timer: ReturnType<typeof setTimeout>;
  onReadable(): void;
  onEnd(): void;
  onClose(): void;
}

interface GuestTicketLifecycle {
  binding: TicketBinding;
  pending?: PendingDataOpen;
  stream?: Duplex;
}

export interface CapsuleGuestSession {
  on(event: "ready", listener: (ready: CapsuleGuestReadySession) => void): this;
  on(event: "event", listener: (event: GuestEvent) => void): this;
  on(event: "fatal", listener: (error: CapsuleGuestSessionError) => void): this;
  on(event: "close", listener: (error?: Error) => void): this;
  once(event: "ready", listener: (ready: CapsuleGuestReadySession) => void): this;
  once(event: "event", listener: (event: GuestEvent) => void): this;
  once(event: "fatal", listener: (error: CapsuleGuestSessionError) => void): this;
  once(event: "close", listener: (error?: Error) => void): this;
}

/**
 * Host-side authenticated Guest protocol over one LCVM CONTROL Duplex and
 * separately accepted DATA Duplex streams. Any malformed Guest input poisons
 * the complete boot session; callers must create a new VM session to recover.
 */
export class CapsuleGuestSession extends EventEmitter {
  readonly #control: Duplex;
  readonly #controlDecoder: JsonFrameDecoder;
  readonly #expectedImageDigest: string;
  readonly #expectedArchitecture: GuestArchitecture;
  readonly #expectedSupervisorVersion: string;
  readonly #expectedFeatures: readonly string[];
  readonly #maxControlFrameBytes: number;
  readonly #maxPendingRequests: number;
  readonly #maxRequestsPerSession: number;
  readonly #requestTimeoutMs: number;
  readonly #dataStreamTimeoutMs: number;
  readonly #maxDataStreams: number;
  readonly #sessionIdFactory: () => string;
  readonly #requestIdFactory: () => string;
  readonly #tickets = new TicketRegistry();
  readonly #ticketLifecycles = new Map<string, GuestTicketLifecycle>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #issuedRequestIds = new Set<string>();
  readonly #dataStreams = new Set<Duplex>();
  readonly #queuedDataStreams: QueuedDataStream[] = [];
  readonly #pendingDataOpens: PendingDataOpen[] = [];
  readonly #unsettledDataOpens = new Set<PendingDataOpen>();
  readonly #readyPromise: Promise<CapsuleGuestReadySession>;

  #resolveReady!: (ready: CapsuleGuestReadySession) => void;
  #rejectReady!: (error: Error) => void;
  #readySettled = false;
  #state: CapsuleGuestSessionState = "waiting-hello";
  #sessionId: string | undefined;
  #bootId: string | undefined;
  #hello: GuestHello | undefined;
  #lastEventSeq = 0;
  #fatalError: CapsuleGuestSessionError | undefined;
  #handshakeTimer: ReturnType<typeof setTimeout>;

  constructor(control: Duplex, options: CapsuleGuestSessionOptions) {
    super();
    this.#control = control;
    this.#maxControlFrameBytes = boundedInteger(
      options.maxControlFrameBytes,
      MAX_CONTROL_FRAME_BYTES,
      1_024,
      MAX_CONTROL_FRAME_BYTES,
      "maxControlFrameBytes",
    );
    this.#maxPendingRequests = boundedInteger(
      options.maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS,
      1,
      MAXIMUM_PENDING_REQUESTS,
      "maxPendingRequests",
    );
    this.#maxRequestsPerSession = boundedInteger(
      options.maxRequestsPerSession,
      DEFAULT_MAX_REQUESTS_PER_SESSION,
      this.#maxPendingRequests,
      MAXIMUM_REQUESTS_PER_SESSION,
      "maxRequestsPerSession",
    );
    this.#requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      MAXIMUM_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    const handshakeTimeoutMs = boundedInteger(
      options.handshakeTimeoutMs,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      1,
      MAXIMUM_PROTOCOL_TIMEOUT_MS,
      "handshakeTimeoutMs",
    );
    this.#dataStreamTimeoutMs = boundedInteger(
      options.dataStreamTimeoutMs,
      DEFAULT_DATA_STREAM_TIMEOUT_MS,
      1,
      MAXIMUM_PROTOCOL_TIMEOUT_MS,
      "dataStreamTimeoutMs",
    );
    this.#maxDataStreams = boundedInteger(
      options.maxDataStreams,
      DEFAULT_MAX_DATA_STREAMS,
      1,
      MAXIMUM_DATA_STREAMS,
      "maxDataStreams",
    );
    this.#sessionIdFactory = options.sessionIdFactory ?? generateSessionId;
    this.#requestIdFactory = options.requestIdFactory ?? generateOpaqueId;

    const expectedSupervisorVersion = validateSupervisorVersion(
      options.expectedSupervisorVersion,
    );
    const policy = parseGuestHello({
      type: "guest.hello",
      protocolVersion: CAPSULE_PROTOCOL_VERSION,
      bootId: "A".repeat(22),
      imageDigest: options.expectedImageDigest,
      supervisorVersion: expectedSupervisorVersion,
      architecture: options.expectedArchitecture,
      features: [...options.expectedFeatures].sort(),
    });
    if (new Set(policy.features).size !== policy.features.length) {
      throw new CapsuleGuestSessionError(
        "HANDSHAKE_MISMATCH",
        "Expected Guest features must not contain duplicates",
      );
    }
    this.#expectedImageDigest = policy.imageDigest;
    this.#expectedArchitecture = policy.architecture;
    this.#expectedSupervisorVersion = policy.supervisorVersion;
    this.#expectedFeatures = Object.freeze([...policy.features]);
    this.#controlDecoder = new JsonFrameDecoder(this.#maxControlFrameBytes);

    this.#readyPromise = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // The transport can fail before a caller asks for readiness. Keep that
    // failure observable without creating a process-level unhandled rejection.
    void this.#readyPromise.catch(() => {});

    control.on("data", this.#onControlData);
    control.on("error", this.#onControlError);
    control.once("end", this.#onControlEnd);
    control.once("close", this.#onControlClose);

    this.#handshakeTimer = setTimeout(() => {
      this.#fail(new CapsuleGuestSessionError(
        "HANDSHAKE_TIMEOUT",
        "Guest did not complete the authenticated control handshake in time",
      ));
    }, handshakeTimeoutMs);
  }

  get state(): CapsuleGuestSessionState {
    return this.#state;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get outstandingTicketCount(): number {
    return this.#tickets.size;
  }

  get pendingRequestCount(): number {
    return this.#pendingRequests.size;
  }

  get activeDataStreamCount(): number {
    return this.#dataStreams.size;
  }

  get failure(): CapsuleGuestSessionError | undefined {
    return this.#fatalError;
  }

  waitUntilReady(): Promise<CapsuleGuestReadySession> {
    return this.#readyPromise;
  }

  issueTicket(options: IssueGuestStreamTicketOptions): TicketBinding {
    const sessionId = this.#requireReadySession();
    const binding = this.#tickets.issue({
      sessionId,
      kind: options.kind,
      appHandle: options.appHandle,
      subjectHandle: options.subjectHandle,
      ttlMs: options.ttlMs,
    });
    this.#ticketLifecycles.set(binding.ticket, { binding });
    return binding;
  }

  revokeTicket(ticketValue: unknown): boolean {
    const ticket = validateStreamTicket(ticketValue, "ticket");
    return this.#revokeTicket(ticket, new CapsuleGuestSessionError(
      "TICKET_NOT_OWNED",
      "Host revoked the DATA stream ticket",
    ));
  }

  request<TOperation extends HostOperation, TResult extends JsonValue = JsonValue>(
    operation: TOperation,
    body: RequestBodyFor<TOperation>,
    options: CapsuleGuestControlRequestOptions = {},
  ): Promise<TResult> {
    let revokeTickets: ReadonlySet<string> = new Set();
    try {
      const sessionId = this.#requireReadySession();
      revokeTickets = this.#validateAssociatedTickets(options.revokeTicketsOnFailure ?? []);
      if (this.#pendingRequests.size >= this.#maxPendingRequests) {
        throw new CapsuleGuestSessionError(
          "PENDING_REQUEST_LIMIT",
          `Guest session already has ${this.#maxPendingRequests} pending requests`,
        );
      }
      if (this.#issuedRequestIds.size >= this.#maxRequestsPerSession) {
        throw new CapsuleGuestSessionError(
          "REQUEST_LIMIT",
          "Guest session exhausted its bounded request-ID lifetime",
        );
      }

      const requestId = validateOpaqueId(this.#requestIdFactory(), "requestId");
      if (this.#issuedRequestIds.has(requestId)) {
        throw new CapsuleGuestSessionError(
          "REQUEST_ID_REUSED",
          "Host request ID factory attempted to reuse an ID in one Guest session",
        );
      }
      const request = parseHostRequestForSession({
        v: CAPSULE_PROTOCOL_VERSION,
        sessionId,
        kind: "request",
        requestId,
        op: operation,
        body,
      }, sessionId);
      const encoded = encodeJsonFrame(request, this.#maxControlFrameBytes);
      const timeoutMs = boundedInteger(
        options.timeoutMs,
        this.#requestTimeoutMs,
        1,
        MAXIMUM_REQUEST_TIMEOUT_MS,
        "request timeout",
      );

      this.#issuedRequestIds.add(requestId);
      return new Promise<TResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#fail(new CapsuleGuestSessionError(
            "REQUEST_TIMEOUT",
            `Guest request ${requestId} timed out after ${timeoutMs} milliseconds`,
          ));
        }, timeoutMs);
        this.#pendingRequests.set(requestId, {
          resolve: (value) => resolve(value as TResult),
          reject,
          timer,
          revokeTicketsOnFailure: revokeTickets,
        });
        this.#writeControlBytes(encoded);
      });
    } catch (error) {
      this.#revokeTickets(revokeTickets);
      return Promise.reject(asError(error));
    }
  }

  /**
   * Accepts a neutral Guest-originated DATA transport. The Guest must not put
   * identity bytes on it: only the Host-written, ticket-bound prelude assigns
   * the stream. A small FIFO queue covers the dial/open scheduling race.
   */
  acceptDataStream(stream: Duplex): void {
    if (this.#state === "closed") {
      const error = this.#fatalError ?? new CapsuleGuestSessionError(
        "SESSION_CLOSED",
        "Guest session is closed",
      );
      stream.on("error", () => {});
      if (!stream.destroyed) stream.destroy(error);
      return;
    }
    if (this.#dataStreams.size >= this.#maxDataStreams) {
      stream.on("error", () => {});
      if (!stream.destroyed) stream.destroy();
      this.#fail(new CapsuleGuestSessionError(
        "DATA_STREAM_LIMIT",
        `Guest exceeded the ${this.#maxDataStreams}-stream Host bound`,
      ));
      return;
    }

    this.#trackDataStream(stream);
    stream.pause();
    const queued = {} as QueuedDataStream;
    queued.stream = stream;
    queued.onReadable = () => {
      if (!this.#queuedDataStreams.includes(queued) || this.#state === "closed") return;
      this.#fail(new CapsuleGuestSessionError(
        "DATA_STREAM_PROTOCOL",
        "Guest wrote to an unassigned DATA stream before the Host prelude",
      ));
    };
    queued.onEnd = () => this.#discardQueuedDataStream(queued, false);
    queued.onClose = () => this.#discardQueuedDataStream(queued, false);
    queued.timer = setTimeout(() => this.#discardQueuedDataStream(queued, true), this.#dataStreamTimeoutMs);
    stream.on("readable", queued.onReadable);
    stream.once("end", queued.onEnd);
    stream.once("close", queued.onClose);
    this.#queuedDataStreams.push(queued);
    this.#drainDataStreams();
  }

  /**
   * Claims one neutral Guest-originated stream FIFO and writes the exact
   * Host-authoritative prelude before exposing the stream to its caller.
   */
  openDataStream(
    ticketValue: unknown,
    kind: StreamKind,
    options: { timeoutMs?: number } = {},
  ): Promise<OpenedGuestDataStream> {
    try {
      const sessionId = this.#requireReadySession();
      const ticket = validateStreamTicket(ticketValue, "ticket");
      const lifecycle = this.#ticketLifecycles.get(ticket);
      if (!lifecycle || lifecycle.pending || lifecycle.stream) {
        throw new CapsuleGuestSessionError(
          "TICKET_NOT_OWNED",
          "DATA stream ticket is unknown, revoked, or already in use",
        );
      }
      if (lifecycle.binding.kind !== kind) {
        throw new CapsuleGuestSessionError(
          "TICKET_NOT_OWNED",
          "DATA stream kind does not match its Host-issued ticket",
        );
      }
      if (this.#unsettledDataOpens.size >= this.#maxDataStreams) {
        throw new CapsuleGuestSessionError(
          "DATA_STREAM_LIMIT",
          `Host already has ${this.#maxDataStreams} pending DATA opens`,
        );
      }
      const prelude = parseDataStreamPrelude({
        protocolVersion: CAPSULE_PROTOCOL_VERSION,
        sessionId,
        ticket,
        kind,
      });
      const timeoutMs = boundedInteger(
        options.timeoutMs,
        this.#dataStreamTimeoutMs,
        1,
        MAXIMUM_PROTOCOL_TIMEOUT_MS,
        "DATA stream timeout",
      );

      return new Promise<OpenedGuestDataStream>((resolve, reject) => {
        const pending = {} as PendingDataOpen;
        pending.ticket = ticket;
        pending.kind = kind;
        pending.prelude = prelude;
        pending.resolve = resolve;
        pending.reject = reject;
        pending.paired = false;
        pending.settled = false;
        pending.abort = (error) => this.#rejectDataOpen(pending, error);
        pending.timer = setTimeout(() => {
          this.#fail(new CapsuleGuestSessionError(
            "DATA_STREAM_TIMEOUT",
            `Guest DATA stream for ${kind} did not arrive or accept its Host prelude in time`,
          ));
        }, timeoutMs);
        lifecycle.pending = pending;
        this.#pendingDataOpens.push(pending);
        this.#unsettledDataOpens.add(pending);
        this.#drainDataStreams();
      });
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  close(): void {
    this.#terminate(
      new CapsuleGuestSessionError("SESSION_CLOSED", "Host closed the Guest session"),
      false,
    );
  }

  readonly #onControlData = (chunk: Buffer | Uint8Array | string): void => {
    if (this.#state === "closed") return;
    try {
      const input = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      for (const value of this.#controlDecoder.push(input)) {
        this.#acceptControlValue(value);
      }
    } catch (error) {
      this.#fail(error);
    }
  };

  readonly #onControlError = (error: Error): void => {
    if (this.#state === "closed") return;
    this.#fail(new CapsuleGuestSessionError(
      "CONTROL_TRANSPORT_CLOSED",
      "Guest CONTROL transport failed",
      { cause: error },
    ));
  };

  readonly #onControlEnd = (): void => {
    if (this.#state === "closed") return;
    try {
      this.#controlDecoder.end();
    } catch (error) {
      this.#fail(error);
      return;
    }
    this.#fail(new CapsuleGuestSessionError(
      "CONTROL_TRANSPORT_CLOSED",
      "Guest CONTROL transport ended",
    ));
  };

  readonly #onControlClose = (): void => {
    if (this.#state === "closed") return;
    this.#fail(new CapsuleGuestSessionError(
      "CONTROL_TRANSPORT_CLOSED",
      "Guest CONTROL transport closed",
    ));
  };

  #acceptControlValue(value: unknown): void {
    switch (this.#state) {
      case "waiting-hello":
        this.#acceptHello(value);
        return;
      case "waiting-ready":
        this.#acceptReady(value);
        return;
      case "ready":
        break;
      case "closed":
        return;
    }

    if (!isPlainObject(value)) {
      throw new CapsuleGuestSessionError(
        "GUEST_PROTOCOL_ERROR",
        "Guest CONTROL message must be an object",
      );
    }
    if (value.kind === "response") {
      this.#acceptResponse(value);
      return;
    }
    if (value.kind === "event") {
      this.#acceptEvent(value);
      return;
    }
    throw new CapsuleGuestSessionError(
      "GUEST_PROTOCOL_ERROR",
      "Guest sent an unsupported CONTROL message",
    );
  }

  #acceptHello(value: unknown): void {
    const hello = parseGuestHello(value);
    if (
      hello.imageDigest !== this.#expectedImageDigest
      || hello.architecture !== this.#expectedArchitecture
      || hello.supervisorVersion !== this.#expectedSupervisorVersion
      || !arraysEqual(hello.features, this.#expectedFeatures)
    ) {
      throw new CapsuleGuestSessionError(
        "HANDSHAKE_MISMATCH",
        "GuestHello does not match the Host-verified image policy",
      );
    }

    const sessionId = validateSessionId(this.#sessionIdFactory(), "sessionId");
    const initialize = parseHostInitialize({
      type: "host.initialize",
      protocolVersion: CAPSULE_PROTOCOL_VERSION,
      sessionId,
      expectedImageDigest: this.#expectedImageDigest,
      maxControlFrameBytes: this.#maxControlFrameBytes,
    });
    this.#hello = Object.freeze({ ...hello, features: Object.freeze([...hello.features]) }) as GuestHello;
    this.#bootId = hello.bootId;
    this.#sessionId = sessionId;
    this.#state = "waiting-ready";
    this.#writeControlBytes(encodeJsonFrame(initialize, this.#maxControlFrameBytes));
  }

  #acceptReady(value: unknown): void {
    const ready = parseGuestReady(value);
    if (ready.bootId !== this.#bootId || ready.sessionId !== this.#sessionId) {
      throw new CapsuleGuestSessionError(
        "HANDSHAKE_MISMATCH",
        "GuestReady does not bind the active Guest boot and Host session",
      );
    }
    const hello = this.#hello;
    const sessionId = this.#sessionId;
    const bootId = this.#bootId;
    if (!hello || !sessionId || !bootId) {
      throw new CapsuleGuestSessionError(
        "HANDSHAKE_MISMATCH",
        "Guest handshake state is incomplete",
      );
    }

    clearTimeout(this.#handshakeTimer);
    this.#state = "ready";
    this.#readySettled = true;
    const result: CapsuleGuestReadySession = Object.freeze({
      sessionId,
      bootId,
      hello,
    });
    this.#resolveReady(result);
    this.emit("ready", result);
    this.#drainDataStreams();
  }

  #acceptResponse(value: unknown): void {
    const response = parseControlResponse(value);
    if (response.sessionId !== this.#sessionId) {
      throw new CapsuleGuestSessionError(
        "UNKNOWN_RESPONSE",
        "Guest response belongs to another boot session",
      );
    }
    const pending = this.#pendingRequests.get(response.requestId);
    if (!pending) {
      throw new CapsuleGuestSessionError(
        "UNKNOWN_RESPONSE",
        `Guest replayed or invented response ${response.requestId}`,
      );
    }
    this.#pendingRequests.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      this.#revokeTickets(pending.revokeTicketsOnFailure);
      pending.reject(new CapsuleGuestRequestError(
        response.error.code,
        response.error.message,
      ));
    }
  }

  #acceptEvent(value: unknown): void {
    const event = parseGuestEvent(value);
    if (event.sessionId !== this.#sessionId) {
      throw new CapsuleGuestSessionError(
        "GUEST_PROTOCOL_ERROR",
        "Guest event belongs to another boot session",
      );
    }
    if (event.eventSeq <= this.#lastEventSeq) {
      throw new CapsuleGuestSessionError(
        "EVENT_SEQUENCE_INVALID",
        `Guest eventSeq ${event.eventSeq} did not increase beyond ${this.#lastEventSeq}`,
      );
    }
    this.#lastEventSeq = event.eventSeq;
    this.emit("event", event);
  }

  #writeControlBytes(encoded: Buffer): void {
    if (this.#state === "closed") return;
    try {
      this.#control.write(encoded, (error) => {
        if (!error || this.#state === "closed") return;
        this.#fail(new CapsuleGuestSessionError(
          "CONTROL_TRANSPORT_CLOSED",
          "Host could not write the Guest CONTROL transport",
          { cause: error },
        ));
      });
    } catch (error) {
      this.#fail(new CapsuleGuestSessionError(
        "CONTROL_TRANSPORT_CLOSED",
        "Host could not write the Guest CONTROL transport",
        { cause: error },
      ));
    }
  }

  #drainDataStreams(): void {
    if (this.#state !== "ready" || !this.#sessionId) return;
    while (this.#pendingDataOpens.length > 0 && this.#queuedDataStreams.length > 0) {
      const pending = this.#pendingDataOpens.shift()!;
      if (pending.settled) continue;
      const queued = this.#queuedDataStreams.shift()!;
      this.#cleanupQueuedDataStream(queued);
      if (queued.stream.destroyed || queued.stream.readableEnded || queued.stream.writableEnded) {
        this.#pendingDataOpens.unshift(pending);
        continue;
      }

      const lifecycle = this.#ticketLifecycles.get(pending.ticket);
      if (!lifecycle || lifecycle.pending !== pending) {
        if (!queued.stream.destroyed) queued.stream.destroy();
        this.#rejectDataOpen(pending, new CapsuleGuestSessionError(
          "TICKET_NOT_OWNED",
          "DATA stream ticket was revoked before transport assignment",
        ));
        continue;
      }

      let binding: ConsumedTicketBinding;
      try {
        binding = this.#tickets.consume(pending.ticket, this.#sessionId, pending.kind);
      } catch (error) {
        if (!queued.stream.destroyed) queued.stream.destroy();
        this.#fail(new CapsuleGuestSessionError(
          "DATA_STREAM_PROTOCOL",
          "Host could not consume the one-use DATA stream ticket",
          { cause: error },
        ));
        return;
      }

      pending.paired = true;
      lifecycle.stream = queued.stream;
      const encoded = encodeJsonFrame(pending.prelude, MAX_DATA_PRELUDE_BYTES);
      try {
        queued.stream.write(encoded, (error) => {
          if (pending.settled) return;
          if (error || queued.stream.destroyed) {
            this.#fail(new CapsuleGuestSessionError(
              "DATA_STREAM_PROTOCOL",
              "Host could not write the DATA stream prelude",
              { cause: error ?? new Error("DATA stream closed during Host prelude write") },
            ));
            return;
          }
          pending.settled = true;
          clearTimeout(pending.timer);
          this.#unsettledDataOpens.delete(pending);
          if (lifecycle.pending === pending) lifecycle.pending = undefined;
          pending.resolve({
            stream: queued.stream,
            prelude: pending.prelude,
            binding,
          });
        });
      } catch (error) {
        this.#fail(new CapsuleGuestSessionError(
          "DATA_STREAM_PROTOCOL",
          "Host could not write the DATA stream prelude",
          { cause: error },
        ));
        return;
      }
    }
  }

  #discardQueuedDataStream(queued: QueuedDataStream, destroy: boolean): void {
    const index = this.#queuedDataStreams.indexOf(queued);
    if (index < 0) return;
    this.#queuedDataStreams.splice(index, 1);
    this.#cleanupQueuedDataStream(queued);
    if (destroy && !queued.stream.destroyed) queued.stream.destroy();
    this.#drainDataStreams();
  }

  #cleanupQueuedDataStream(queued: QueuedDataStream): void {
    clearTimeout(queued.timer);
    queued.stream.off("readable", queued.onReadable);
    queued.stream.off("end", queued.onEnd);
    queued.stream.off("close", queued.onClose);
  }

  #rejectDataOpen(pending: PendingDataOpen, error: Error): void {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.#unsettledDataOpens.delete(pending);
    const index = this.#pendingDataOpens.indexOf(pending);
    if (index >= 0) this.#pendingDataOpens.splice(index, 1);
    const lifecycle = this.#ticketLifecycles.get(pending.ticket);
    if (lifecycle?.pending === pending) lifecycle.pending = undefined;
    pending.reject(error);
  }

  #trackDataStream(stream: Duplex): void {
    this.#dataStreams.add(stream);
    const swallowTransportError = () => {};
    const forget = () => {
      this.#dataStreams.delete(stream);
      for (const [ticket, lifecycle] of this.#ticketLifecycles) {
        if (lifecycle.stream !== stream) continue;
        this.#ticketLifecycles.delete(ticket);
        if (
          lifecycle.pending?.paired
          && !lifecycle.pending.settled
          && this.#state !== "closed"
        ) {
          this.#fail(new CapsuleGuestSessionError(
            "DATA_STREAM_PROTOCOL",
            "Guest DATA stream closed before accepting the Host prelude",
          ));
        }
        break;
      }
      stream.off("error", swallowTransportError);
    };
    stream.on("error", swallowTransportError);
    stream.once("close", forget);
  }

  #validateAssociatedTickets(values: readonly string[]): ReadonlySet<string> {
    const result = new Set<string>();
    let validationError: Error | undefined;
    for (const value of values) {
      let ticket: string;
      try {
        ticket = validateStreamTicket(value, "revokeTicketsOnFailure");
      } catch (error) {
        validationError ??= asError(error);
        continue;
      }
      if (!this.#ticketLifecycles.has(ticket)) {
        validationError ??= new CapsuleGuestSessionError(
          "TICKET_NOT_OWNED",
          "Control request referenced a ticket not issued by this Host session",
        );
        continue;
      }
      result.add(ticket);
    }
    if (validationError) {
      this.#revokeTickets(result);
      throw validationError;
    }
    return result;
  }

  #revokeTickets(tickets: ReadonlySet<string>): void {
    for (const ticket of tickets) {
      this.#revokeTicket(ticket, new CapsuleGuestSessionError(
        "TICKET_NOT_OWNED",
        "Control request failed and revoked its DATA stream ticket",
      ));
    }
  }

  #revokeTicket(ticket: string, error: Error): boolean {
    const lifecycle = this.#ticketLifecycles.get(ticket);
    if (!lifecycle) return false;
    this.#ticketLifecycles.delete(ticket);
    this.#tickets.revoke(ticket);
    if (lifecycle.pending) this.#rejectDataOpen(lifecycle.pending, error);
    if (lifecycle.stream && !lifecycle.stream.destroyed) lifecycle.stream.destroy(error);
    return true;
  }

  #requireReadySession(): string {
    if (this.#state !== "ready" || !this.#sessionId) {
      throw this.#fatalError ?? new CapsuleGuestSessionError(
        "SESSION_CLOSED",
        "Guest session is not ready",
      );
    }
    return this.#sessionId;
  }

  #fail(error: unknown): void {
    const failure = error instanceof CapsuleGuestSessionError
      ? error
      : new CapsuleGuestSessionError(
        "GUEST_PROTOCOL_ERROR",
        error instanceof Error ? error.message : "Malformed Guest protocol input",
        { cause: error },
      );
    this.#terminate(failure, true);
  }

  #terminate(error: Error, fatal: boolean): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    clearTimeout(this.#handshakeTimer);
    if (fatal && error instanceof CapsuleGuestSessionError) this.#fatalError = error;

    if (this.#sessionId) {
      this.#tickets.revokeSession(this.#sessionId);
    }

    const pendingRequests = [...this.#pendingRequests.values()];
    this.#pendingRequests.clear();
    for (const pending of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    const pendingDataOpens = [...this.#unsettledDataOpens];
    for (const pending of pendingDataOpens) pending.abort(error);
    this.#unsettledDataOpens.clear();
    this.#pendingDataOpens.length = 0;

    for (const queued of [...this.#queuedDataStreams]) {
      this.#cleanupQueuedDataStream(queued);
    }
    this.#queuedDataStreams.length = 0;
    this.#ticketLifecycles.clear();

    for (const stream of this.#dataStreams) {
      if (!stream.destroyed) stream.destroy(error);
    }
    this.#dataStreams.clear();
    if (!this.#control.destroyed) this.#control.destroy(error);

    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady(error);
    }
    if (fatal && error instanceof CapsuleGuestSessionError) {
      try { this.emit("fatal", error); } catch {}
    }
    try { this.emit("close", error); } catch {}
  }
}

function validateSupervisorVersion(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > 64
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
  ) {
    throw new CapsuleGuestSessionError(
      "HANDSHAKE_MISMATCH",
      "Expected Guest supervisor version is invalid",
    );
  }
  return value;
}

function parseGuestEvent(value: unknown): GuestEvent {
  if (!isPlainObject(value)) {
    throw new CapsuleGuestSessionError(
      "GUEST_PROTOCOL_ERROR",
      "Guest event must be an object",
    );
  }
  assertExactKeys(value, ["v", "sessionId", "kind", "eventSeq", "type", "body"]);
  if (value.v !== CAPSULE_PROTOCOL_VERSION || value.kind !== "event") {
    throw new CapsuleGuestSessionError(
      "GUEST_PROTOCOL_ERROR",
      "Guest event has an unsupported version or kind",
    );
  }
  if (!Number.isSafeInteger(value.eventSeq) || Number(value.eventSeq) < 1) {
    throw new CapsuleGuestSessionError(
      "EVENT_SEQUENCE_INVALID",
      "Guest eventSeq must be a positive safe integer",
    );
  }
  if (typeof value.type !== "string" || !GUEST_EVENT_TYPES.has(value.type)) {
    throw new CapsuleGuestSessionError(
      "GUEST_PROTOCOL_ERROR",
      "Guest event type is not supported",
    );
  }
  assertJsonValue(value.body, 0);
  return {
    v: CAPSULE_PROTOCOL_VERSION,
    sessionId: validateSessionId(value.sessionId, "$.sessionId"),
    kind: "event",
    eventSeq: Number(value.eventSeq),
    type: value.type as GuestEventType,
    body: value.body as JsonValue,
  };
}

function assertJsonValue(value: unknown, depth: number): asserts value is JsonValue {
  if (depth > 64) {
    throw new CapsuleGuestSessionError(
      "GUEST_PROTOCOL_ERROR",
      "Guest JSON body exceeds the nesting limit",
    );
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) assertJsonValue(item, depth + 1);
    return;
  }
  throw new CapsuleGuestSessionError(
    "GUEST_PROTOCOL_ERROR",
    "Guest message contains a non-JSON value",
  );
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new CapsuleGuestSessionError(
      "GUEST_PROTOCOL_ERROR",
      "Guest message contains unknown or missing fields",
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function generateSessionId(): string {
  return randomBytes(32).toString("base64url");
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
