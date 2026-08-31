import type { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { APP_CLI_MAX_CONTROL_BYTES } from "./protocol";

export class AppCliStreamReader {
  readonly #iterator: AsyncIterator<unknown>;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(stream: Readable) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  async readFrame(): Promise<Buffer> {
    const header = await this.readExact(4);
    const bytes = header.readUInt32BE(0);
    if (bytes < 1 || bytes > APP_CLI_MAX_CONTROL_BYTES) {
      throw new Error("App CLI frame length is outside the V1 bound");
    }
    return this.readExact(bytes);
  }

  async readExact(bytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid App CLI read length");
    const result = Buffer.allocUnsafe(bytes);
    let written = 0;
    while (written < bytes) {
      if (this.#buffer.byteLength === 0) {
        const next = await this.#iterator.next();
        if (next.done) throw new Error("App CLI stream ended before its declared payload");
        this.#buffer = Buffer.isBuffer(next.value)
          ? next.value
          : next.value instanceof Uint8Array
            ? Buffer.from(next.value)
            : Buffer.from(String(next.value));
        if (this.#buffer.byteLength === 0) continue;
      }
      const take = Math.min(bytes - written, this.#buffer.byteLength);
      this.#buffer.copy(result, written, 0, take);
      written += take;
      this.#buffer = this.#buffer.subarray(take);
    }
    return result;
  }
}

export async function writeAppCliBytes(stream: Writable, bytes: Uint8Array): Promise<void> {
  if (stream.write(bytes)) return;
  await once(stream, "drain");
}
