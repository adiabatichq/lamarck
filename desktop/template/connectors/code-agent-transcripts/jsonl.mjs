import { createReadStream } from "node:fs";

export async function* readJsonLines(path, opts = {}) {
  const startOffset = opts.startOffset ?? 0;
  if (opts.readLinesImpl) {
    let offset = startOffset;
    for await (const value of opts.readLinesImpl(path, startOffset)) {
      if (opts.endOffset !== undefined && offset >= opts.endOffset) break;
      if (typeof value !== "string" || !value.trim()) continue;
      const nextOffset = offset + Buffer.byteLength(value) + 1;
      yield { line: value, complete: true, startOffset: offset, nextOffset };
      offset = nextOffset;
    }
    return;
  }

  if (opts.endOffset !== undefined && opts.endOffset <= startOffset) return;
  const streamOptions = { start: startOffset };
  if (opts.endOffset !== undefined) streamOptions.end = opts.endOffset - 1;
  const stream = createReadStream(path, streamOptions);
  let fragments = [];
  let fragmentsLength = 0;
  let chunkOffset = startOffset;
  let lineStartOffset = startOffset;
  for await (const chunk of stream) {
    let segmentStart = 0;
    let newlineIndex = chunk.indexOf(10, segmentStart);
    while (newlineIndex !== -1) {
      const segment = chunk.subarray(segmentStart, newlineIndex);
      if (segment.length) {
        fragments.push(segment);
        fragmentsLength += segment.length;
      }
      const rawLine = stripTrailingCarriageReturn(
        joinBufferFragments(fragments, fragmentsLength),
      );
      const nextOffset = chunkOffset + newlineIndex + 1;
      const line = rawLine.toString("utf8");
      if (line.trim()) yield { line, complete: true, startOffset: lineStartOffset, nextOffset };
      fragments = [];
      fragmentsLength = 0;
      segmentStart = newlineIndex + 1;
      lineStartOffset = nextOffset;
      newlineIndex = chunk.indexOf(10, segmentStart);
    }
    if (segmentStart < chunk.length) {
      const fragment = chunk.subarray(segmentStart);
      fragments.push(fragment);
      fragmentsLength += fragment.length;
    }
    chunkOffset += chunk.length;
  }
  if (fragmentsLength) {
    const line = stripTrailingCarriageReturn(
      joinBufferFragments(fragments, fragmentsLength),
    ).toString("utf8");
    if (line.trim()) {
      yield {
        line,
        complete: opts.endOffset !== undefined,
        startOffset: lineStartOffset,
        nextOffset: lineStartOffset + fragmentsLength,
      };
    }
  }
}

function joinBufferFragments(fragments, totalLength) {
  if (fragments.length === 0) return Buffer.alloc(0);
  if (fragments.length === 1) return fragments[0];
  return Buffer.concat(fragments, totalLength);
}

function stripTrailingCarriageReturn(buffer) {
  return buffer.length && buffer[buffer.length - 1] === 13 ? buffer.subarray(0, -1) : buffer;
}
