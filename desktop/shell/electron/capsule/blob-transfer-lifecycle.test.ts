import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  abortableIterable,
  startBlobTransfer,
  writeIterable,
} from "./macos-backend";

const FAST_POLICY = {
  idleTimeoutMs: 5,
  baseDeadlineMs: 100,
  minimumBytesPerSecond: 1024 * 1024,
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("Host blob source cancellation", () => {
  test("aborts a never-yielding AsyncIterator and invokes return at the idle deadline", async () => {
    vi.useFakeTimers();
    const destination = new PassThrough();
    destination.on("error", () => {});
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => await new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: returned,
        };
      },
    };
    const transfer = startBlobTransfer(destination, 1, new AbortController().signal, FAST_POLICY);
    const writing = writeIterable(destination, source, transfer.signal, transfer.progress);
    const rejected = expect(writing).rejects.toThrow(
      "idle deadline (0/1 bytes observed; phase=data)",
    );

    await vi.advanceTimersByTimeAsync(6);
    await rejected;
    expect(returned).toHaveBeenCalledOnce();
  });

  test("destroys a stalled Readable when an inbound transfer deadline fires", async () => {
    vi.useFakeTimers();
    const transport = new PassThrough();
    transport.on("error", () => {});
    const source = new Readable({ read() {} });
    const transfer = startBlobTransfer(transport, 1, new AbortController().signal, FAST_POLICY);
    const consuming = (async () => {
      for await (const _chunk of abortableIterable(source, transfer.signal, transfer.progress)) {
        // A stalled source never reaches this branch.
      }
    })();
    const rejected = expect(consuming).rejects.toThrow(
      "idle deadline (0/1 bytes observed; phase=data)",
    );

    await vi.advanceTimersByTimeAsync(6);
    await rejected;
    expect(source.destroyed).toBe(true);
  });

  test("reports partial byte progress when the next DATA window stalls", async () => {
    vi.useFakeTimers();
    const transport = new PassThrough();
    transport.on("error", () => {});
    const transfer = startBlobTransfer(transport, 2, new AbortController().signal, FAST_POLICY);
    transfer.progress(1);

    await vi.advanceTimersByTimeAsync(6);
    expect(transfer.signal.aborted).toBe(true);
    expect(transfer.signal.reason).toMatchObject({
      message: "Host blob DATA stream made no byte progress before its idle deadline (1/2 bytes observed; phase=data)",
    });
  });
});
