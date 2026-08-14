import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once as onceEvent } from "node:events";
import { PassThrough, type TransformCallback } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  CapsuleVmHostClient,
  type CapsuleVmHostStream,
  launchCapsuleVmHost,
} from "./launcher";
import {
  CAPSULE_VM_CONTROL_VSOCK_PORT,
  CAPSULE_VM_DATA_VSOCK_PORT,
  CAPSULE_VM_HELPER_STREAM_ID_MIN,
  CAPSULE_VM_MAX_OPEN_STREAMS,
  CAPSULE_VM_MAX_PENDING_REQUESTS,
  CAPSULE_VM_PROTOCOL_VERSION,
  CAPSULE_VM_STREAM_CHUNK_BYTES,
  CAPSULE_VM_STREAM_WINDOW_BYTES,
  CapsuleVmFrameDecoder,
  CapsuleVmFrameKind,
  decodeCapsuleVmJson,
  decodeCapsuleVmWindowUpdate,
  encodeCapsuleVmFrame,
  encodeCapsuleVmJson,
  encodeCapsuleVmWindowUpdate,
  type CapsuleVmFrame,
} from "./protocol";

class FakeChild extends EventEmitter {
  readonly stdin: PassThrough;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 123;
  killed = false;

  constructor(stdin = new PassThrough()) {
    super();
    this.stdin = stdin;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

class DelayedPassThrough extends PassThrough {
  readonly #pending: Array<() => void> = [];

  get pendingCount(): number {
    return this.#pending.length;
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.#pending.push(() => super._transform(chunk, encoding, callback));
  }

  releaseNext(): void {
    const release = this.#pending.shift();
    if (!release) throw new Error("No delayed Host write is pending");
    release();
  }
}

describe("Capsule VM helper launcher v2", () => {
  test("requires protocol v2 for probe, signed start, and stateful stop", async () => {
    const child = new FakeChild();
    const decoder = new CapsuleVmFrameDecoder();
    child.stdin.on("data", (chunk: Uint8Array) => {
      for (const request of decoder.push(chunk)) {
        expect(request.kind).toBe(CapsuleVmFrameKind.Request);
        const value = decodeCapsuleVmJson(request.payload) as {
          method: string;
          params?: Record<string, unknown>;
        };
        if (value.method === "probe") {
          writeResponse(child, request.streamId, {
            protocolVersion: CAPSULE_VM_PROTOCOL_VERSION,
            hostArchitecture: "arm64",
            virtualizationSupported: true,
          });
        } else if (value.method === "prepareState") {
          expect(value.params).toEqual({
            stateDirectory: "/private/var/tmp/lamarck-state",
            stateDiskBytes: 4 * 1_024 * 1_024 * 1_024,
          });
          writeResponse(child, request.streamId, {
            preparationId: PREPARATION_ID,
            stateDiskBytes: 4 * 1_024 * 1_024 * 1_024,
            existingPhysicalBytes: 0,
            additionalPhysicalBytes: 4 * 1_024 * 1_024 * 1_024,
            peakPhysicalBytes: 4 * 1_024 * 1_024 * 1_024,
          });
        } else if (value.method === "start") {
          expect(value.params).toMatchObject({ statePreparationId: PREPARATION_ID });
          expect(value.params).not.toHaveProperty("stateDirectory");
          expect(value.params).not.toHaveProperty("stateDiskBytes");
          writeResponse(child, request.streamId, {
            protocolVersion: CAPSULE_VM_PROTOCOL_VERSION,
            state: "running",
            imageDigest: IMAGE_DIGEST,
            architecture: "arm64",
          });
        } else if (value.method === "cancelStatePreparation") {
          expect(value.params).toEqual({ preparationId: PREPARATION_ID });
          writeResponse(child, request.streamId, { state: "cancelled" });
        } else if (value.method === "stop") {
          writeResponse(child, request.streamId, { state: "stopped" });
        }
      }
    });
    const client = new CapsuleVmHostClient(child.asChild(), { requestTimeoutMs: 100 });

    await expect(client.probe()).resolves.toMatchObject({
      protocolVersion: CAPSULE_VM_PROTOCOL_VERSION,
    });
    await expect(client.prepareState({
      stateDirectory: "/private/var/tmp/lamarck-state",
      stateDiskBytes: 4 * 1_024 * 1_024 * 1_024,
    })).resolves.toMatchObject({ preparationId: PREPARATION_ID });
    await expect(client.cancelStatePreparation(PREPARATION_ID)).resolves.toBeUndefined();
    await client.prepareState({
      stateDirectory: "/private/var/tmp/lamarck-state",
      stateDiskBytes: 4 * 1_024 * 1_024 * 1_024,
    });
    await expect(client.startGuest(guestDescriptor())).resolves.toMatchObject({
      protocolVersion: CAPSULE_VM_PROTOCOL_VERSION,
      imageDigest: IMAGE_DIGEST,
    });
    await expect(client.stopGuest()).resolves.toBeUndefined();
    client.close();
  });

  test("does not contact the helper without a complete Guest image", async () => {
    const child = new FakeChild();
    const onInput = vi.fn();
    child.stdin.on("data", onInput);
    const client = new CapsuleVmHostClient(child.asChild());

    await expect(client.startGuest()).rejects.toMatchObject({ code: "guest_image_required" });
    for (const stateDiskBytes of [
      4 * 1_024 * 1_024 * 1_024 - 1,
      4 * 1_024 * 1_024 * 1_024 + 1,
      64 * 1_024 * 1_024 * 1_024 + 64 * 1_024 * 1_024,
    ]) {
      await expect(client.startGuest({ ...guestDescriptor(), stateDiskBytes }))
        .rejects.toMatchObject({ code: "guest_image_required" });
      await expect(client.prepareState({
        stateDirectory: "/private/var/tmp/lamarck-state",
        stateDiskBytes,
      })).rejects.toMatchObject({ code: "state_preparation_required" });
    }
    expect(onInput).not.toHaveBeenCalled();
    client.close();
  });

  test("derives the start deadline from state materialization size", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const client = new CapsuleVmHostClient(child.asChild(), { requestTimeoutMs: 1 });
      const start = client.startGuest(guestDescriptor());
      const rejected = expect(start).rejects.toMatchObject({ code: "request_timeout" });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(child.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns receive credit only after Node consumes DATA", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "control");

    writeHelperFrame(child, CapsuleVmFrameKind.Data, stream.streamId, Buffer.from("hello"));
    expect(stream.readableLength).toBe(5);
    expect(outbound).toEqual([]);

    expect(stream.read()?.toString()).toBe("hello");
    const update = await waitFor(() => outbound.find(
      (frame) => frame.kind === CapsuleVmFrameKind.WindowUpdate,
    ));
    expect(decodeCapsuleVmWindowUpdate(update.payload)).toBe(5);

    const ended = onceEvent(stream, "end");
    writeHelperFrame(child, CapsuleVmFrameKind.Fin, stream.streamId, new Uint8Array());
    stream.resume();
    await ended;
    stream.end();
    await onceEvent(stream, "finish");
    await waitFor(() => outbound.some((frame) => frame.kind === CapsuleVmFrameKind.Fin));
    await waitFor(() => client.openStreamCount === 0);
    client.close();
  });

  test("physically completes an in-flight receive-credit update before queued Host FIN", async () => {
    const stdin = new DelayedPassThrough();
    const child = new FakeChild(stdin);
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");

    writeHelperFrame(child, CapsuleVmFrameKind.Data, stream.streamId, Buffer.from([0x61]));
    expect(stream.read()).toEqual(Buffer.from([0x61]));
    await waitFor(() => stdin.pendingCount === 1);

    const ended = onceEvent(stream, "end");
    writeHelperFrame(child, CapsuleVmFrameKind.Fin, stream.streamId, new Uint8Array());
    stream.resume();
    await ended;
    const finished = onceEvent(stream, "finish");
    stream.end();

    expect(outbound).toEqual([]);
    stdin.releaseNext();
    await waitFor(() => stdin.pendingCount === 1);
    expect(outbound.map((frame) => frame.kind)).toEqual([
      CapsuleVmFrameKind.WindowUpdate,
    ]);

    stdin.releaseNext();
    await finished;
    await waitFor(() => client.openStreamCount === 0);
    expect(outbound.map((frame) => frame.kind)).toEqual([
      CapsuleVmFrameKind.WindowUpdate,
      CapsuleVmFrameKind.Fin,
    ]);
    client.close();
  });

  test("drops unscheduled receive credit when normal stream retirement overtakes it", async () => {
    const stdin = new DelayedPassThrough();
    const child = new FakeChild(stdin);
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const blocker = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const target = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN + 1, "data");

    const blockerWrite = writeAsync(blocker, Buffer.from("block writer"));
    await waitFor(() => stdin.pendingCount === 1);

    writeHelperFrame(child, CapsuleVmFrameKind.Data, target.streamId, Buffer.from([0x62]));
    expect(target.read()).toEqual(Buffer.from([0x62]));
    const ended = onceEvent(target, "end");
    writeHelperFrame(child, CapsuleVmFrameKind.Fin, target.streamId, new Uint8Array());
    target.resume();
    await ended;
    const finished = onceEvent(target, "finish");
    target.end();

    stdin.releaseNext();
    await blockerWrite;
    await waitFor(() => stdin.pendingCount === 1);
    expect(outbound.map((frame) => [frame.kind, frame.streamId])).toEqual([
      [CapsuleVmFrameKind.Data, blocker.streamId],
    ]);

    stdin.releaseNext();
    await finished;
    await waitFor(() => client.openStreamCount === 1);

    const sentinelWrite = writeAsync(blocker, Buffer.from("sentinel"));
    await waitFor(() => stdin.pendingCount === 1);
    stdin.releaseNext();
    await sentinelWrite;
    expect(outbound.map((frame) => [frame.kind, frame.streamId])).toEqual([
      [CapsuleVmFrameKind.Data, blocker.streamId],
      [CapsuleVmFrameKind.Fin, target.streamId],
      [CapsuleVmFrameKind.Data, blocker.streamId],
    ]);
    expect(outbound.some((frame) =>
      frame.kind === CapsuleVmFrameKind.WindowUpdate
      && frame.streamId === target.streamId)).toBe(false);
    client.close();
  });

  test("returns receive credit across multiple windows consumed by async iteration", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const received: Buffer[] = [];
    const consume = (async () => {
      for await (const chunk of stream) received.push(Buffer.from(chunk));
    })();

    const fullWindowChunks = CAPSULE_VM_STREAM_WINDOW_BYTES / CAPSULE_VM_STREAM_CHUNK_BYTES;
    let sentBytes = 0;
    for (let window = 0; window < 3; window += 1) {
      for (let chunk = 0; chunk < fullWindowChunks; chunk += 1) {
        const payload = Buffer.alloc(CAPSULE_VM_STREAM_CHUNK_BYTES, window + 1);
        writeHelperFrame(child, CapsuleVmFrameKind.Data, stream.streamId, payload);
        sentBytes += payload.byteLength;
      }
      await waitFor(() => outbound
        .filter((frame) => frame.kind === CapsuleVmFrameKind.WindowUpdate)
        .reduce((bytes, frame) => bytes + decodeCapsuleVmWindowUpdate(frame.payload), 0) >= sentBytes);
      expect(child.killed).toBe(false);
    }

    writeHelperFrame(child, CapsuleVmFrameKind.Fin, stream.streamId, new Uint8Array());
    await consume;
    expect(stream.destroyed).toBe(false);
    expect(stream.writableEnded).toBe(false);
    expect(Buffer.concat(received)).toEqual(Buffer.concat([
      Buffer.alloc(CAPSULE_VM_STREAM_WINDOW_BYTES, 1),
      Buffer.alloc(CAPSULE_VM_STREAM_WINDOW_BYTES, 2),
      Buffer.alloc(CAPSULE_VM_STREAM_WINDOW_BYTES, 3),
    ]));
    const finished = onceEvent(stream, "finish");
    stream.end();
    await finished;
    await waitFor(() => client.openStreamCount === 0);
    expect(outbound.filter((frame) => frame.kind === CapsuleVmFrameKind.Fin)).toHaveLength(1);
    expect(outbound.some((frame) => frame.kind === CapsuleVmFrameKind.Reset)).toBe(false);
    await waitFor(() => stream.destroyed);
    client.close();
  });

  test("returns receive credit when delayed DATA is consumed by pipe flowing mode", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const sink = new PassThrough();
    const received: Buffer[] = [];
    sink.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));
    stream.pipe(sink);

    // Let pipe() enter flowing mode before helper DATA arrives. Node then
    // dispatches push()ed chunks directly through "data" instead of read().
    await new Promise((resolve) => setImmediate(resolve));
    const fullWindowChunks = CAPSULE_VM_STREAM_WINDOW_BYTES / CAPSULE_VM_STREAM_CHUNK_BYTES;
    let sentBytes = 0;
    for (let window = 0; window < 3; window += 1) {
      for (let chunk = 0; chunk < fullWindowChunks; chunk += 1) {
        const payload = Buffer.alloc(CAPSULE_VM_STREAM_CHUNK_BYTES, window + 1);
        writeHelperFrame(child, CapsuleVmFrameKind.Data, stream.streamId, payload);
        sentBytes += payload.byteLength;
      }
      await waitFor(() => outbound
        .filter((frame) => frame.kind === CapsuleVmFrameKind.WindowUpdate)
        .reduce((bytes, frame) => bytes + decodeCapsuleVmWindowUpdate(frame.payload), 0) >= sentBytes);
      expect(child.killed).toBe(false);
    }

    writeHelperFrame(child, CapsuleVmFrameKind.Fin, stream.streamId, new Uint8Array());
    await onceEvent(sink, "end");
    stream.end();
    await onceEvent(stream, "finish");
    await waitFor(() => client.openStreamCount === 0);
    expect(Buffer.concat(received)).toEqual(Buffer.concat([
      Buffer.alloc(CAPSULE_VM_STREAM_WINDOW_BYTES, 1),
      Buffer.alloc(CAPSULE_VM_STREAM_WINDOW_BYTES, 2),
      Buffer.alloc(CAPSULE_VM_STREAM_WINDOW_BYTES, 3),
    ]));
    client.close();
  });

  test("enforces the fixed 256 KiB receive window without pausing global stdout", async () => {
    const child = new FakeChild();
    const pause = vi.spyOn(child.stdout, "pause");
    const client = new CapsuleVmHostClient(child.asChild());
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const chunk = Buffer.alloc(CAPSULE_VM_STREAM_CHUNK_BYTES);

    for (let index = 0; index < CAPSULE_VM_STREAM_WINDOW_BYTES / chunk.byteLength; index += 1) {
      writeHelperFrame(child, CapsuleVmFrameKind.Data, stream.streamId, chunk);
    }
    expect(stream.readableLength).toBe(CAPSULE_VM_STREAM_WINDOW_BYTES);
    expect(child.killed).toBe(false);
    expect(pause).not.toHaveBeenCalled();

    writeHelperFrame(child, CapsuleVmFrameKind.Data, stream.streamId, Buffer.from([1]));
    await waitFor(() => child.killed);
  });

  test("stalls Host DATA at its implicit window and resumes only with valid credit", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");

    const firstWrite = writeAsync(stream, Buffer.alloc(CAPSULE_VM_STREAM_WINDOW_BYTES, 0x61));
    const secondWrite = writeAsync(stream, Buffer.from([0x62]));
    await firstWrite;
    await waitFor(() => outbound.filter((frame) => frame.kind === CapsuleVmFrameKind.Data).length === 4);
    expect(outbound.filter((frame) => frame.kind === CapsuleVmFrameKind.Data))
      .toHaveLength(CAPSULE_VM_STREAM_WINDOW_BYTES / CAPSULE_VM_STREAM_CHUNK_BYTES);

    let secondFinished = false;
    void secondWrite.then(() => { secondFinished = true; });
    await Promise.resolve();
    expect(secondFinished).toBe(false);

    writeHelperFrame(
      child,
      CapsuleVmFrameKind.WindowUpdate,
      stream.streamId,
      encodeCapsuleVmWindowUpdate(1),
    );
    await secondWrite;
    expect(outbound.filter((frame) => frame.kind === CapsuleVmFrameKind.Data).at(-1)?.payload)
      .toEqual(new Uint8Array([0x62]));
    client.close();
  });

  test("retires dual-FIN streams only after exact applied-DATA credit drains", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const payload = Buffer.from("applied before FIN");

    await writeAsync(stream, payload);
    await waitFor(() => outbound.some((frame) => frame.kind === CapsuleVmFrameKind.Data));

    const ended = onceEvent(stream, "end");
    writeHelperFrame(child, CapsuleVmFrameKind.Fin, stream.streamId, new Uint8Array());
    stream.resume();
    await ended;
    const finished = onceEvent(stream, "finish");
    stream.end();
    await finished;
    await waitFor(() => outbound.some((frame) => frame.kind === CapsuleVmFrameKind.Fin));

    expect(client.openStreamCount).toBe(1);
    expect(child.killed).toBe(false);

    writeHelperFrame(
      child,
      CapsuleVmFrameKind.WindowUpdate,
      stream.streamId,
      encodeCapsuleVmWindowUpdate(payload.byteLength),
    );
    await waitFor(() => client.openStreamCount === 0);
    expect(child.killed).toBe(false);
    client.close();
  });

  test("preserves a clean dual-FIN close while Host FIN completion and exact credit are pending", async () => {
    const stdin = new DelayedPassThrough();
    const child = new FakeChild(stdin);
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const payload = Buffer.from("applied before clean close");

    const write = writeAsync(stream, payload);
    await waitFor(() => stdin.pendingCount === 1);
    stdin.releaseNext();
    await write;
    expect(outbound.map((frame) => frame.kind)).toEqual([CapsuleVmFrameKind.Data]);

    const ended = onceEvent(stream, "end");
    writeHelperFrame(child, CapsuleVmFrameKind.Fin, stream.streamId, new Uint8Array());
    stream.resume();
    await ended;

    stream.end();
    await waitFor(() => stdin.pendingCount === 1);
    const closed = onceEvent(stream, "close");
    stream.destroy();
    await closed;

    expect(client.openStreamCount).toBe(1);
    expect(outbound.map((frame) => frame.kind)).toEqual([CapsuleVmFrameKind.Data]);

    stdin.releaseNext();
    await waitFor(() => outbound.some((frame) => frame.kind === CapsuleVmFrameKind.Fin));
    expect(client.openStreamCount).toBe(1);
    expect(outbound.some((frame) => frame.kind === CapsuleVmFrameKind.Reset)).toBe(false);

    writeHelperFrame(
      child,
      CapsuleVmFrameKind.WindowUpdate,
      stream.streamId,
      encodeCapsuleVmWindowUpdate(payload.byteLength),
    );
    await waitFor(() => client.openStreamCount === 0);
    expect(child.killed).toBe(false);
    client.close();
  });

  test("fails closed on invalid or excess credit while a dual-FIN stream drains", async () => {
    for (const lateUpdate of [
      new Uint8Array(3),
      encodeCapsuleVmWindowUpdate(2),
    ]) {
      const child = new FakeChild();
      const client = new CapsuleVmHostClient(child.asChild());
      const outbound = captureOutbound(child);
      const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");

      await writeAsync(stream, Buffer.from([0x61]));
      await waitFor(() => outbound.some((frame) => frame.kind === CapsuleVmFrameKind.Data));
      const ended = onceEvent(stream, "end");
      writeHelperFrame(child, CapsuleVmFrameKind.Fin, stream.streamId, new Uint8Array());
      stream.resume();
      await ended;
      const finished = onceEvent(stream, "finish");
      stream.end();
      await finished;
      await waitFor(() => outbound.some((frame) => frame.kind === CapsuleVmFrameKind.Fin));
      expect(client.openStreamCount).toBe(1);

      writeHelperFrame(child, CapsuleVmFrameKind.WindowUpdate, stream.streamId, lateUpdate);
      await waitFor(() => child.killed);
    }
  });

  test("fails closed on credit after a dual-FIN stream has fully drained", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");

    await writeAsync(stream, Buffer.from([0x61]));
    await waitFor(() => outbound.some((frame) => frame.kind === CapsuleVmFrameKind.Data));
    const ended = onceEvent(stream, "end");
    writeHelperFrame(child, CapsuleVmFrameKind.Fin, stream.streamId, new Uint8Array());
    stream.resume();
    await ended;
    const finished = onceEvent(stream, "finish");
    stream.end();
    await finished;
    await waitFor(() => outbound.some((frame) => frame.kind === CapsuleVmFrameKind.Fin));

    writeHelperFrame(
      child,
      CapsuleVmFrameKind.WindowUpdate,
      stream.streamId,
      encodeCapsuleVmWindowUpdate(1),
    );
    await waitFor(() => client.openStreamCount === 0);
    writeHelperFrame(
      child,
      CapsuleVmFrameKind.WindowUpdate,
      stream.streamId,
      encodeCapsuleVmWindowUpdate(1),
    );
    await waitFor(() => child.killed);
  });

  test("prioritizes stop and round-robins DATA instead of queueing a bulk stream ahead", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild(), { requestTimeoutMs: 100 });
    const outbound = captureOutbound(child, (frame) => {
      if (frame.kind !== CapsuleVmFrameKind.Request) return;
      const value = decodeCapsuleVmJson(frame.payload) as { method: string };
      if (value.method === "stop") writeResponse(child, frame.streamId, { state: "stopped" });
    });
    const first = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const second = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN + 1, "data");

    const firstWrite = writeAsync(first, Buffer.alloc(CAPSULE_VM_STREAM_WINDOW_BYTES));
    const secondWrite = writeAsync(second, Buffer.alloc(CAPSULE_VM_STREAM_WINDOW_BYTES));
    const stop = client.stopGuest();
    await stop;
    await Promise.all([firstWrite, secondWrite]);

    const relevant = outbound.filter((frame) =>
      frame.kind === CapsuleVmFrameKind.Data || frame.kind === CapsuleVmFrameKind.Request);
    expect(relevant[0].kind).toBe(CapsuleVmFrameKind.Data);
    expect(relevant[1].kind).toBe(CapsuleVmFrameKind.Request);
    const dataIds = relevant.filter((frame) => frame.kind === CapsuleVmFrameKind.Data)
      .map((frame) => frame.streamId);
    expect(dataIds.slice(0, 6)).toEqual([
      first.streamId,
      second.streamId,
      first.streamId,
      second.streamId,
      first.streamId,
      second.streamId,
    ]);
    client.close();
  });

  test("fails closed on credit overflow and malformed WINDOW_UPDATE", async () => {
    for (const payload of [
      encodeCapsuleVmWindowUpdate(1),
      new Uint8Array(3),
      new Uint8Array(4),
    ]) {
      const child = new FakeChild();
      const client = new CapsuleVmHostClient(child.asChild());
      const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
      writeHelperFrame(child, CapsuleVmFrameKind.WindowUpdate, stream.streamId, payload);
      await waitFor(() => child.killed);
    }
  });

  test("fails closed on DATA after FIN, duplicate FIN, and nonempty FIN", async () => {
    for (const terminalFrames of [
      [
        { kind: CapsuleVmFrameKind.Fin, payload: new Uint8Array() },
        { kind: CapsuleVmFrameKind.Data, payload: Buffer.from("late") },
      ],
      [
        { kind: CapsuleVmFrameKind.Fin, payload: new Uint8Array() },
        { kind: CapsuleVmFrameKind.Fin, payload: new Uint8Array() },
      ],
      [{ kind: CapsuleVmFrameKind.Fin, payload: Buffer.from([1]) }],
    ]) {
      const child = new FakeChild();
      const client = new CapsuleVmHostClient(child.asChild());
      const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
      for (const frame of terminalFrames) {
        writeHelperFrame(child, frame.kind, stream.streamId, frame.payload);
      }
      await waitFor(() => child.killed);
    }
  });

  test("uses RESET/RESET_ACK tombstones for local aborts", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");

    const closed = onceEvent(stream, "close");
    stream.destroy();
    await closed;
    const reset = await waitFor(() => outbound.find(
      (frame) => frame.kind === CapsuleVmFrameKind.Reset,
    ));
    expect(decodeCapsuleVmJson(reset.payload)).toEqual({
      code: "host_stream_aborted",
      message: "Host destroyed stream before both directions reached FIN",
    });
    writeHelperFrame(child, CapsuleVmFrameKind.ResetAck, stream.streamId, new Uint8Array());
    await waitFor(() => client.openStreamCount === 0);

    writeHelperFrame(child, CapsuleVmFrameKind.Data, stream.streamId, Buffer.from("replay"));
    await waitFor(() => child.killed);
  });

  test("keeps exact late write credit live until a local RESET is acknowledged", async () => {
    const stdin = new DelayedPassThrough();
    const child = new FakeChild(stdin);
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const payload = Buffer.from("physically applied before reset");

    const write = writeAsync(stream, payload);
    await waitFor(() => stdin.pendingCount === 1);
    stdin.releaseNext();
    await write;

    const closed = onceEvent(stream, "close");
    stream.destroy(new Error("abort after DATA reached Swift"));
    await waitFor(() => stdin.pendingCount === 1);
    stdin.releaseNext();
    await closed;
    expect(outbound.map((frame) => frame.kind)).toEqual([
      CapsuleVmFrameKind.Data,
      CapsuleVmFrameKind.Reset,
    ]);
    expect(client.openStreamCount).toBe(1);

    writeHelperFrame(
      child,
      CapsuleVmFrameKind.WindowUpdate,
      stream.streamId,
      encodeCapsuleVmWindowUpdate(payload.byteLength),
    );
    expect(child.killed).toBe(false);
    expect(client.openStreamCount).toBe(1);

    writeHelperFrame(child, CapsuleVmFrameKind.ResetAck, stream.streamId, new Uint8Array());
    await waitFor(() => client.openStreamCount === 0);
    expect(child.killed).toBe(false);
    client.close();
  });

  test("consumes previously credited in-flight DATA and FIN before local RESET_ACK", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const received: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));

    const closed = onceEvent(stream, "close");
    stream.destroy(new Error("abort while helper DATA is already in flight"));
    await closed;
    expect(client.openStreamCount).toBe(1);

    writeHelperFrame(child, CapsuleVmFrameKind.Data, stream.streamId, Buffer.from("in flight"));
    writeHelperFrame(child, CapsuleVmFrameKind.Fin, stream.streamId, new Uint8Array());
    expect(received).toEqual([]);
    expect(child.killed).toBe(false);
    expect(client.openStreamCount).toBe(1);

    writeHelperFrame(child, CapsuleVmFrameKind.ResetAck, stream.streamId, new Uint8Array());
    await waitFor(() => client.openStreamCount === 0);
    expect(received).toEqual([]);
    expect(child.killed).toBe(false);
    client.close();
  });

  test("fails closed on excess late write credit while local RESET awaits its ACK", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");

    await writeAsync(stream, Buffer.from([0x61]));
    const closed = onceEvent(stream, "close");
    stream.destroy(new Error("abort with one byte outstanding"));
    await closed;
    writeHelperFrame(
      child,
      CapsuleVmFrameKind.WindowUpdate,
      stream.streamId,
      encodeCapsuleVmWindowUpdate(2),
    );
    await waitFor(() => child.killed);
  });

  test("turns an early async-iterator exit into RESET instead of clean FIN", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");

    const consumed = (async () => {
      for await (const _chunk of stream) break;
    })();
    writeHelperFrame(child, CapsuleVmFrameKind.Data, stream.streamId, Buffer.from("one chunk"));
    await consumed;

    const reset = await waitFor(() => outbound.find(
      (frame) => frame.kind === CapsuleVmFrameKind.Reset,
    ));
    expect(decodeCapsuleVmJson(reset.payload)).toMatchObject({ code: "host_stream_aborted" });
    expect(outbound.some((frame) => frame.kind === CapsuleVmFrameKind.Fin)).toBe(false);
    writeHelperFrame(child, CapsuleVmFrameKind.ResetAck, stream.streamId, new Uint8Array());
    await waitFor(() => client.openStreamCount === 0);
    client.close();
  });

  test("withdraws a queued FIN when local RESET wins before physical write", async () => {
    const stdin = new DelayedPassThrough();
    const child = new FakeChild(stdin);
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const blocker = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const target = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN + 1, "data");

    const blockingWrite = writeAsync(blocker, Buffer.from("block physical writer"));
    await waitFor(() => stdin.pendingCount === 1);
    target.end();
    const closed = onceEvent(target, "close");
    target.destroy(new Error("abort before queued FIN is written"));

    stdin.releaseNext();
    await blockingWrite;
    await waitFor(() => stdin.pendingCount === 1);
    stdin.releaseNext();
    await closed;

    const targetFrames = outbound.filter((frame) => frame.streamId === target.streamId);
    expect(targetFrames.filter((frame) => frame.kind === CapsuleVmFrameKind.Reset)).toHaveLength(1);
    expect(targetFrames.some((frame) => frame.kind === CapsuleVmFrameKind.Fin)).toBe(false);
    client.close();
  });

  test("acknowledges a strict peer RESET and rejects its replay", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound = captureOutbound(child);
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const resetPayload = encodeCapsuleVmJson({ code: "vsock_read_failed", message: "peer reset" });

    const closed = onceEvent(stream, "close");
    writeHelperFrame(child, CapsuleVmFrameKind.Reset, stream.streamId, resetPayload);
    await closed;
    await waitFor(() => outbound.some((frame) => frame.kind === CapsuleVmFrameKind.ResetAck));
    expect(client.openStreamCount).toBe(0);
    expect(child.killed).toBe(false);

    writeHelperFrame(child, CapsuleVmFrameKind.Reset, stream.streamId, resetPayload);
    await waitFor(() => child.killed);
  });

  test("fails closed on malformed RESET and RESET_ACK payloads", async () => {
    for (const [kind, payload] of [
      [CapsuleVmFrameKind.Reset, new Uint8Array()],
      [CapsuleVmFrameKind.Reset, encodeCapsuleVmJson({
        code: "bad",
        message: "unknown field",
        extra: true,
      })],
      [CapsuleVmFrameKind.ResetAck, Buffer.from([1])],
    ] as const) {
      const child = new FakeChild();
      const client = new CapsuleVmHostClient(child.asChild());
      const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
      writeHelperFrame(child, kind, stream.streamId, payload);
      await waitFor(() => child.killed);
    }
  });

  test("rejects oversized local writes instead of creating an unbounded per-stream queue", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const stream = await openStream(child, client, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");

    await expect(writeAsync(stream, Buffer.alloc(CAPSULE_VM_STREAM_WINDOW_BYTES + 1)))
      .rejects.toMatchObject({ code: "stream_write_too_large" });
    client.close();
  });

  test("enforces global stream bounds, disjoint IDs, and one control stream per boot", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    for (let index = 0; index < CAPSULE_VM_MAX_OPEN_STREAMS; index += 1) {
      writeOpenEvent(
        child,
        CAPSULE_VM_HELPER_STREAM_ID_MIN + index,
        index === 0 ? "control" : "data",
      );
    }
    expect(client.openStreamCount).toBe(CAPSULE_VM_MAX_OPEN_STREAMS);
    writeOpenEvent(child, CAPSULE_VM_HELPER_STREAM_ID_MIN + CAPSULE_VM_MAX_OPEN_STREAMS, "data");
    await waitFor(() => child.killed);
  });

  test("kills ambiguous helper sessions on malformed output or request timeout", async () => {
    const malformed = new FakeChild();
    malformed.stdin.on("data", () => malformed.stdout.write(new Uint8Array(16)));
    const malformedClient = new CapsuleVmHostClient(malformed.asChild(), { requestTimeoutMs: 100 });
    await expect(malformedClient.probe()).rejects.toMatchObject({ code: "invalid_magic" });
    expect(malformed.killed).toBe(true);

    const silent = new FakeChild();
    const silentClient = new CapsuleVmHostClient(silent.asChild(), { requestTimeoutMs: 10 });
    await expect(silentClient.probe()).rejects.toMatchObject({ code: "request_timeout" });
    expect(silent.killed).toBe(true);
  });

  test("starts a request deadline only after the REQUEST frame is physically written", async () => {
    const input = new DelayedPassThrough();
    const child = new FakeChild(input);
    const decoder = new CapsuleVmFrameDecoder();
    child.stdin.on("data", (chunk: Uint8Array) => {
      for (const request of decoder.push(chunk)) {
        writeResponse(child, request.streamId, {
          protocolVersion: CAPSULE_VM_PROTOCOL_VERSION,
          hostArchitecture: "arm64",
          virtualizationSupported: true,
        });
      }
    });
    const client = new CapsuleVmHostClient(child.asChild(), { requestTimeoutMs: 10 });

    const probe = client.probe();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(child.killed).toBe(false);

    input.releaseNext();
    await expect(probe).resolves.toMatchObject({
      protocolVersion: CAPSULE_VM_PROTOCOL_VERSION,
    });
    client.close();
  });

  test("bounds pending requests while the prioritized writer is stalled", async () => {
    const input = new DelayedPassThrough();
    const child = new FakeChild(input);
    const client = new CapsuleVmHostClient(child.asChild(), { requestTimeoutMs: 10 });
    const admitted = Array.from(
      { length: CAPSULE_VM_MAX_PENDING_REQUESTS },
      () => client.probe().catch(() => undefined),
    );

    await expect(client.probe()).rejects.toMatchObject({
      code: "too_many_pending_requests",
    });
    expect(child.killed).toBe(false);

    client.close();
    await Promise.all(admitted);
  });

  test("spawns an absolute helper without a shell or inherited environment", () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child.asChild());
    const client = launchCapsuleVmHost({
      executablePath: "/Applications/Lamarck.app/Contents/Helpers/lamarck-capsule-vm-host",
      spawnProcess: spawnProcess as never,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "/Applications/Lamarck.app/Contents/Helpers/lamarck-capsule-vm-host",
      [],
      expect.objectContaining({
        shell: false,
        env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    client.close();
  });
});

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const PREPARATION_ID = "01234567-89ab-4def-8123-456789abcdef";

function guestDescriptor() {
  return {
    imageBundlePath: "/Applications/Lamarck.app/Contents/Resources/capsule-guest",
    stateDirectory: "/Users/test/Library/Application Support/Lamarck/capsule-vm",
    workspaceFilesPath: "/Users/test/Documents/Lamarck/files",
    expectedManifestDigest: IMAGE_DIGEST,
    manifestPublicKey: Buffer.alloc(32, 7).toString("base64"),
    cpuCount: 2,
    memorySizeBytes: 1_073_741_824,
    stateDiskBytes: 4 * 1_024 * 1_024 * 1_024,
    statePreparationId: PREPARATION_ID,
  };
}

function captureOutbound(child: FakeChild, onFrame?: (frame: CapsuleVmFrame) => void): CapsuleVmFrame[] {
  const frames: CapsuleVmFrame[] = [];
  const decoder = new CapsuleVmFrameDecoder();
  child.stdin.on("data", (chunk: Uint8Array) => {
    for (const frame of decoder.push(chunk)) {
      frames.push(frame);
      onFrame?.(frame);
    }
  });
  return frames;
}

async function openStream(
  child: FakeChild,
  client: CapsuleVmHostClient,
  streamId: number,
  channel: "control" | "data",
): Promise<CapsuleVmHostStream> {
  let opened: CapsuleVmHostStream | undefined;
  client.once("stream", (stream) => { opened = stream; });
  writeOpenEvent(child, streamId, channel);
  return waitFor(() => opened);
}

function writeResponse(child: FakeChild, streamId: number, result: unknown): void {
  writeHelperFrame(
    child,
    CapsuleVmFrameKind.Response,
    streamId,
    encodeCapsuleVmJson({ ok: true, result }),
  );
}

function writeOpenEvent(
  child: FakeChild,
  streamId: number,
  channel: "control" | "data",
): void {
  writeHelperFrame(child, CapsuleVmFrameKind.Event, streamId, encodeCapsuleVmJson({
    type: "stream.open",
    channel,
    sourcePort: 50_000,
    destinationPort: channel === "control"
      ? CAPSULE_VM_CONTROL_VSOCK_PORT
      : CAPSULE_VM_DATA_VSOCK_PORT,
  }));
}

function writeHelperFrame(
  child: FakeChild,
  kind: CapsuleVmFrameKind,
  streamId: number,
  payload: Uint8Array,
): void {
  child.stdout.write(encodeCapsuleVmFrame({ kind, streamId, payload }));
}

function writeAsync(stream: CapsuleVmHostStream, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

async function waitFor<T>(operation: () => T | undefined | false): Promise<Exclude<T, undefined | false>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = operation();
    if (value !== undefined && value !== false) return value as Exclude<T, undefined | false>;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition");
}
