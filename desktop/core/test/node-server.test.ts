import { Duplex, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  bindClientDisconnectAbort,
  pipeResponseBody,
  WebSocketConnection,
} from "../src/node-server";

describe("Node Core HTTP adapter", () => {
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
