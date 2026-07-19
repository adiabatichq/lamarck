import { MAX_CONTROL_FRAME_BYTES } from "./codec";
import { CAPSULE_PROTOCOL_VERSION, type GuestArchitecture, type GuestHello, type GuestReady } from "./types";
import { parseGuestHello, parseHostInitialize } from "./validate";

export type HandshakeErrorCode =
  | "HANDSHAKE_INVALID_STATE"
  | "HANDSHAKE_IMAGE_MISMATCH";

export class HandshakeError extends Error {
  readonly code: HandshakeErrorCode;

  constructor(code: HandshakeErrorCode, message: string) {
    super(message);
    this.name = "HandshakeError";
    this.code = code;
  }
}

export interface GuestHandshakeOptions {
  bootId: string;
  imageDigest: string;
  supervisorVersion: string;
  architecture: GuestArchitecture;
  features?: string[];
}

export class GuestHandshake {
  private phase: "waiting-initialize" | "ready" = "waiting-initialize";
  private activeSessionId: string | undefined;
  private activeMaxControlFrameBytes: number | undefined;
  private readonly helloMessage: GuestHello;

  constructor(options: GuestHandshakeOptions) {
    this.helloMessage = parseGuestHello({
      type: "guest.hello",
      protocolVersion: CAPSULE_PROTOCOL_VERSION,
      bootId: options.bootId,
      imageDigest: options.imageDigest,
      supervisorVersion: options.supervisorVersion,
      architecture: options.architecture,
      features: [...(options.features ?? [])].sort(),
    });
  }

  get state(): "waiting-initialize" | "ready" {
    return this.phase;
  }

  get sessionId(): string | undefined {
    return this.activeSessionId;
  }

  get maxControlFrameBytes(): number | undefined {
    return this.activeMaxControlFrameBytes;
  }

  hello(): GuestHello {
    return {
      ...this.helloMessage,
      features: [...this.helloMessage.features],
    };
  }

  initialize(value: unknown): GuestReady {
    if (this.phase !== "waiting-initialize") {
      throw new HandshakeError("HANDSHAKE_INVALID_STATE", "Guest session is already initialized");
    }
    const initialize = parseHostInitialize(value);
    if (initialize.expectedImageDigest !== this.helloMessage.imageDigest) {
      throw new HandshakeError(
        "HANDSHAKE_IMAGE_MISMATCH",
        "Host expected a different verified Guest image digest",
      );
    }
    if (initialize.maxControlFrameBytes > MAX_CONTROL_FRAME_BYTES) {
      throw new HandshakeError(
        "HANDSHAKE_INVALID_STATE",
        "Host control frame limit exceeds the Guest hard limit",
      );
    }
    this.phase = "ready";
    this.activeSessionId = initialize.sessionId;
    this.activeMaxControlFrameBytes = initialize.maxControlFrameBytes;
    return {
      type: "guest.ready",
      protocolVersion: CAPSULE_PROTOCOL_VERSION,
      bootId: this.helloMessage.bootId,
      sessionId: initialize.sessionId,
    };
  }
}
