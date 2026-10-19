import type { Readable, Writable } from "node:stream";

export const OUTPUT_RELAY_BYTES = 64 * 1024;

/** Always drain the process. Transport congestion keeps a bounded recent tail,
 * never an unbounded Writable queue or backpressure on unattended App code. */
export function drainWorkloadOutput(sources: readonly Readable[], destination?: Writable): { finish(): Promise<void> } {
  let pending = Buffer.alloc(0);
  let blocked = false;
  let closed = !destination;
  let ended = 0;
  const waiters = new Set<() => void>();
  const notify = () => { if (closed || (ended === sources.length && !pending.length)) for (const done of waiters) done(); };
  const flush = () => {
    if (closed || blocked || !pending.length) return;
    const bytes = pending;
    pending = Buffer.alloc(0);
    try { blocked = !destination!.write(bytes); } catch { close(); }
    notify();
  };
  const close = () => { closed = true; pending = Buffer.alloc(0); notify(); };
  destination?.on("drain", () => { blocked = false; flush(); });
  destination?.once("close", close);
  destination?.on("error", close);
  for (const source of sources) {
    source.on("data", (chunk: Buffer) => {
      if (closed) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // A single source chunk is bounded too, including synthetic test streams.
      pending = bytes.length >= OUTPUT_RELAY_BYTES ? Buffer.from(bytes.subarray(-OUTPUT_RELAY_BYTES))
        : Buffer.concat([pending.subarray(Math.max(0, pending.length + bytes.length - OUTPUT_RELAY_BYTES)), bytes]);
      flush();
    });
    source.once("end", () => { if (++ended === sources.length) { flush(); notify(); } });
    source.resume();
  }
  return { finish: () => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
    // Descendants may hold a pipe after init exits. Evidence cannot delay
    // descendant cleanup indefinitely, including if the Host stopped reading.
    const timer = setTimeout(done, 1000);
    waiters.add(done); flush(); notify();
  }) };
}
