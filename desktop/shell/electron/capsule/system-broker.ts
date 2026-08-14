import {
  SYSTEM_OPERATIONS,
  type JsonValue,
  type SystemOperation,
  type SystemOperationMap,
} from "@lamarck/system/protocol";
export { SYSTEM_OPERATIONS };

const SYSTEM_OPERATION_SET: ReadonlySet<string> = new Set(SYSTEM_OPERATIONS);
const APP_CAPABILITY_HEADER = "x-lamarck-app-capability";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT_PER_SENDER = 16;
const DEFAULT_MAX_IN_FLIGHT_GLOBAL = 128;
const DEFAULT_MAX_AGGREGATE_BYTES_PER_SENDER = 128 * 1024 * 1024;
const DEFAULT_MAX_AGGREGATE_BYTES_GLOBAL = 512 * 1024 * 1024;
const MAX_JSON_DEPTH = 128;

export type SenderId = string | number;

export interface SystemSenderBinding {
  channelId: string;
  capability: string;
}

export interface SystemBrokerOptions {
  coreBaseUrl: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxInFlightPerSender?: number;
  maxInFlightGlobal?: number;
  maxAggregateBytesPerSender?: number;
  maxAggregateBytesGlobal?: number;
  revokeCapability(channelId: string): void | Promise<void>;
}

export type SystemBrokerErrorCode =
  | "sender_unbound"
  | "operation_denied"
  | "invalid_request"
  | "request_too_large"
  | "request_timeout"
  | "request_aborted"
  | "transport_error"
  | "response_too_large"
  | "invalid_response"
  | "core_error"
  | "too_many_requests"
  | "resource_exhausted"
  | "revoke_failed";

export class SystemBrokerError extends Error {
  readonly code: SystemBrokerErrorCode;

  constructor(code: SystemBrokerErrorCode, message: string) {
    super(message);
    this.name = "SystemBrokerError";
    this.code = code;
  }
}

interface PrivateBinding {
  readonly channelId: string;
  readonly capability: string;
}

interface CoreRequest {
  readonly method: "POST" | "DELETE";
  readonly path: string;
  readonly body?: JsonValue;
  readonly sizeValue: JsonValue;
}

interface InvocationLease {
  readonly senderId: SenderId;
  readonly controller: AbortController;
  bytes: number;
  released: boolean;
}

interface CoreResponse {
  readonly data: unknown;
}

/**
 * Trusted Host seam between an Electron-owned sender and Core's opaque App
 * capability. App input selects an operation and its ordinary arguments only;
 * it cannot supply a route, capability, App id, workload, or channel id.
 */
export class SystemBroker {
  #coreBaseUrl: SystemBrokerOptions["coreBaseUrl"];
  #fetch: typeof fetch;
  #timeoutMs: number;
  #maxRequestBytes: number;
  #maxResponseBytes: number;
  #maxInFlightPerSender: number;
  #maxInFlightGlobal: number;
  #maxAggregateBytesPerSender: number;
  #maxAggregateBytesGlobal: number;
  #revokeCapability: SystemBrokerOptions["revokeCapability"];
  #bindingsBySender = new Map<SenderId, PrivateBinding>();
  #senderByChannel = new Map<string, SenderId>();
  #inFlightBySender = new Map<SenderId, Set<InvocationLease>>();
  #aggregateBytesBySender = new Map<SenderId, number>();
  #inFlightGlobal = 0;
  #aggregateBytesGlobal = 0;

  constructor(options: SystemBrokerOptions) {
    this.#coreBaseUrl = options.coreBaseUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new Error("SystemBroker requires fetch");
    this.#timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.#maxRequestBytes = positiveInteger(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES);
    this.#maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    this.#maxInFlightPerSender = positiveInteger(
      options.maxInFlightPerSender,
      DEFAULT_MAX_IN_FLIGHT_PER_SENDER,
    );
    this.#maxInFlightGlobal = positiveInteger(
      options.maxInFlightGlobal,
      DEFAULT_MAX_IN_FLIGHT_GLOBAL,
    );
    this.#maxAggregateBytesPerSender = positiveInteger(
      options.maxAggregateBytesPerSender,
      DEFAULT_MAX_AGGREGATE_BYTES_PER_SENDER,
    );
    this.#maxAggregateBytesGlobal = positiveInteger(
      options.maxAggregateBytesGlobal,
      DEFAULT_MAX_AGGREGATE_BYTES_GLOBAL,
    );
    this.#revokeCapability = options.revokeCapability;
  }

  get size(): number {
    return this.#bindingsBySender.size;
  }

  bindSender(senderId: SenderId, binding: SystemSenderBinding): void {
    validateSenderId(senderId);
    if (!binding || typeof binding.channelId !== "string" || !binding.channelId) {
      throw new Error("System sender binding requires channelId");
    }
    if (typeof binding.capability !== "string" || !binding.capability) {
      throw new Error("System sender binding requires capability");
    }
    if (this.#bindingsBySender.has(senderId)) {
      throw new Error(`System sender is already bound: ${String(senderId)}`);
    }
    if (this.#senderByChannel.has(binding.channelId)) {
      throw new Error(`System channel is already bound: ${binding.channelId}`);
    }

    // The caller-owned object is never retained. Only this private copy holds
    // the raw capability, and no public inspection API returns the binding.
    const stored: PrivateBinding = Object.freeze({
      channelId: binding.channelId,
      capability: binding.capability,
    });
    this.#bindingsBySender.set(senderId, stored);
    this.#senderByChannel.set(stored.channelId, senderId);
  }

  unbindSender(senderId: SenderId): boolean {
    const binding = this.#bindingsBySender.get(senderId);
    if (!binding) return false;
    this.#detach(senderId, binding);
    return true;
  }

  /**
   * Synchronously removes every renderer/workload authority and aborts all
   * requests already carrying one. This is the local fail-closed seam used
   * when Core itself disappears: network revocation is no longer trustworthy.
   */
  unbindAll(): number {
    const senders = [...this.#bindingsBySender.keys()];
    for (const senderId of senders) {
      const binding = this.#bindingsBySender.get(senderId);
      if (binding) this.#detach(senderId, binding);
    }
    return senders.length;
  }

  async revoke(channelId: string): Promise<boolean> {
    const senderId = this.#senderByChannel.get(channelId);
    if (senderId === undefined) return false;
    const binding = this.#bindingsBySender.get(senderId);
    if (!binding || binding.channelId !== channelId) {
      // Inconsistent private state must deny further use rather than guessing.
      this.#senderByChannel.delete(channelId);
      throw new SystemBrokerError("revoke_failed", "System channel binding is inconsistent");
    }
    this.#detach(senderId, binding);
    try {
      await this.#revokeCapability(channelId);
      return true;
    } catch (error) {
      throw new SystemBrokerError(
        "revoke_failed",
        `System channel was locally revoked but Core revocation failed: ${errorMessage(error)}`,
      );
    }
  }

  async revokeSender(senderId: SenderId): Promise<boolean> {
    const binding = this.#bindingsBySender.get(senderId);
    return binding ? this.revoke(binding.channelId) : false;
  }

  async invoke<Operation extends SystemOperation>(
    senderId: SenderId,
    operation: Operation,
    input: SystemOperationMap[Operation]["input"],
  ): Promise<SystemOperationMap[Operation]["output"]> {
    const binding = this.#requireBinding(senderId);
    return await this.#invokeBound(
      senderId,
      binding,
      operation,
      input,
      0,
      ({ data }) => data as SystemOperationMap[Operation]["output"],
    );
  }

  /**
   * Browser-only wire seam. The isolated preload serializes and bounds the
   * request before IPC; Electron main passes only that string here. The reply
   * is also one bounded JSON string so neither direction structured-clones an
   * App-controlled object graph in the Host process.
   */
  async invokeSerialized(senderId: SenderId, serializedRequest: unknown): Promise<string> {
    try {
      const binding = this.#requireBinding(senderId);
      if (typeof serializedRequest !== "string") {
        throw new SystemBrokerError("invalid_request", "Serialized System SDK request required");
      }
      const outerBytes = byteLength(serializedRequest);
      if (outerBytes > this.#maxRequestBytes) {
        throw new SystemBrokerError("request_too_large", "System SDK request exceeds the size limit");
      }
      const request = parseSerializedRequest(serializedRequest);
      return await this.#invokeBound(
        senderId,
        binding,
        request.operation,
        request.input as never,
        outerBytes,
        ({ data }, lease) => {
          const serialized = serializeBrowserSuccess(data);
          const responseBytes = byteLength(serialized);
          if (responseBytes > this.#maxResponseBytes) {
            throw new SystemBrokerError("response_too_large", "System SDK response exceeds the size limit");
          }
          // Count the Host-to-renderer representation separately from the Core
          // response bytes: both coexist while the IPC reply is being formed.
          this.#chargeLease(lease, responseBytes);
          return serialized;
        },
      );
    } catch (error) {
      return serializeBrowserFailure(error);
    }
  }

  async #invokeBound<Operation extends SystemOperation, Result>(
    senderId: SenderId,
    binding: PrivateBinding,
    operation: Operation,
    input: SystemOperationMap[Operation]["input"],
    outerRequestBytes: number,
    finish: (response: CoreResponse, lease: InvocationLease) => Result,
  ): Promise<Result> {
    if (!SYSTEM_OPERATION_SET.has(operation)) {
      throw new SystemBrokerError("operation_denied", "System SDK operation is not allowed");
    }

    const coreRequest = mapCoreRequest(operation, input);
    const serializedForSize = serializeJson(coreRequest.sizeValue);
    const coreRequestBytes = byteLength(serializedForSize);
    if (coreRequestBytes > this.#maxRequestBytes) {
      throw new SystemBrokerError("request_too_large", "System SDK request exceeds the size limit");
    }
    const body = coreRequest.body === undefined ? undefined : serializeJson(coreRequest.body);
    const lease = this.#acquireLease(senderId, outerRequestBytes + coreRequestBytes);
    const controller = lease.controller;
    const timeout = setTimeout(() => {
      controller.abort(new SystemBrokerError("request_timeout", "System SDK request timed out"));
    }, this.#timeoutMs);

    try {
      const baseUrl = typeof this.#coreBaseUrl === "function"
        ? await raceWithAbort(Promise.resolve(this.#coreBaseUrl()), controller.signal)
        : this.#coreBaseUrl;
      if (this.#bindingsBySender.get(senderId) !== binding) {
        throw new SystemBrokerError("request_aborted", "System SDK sender was unbound");
      }
      const url = new URL(coreRequest.path, ensureTrailingSlash(baseUrl)).toString();
      const headers = new Headers({
        Accept: "application/json",
        [APP_CAPABILITY_HEADER]: binding.capability,
      });
      if (body !== undefined) headers.set("Content-Type", "application/json");

      let response: Response;
      try {
        response = await raceWithAbort(
          Promise.resolve(this.#fetch(url, {
            method: coreRequest.method,
            headers,
            body,
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          })),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof SystemBrokerError) throw error;
        throw new SystemBrokerError("transport_error", `Core request failed: ${errorMessage(error)}`);
      }

      const contentType = response.headers.get("content-type");
      if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
        throw new SystemBrokerError("invalid_response", "Core returned a non-JSON System SDK response");
      }
      const text = await readBoundedResponse(
        response,
        this.#maxResponseBytes,
        controller.signal,
        (bytes) => this.#chargeLease(lease, bytes),
      );
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new SystemBrokerError("invalid_response", "Core returned malformed JSON");
      }
      if (!response.ok) {
        const message = isRecord(data) && typeof data.error === "string"
          ? data.error
          : `Core returned HTTP ${response.status}`;
        throw new SystemBrokerError("core_error", message);
      }
      return finish({ data }, lease);
    } finally {
      clearTimeout(timeout);
      this.#releaseLease(lease);
    }
  }

  #requireBinding(senderId: SenderId): PrivateBinding {
    const binding = this.#bindingsBySender.get(senderId);
    if (!binding) {
      throw new SystemBrokerError("sender_unbound", "System SDK sender is not bound");
    }
    return binding;
  }

  #detach(senderId: SenderId, binding: PrivateBinding): void {
    this.#bindingsBySender.delete(senderId);
    this.#senderByChannel.delete(binding.channelId);
    const leases = this.#inFlightBySender.get(senderId);
    if (!leases) return;
    for (const lease of [...leases]) {
      lease.controller.abort(new SystemBrokerError("request_aborted", "System SDK sender was unbound"));
    }
  }

  #acquireLease(senderId: SenderId, bytes: number): InvocationLease {
    const leases = this.#inFlightBySender.get(senderId) ?? new Set<InvocationLease>();
    if (leases.size >= this.#maxInFlightPerSender || this.#inFlightGlobal >= this.#maxInFlightGlobal) {
      throw new SystemBrokerError("too_many_requests", "Too many in-flight System SDK requests");
    }
    this.#assertByteBudget(senderId, bytes);

    const lease: InvocationLease = {
      senderId,
      controller: new AbortController(),
      bytes,
      released: false,
    };
    leases.add(lease);
    this.#inFlightBySender.set(senderId, leases);
    this.#aggregateBytesBySender.set(
      senderId,
      (this.#aggregateBytesBySender.get(senderId) ?? 0) + bytes,
    );
    this.#inFlightGlobal++;
    this.#aggregateBytesGlobal += bytes;
    return lease;
  }

  #chargeLease(lease: InvocationLease, bytes: number): void {
    if (lease.released || bytes <= 0) return;
    this.#assertByteBudget(lease.senderId, bytes);
    lease.bytes += bytes;
    this.#aggregateBytesBySender.set(
      lease.senderId,
      (this.#aggregateBytesBySender.get(lease.senderId) ?? 0) + bytes,
    );
    this.#aggregateBytesGlobal += bytes;
  }

  #assertByteBudget(senderId: SenderId, additionalBytes: number): void {
    const senderBytes = this.#aggregateBytesBySender.get(senderId) ?? 0;
    if (
      additionalBytes < 0
      || !Number.isSafeInteger(additionalBytes)
      || senderBytes + additionalBytes > this.#maxAggregateBytesPerSender
      || this.#aggregateBytesGlobal + additionalBytes > this.#maxAggregateBytesGlobal
    ) {
      throw new SystemBrokerError("resource_exhausted", "System SDK byte budget is exhausted");
    }
  }

  #releaseLease(lease: InvocationLease): void {
    if (lease.released) return;
    lease.released = true;
    const leases = this.#inFlightBySender.get(lease.senderId);
    leases?.delete(lease);
    if (leases?.size === 0) this.#inFlightBySender.delete(lease.senderId);

    const senderBytes = this.#aggregateBytesBySender.get(lease.senderId) ?? 0;
    const remainingSenderBytes = Math.max(0, senderBytes - lease.bytes);
    if (remainingSenderBytes === 0) this.#aggregateBytesBySender.delete(lease.senderId);
    else this.#aggregateBytesBySender.set(lease.senderId, remainingSenderBytes);
    this.#inFlightGlobal = Math.max(0, this.#inFlightGlobal - 1);
    this.#aggregateBytesGlobal = Math.max(0, this.#aggregateBytesGlobal - lease.bytes);
  }
}

function parseSerializedRequest(serialized: string): {
  operation: SystemOperation;
  input: unknown;
} {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new SystemBrokerError("invalid_request", "Serialized System SDK request is not valid JSON");
  }
  if (!isRecord(value)) {
    throw new SystemBrokerError("invalid_request", "Serialized System SDK request must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "input" || keys[1] !== "operation") {
    throw new SystemBrokerError("invalid_request", "Serialized System SDK request is malformed");
  }
  if (typeof value.operation !== "string" || !SYSTEM_OPERATION_SET.has(value.operation)) {
    throw new SystemBrokerError("operation_denied", "System SDK operation is not allowed");
  }
  return { operation: value.operation as SystemOperation, input: value.input };
}

function serializeBrowserSuccess(data: unknown): string {
  try {
    return JSON.stringify({ ok: true, result: data });
  } catch {
    throw new SystemBrokerError("invalid_response", "Core returned an unserializable System SDK response");
  }
}

function serializeBrowserFailure(error: unknown): string {
  const message = errorMessage(error).slice(0, 1_024) || "System SDK request failed";
  const code = error instanceof SystemBrokerError ? error.code : "transport_error";
  return JSON.stringify({ ok: false, error: { message, code } });
}

function mapCoreRequest(operation: string, input: unknown): CoreRequest {
  if (!SYSTEM_OPERATION_SET.has(operation)) {
    throw new SystemBrokerError("operation_denied", `System SDK operation is not allowed: ${operation}`);
  }
  const value = expectRecord(input);

  switch (operation as SystemOperation) {
    case "query":
    case "mutate": {
      const sql = expectString(value.sql, `${operation}.sql`);
      const body: Record<string, JsonValue> = { sql };
      if (value.params !== undefined) body.params = expectJson(value.params, `${operation}.params`);
      return {
        method: "POST",
        path: operation === "query" ? "/api/query" : "/api/mutate",
        body,
        sizeValue: body,
      };
    }
    case "resolveContentRef": {
      const body = { ref: expectJson(value.ref, "resolveContentRef.ref") };
      return { method: "POST", path: "/api/content-ref/resolve", body, sizeValue: body };
    }
    case "transaction": {
      if (!Array.isArray(value.statements)) invalid("transaction.statements must be an array");
      const body = { statements: expectJson(value.statements, "transaction.statements") };
      return { method: "POST", path: "/api/transaction", body, sizeValue: body };
    }
    case "vfs.command": {
      const body: Record<string, JsonValue> = {
        command: expectString(value.command, "vfs.command.command"),
      };
      if (value.options !== undefined) body.options = expectJson(value.options, "vfs.command.options");
      return { method: "POST", path: "/api/vfs/command", body, sizeValue: body };
    }
    case "vfs.open": {
      const body = { path: expectString(value.path, "vfs.open.path") };
      return { method: "POST", path: "/api/vfs/open", body, sizeValue: body };
    }
    case "writeEvent": {
      const body: Record<string, JsonValue> = {
        type: expectString(value.type, "writeEvent.type"),
        startedAt: expectFiniteNumber(value.startedAt, "writeEvent.startedAt"),
        payload: expectJson(value.payload, "writeEvent.payload"),
      };
      if (value.endedAt !== undefined) {
        body.endedAt = expectFiniteNumber(value.endedAt, "writeEvent.endedAt");
      }
      if (value.externalId !== undefined) {
        body.externalId = expectString(value.externalId, "writeEvent.externalId");
      }
      // Deliberately omit source, appId, workload, channelId, and every unknown
      // field. Core derives provenance from the opaque bound capability.
      return { method: "POST", path: "/api/events", body, sizeValue: body };
    }
  }
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalid("System SDK operation input must be an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string") invalid(`${name} must be a string`);
  return value;
}

function expectFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${name} must be a finite number`);
  return value;
}

function expectJson(value: unknown, name: string): JsonValue {
  try {
    assertJson(value);
    return value as JsonValue;
  } catch (error) {
    invalid(`${name} must be JSON: ${errorMessage(error)}`);
  }
}

function assertJson(root: unknown): void {
  const ancestors = new Set<object>();
  const stack: Array<{ value: unknown; depth: number; exit: boolean }> = [
    { value: root, depth: 0, exit: false },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const value = frame.value;
    if (frame.exit) {
      ancestors.delete(value as object);
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("numbers must be finite");
      continue;
    }
    if (typeof value !== "object") throw new Error(`unsupported ${typeof value}`);
    if (frame.depth > MAX_JSON_DEPTH) throw new Error("nested too deeply");
    if (ancestors.has(value)) throw new Error("cyclic value");
    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("non-plain object");
    }

    ancestors.add(value);
    stack.push({ value, depth: frame.depth, exit: true });
    const children: unknown[] = Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>);
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ value: children[index], depth: frame.depth + 1, exit: false });
    }
  }
}

function invalid(message: string): never {
  throw new SystemBrokerError("invalid_request", message);
}

function serializeJson(value: JsonValue): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new SystemBrokerError("invalid_request", `System SDK input is not serializable: ${errorMessage(error)}`);
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  chargeBytes: (bytes: number) => void,
): Promise<string> {
  if (!response.body) return "";
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new SystemBrokerError("response_too_large", "Core response exceeds the size limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new SystemBrokerError("response_too_large", "Core response exceeds the size limit");
      }
      chargeBytes(value.byteLength);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new SystemBrokerError("request_aborted", "System SDK request was aborted");
}

function validateSenderId(senderId: SenderId): void {
  if (
    (typeof senderId !== "string" && typeof senderId !== "number")
    || (typeof senderId === "string" && senderId.length === 0)
    || (typeof senderId === "number" && !Number.isSafeInteger(senderId))
  ) {
    throw new Error("System sender id must be a non-empty string or safe integer");
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
