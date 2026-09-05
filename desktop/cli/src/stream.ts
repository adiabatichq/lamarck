import type { Readable, Writable } from "node:stream";
import { CLI_MAX_CONTROL_BYTES } from "./operations.js";

export class CliStreamReader {
  readonly #iterator: AsyncIterator<unknown>;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  constructor(stream: Readable) { this.#iterator = stream[Symbol.asyncIterator](); }
  async readFrame(): Promise<Buffer> {
    const header = await this.readExact(4);
    const bytes = header.readUInt32BE(0);
    if (bytes < 1 || bytes > CLI_MAX_CONTROL_BYTES) throw new Error("CLI frame length is outside the V1 bound");
    return this.readExact(bytes);
  }
  async readExact(bytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid CLI read length");
    const result = Buffer.allocUnsafe(bytes); let written = 0;
    while (written < bytes) {
      if (!this.#buffer.byteLength) {
        const next = await this.#iterator.next();
        if (next.done) throw new Error("CLI stream ended before its declared payload");
        this.#buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
        if (!this.#buffer.byteLength) continue;
      }
      const take = Math.min(bytes - written, this.#buffer.byteLength);
      this.#buffer.copy(result, written, 0, take); written += take; this.#buffer = this.#buffer.subarray(take);
    }
    return result;
  }

  async readToEnd(maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid CLI read bound");
    const chunks: Buffer[] = [];
    let total = 0;
    if (this.#buffer.byteLength) {
      chunks.push(this.#buffer);
      total += this.#buffer.byteLength;
      this.#buffer = Buffer.alloc(0);
    }
    for (;;) {
      const next = await this.#iterator.next();
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error("CLI stream exceeds its declared payload");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
}

export async function writeCliBytes(stream: Writable, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(bytes, (error) => error ? reject(error) : resolve());
  });
}
