import { PassThrough, Writable } from "node:stream";
import { expect, test } from "vitest";
import { drainWorkloadOutput, OUTPUT_RELAY_BYTES } from "../src/oci/workload-output";

test("stdout and stderr keep draining through saturation and transport failure", async () => {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const received: Buffer[] = [];
  let unblock: (() => void) | undefined;
  const sink = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    received.push(Buffer.from(chunk)); unblock = callback;
  } });
  drainWorkloadOutput([stdout, stderr], sink);
  stdout.write(Buffer.alloc(OUTPUT_RELAY_BYTES, "a"));
  for (let n = 0; n < 1024; n++) { stdout.write(Buffer.alloc(4096, "b")); stderr.write(Buffer.alloc(4096, "c")); }
  expect(stdout.readableLength).toBe(0); expect(stderr.readableLength).toBe(0);
  expect(sink.writableLength).toBeLessThanOrEqual(OUTPUT_RELAY_BYTES);
  unblock!(); await new Promise(resolve => setImmediate(resolve));
  expect(received.at(-1)!.length).toBeLessThanOrEqual(OUTPUT_RELAY_BYTES);
  expect(received.at(-1)!.subarray(-4096).toString()).toBe("c".repeat(4096));
  sink.destroy(new Error("Host lost")); await new Promise(resolve => setImmediate(resolve));
  stdout.write(Buffer.alloc(OUTPUT_RELAY_BYTES)); stderr.write(Buffer.alloc(OUTPUT_RELAY_BYTES));
  expect(stdout.readableLength).toBe(0); expect(stderr.readableLength).toBe(0);
  stdout.end(); stderr.end();
});
