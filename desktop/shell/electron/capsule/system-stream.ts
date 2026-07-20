import type { Duplex } from "node:stream";
import type {
  SystemOperation,
  SystemRpcRequest,
  SystemRpcResponse,
} from "@lamarck/system/protocol";
import {
  SYSTEM_OPERATIONS,
  SystemBrokerError,
  type SenderId,
  type SystemBroker,
} from "./system-broker";

const DEFAULT_MAX_FRAME_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 16;
const DEFAULT_MAX_BUFFERED_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_RESPONSE_BYTES_GLOBAL = 256 * 1024 * 1024;
const OPERATION_SET: ReadonlySet<string> = new Set(SYSTEM_OPERATIONS);

export interface SystemStreamServerOptions {
  maxFrameBytes?: number;
  maxInFlight?: number;
  maxBufferedResponseBytes?: number;
  maxBufferedResponseBytesGlobal?: number;
  /** Capability lifetime is normally owned by CapsuleManager, not one socket. */
  unbindOnClose?: boolean;
}

export interface SystemStreamAttachmentHooks {
  onClose?(error?: Error): void;
}

/** Terminates the Node workload's framed System SDK protocol in the Host. */
export class SystemStreamServer {
  readonly #broker: SystemBroker;
  readonly #maxFrameBytes: number;
  readonly #maxInFlight: number;
  readonly #maxBufferedResponseBytes: number;
  readonly #maxBufferedResponseBytesGlobal: number;
  readonly #unbindOnClose: boolean;
  #bufferedResponseBytesGlobal = 0;

  constructor(broker: SystemBroker, options: SystemStreamServerOptions = {}) {
    this.#broker = broker;
    this.#maxFrameBytes = positiveInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES);
    this.#maxInFlight = positiveInteger(options.maxInFlight, DEFAULT_MAX_IN_FLIGHT);
    this.#maxBufferedResponseBytes = positiveInteger(
      options.maxBufferedResponseBytes,
      DEFAULT_MAX_BUFFERED_RESPONSE_BYTES,
    );
    this.#maxBufferedResponseBytesGlobal = positiveInteger(
      options.maxBufferedResponseBytesGlobal,
      DEFAULT_MAX_BUFFERED_RESPONSE_BYTES_GLOBAL,
    );
    this.#unbindOnClose = options.unbindOnClose ?? true;
  }

  attach(
    senderId: SenderId,
    stream: Duplex,
    hooks: SystemStreamAttachmentHooks = {},
  ): () => void {
    const requestHeader = Buffer.allocUnsafe(4);
    let requestHeaderBytes = 0;
    let requestPayload: Buffer | undefined;
    let requestPayloadBytes = 0;
    let closed = false;
    const inFlight = new Set<number>();
    const responseFrames = new Set<Buffer>();
    let bufferedResponseBytes = 0;

    const releaseResponseFrame = (frame: Buffer) => {
      if (!responseFrames.delete(frame)) return;
      bufferedResponseBytes = Math.max(0, bufferedResponseBytes - frame.byteLength);
      this.#bufferedResponseBytesGlobal = Math.max(
        0,
        this.#bufferedResponseBytesGlobal - frame.byteLength,
      );
    };
    const releaseAllResponseFrames = () => {
      for (const frame of [...responseFrames]) releaseResponseFrame(frame);
    };

    const close = (error?: Error) => {
      if (closed) return;
      closed = true;
      requestHeaderBytes = 0;
      requestPayload = undefined;
      requestPayloadBytes = 0;
      releaseAllResponseFrames();
      if (this.#unbindOnClose) this.#broker.unbindSender(senderId);
      if (!stream.destroyed) stream.destroy();
      try {
        hooks.onClose?.(error);
      } catch {}
    };
    const fail = (error: unknown) => close(
      error instanceof Error ? error : new Error(String(error)),
    );

    stream.on("data", (chunk: Buffer | Uint8Array | string) => {
      if (closed) return;
      const bytes = typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);
      let offset = 0;
      try {
        while (offset < bytes.byteLength) {
          if (!requestPayload) {
            const headerTake = Math.min(4 - requestHeaderBytes, bytes.byteLength - offset);
            bytes.copy(requestHeader, requestHeaderBytes, offset, offset + headerTake);
            requestHeaderBytes += headerTake;
            offset += headerTake;
            if (requestHeaderBytes < 4) return;

            const length = requestHeader.readUInt32BE(0);
            if (length === 0 || length > this.#maxFrameBytes) {
              throw new Error("invalid System SDK frame size");
            }
            requestPayload = Buffer.allocUnsafe(length);
            requestPayloadBytes = 0;
            requestHeaderBytes = 0;
          }

          const payloadTake = Math.min(
            requestPayload.byteLength - requestPayloadBytes,
            bytes.byteLength - offset,
          );
          bytes.copy(
            requestPayload,
            requestPayloadBytes,
            offset,
            offset + payloadTake,
          );
          requestPayloadBytes += payloadTake;
          offset += payloadTake;
          if (requestPayloadBytes < requestPayload.byteLength) return;

          const payload = requestPayload;
          requestPayload = undefined;
          requestPayloadBytes = 0;
          const request = parseRequest(payload);
          if (inFlight.has(request.requestId)) throw new Error("duplicate in-flight System SDK request id");
          if (inFlight.size >= this.#maxInFlight) throw new Error("too many in-flight System SDK requests");
          inFlight.add(request.requestId);
          void this.#invoke(senderId, request)
            .then((response) => {
              if (closed) return;
              const frame = encodeFrame(response, this.#maxFrameBytes);
              if (
                bufferedResponseBytes + frame.byteLength > this.#maxBufferedResponseBytes
                || this.#bufferedResponseBytesGlobal + frame.byteLength
                  > this.#maxBufferedResponseBytesGlobal
              ) {
                throw new Error("System SDK response buffer limit exceeded");
              }
              responseFrames.add(frame);
              bufferedResponseBytes += frame.byteLength;
              this.#bufferedResponseBytesGlobal += frame.byteLength;
              return writeFrame(stream, frame).finally(() => releaseResponseFrame(frame));
            })
            .catch(fail)
            .finally(() => inFlight.delete(request.requestId));
        }
      } catch (error) {
        fail(error);
      }
    });
    stream.once("error", fail);
    stream.once("end", () => close());
    stream.once("close", () => close());
    return () => close();
  }

  async #invoke(senderId: SenderId, request: SystemRpcRequest): Promise<SystemRpcResponse> {
    let response: SystemRpcResponse;
    try {
      const result = await this.#broker.invoke(
        senderId,
        request.operation,
        request.input as never,
      );
      response = { version: 1, requestId: request.requestId, ok: true, result } as SystemRpcResponse;
    } catch (error) {
      response = {
        version: 1,
        requestId: request.requestId,
        ok: false,
        error: {
          message: error instanceof Error ? error.message : "System SDK request failed",
          ...(error instanceof SystemBrokerError ? { code: error.code } : {}),
        },
      };
    }
    return response;
  }
}

function parseRequest(payload: Buffer): SystemRpcRequest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new Error("System SDK request is not valid UTF-8 JSON");
  }
  if (!value || typeof value !== "object") throw new Error("System SDK request must be an object");
  const keys = Object.keys(value).sort();
  if (keys.length !== 4 || keys.some((key, index) => key !== ["input", "operation", "requestId", "version"][index])) {
    throw new Error("Malformed System SDK request");
  }
  const request = value as Partial<SystemRpcRequest>;
  if (
    request.version !== 1
    || !Number.isSafeInteger(request.requestId)
    || Number(request.requestId) < 1
    || typeof request.operation !== "string"
    || !OPERATION_SET.has(request.operation)
    || !("input" in request)
  ) {
    throw new Error("Malformed System SDK request");
  }
  return request as SystemRpcRequest<SystemOperation>;
}

function encodeFrame(response: SystemRpcResponse, maxFrameBytes: number): Buffer {
  const payload = Buffer.from(JSON.stringify(response), "utf8");
  if (payload.byteLength > maxFrameBytes) throw new Error("System SDK response exceeds the frame limit");
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

async function writeFrame(stream: Duplex, frame: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(frame, (error) => error ? reject(error) : resolve());
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
