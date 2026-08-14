import { describe, expect, test, vi } from "vitest";
import {
  SYSTEM_OPERATIONS,
  SystemBroker,
  SystemBrokerError,
} from "./system-broker";

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function browserRequest(operation: string, input: unknown): string {
  return JSON.stringify({ operation, input });
}

function browserEnvelope(serialized: string): {
  ok: boolean;
  result?: unknown;
  error?: { message: string; code?: string };
} {
  return JSON.parse(serialized) as {
    ok: boolean;
    result?: unknown;
    error?: { message: string; code?: string };
  };
}

function createBroker(
  fetchImpl: typeof fetch,
  options: Partial<ConstructorParameters<typeof SystemBroker>[0]> = {},
) {
  const revokeCapability = options.revokeCapability ?? vi.fn();
  return {
    broker: new SystemBroker({
      coreBaseUrl: "http://127.0.0.1:32100",
      fetch: fetchImpl,
      revokeCapability,
      ...options,
    }),
    revokeCapability,
  };
}

describe("SystemBroker", () => {
  test("exposes the closed System operation allowlist and rejects unknown operations", async () => {
    expect(SYSTEM_OPERATIONS).toEqual([
      "query",
      "resolveContentRef",
      "mutate",
      "transaction",
      "vfs.command",
      "vfs.open",
      "writeEvent",
    ]);
    const fetchImpl = vi.fn<typeof fetch>();
    const { broker } = createBroker(fetchImpl);
    broker.bindSender(1, { channelId: "channel-a", capability: "cap-a" });

    await expect(
      broker.invoke(1, "attach" as never, {} as never),
    ).rejects.toMatchObject({ code: "operation_denied" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("binds authority to the actual sender and strips caller identity fields", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      request = { url: String(input), init };
      return jsonResponse({ ok: true, id: "event-1" });
    });
    const { broker } = createBroker(fetchImpl);
    broker.bindSender("sender-a", { channelId: "channel-a", capability: "capability-a" });
    broker.bindSender("sender-b", { channelId: "channel-b", capability: "capability-b" });

    await broker.invoke("sender-a", "writeEvent", {
      type: "test.event",
      startedAt: 1,
      payload: { ok: true },
      appId: "app-b",
      source: "app:app-b:ui",
      channelId: "channel-b",
    } as never);

    const headers = new Headers(request?.init?.headers);
    expect(headers.get("x-lamarck-app-capability")).toBe("capability-a");
    expect(headers.has("x-lamarck-app-id")).toBe(false);
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      type: "test.event",
      startedAt: 1,
      payload: { ok: true },
    });
    await expect(broker.invoke("sender-c", "query", { sql: "SELECT 1" }))
      .rejects.toMatchObject({ code: "sender_unbound" });
  });

  test("accepts omitted SDK optionals and does not forward undefined fields", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    });
    const { broker } = createBroker(fetchImpl);
    broker.bindSender(1, { channelId: "channel", capability: "capability" });

    await broker.invoke(1, "query", { sql: "SELECT 1", params: undefined });
    await broker.invoke(1, "vfs.command", {
      command: "ls",
      options: undefined,
    });

    expect(bodies).toEqual([
      { sql: "SELECT 1" },
      { command: "ls" },
    ]);
  });

  test("does not expose a bound raw capability through its API or serialization", () => {
    const { broker } = createBroker(vi.fn<typeof fetch>());
    const result = broker.bindSender(1, {
      channelId: "channel-secret",
      capability: "raw-secret-capability",
    });

    expect(result).toBeUndefined();
    expect(broker.size).toBe(1);
    expect(JSON.stringify(broker)).not.toContain("raw-secret-capability");
    expect(Object.keys(broker)).toEqual([]);
  });

  test.each([
    {
      operation: "query",
      input: { sql: "SELECT ?", params: [1] },
      method: "POST",
      path: "/api/query",
      body: { sql: "SELECT ?", params: [1] },
    },
    {
      operation: "resolveContentRef",
      input: { ref: { kind: "content-blob", version: 1, digest: "sha256:x" } },
      method: "POST",
      path: "/api/content-ref/resolve",
      body: { ref: { kind: "content-blob", version: 1, digest: "sha256:x" } },
    },
    {
      operation: "mutate",
      input: { sql: "DELETE FROM x" },
      method: "POST",
      path: "/api/mutate",
      body: { sql: "DELETE FROM x" },
    },
    {
      operation: "transaction",
      input: { statements: [{ sql: "SELECT 1" }] },
      method: "POST",
      path: "/api/transaction",
      body: { statements: [{ sql: "SELECT 1" }] },
    },
    {
      operation: "vfs.command",
      input: { command: "tee -- apps/a/result.md", options: { stdin: { encoding: "utf8", data: "text" } } },
      method: "POST",
      path: "/api/vfs/command",
      body: { command: "tee -- apps/a/result.md", options: { stdin: { encoding: "utf8", data: "text" } } },
    },
    {
      operation: "vfs.open",
      input: { path: "apps/a/a file.png" },
      method: "POST",
      path: "/api/vfs/open",
      body: { path: "apps/a/a file.png" },
    },
    {
      operation: "writeEvent",
      input: { type: "test", startedAt: 1, endedAt: 2, externalId: "x", payload: {} },
      method: "POST",
      path: "/api/events",
      body: { type: "test", startedAt: 1, endedAt: 2, externalId: "x", payload: {} },
    },
  ])("maps $operation to its fixed Core route", async ({ operation, input, method, path, body }) => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return jsonResponse({ mapped: operation });
    });
    const { broker } = createBroker(fetchImpl);
    broker.bindSender(7, { channelId: "channel", capability: "capability" });

    await broker.invoke(7, operation as never, input as never);

    expect(new URL(seenUrl).pathname).toBe(path);
    expect(seenInit?.method).toBe(method);
    expect(seenInit?.body === undefined ? undefined : JSON.parse(String(seenInit.body))).toEqual(body);
  });

  test("unbinds and revokes bindings fail closed", async () => {
    const revokeCapability = vi.fn(async () => {});
    const { broker } = createBroker(vi.fn<typeof fetch>(), { revokeCapability });
    broker.bindSender(1, { channelId: "channel-a", capability: "cap-a" });
    broker.bindSender(2, { channelId: "channel-b", capability: "cap-b" });

    expect(broker.unbindSender(1)).toBe(true);
    expect(broker.unbindSender(1)).toBe(false);
    await expect(broker.invoke(1, "query", { sql: "SELECT 1" }))
      .rejects.toMatchObject({ code: "sender_unbound" });
    expect(revokeCapability).not.toHaveBeenCalled();

    await expect(broker.revoke("channel-b")).resolves.toBe(true);
    expect(revokeCapability).toHaveBeenCalledWith("channel-b");
    expect(broker.size).toBe(0);
    await expect(broker.revoke("channel-b")).resolves.toBe(false);
    await expect(broker.invoke(2, "query", { sql: "SELECT 1" }))
      .rejects.toMatchObject({ code: "sender_unbound" });
  });

  test("synchronously drops every authority and aborts in-flight calls when Core is lost", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const { broker } = createBroker(fetchImpl, { timeoutMs: 10_000 });
    broker.bindSender("browser-a", { channelId: "channel-a", capability: "cap-a" });
    broker.bindSender("runtime-b", { channelId: "channel-b", capability: "cap-b" });

    const browser = broker.invokeSerialized(
      "browser-a",
      browserRequest("query", { sql: "SELECT 1" }),
    );
    const runtime = broker.invoke("runtime-b", "query", { sql: "SELECT 2" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    expect(broker.unbindAll()).toBe(2);
    expect(broker.size).toBe(0);
    expect(browserEnvelope(await browser).error?.code).toBe("request_aborted");
    await expect(runtime).rejects.toMatchObject({ code: "request_aborted" });
    expect(broker.unbindAll()).toBe(0);
    await expect(broker.invoke("runtime-b", "query", { sql: "SELECT 3" }))
      .rejects.toMatchObject({ code: "sender_unbound" });
  });

  test("rejects oversized requests before fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { broker } = createBroker(fetchImpl, { maxRequestBytes: 64 });
    broker.bindSender(1, { channelId: "channel", capability: "capability" });

    await expect(broker.invoke(1, "vfs.command", {
      command: "tee -- apps/a/result.md",
      options: { stdin: { encoding: "utf8", data: "x".repeat(100) } },
    })).rejects.toMatchObject({ code: "request_too_large" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("accepts only a bounded serialized browser request and returns a serialized envelope", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ rows: [{ answer: 42 }] }));
    const { broker } = createBroker(fetchImpl, { maxRequestBytes: 128 });
    broker.bindSender(1, { channelId: "channel", capability: "capability" });

    const success = browserEnvelope(await broker.invokeSerialized(
      1,
      browserRequest("query", { sql: "SELECT 42" }),
    ));
    expect(success).toEqual({ ok: true, result: { rows: [{ answer: 42 }] } });

    const objectFailure = browserEnvelope(await broker.invokeSerialized(1, {
      operation: "query",
      input: { sql: "SELECT 1" },
    }));
    expect(objectFailure.error?.code).toBe("invalid_request");
    const oversizedFailure = browserEnvelope(await broker.invokeSerialized(1, "x".repeat(129)));
    expect(oversizedFailure.error?.code).toBe("request_too_large");
    const afterParseFailure = browserEnvelope(await broker.invokeSerialized(
      1,
      browserRequest("query", { sql: "SELECT 42" }),
    ));
    expect(afterParseFailure.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("rejects malformed and deeply nested JSON at the Host boundary without recursion", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { broker } = createBroker(fetchImpl);
    broker.bindSender(1, { channelId: "channel", capability: "capability" });
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 140; depth++) deep = { next: deep };

    const malformed = browserEnvelope(await broker.invokeSerialized(1, "{"));
    expect(malformed.error?.code).toBe("invalid_request");
    const browserDeep = browserEnvelope(await broker.invokeSerialized(
      1,
      browserRequest("writeEvent", { type: "deep", startedAt: 1, payload: deep }),
    ));
    expect(browserDeep.error).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("nested too deeply"),
    });
    await expect(broker.invoke(1, "writeEvent", {
      type: "deep",
      startedAt: 1,
      payload: deep as never,
    })).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("nested too deeply"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("allows 16 browser calls per WebContents and fails the 17th fast", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const { broker } = createBroker(fetchImpl, { timeoutMs: 10_000 });
    broker.bindSender(1, { channelId: "channel", capability: "capability" });
    const serialized = browserRequest("query", { sql: "SELECT 1" });

    const pending = Array.from({ length: 16 }, () => broker.invokeSerialized(1, serialized));
    expect(fetchImpl).toHaveBeenCalledTimes(16);
    const rejected = browserEnvelope(await broker.invokeSerialized(1, serialized));
    expect(rejected.error?.code).toBe("too_many_requests");
    expect(fetchImpl).toHaveBeenCalledTimes(16);

    broker.unbindSender(1);
    const settled = (await Promise.all(pending)).map(browserEnvelope);
    expect(settled.every((result) => result.error?.code === "request_aborted")).toBe(true);
  });

  test("enforces aggregate request bytes per sender and globally", async () => {
    const content = "x".repeat(100);
    const vfsInput = {
      command: "tee -- apps/a/result.md",
      options: { stdin: { encoding: "utf8", data: content } },
    };
    const serialized = browserRequest("vfs.command", vfsInput);
    const coreBody = JSON.stringify(vfsInput);
    const leaseBytes = Buffer.byteLength(serialized) + Buffer.byteLength(coreBody);
    const pendingFetch = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const { broker: senderBroker } = createBroker(pendingFetch, {
      timeoutMs: 10_000,
      maxAggregateBytesPerSender: leaseBytes * 2 - 1,
      maxAggregateBytesGlobal: leaseBytes * 4,
    });
    senderBroker.bindSender(1, { channelId: "sender-channel", capability: "capability" });
    const first = senderBroker.invokeSerialized(1, serialized);
    const senderRejected = browserEnvelope(await senderBroker.invokeSerialized(1, serialized));
    expect(senderRejected.error?.code).toBe("resource_exhausted");
    expect(pendingFetch).toHaveBeenCalledTimes(1);
    senderBroker.unbindSender(1);
    await first;

    const globalFetch = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const { broker: globalBroker } = createBroker(globalFetch, {
      timeoutMs: 10_000,
      maxAggregateBytesPerSender: leaseBytes * 2,
      maxAggregateBytesGlobal: leaseBytes * 2 - 1,
    });
    globalBroker.bindSender(1, { channelId: "global-a", capability: "capability-a" });
    globalBroker.bindSender(2, { channelId: "global-b", capability: "capability-b" });
    const globalFirst = globalBroker.invokeSerialized(1, serialized);
    const globalRejected = browserEnvelope(await globalBroker.invokeSerialized(2, serialized));
    expect(globalRejected.error?.code).toBe("resource_exhausted");
    expect(globalFetch).toHaveBeenCalledTimes(1);
    globalBroker.unbindSender(1);
    globalBroker.unbindSender(2);
    await globalFirst;
  });

  test("charges response bytes and releases every byte lease after abort", async () => {
    const serialized = browserRequest("query", { sql: "SELECT 1" });
    const coreBody = JSON.stringify({ sql: "SELECT 1" });
    const requestBytes = Buffer.byteLength(serialized) + Buffer.byteLength(coreBody);
    const largeCoreResponse = { rows: ["x".repeat(100)] };
    const largeResponseBytes = Buffer.byteLength(JSON.stringify(largeCoreResponse));
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => jsonResponse(largeCoreResponse))
      .mockImplementationOnce(async () => jsonResponse({ rows: [] }));
    const { broker } = createBroker(fetchImpl, {
      maxAggregateBytesPerSender: requestBytes + largeResponseBytes - 1,
      maxAggregateBytesGlobal: requestBytes + largeResponseBytes - 1,
    });
    broker.bindSender(1, { channelId: "channel", capability: "capability" });

    const responseRejected = browserEnvelope(await broker.invokeSerialized(1, serialized));
    expect(responseRejected.error?.code).toBe("resource_exhausted");
    expect(browserEnvelope(await broker.invokeSerialized(1, serialized))).toEqual({
      ok: true,
      result: { rows: [] },
    });

    const pendingFetch = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockImplementationOnce(async () => jsonResponse({ rows: [] }));
    const { broker: abortBroker } = createBroker(pendingFetch, {
      timeoutMs: 10_000,
      maxAggregateBytesPerSender: requestBytes * 2 - 1,
      maxAggregateBytesGlobal: requestBytes * 2 - 1,
    });
    abortBroker.bindSender(7, { channelId: "old-channel", capability: "old-capability" });
    const pending = abortBroker.invokeSerialized(7, serialized);
    abortBroker.unbindSender(7);
    expect(browserEnvelope(await pending).error?.code).toBe("request_aborted");

    abortBroker.bindSender(7, { channelId: "new-channel", capability: "new-capability" });
    const afterReload = browserEnvelope(await abortBroker.invokeSerialized(7, serialized));
    expect(afterReload).toEqual({ ok: true, result: { rows: [] } });
  });

  test("releases the lease when Core base URL resolution fails", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ rows: [] }));
    const { broker } = createBroker(fetchImpl, {
      coreBaseUrl: async () => {
        attempts++;
        if (attempts === 1) throw new Error("Core is restarting");
        return "http://127.0.0.1:32100";
      },
      maxInFlightPerSender: 1,
    });
    broker.bindSender(1, { channelId: "channel", capability: "capability" });
    const serialized = browserRequest("query", { sql: "SELECT 1" });

    const failed = browserEnvelope(await broker.invokeSerialized(1, serialized));
    expect(failed.error).toMatchObject({ code: "transport_error", message: "Core is restarting" });
    expect(browserEnvelope(await broker.invokeSerialized(1, serialized))).toEqual({
      ok: true,
      result: { rows: [] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("rejects oversized Core responses", async () => {
    const { broker } = createBroker(
      vi.fn<typeof fetch>(async () => jsonResponse({ rows: ["x".repeat(100)] })),
      { maxResponseBytes: 32 },
    );
    broker.bindSender(1, { channelId: "channel", capability: "capability" });

    await expect(broker.invoke(1, "query", { sql: "SELECT 1" }))
      .rejects.toMatchObject({ code: "response_too_large" });
  });

  test("times out even when injected fetch ignores AbortSignal", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => {});
    });
    const { broker } = createBroker(fetchImpl, { timeoutMs: 10 });
    broker.bindSender(1, { channelId: "channel", capability: "capability" });

    await expect(broker.invoke(1, "query", { sql: "SELECT 1" }))
      .rejects.toMatchObject({ code: "request_timeout" });
    expect(signals[0]?.aborted).toBe(true);
  });

  test("aborts an in-flight request when its sender is unbound", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const { broker } = createBroker(fetchImpl, { timeoutMs: 10_000 });
    broker.bindSender(1, { channelId: "channel", capability: "capability" });

    const request = broker.invoke(1, "query", { sql: "SELECT 1" });
    await Promise.resolve();
    expect(broker.unbindSender(1)).toBe(true);
    await expect(request).rejects.toMatchObject({ code: "request_aborted" });
  });

  test("tracks before resolving Core and never fetches after unbind", async () => {
    let resolveBaseUrl!: (value: string) => void;
    const baseUrl = new Promise<string>((resolve) => { resolveBaseUrl = resolve; });
    const fetchImpl = vi.fn<typeof fetch>();
    const { broker } = createBroker(fetchImpl, { coreBaseUrl: () => baseUrl });
    broker.bindSender(1, { channelId: "channel", capability: "capability" });

    const request = broker.invoke(1, "query", { sql: "SELECT 1" });
    await Promise.resolve();
    expect(broker.unbindSender(1)).toBe(true);
    resolveBaseUrl("http://127.0.0.1:32100");

    await expect(request).rejects.toMatchObject({ code: "request_aborted" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("removes a binding even when Core revocation fails", async () => {
    const { broker } = createBroker(vi.fn<typeof fetch>(), {
      revokeCapability: async () => { throw new Error("Core unavailable"); },
    });
    broker.bindSender(1, { channelId: "channel", capability: "capability" });

    await expect(broker.revokeSender(1)).rejects.toMatchObject({
      code: "revoke_failed",
    } satisfies Partial<SystemBrokerError>);
    expect(broker.size).toBe(0);
    await expect(broker.invoke(1, "query", { sql: "SELECT 1" }))
      .rejects.toMatchObject({ code: "sender_unbound" });
  });
});
