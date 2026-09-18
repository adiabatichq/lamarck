import { Duplex, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  bindClientDisconnectAbort,
  pipeResponseBody,
  serve,
  WebSocketConnection,
} from "../src/node-server";

describe("Node Core HTTP adapter", () => {
  test("shutdown waits for an admitted mutation after disconnecting its client", async () => {
    let complete!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const mutation = new Promise<void>(resolve => { complete = resolve; });
    const server = await serve({
      hostname: "127.0.0.1", port: 0,
      async fetch() {
        entered();
        await mutation;
        return Response.json({ committed: true });
      },
    });
    const response = fetch(`http://127.0.0.1:${server.port}/mutation`, { method: "POST" }).catch(() => null);
    await started;
    let stopped = false;
    const closing = server.stop().then(() => { stopped = true; });
    try {
      await delay(10);
      expect(stopped).toBe(false);
    } finally {
      complete();
      await closing;
      await response;
    }
    expect(stopped).toBe(true);
  });
  test("aborts the Fetch request when its HTTP client disconnects before a response", () => {
    const response = new FakeResponseClose();
    const controller = new AbortController();
    const cleanup = bindClientDisconnectAbort(response, controller);

    response.emit("close");
    expect(controller.signal.aborted).toBe(true);
    cleanup();
  });

  test("does not reinterpret a completed response close as request cancellation", () => {
    const response = new FakeResponseClose();
    response.writableEnded = true;
    const controller = new AbortController();
    const cleanup = bindClientDisconnectAbort(response, controller);

    response.emit("close");
    expect(controller.signal.aborted).toBe(false);
    cleanup();
  });

  test("cancels an SSE-style Web stream when the client disconnects", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const piping = pipeResponseBody(body, sink as unknown as ServerResponse);
    await delay(0);
    sink.emit("close");
    await piping;

    expect(cancelled).toBe(true);
  });

  test("destroys a WebSocket transport instead of buffering unbounded output", async () => {
    let closed = false;
    const transport = new StalledDuplex();
    const connection = new WebSocketConnection(transport, {}, {
      close() {
        closed = true;
      },
    });
    const megabyte = new Uint8Array(1024 * 1024);

    for (let index = 0; index < 8; index++) connection.socket.send(megabyte);
    await delay(0);

    expect(transport.destroyed).toBe(true);
    expect(closed).toBe(true);
  });

  test("cancels a late response when the client has already disconnected", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    sink.destroy();
    await delay(0); // The close event is already gone before the handler returns.
    await pipeResponseBody(body, sink as unknown as ServerResponse);
    expect(cancelled).toBe(true);
    expect(sink.listenerCount("close")).toBe(0);
  });
});

class FakeResponseClose extends EventEmitter {
  writableEnded = false;
  writableFinished = false;
}

class StalledDuplex extends Duplex {
  _read(): void {}

  _write(_chunk: Buffer, _encoding: BufferEncoding, _callback: (error?: Error | null) => void): void {
    // Deliberately never acknowledge the write, simulating a client that has
    // stopped reading while terminal output continues.
  }
}
