import {
  CAPSULE_TREE_HEADER_BYTES,
  CAPSULE_TREE_MAGIC,
  CAPSULE_TREE_MAX_ENTRIES,
  capsuleTreeParent,
  compareCapsuleTreePaths,
  decodeCapsuleTreeHeader,
  decodeCapsuleTreePath,
  type CapsuleTreeRecordHeader,
} from "@lamarck/capsule";
import { constants } from "node:fs";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface MaterializedTree {
  entries: number;
  contentBytes: number;
}

/** Materialize the closed capsule-tree-v1 stream without following links. */
export async function materializeCapsuleTree(
  source: AsyncIterable<Uint8Array>,
  destination: string,
  signal?: AbortSignal,
): Promise<MaterializedTree> {
  const reader = new AsyncByteReader(source, signal);
  try {
    throwIfAborted(signal);
    const root = resolve(destination);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true, mode: 0o755 });
    const magic = await reader.readExact(CAPSULE_TREE_MAGIC.byteLength);
    if (!magic.equals(CAPSULE_TREE_MAGIC)) throw new Error("capsule tree magic mismatch");

    const directories = new Set<string>();
    let previousPath: string | undefined;
    let entries = 0;
    let contentBytes = 0;
    for (;;) {
      throwIfAborted(signal);
      const header = decodeCapsuleTreeHeader(await reader.readExact(CAPSULE_TREE_HEADER_BYTES));
      if (header.type === "end") {
        await reader.assertEof();
        return { entries, contentBytes };
      }
      entries += 1;
      if (entries > CAPSULE_TREE_MAX_ENTRIES) throw new Error("capsule tree has too many entries");
      const path = decodeCapsuleTreePath(await reader.readExact(header.pathLength));
      if (previousPath !== undefined && compareCapsuleTreePaths(previousPath, path) >= 0) {
        throw new Error("capsule tree paths are not strictly ordered");
      }
      previousPath = path;
      const parent = capsuleTreeParent(path);
      if (parent !== undefined && !directories.has(parent)) {
        throw new Error(`capsule tree parent ${parent} was not declared before ${path}`);
      }
      const outputPath = safeOutputPath(root, path);
      if (header.type === "directory") {
        await mkdir(outputPath, { mode: 0o755 });
        await chmod(outputPath, 0o755);
        directories.add(path);
        continue;
      }
      await writeRegularFile(reader, outputPath, header, signal);
      contentBytes += header.contentLength;
    }
  } finally {
    await reader.close();
  }
}

async function writeRegularFile(
  reader: AsyncByteReader,
  path: string,
  header: CapsuleTreeRecordHeader,
  signal?: AbortSignal,
): Promise<void> {
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags, header.mode);
  let remaining = header.contentLength;
  try {
    while (remaining > 0) {
      throwIfAborted(signal);
      const chunk = await reader.readUpTo(Math.min(64 * 1024, remaining));
      await writeAll(handle, chunk);
      remaining -= chunk.byteLength;
    }
    await handle.sync();
    await handle.chmod(header.mode);
  } finally {
    await handle.close();
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten < 1) throw new Error("capsule tree output made no write progress");
    offset += bytesWritten;
  }
}

function safeOutputPath(root: string, relative: string): string {
  const output = resolve(join(root, ...relative.split("/")));
  if (!output.startsWith(`${root}${sep}`)) throw new Error("capsule tree path escaped destination");
  return output;
}

class AsyncByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>, private readonly signal?: AbortSignal) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async readExact(bytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = await this.readUpTo(remaining);
      chunks.push(chunk);
      remaining -= chunk.byteLength;
    }
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bytes);
  }

  async readUpTo(maximum: number): Promise<Buffer> {
    throwIfAborted(this.signal);
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("invalid byte read size");
    while (this.buffered.byteLength === 0 && !this.ended) {
      const next = await this.iterator.next();
      throwIfAborted(this.signal);
      if (next.done) {
        this.ended = true;
        break;
      }
      this.buffered = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    }
    if (this.buffered.byteLength === 0) throw new Error("capsule tree stream ended early");
    const length = Math.min(maximum, this.buffered.byteLength);
    const result = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return result;
  }

  async assertEof(): Promise<void> {
    throwIfAborted(this.signal);
    if (this.buffered.byteLength > 0) throw new Error("capsule tree has trailing bytes");
    const next = await this.iterator.next();
    throwIfAborted(this.signal);
    if (!next.done) throw new Error("capsule tree has trailing bytes");
    this.ended = true;
  }

  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.iterator.return?.();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("capsule tree materialization aborted");
}
