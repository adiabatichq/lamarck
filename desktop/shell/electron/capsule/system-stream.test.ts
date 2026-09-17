import { Duplex } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { SystemBroker } from "./system-broker";
import { SystemStreamServer } from "./system-stream";

describe("Node System SDK stream termination", () => {
  test.each(['ai.cancel', 'ai.toolResult'] as const)("admits %s as request 17 while ordinary requests are saturated", async operation => {
    const release: (() => void)[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/query')) return new Promise<Response>((resolve, reject) => {
        release.push(() => resolve(Response.json({ rows: [] })));
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
      return Response.json({ ok: true });
    });
    const broker = new SystemBroker({ coreBaseUrl: 'http://127.0.0.1:32100', fetch: fetchMock, revokeCapability: () => {} });
    broker.bindSender('node-control', { channelId: 'channel-control', capability: 'secret-control' });
    const { client, server } = duplexPair();
    const onClose = vi.fn();
    new SystemStreamServer(broker).attach('node-control', server, { onClose });
    try {
      client.write(Buffer.concat(Array.from({ length: 16 }, (_, i) => frame({ version: 1, requestId: i + 1, operation: 'query', input: { sql: 'select 1' } }))));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(16));
      const response = readFrame(client);
      client.write(frame({ version: 1, requestId: 17, operation, input: { invocationId: 'ai-fixture', ...(operation === 'ai.toolResult' ? { toolCallId: 'tool', value: 'answer', failed: false } : {}) } }));
      expect(await response).toEqual({ version: 1, requestId: 17, ok: true, result: { ok: true } });
      expect(fetchMock).toHaveBeenCalledTimes(17);
      expect(new Headers(fetchMock.mock.calls[16][1]?.headers).get('x-lamarck-app-capability')).toBe('secret-control');
      expect(onClose).not.toHaveBeenCalled();
      expect(server.destroyed).toBe(false);
      expect(broker.size).toBe(1);
    } finally {
      for (const resolve of release) resolve();
      client.destroy();
    }
  });

  test.each(['query', 'ai.next'] as const)('does not let %s consume the control reserve', async operation => {
    const broker = new SystemBroker({
      coreBaseUrl: 'http://127.0.0.1:32100', revokeCapability: () => {},
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); }),
    });
    broker.bindSender('node-overflow', { channelId: 'channel-overflow', capability: 'secret-overflow' });
    const { client, server } = duplexPair();
    const onClose = vi.fn();
    new SystemStreamServer(broker).attach('node-overflow', server, { onClose });
    client.write(Buffer.concat(Array.from({ length: 17 }, (_, i) => frame({ version: 1, requestId: i + 1, operation, input: operation === 'query' ? { sql: 'select 1' } : { invocationId: 'ai-fixture', sequence: i } }))));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ message: 'too many in-flight System SDK requests' })));
    expect(server.destroyed).toBe(true);
    expect(broker.size).toBe(0);
    client.destroy();
  });

  test('bounds the control reserve to four extra requests', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); }));
    const broker = new SystemBroker({ coreBaseUrl: 'http://127.0.0.1:32100', fetch: fetchMock, revokeCapability: () => {} });
    broker.bindSender('node-reserve', { channelId: 'channel-reserve', capability: 'secret-reserve' });
    const { client, server } = duplexPair();
    const onClose = vi.fn();
    new SystemStreamServer(broker).attach('node-reserve', server, { onClose });
    client.write(Buffer.concat(Array.from({ length: 20 }, (_, i) => frame({ version: 1, requestId: i + 1, operation: i < 16 ? 'query' : 'ai.cancel', input: i < 16 ? { sql: 'select 1' } : { invocationId: 'ai-fixture' } }))));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(20));
    expect(onClose).not.toHaveBeenCalled();
    client.write(frame({ version: 1, requestId: 21, operation: 'ai.cancel', input: { invocationId: 'ai-fixture' } }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ message: 'too many in-flight System SDK requests' })));
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(broker.size).toBe(0);
    client.destroy();
  });

  test("maps framed requests through the sender-bound Host broker", async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => Response.json({ rows: [{ answer: 42 }] }));
    const broker = new SystemBroker({
      coreBaseUrl: "http://127.0.0.1:32100",
      fetch: fetchMock as typeof globalThis.fetch,
      revokeCapability: () => {},
    });
    broker.bindSender("node-1", { channelId: "channel-1", capability: "secret-1" });
    const { client, server } = duplexPair();
    new SystemStreamServer(broker).attach("node-1", server);

    client.write(frame({
      version: 1,
      requestId: 9,
      operation: "query",
      input: { sql: "select ?", params: [42] },
    }));
    const response = await readFrame(client) as {
      requestId: number;
      ok: boolean;
      result: { rows: Array<{ answer: number }> };
    };
    expect(response).toEqual({
      version: 1,
      requestId: 9,
      ok: true,
      result: { rows: [{ answer: 42 }] },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get("x-lamarck-app-capability")).toBe("secret-1");
    expect(String(init?.body)).toContain("select ?");
    client.on("error", () => {});
    client.destroy();
  });

  test("destroys malformed streams and removes their capability binding", async () => {
    const broker = new SystemBroker({
      coreBaseUrl: "http://127.0.0.1:32100",
      fetch: vi.fn(),
      revokeCapability: () => {},
    });
    broker.bindSender("node-bad", { channelId: "channel-bad", capability: "secret-bad" });
    const { client, server } = duplexPair();
    new SystemStreamServer(broker, { maxFrameBytes: 64 }).attach("node-bad", server);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(65);
    client.write(oversized);
    await new Promise((resolve) => setImmediate(resolve));
    expect(broker.size).toBe(0);
    client.on("error", () => {});
    client.destroy();
  });

  test("rejects an oversized length split across chunks without concatenating the payload", async () => {
    const broker = new SystemBroker({
      coreBaseUrl: "http://127.0.0.1:32100",
      fetch: vi.fn(),
      revokeCapability: () => {},
    });
    broker.bindSender("node-prefix", { channelId: "channel-prefix", capability: "secret-prefix" });
    const { client, server } = duplexPair();
    new SystemStreamServer(broker, { maxFrameBytes: 512 }).attach("node-prefix", server);
    client.write(Buffer.from([0, 0]));
    const remainder = Buffer.alloc(64 * 1024);
    remainder.writeUInt16BE(513, 0);
    client.write(remainder);

    await new Promise((resolve) => setImmediate(resolve));
    expect(broker.size).toBe(0);
    client.on("error", () => {});
    client.destroy();
  });

  test.each([
    ["unknown fields", frame({
      version: 1,
      requestId: 1,
      operation: "query",
      input: { sql: "select 1" },
      appId: "forged-app",
    })],
    ["invalid UTF-8", Buffer.from([0, 0, 0, 2, 0xc3, 0x28])],
  ])("fails closed on %s", async (_label, bytes) => {
    const broker = new SystemBroker({
      coreBaseUrl: "http://127.0.0.1:32100",
      fetch: vi.fn(),
      revokeCapability: () => {},
    });
    broker.bindSender("node-bad", { channelId: "channel-bad", capability: "secret-bad" });
    const { client, server } = duplexPair();
    new SystemStreamServer(broker).attach("node-bad", server);
    client.write(bytes);
    await new Promise((resolve) => setImmediate(resolve));
    expect(broker.size).toBe(0);
    client.on("error", () => {});
    client.destroy();
  });

  test("lets CapsuleManager own the binding across a normal stream replacement", async () => {
    const broker = new SystemBroker({
      coreBaseUrl: "http://127.0.0.1:32100",
      fetch: vi.fn(),
      revokeCapability: () => {},
    });
    broker.bindSender("node-reload", { channelId: "channel-reload", capability: "secret-reload" });
    const { client, server } = duplexPair();
    const onClose = vi.fn();
    new SystemStreamServer(broker, { unbindOnClose: false }).attach(
      "node-reload",
      server,
      { onClose },
    );
    client.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(broker.size).toBe(1);
    expect(onClose).toHaveBeenCalledWith(undefined);
    broker.unbindSender("node-reload");
  });

  test("closes a slow SDK stream before concurrent responses can buffer without bound", async () => {
    const fetchMock = vi.fn(async () => Response.json({ rows: ["x".repeat(120)] }));
    const broker = new SystemBroker({
      coreBaseUrl: "http://127.0.0.1:32100",
      fetch: fetchMock as typeof globalThis.fetch,
      revokeCapability: () => {},
    });
    broker.bindSender("node-slow", { channelId: "channel-slow", capability: "secret-slow" });
    const stream = new BlockedWriteDuplex();
    const onClose = vi.fn();
    new SystemStreamServer(broker, {
      maxFrameBytes: 1_024,
      maxBufferedResponseBytes: 240,
    }).attach("node-slow", stream, { onClose });

    stream.feed(Buffer.concat([
      frame({ version: 1, requestId: 1, operation: "query", input: { sql: "select 1" } }),
      frame({ version: 1, requestId: 2, operation: "query", input: { sql: "select 2" } }),
    ]));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onClose.mock.calls[0]?.[0]).toMatchObject({
      message: "System SDK response buffer limit exceeded",
    });
    expect(stream.destroyed).toBe(true);
    expect(broker.size).toBe(0);
  });
});

function duplexPair(): { client: Duplex; server: Duplex } {
  const client = new MemoryDuplex();
  const server = new MemoryDuplex();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

class MemoryDuplex extends Duplex {
  peer: MemoryDuplex | undefined;
  _read(): void {}
  _write(chunk: Buffer | Uint8Array | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.peer?.destroyed) callback(new Error("peer closed"));
    else {
      this.peer?.push(Buffer.from(chunk));
      callback();
    }
  }
  _final(callback: (error?: Error | null) => void): void {
    this.peer?.push(null);
    callback();
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.peer?.push(null);
    callback(error);
  }
}

class BlockedWriteDuplex extends Duplex {
  _read(): void {}

  _write(
    _chunk: Buffer | Uint8Array | string,
    _encoding: BufferEncoding,
    _callback: (error?: Error | null) => void,
  ): void {
    // Deliberately withhold the callback to model a Guest workload that stops
    // consuming Host responses while continuing to issue requests.
  }

  feed(bytes: Buffer): void {
    this.push(bytes);
  }
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const result = Buffer.allocUnsafe(payload.length + 4);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

function readFrame(stream: Duplex): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => reject(new Error("response timeout")), 1_000);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < length + 4) return;
      cleanup();
      resolve(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("error", reject);
    };
    stream.on("data", onData);
    stream.once("error", reject);
  });
}
