import { MAX_DATA_PRELUDE_BYTES, parseDataStreamPrelude, type DataStreamPrelude } from "@lamarck/capsule";
import type { Socket } from "node:net";

export async function readDataStreamPrelude(
  socket: Socket,
  timeoutMs = 10_000,
): Promise<DataStreamPrelude> {
  return await new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let expectedFrameBytes: number | undefined;
    const timer = setTimeout(() => finish(new Error("data stream prelude timed out")), timeoutMs);
    const onData = (chunk: Buffer) => {
      socket.pause();
      buffered = buffered.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk]);
      if (expectedFrameBytes === undefined && buffered.byteLength >= 4) {
        const payloadBytes = buffered.readUInt32BE(0);
        if (payloadBytes < 1 || payloadBytes > MAX_DATA_PRELUDE_BYTES) {
          finish(new Error("data stream prelude length is outside the protocol limit"));
          return;
        }
        expectedFrameBytes = 4 + payloadBytes;
      }
      if (expectedFrameBytes === undefined || buffered.byteLength < expectedFrameBytes) {
        socket.resume();
        return;
      }
      const payload = buffered.subarray(4, expectedFrameBytes);
      const extra = buffered.subarray(expectedFrameBytes);
      let value: unknown;
      try {
        const json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
        value = JSON.parse(json) as unknown;
      } catch (error) {
        finish(new Error(`invalid data stream prelude JSON: ${String(error)}`));
        return;
      }
      try {
        const prelude = parseDataStreamPrelude(value);
        cleanup();
        if (extra.byteLength > 0) socket.unshift(extra);
        resolve(prelude);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onEnd = () => finish(new Error("data stream ended before its prelude"));
    const onError = (error: Error) => finish(error);
    const finish = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onError);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.resume();
  });
}
