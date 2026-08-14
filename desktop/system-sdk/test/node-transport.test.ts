import { Duplex, PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { FramedRpcClient } from "../src/node-transport";

function transportPair() {
  const hostToClient = new PassThrough();
  const clientToHost = new PassThrough();
  const client = Duplex.from({ readable: hostToClient, writable: clientToHost });
  return { client, hostToClient, clientToHost };
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const result = Buffer.allocUnsafe(payload.length + 4);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

async function readFrame(stream: PassThrough): Promise<Record<string, unknown>> {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < length + 4) return;
      cleanup();
      try {
        resolve(JSON.parse(buffer.subarray(4, length + 4).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = () => stream.off("data", onData);
    stream.on("data", onData);
  });
}

describe("Node framed System SDK transport", () => {
  test("sends length-prefixed RPC and accepts fragmented responses", async () => {
    const streams = transportPair();
    const client = new FramedRpcClient(streams.client, { requestTimeoutMs: 1_000 });

    const resultPromise = client.request("query", { sql: "SELECT ?", params: [1] });
    const request = await readFrame(streams.clientToHost);
    expect(request).toEqual({
      version: 1,
      requestId: 1,
      operation: "query",
      input: { sql: "SELECT ?", params: [1] },
    });

    const response = frame({
      version: 1,
      requestId: 1,
      ok: true,
      result: { rows: [{ value: 1 }] },
    });
    streams.hostToClient.write(response.subarray(0, 3));
    streams.hostToClient.write(response.subarray(3));
    await expect(resultPromise).resolves.toEqual({ rows: [{ value: 1 }] });
    client.close();
  });

  test("fails closed on a stale response id", async () => {
    const streams = transportPair();
    const client = new FramedRpcClient(streams.client, { requestTimeoutMs: 1_000 });
    const resultPromise = client.request("query", { sql: "SELECT 1" });
    await readFrame(streams.clientToHost);

    streams.hostToClient.write(frame({
      version: 1,
      requestId: 999,
      ok: true,
      result: {},
    }));
    await expect(resultPromise).rejects.toThrow("Unexpected or stale");
    await expect(client.request("query", { sql: "SELECT 2" })).rejects.toThrow("closed");
  });

  test.each([
    ["unknown response fields", frame({
      version: 1,
      requestId: 1,
      ok: true,
      result: {},
      capability: "forged",
    })],
    ["invalid UTF-8", Buffer.from([0, 0, 0, 2, 0xc3, 0x28])],
  ])("fails closed on %s", async (_label, response) => {
    const streams = transportPair();
    const client = new FramedRpcClient(streams.client, { requestTimeoutMs: 1_000 });
    const resultPromise = client.request("query", { sql: "SELECT 1" });
    await readFrame(streams.clientToHost);
    streams.hostToClient.write(response);
    await expect(resultPromise).rejects.toBeInstanceOf(Error);
    await expect(client.request("query", { sql: "SELECT 2" })).rejects.toThrow("closed");
  });

  test.each([
    ["one oversized chunk", (limit: number) => {
      const bytes = Buffer.alloc(1024 * 1024);
      bytes.writeUInt32BE(limit + 1, 0);
      return [bytes];
    }],
    ["an oversized length split across chunks", (limit: number) => {
      const prefix = Buffer.from([0, 0]);
      const remainder = Buffer.alloc(1024 * 1024);
      remainder.writeUInt16BE(limit + 1, 0);
      return [prefix, remainder];
    }],
  ])("rejects %s before buffering its payload", async (_label, chunks) => {
    const streams = transportPair();
    const limit = 512;
    const client = new FramedRpcClient(streams.client, {
      maxFrameBytes: limit,
      requestTimeoutMs: 1_000,
    });
    const resultPromise = client.request("query", { sql: "SELECT 1" });
    await readFrame(streams.clientToHost);

    for (const chunk of chunks(limit)) streams.hostToClient.write(chunk);

    await expect(resultPromise).rejects.toThrow("frame limit");
    await expect(client.request("query", { sql: "SELECT 2" })).rejects.toThrow("closed");
  });

  test("accepts multiple complete response frames coalesced into one chunk", async () => {
    const streams = transportPair();
    const client = new FramedRpcClient(streams.client, { requestTimeoutMs: 1_000 });
    const first = client.request("query", { sql: "SELECT 1" });
    const second = client.request("query", { sql: "SELECT 2" });
    await readFrame(streams.clientToHost);

    streams.hostToClient.write(Buffer.concat([
      frame({ version: 1, requestId: 1, ok: true, result: { rows: [1] } }),
      frame({ version: 1, requestId: 2, ok: true, result: { rows: [2] } }),
    ]));

    await expect(first).resolves.toEqual({ rows: [1] });
    await expect(second).resolves.toEqual({ rows: [2] });
    client.close();
  });

  test("bounds request frames and times out an unanswered call", async () => {
    const oversizedStreams = transportPair();
    const bounded = new FramedRpcClient(oversizedStreams.client, {
      maxFrameBytes: 64,
      requestTimeoutMs: 1_000,
    });
    await expect(bounded.request("vfs.command", {
      command: "tee -- apps/a/result.md",
      options: { stdin: { encoding: "utf8", data: "x".repeat(100) } },
    })).rejects.toThrow("frame limit");
    bounded.close();

    const timeoutStreams = transportPair();
    const timeout = new FramedRpcClient(timeoutStreams.client, { requestTimeoutMs: 10 });
    await expect(timeout.request("query", { sql: "SELECT 1" })).rejects.toThrow("timed out");
    timeout.close();
  });
});
