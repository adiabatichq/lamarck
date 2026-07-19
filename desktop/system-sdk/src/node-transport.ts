import type { Duplex } from "node:stream";
import type {
  SystemInvoke,
  SystemOperation,
  SystemOperationMap,
  SystemRpcRequest,
  SystemRpcResponse,
} from "./protocol.js";

const DEFAULT_MAX_FRAME_BYTES = 20 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface FramedRpcClientOptions {
  maxFrameBytes?: number;
  requestTimeoutMs?: number;
}

/** Four-byte big-endian length followed by one UTF-8 JSON RPC frame. */
export class FramedRpcClient {
  readonly invoke: SystemInvoke;
  #stream: Duplex;
  #maxFrameBytes: number;
  #requestTimeoutMs: number;
  #nextRequestId = 1;
  #pending = new Map<number, PendingRequest>();
  #header = Buffer.allocUnsafe(4);
  #headerBytes = 0;
  #payload: Buffer | undefined;
  #payloadBytes = 0;
  #closed = false;

  constructor(stream: Duplex, options: FramedRpcClientOptions = {}) {
    this.#stream = stream;
    this.#maxFrameBytes = positiveInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES);
    this.#requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.invoke = <Operation extends SystemOperation>(
      operation: Operation,
      input: SystemOperationMap[Operation]["input"],
    ) => this.request(operation, input);

    stream.on("data", (chunk: Buffer | Uint8Array | string) => this.#onData(chunk));
    stream.once("error", (error) => this.#fail(error instanceof Error ? error : new Error(String(error))));
    stream.once("end", () => this.#fail(new Error("Lamarck System SDK channel ended")));
    stream.once("close", () => this.#fail(new Error("Lamarck System SDK channel closed")));
  }

  request<Operation extends SystemOperation>(
    operation: Operation,
    input: SystemOperationMap[Operation]["input"],
  ): Promise<SystemOperationMap[Operation]["output"]> {
    if (this.#closed) return Promise.reject(new Error("Lamarck System SDK channel is closed"));
    const requestId = this.#nextRequestId++;
    const message: SystemRpcRequest<Operation> = { version: 1, requestId, operation, input };

    let payload: Buffer;
    try {
      payload = Buffer.from(JSON.stringify(message), "utf8");
    } catch (error) {
      return Promise.reject(new Error(`System SDK request is not serializable: ${errorMessage(error)}`));
    }
    if (payload.byteLength > this.#maxFrameBytes) {
      return Promise.reject(new Error("System SDK request exceeds the frame limit"));
    }

    const frame = Buffer.allocUnsafe(4 + payload.byteLength);
    frame.writeUInt32BE(payload.byteLength, 0);
    payload.copy(frame, 4);

    return new Promise<SystemOperationMap[Operation]["output"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("System SDK request timed out"));
      }, this.#requestTimeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#stream.write(frame, (error) => {
        if (!error) return;
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#fail(new Error("Lamarck System SDK channel closed by the client"));
    this.#stream.destroy();
  }

  #onData(chunk: Buffer | Uint8Array | string): void {
    if (this.#closed) return;
    const bytes = typeof chunk === "string"
      ? Buffer.from(chunk)
      : Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);
    let offset = 0;

    try {
      while (offset < bytes.byteLength) {
        if (!this.#payload) {
          const headerTake = Math.min(4 - this.#headerBytes, bytes.byteLength - offset);
          bytes.copy(this.#header, this.#headerBytes, offset, offset + headerTake);
          this.#headerBytes += headerTake;
          offset += headerTake;
          if (this.#headerBytes < 4) return;

          const length = this.#header.readUInt32BE(0);
          if (length === 0 || length > this.#maxFrameBytes) {
            throw new Error("System SDK response exceeds the frame limit");
          }
          // Allocate exactly one already-validated frame. Never concatenate an
          // arbitrary transport chunk or repeatedly copy a partial payload.
          this.#payload = Buffer.allocUnsafe(length);
          this.#payloadBytes = 0;
          this.#headerBytes = 0;
        }

        const payloadTake = Math.min(
          this.#payload.byteLength - this.#payloadBytes,
          bytes.byteLength - offset,
        );
        bytes.copy(
          this.#payload,
          this.#payloadBytes,
          offset,
          offset + payloadTake,
        );
        this.#payloadBytes += payloadTake;
        offset += payloadTake;
        if (this.#payloadBytes < this.#payload.byteLength) return;

        const payload = this.#payload;
        this.#payload = undefined;
        this.#payloadBytes = 0;
        const json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
        this.#acceptResponse(JSON.parse(json) as unknown);
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      this.#stream.destroy();
    }
  }

  #acceptResponse(value: unknown): void {
    if (!isSystemRpcResponse(value)) throw new Error("Malformed System SDK response");
    const pending = this.#pending.get(value.requestId);
    if (!pending) throw new Error("Unexpected or stale System SDK response id");
    clearTimeout(pending.timer);
    this.#pending.delete(value.requestId);
    if (value.ok) pending.resolve(value.result);
    else pending.reject(new Error(value.error.message));
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#headerBytes = 0;
    this.#payload = undefined;
    this.#payloadBytes = 0;
  }
}

function isSystemRpcResponse(value: unknown): value is SystemRpcResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<SystemRpcResponse>;
  if (
    response.version !== 1
    || !Number.isSafeInteger(response.requestId)
    || Number(response.requestId) < 1
    || typeof response.ok !== "boolean"
  ) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (response.ok) {
    return keys.length === 4
      && keys.every((key, index) => key === ["ok", "requestId", "result", "version"][index]);
  }
  if (
    keys.length !== 4
    || keys.some((key, index) => key !== ["error", "ok", "requestId", "version"][index])
  ) return false;
  const error = (value as { error?: { message?: unknown; code?: unknown } }).error;
  if (!error || typeof error !== "object" || typeof error.message !== "string") return false;
  const errorKeys = Object.keys(error).sort();
  return (errorKeys.length === 1 && errorKeys[0] === "message")
    || (
      errorKeys.length === 2
      && errorKeys[0] === "code"
      && errorKeys[1] === "message"
      && typeof error.code === "string"
    );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
