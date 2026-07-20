import { EventEmitter, once as onceEvent } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
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
  CAPSULE_VM_STREAM_CHUNK_BYTES,
  CapsuleVmFrameDecoder,
  CapsuleVmFrameKind,
  decodeCapsuleVmJson,
  encodeCapsuleVmFrame,
  encodeCapsuleVmJson,
} from "./protocol";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 123;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

describe("Capsule VM helper launcher", () => {
  test("probes over a request-bound response stream", async () => {
    const child = new FakeChild();
    const requestDecoder = new CapsuleVmFrameDecoder();
    child.stdin.on("data", (chunk: Uint8Array) => {
      const [request] = requestDecoder.push(chunk);
      expect(request.kind).toBe(CapsuleVmFrameKind.Request);
      expect(decodeCapsuleVmJson(request.payload)).toEqual({ method: "probe" });
      child.stdout.write(encodeCapsuleVmFrame({
        kind: CapsuleVmFrameKind.Response,
        streamId: request.streamId,
        payload: encodeCapsuleVmJson({
          ok: true,
          result: {
            protocolVersion: 1,
            hostArchitecture: "arm64",
            virtualizationSupported: true,
          },
        }),
      }));
    });
    const client = new CapsuleVmHostClient(child.asChild(), { requestTimeoutMs: 100 });

    await expect(client.probe()).resolves.toEqual({
      protocolVersion: 1,
      hostArchitecture: "arm64",
      virtualizationSupported: true,
    });
    client.close();
  });

  test("does not contact the helper without a complete Guest image", async () => {
    const child = new FakeChild();
    const onInput = vi.fn();
    child.stdin.on("data", onInput);
    const client = new CapsuleVmHostClient(child.asChild());

    await expect(client.startGuest()).rejects.toMatchObject({
      code: "guest_image_required",
    });
    expect(onInput).not.toHaveBeenCalled();
    client.close();
  });

  test("starts only a matching signed Guest descriptor and stops statefully", async () => {
    const child = new FakeChild();
    const requestDecoder = new CapsuleVmFrameDecoder();
    child.stdin.on("data", (chunk: Uint8Array) => {
      for (const request of requestDecoder.push(chunk)) {
        const value = decodeCapsuleVmJson(request.payload) as { method: string };
        if (value.method === "start") {
          writeResponse(child, request.streamId, {
            protocolVersion: 1,
            state: "running",
            imageDigest: IMAGE_DIGEST,
            architecture: "arm64",
          });
        } else if (value.method === "stop") {
          writeResponse(child, request.streamId, { state: "stopped" });
        }
      }
    });
    const client = new CapsuleVmHostClient(child.asChild(), { requestTimeoutMs: 100 });

    await expect(client.startGuest(guestDescriptor())).resolves.toEqual({
      protocolVersion: 1,
      state: "running",
      imageDigest: IMAGE_DIGEST,
      architecture: "arm64",
    });
    await expect(client.stopGuest()).resolves.toBeUndefined();
    client.close();
  });

  test("exposes helper-originated vsock as a bounded Node Duplex", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild(), { requestTimeoutMs: 100 });
    let opened: CapsuleVmHostStream | undefined;
    client.once("stream", (stream) => { opened = stream; });
    const outbound: Array<{ kind: CapsuleVmFrameKind; streamId: number; payload: Uint8Array }> = [];
    const outboundDecoder = new CapsuleVmFrameDecoder();
    child.stdin.on("data", (chunk: Uint8Array) => outbound.push(...outboundDecoder.push(chunk)));

    writeOpenEvent(child, CAPSULE_VM_HELPER_STREAM_ID_MIN, "control");
    const stream = await waitFor(() => opened);
    expect(stream.channel).toBe("control");
    expect(stream.destinationPort).toBe(CAPSULE_VM_CONTROL_VSOCK_PORT);

    const received: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => received.push(chunk));
    writeHelperFrame(child, CapsuleVmFrameKind.StreamData, stream.streamId, Buffer.from("hello"));
    writeHelperFrame(child, CapsuleVmFrameKind.StreamEnd, stream.streamId, new Uint8Array());
    await onceEvent(stream, "end");
    expect(Buffer.concat(received).toString()).toBe("hello");

    const payload = Buffer.alloc(CAPSULE_VM_STREAM_CHUNK_BYTES + 7, 0x61);
    await new Promise<void>((resolve, reject) => {
      stream.write(payload, (error) => error ? reject(error) : resolve());
    });
    stream.end();
    await onceEvent(stream, "finish");
    await waitFor(() => outbound.filter((frame) => frame.kind === CapsuleVmFrameKind.StreamData).length === 2);

    const dataFrames = outbound.filter((frame) => frame.kind === CapsuleVmFrameKind.StreamData);
    expect(dataFrames.map((frame) => frame.payload.byteLength)).toEqual([
      CAPSULE_VM_STREAM_CHUNK_BYTES,
      7,
    ]);
    expect(outbound.at(-1)?.kind).toBe(CapsuleVmFrameKind.StreamEnd);
    await waitFor(() => client.openStreamCount === 0);
    client.close();
  });

  test("drains in-flight bytes after a local abort and rejects a second control stream", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    let stream: CapsuleVmHostStream | undefined;
    client.once("stream", (value) => { stream = value; });
    writeOpenEvent(child, CAPSULE_VM_HELPER_STREAM_ID_MIN, "control");
    const opened = await waitFor(() => stream);
    opened.destroy();
    await onceEvent(opened, "close");

    writeHelperFrame(child, CapsuleVmFrameKind.StreamData, opened.streamId, Buffer.from("late"));
    writeHelperFrame(child, CapsuleVmFrameKind.StreamEnd, opened.streamId, new Uint8Array());
    await waitFor(() => client.openStreamCount === 0);
    expect(child.killed).toBe(false);

    writeOpenEvent(child, CAPSULE_VM_HELPER_STREAM_ID_MIN + 1, "control");
    await waitFor(() => child.killed);
  });

  test("acknowledges local teardown after a helper read-side half-close", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound: Array<{ kind: CapsuleVmFrameKind; streamId: number; payload: Uint8Array }> = [];
    const outboundDecoder = new CapsuleVmFrameDecoder();
    child.stdin.on("data", (chunk: Uint8Array) => outbound.push(...outboundDecoder.push(chunk)));
    let stream: CapsuleVmHostStream | undefined;
    client.once("stream", (value) => { stream = value; });

    writeOpenEvent(child, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const opened = await waitFor(() => stream);
    opened.resume();
    const ended = onceEvent(opened, "end");
    writeHelperFrame(child, CapsuleVmFrameKind.StreamEnd, opened.streamId, new Uint8Array());
    await ended;

    opened.destroy();
    await onceEvent(opened, "close");
    const abort = await waitFor(() => outbound.find(
      (frame) => frame.kind === CapsuleVmFrameKind.StreamEnd
        && frame.streamId === opened.streamId,
    ));
    expect(decodeCapsuleVmJson(abort.payload)).toEqual({
      code: "host_stream_aborted",
      message: "Host destroyed stream",
    });
    expect(client.openStreamCount).toBe(1);

    writeHelperFrame(child, CapsuleVmFrameKind.StreamEnd, opened.streamId, new Uint8Array());
    await waitFor(() => client.openStreamCount === 0);
    expect(child.killed).toBe(false);
    client.close();
  });

  test("does not echo a helper-side terminal stream error", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const outbound: Array<{ kind: CapsuleVmFrameKind; streamId: number; payload: Uint8Array }> = [];
    const outboundDecoder = new CapsuleVmFrameDecoder();
    child.stdin.on("data", (chunk: Uint8Array) => outbound.push(...outboundDecoder.push(chunk)));
    let stream: CapsuleVmHostStream | undefined;
    client.once("stream", (value) => { stream = value; });

    writeOpenEvent(child, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const opened = await waitFor(() => stream);
    const closed = onceEvent(opened, "close");
    writeHelperFrame(
      child,
      CapsuleVmFrameKind.StreamEnd,
      opened.streamId,
      encodeCapsuleVmJson({ code: "vsock_read_failed", message: "peer reset" }),
    );
    await closed;

    expect(outbound).toEqual([]);
    expect(client.openStreamCount).toBe(0);
    expect(child.killed).toBe(false);
    client.close();
  });

  test("admits one fresh control stream after a new Guest boot starts", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    const opened: CapsuleVmHostStream[] = [];
    client.on("stream", (stream) => opened.push(stream));

    writeOpenEvent(child, CAPSULE_VM_HELPER_STREAM_ID_MIN, "control");
    const first = await waitFor(() => opened[0]);
    first.destroy();
    await onceEvent(first, "close");
    writeHelperFrame(child, CapsuleVmFrameKind.StreamEnd, first.streamId, new Uint8Array());
    await waitFor(() => client.openStreamCount === 0);

    writeHelperFrame(child, CapsuleVmFrameKind.Event, 0, encodeCapsuleVmJson({
      type: "vm.state",
      state: "starting",
    }));
    writeOpenEvent(child, CAPSULE_VM_HELPER_STREAM_ID_MIN + 1, "control");
    const second = await waitFor(() => opened[1]);

    expect(second.channel).toBe("control");
    expect(child.killed).toBe(false);
    second.destroy();
    writeHelperFrame(child, CapsuleVmFrameKind.StreamEnd, second.streamId, new Uint8Array());
    await waitFor(() => client.openStreamCount === 0);
    client.close();
  });

  test("bounds one slow stream without head-of-line blocking helper stdout", async () => {
    const child = new FakeChild();
    const pause = vi.spyOn(child.stdout, "pause");
    const client = new CapsuleVmHostClient(child.asChild(), { streamHighWaterMarkBytes: 1 });
    let stream: CapsuleVmHostStream | undefined;
    client.once("stream", (value) => { stream = value; });
    writeOpenEvent(child, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    const opened = await waitFor(() => stream);
    const closed = onceEvent(opened, "close");

    writeHelperFrame(child, CapsuleVmFrameKind.StreamData, opened.streamId, Buffer.from("ab"));
    await closed;
    expect(pause).not.toHaveBeenCalled();
    expect(child.killed).toBe(false);

    writeHelperFrame(child, CapsuleVmFrameKind.StreamEnd, opened.streamId, new Uint8Array());
    await waitFor(() => client.openStreamCount === 0);
    client.close();
  });

  test("enforces the global helper stream bound", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    for (let index = 0; index < CAPSULE_VM_MAX_OPEN_STREAMS; index += 1) {
      writeOpenEvent(child, CAPSULE_VM_HELPER_STREAM_ID_MIN + index, "data");
    }
    expect(client.openStreamCount).toBe(CAPSULE_VM_MAX_OPEN_STREAMS);
    writeOpenEvent(
      child,
      CAPSULE_VM_HELPER_STREAM_ID_MIN + CAPSULE_VM_MAX_OPEN_STREAMS,
      "data",
    );
    await waitFor(() => child.killed);
  });

  test("fails the helper session on unknown, wrong-parity, or oversized stream frames", async () => {
    for (const frame of [
      encodeCapsuleVmFrame({
        kind: CapsuleVmFrameKind.StreamData,
        streamId: CAPSULE_VM_HELPER_STREAM_ID_MIN,
        payload: new Uint8Array(),
      }),
      encodeCapsuleVmFrame({
        kind: CapsuleVmFrameKind.Event,
        streamId: 7,
        payload: encodeCapsuleVmJson({
          type: "stream.open",
          channel: "data",
          sourcePort: 50_001,
          destinationPort: CAPSULE_VM_DATA_VSOCK_PORT,
        }),
      }),
      encodeCapsuleVmFrame({
        kind: CapsuleVmFrameKind.StreamData,
        streamId: 7,
        payload: new Uint8Array(),
      }),
    ]) {
      const child = new FakeChild();
      const client = new CapsuleVmHostClient(child.asChild());
      child.stdout.write(frame);
      await waitFor(() => child.killed);
      client.close();
    }

    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild());
    writeOpenEvent(child, CAPSULE_VM_HELPER_STREAM_ID_MIN, "data");
    writeHelperFrame(
      child,
      CapsuleVmFrameKind.StreamData,
      CAPSULE_VM_HELPER_STREAM_ID_MIN,
      new Uint8Array(CAPSULE_VM_STREAM_CHUNK_BYTES + 1),
    );
    await waitFor(() => child.killed);
    client.close();
  });

  test("kills the helper and rejects pending work on a malformed response", async () => {
    const child = new FakeChild();
    child.stdin.on("data", () => {
      child.stdout.write(new Uint8Array(16));
    });
    const client = new CapsuleVmHostClient(child.asChild(), { requestTimeoutMs: 100 });

    await expect(client.probe()).rejects.toMatchObject({ code: "invalid_magic" });
    expect(child.killed).toBe(true);
  });

  test("kills an ambiguous helper session on request timeout", async () => {
    const child = new FakeChild();
    const client = new CapsuleVmHostClient(child.asChild(), { requestTimeoutMs: 10 });

    await expect(client.probe()).rejects.toMatchObject({ code: "request_timeout" });
    expect(child.killed).toBe(true);
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

function guestDescriptor() {
  return {
    imageBundlePath: "/Applications/Lamarck.app/Contents/Resources/capsule-guest",
    stateDirectory: "/Users/test/Library/Application Support/Lamarck/capsule-vm",
    expectedManifestDigest: IMAGE_DIGEST,
    manifestPublicKey: Buffer.alloc(32, 7).toString("base64"),
    cpuCount: 2,
    memorySizeBytes: 1_073_741_824,
  };
}

function writeResponse(child: FakeChild, streamId: number, result: unknown): void {
  child.stdout.write(encodeCapsuleVmFrame({
    kind: CapsuleVmFrameKind.Response,
    streamId,
    payload: encodeCapsuleVmJson({ ok: true, result }),
  }));
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

async function waitFor<T>(operation: () => T | undefined | false): Promise<Exclude<T, undefined | false>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = operation();
    if (value !== undefined && value !== false) return value as Exclude<T, undefined | false>;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition");
}
