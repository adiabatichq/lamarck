import { normalize } from "node:path/posix";

export const CAPSULE_TREE_MAGIC = Buffer.from("LCAPT001", "ascii");
export const CAPSULE_TREE_HEADER_BYTES = 16;
export const CAPSULE_TREE_MAX_PATH_BYTES = 4_096;
export const CAPSULE_TREE_MAX_ENTRIES = 100_000;
export const CAPSULE_TREE_MAX_FILE_BYTES = 512 * 1024 * 1024;

export type CapsuleTreeEntryType = "directory" | "file" | "end";

export interface CapsuleTreeRecordHeader {
  type: CapsuleTreeEntryType;
  mode: 0 | 0o644 | 0o755;
  pathLength: number;
  contentLength: number;
}

export class CapsuleTreeFormatError extends Error {
  readonly code = "CAPSULE_TREE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CapsuleTreeFormatError";
  }
}

export function encodeCapsuleTreeHeader(header: CapsuleTreeRecordHeader): Buffer {
  validateHeader(header);
  const result = Buffer.alloc(CAPSULE_TREE_HEADER_BYTES);
  result[0] = header.type === "directory" ? 1 : header.type === "file" ? 2 : 0;
  result.writeUInt16BE(header.mode, 2);
  result.writeUInt32BE(header.pathLength, 4);
  result.writeBigUInt64BE(BigInt(header.contentLength), 8);
  return result;
}

export function decodeCapsuleTreeHeader(value: Uint8Array): CapsuleTreeRecordHeader {
  if (value.byteLength !== CAPSULE_TREE_HEADER_BYTES) {
    throw new CapsuleTreeFormatError("record header must be exactly 16 bytes");
  }
  const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (buffer[1] !== 0) throw new CapsuleTreeFormatError("record flags must be zero");
  const rawType = buffer[0];
  const type: CapsuleTreeEntryType = rawType === 0
    ? "end"
    : rawType === 1
      ? "directory"
      : rawType === 2
        ? "file"
        : invalid(`unknown record type ${rawType}`);
  const contentLength = Number(buffer.readBigUInt64BE(8));
  if (!Number.isSafeInteger(contentLength)) {
    throw new CapsuleTreeFormatError("content length exceeds the safe integer range");
  }
  const result: CapsuleTreeRecordHeader = {
    type,
    mode: buffer.readUInt16BE(2) as CapsuleTreeRecordHeader["mode"],
    pathLength: buffer.readUInt32BE(4),
    contentLength,
  };
  validateHeader(result);
  return result;
}

export function encodeCapsuleTreePath(path: string): Buffer {
  validateCapsuleTreePath(path);
  const bytes = Buffer.from(path, "utf8");
  if (bytes.byteLength > CAPSULE_TREE_MAX_PATH_BYTES) {
    throw new CapsuleTreeFormatError(`path exceeds ${CAPSULE_TREE_MAX_PATH_BYTES} UTF-8 bytes`);
  }
  return bytes;
}

export function decodeCapsuleTreePath(value: Uint8Array): string {
  if (value.byteLength < 1 || value.byteLength > CAPSULE_TREE_MAX_PATH_BYTES) {
    throw new CapsuleTreeFormatError("path byte length is outside the v1 bounds");
  }
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new CapsuleTreeFormatError(`path is not valid UTF-8: ${String(error)}`);
  }
  if (!Buffer.from(path, "utf8").equals(Buffer.from(value))) {
    throw new CapsuleTreeFormatError("path is not canonical UTF-8");
  }
  validateCapsuleTreePath(path);
  return path;
}

export function validateCapsuleTreePath(path: string): string {
  if (path.length === 0 || path.startsWith("/") || path.endsWith("/")) {
    throw new CapsuleTreeFormatError("path must be a non-empty relative POSIX path");
  }
  if (path.includes("\0") || path.includes("\\") || path.includes("//")) {
    throw new CapsuleTreeFormatError("path contains a forbidden character or separator");
  }
  if (path !== path.normalize("NFC")) {
    throw new CapsuleTreeFormatError("path must use NFC Unicode normalization");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new CapsuleTreeFormatError("path contains traversal or empty segments");
  }
  if (normalize(path) !== path) {
    throw new CapsuleTreeFormatError("path is not in canonical POSIX form");
  }
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes > CAPSULE_TREE_MAX_PATH_BYTES) {
    throw new CapsuleTreeFormatError(`path exceeds ${CAPSULE_TREE_MAX_PATH_BYTES} UTF-8 bytes`);
  }
  return path;
}

export function compareCapsuleTreePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function capsuleTreeParent(path: string): string | undefined {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? undefined : path.slice(0, separator);
}

function validateHeader(header: CapsuleTreeRecordHeader): void {
  if (!Number.isSafeInteger(header.pathLength) || header.pathLength < 0) {
    throw new CapsuleTreeFormatError("path length must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(header.contentLength) || header.contentLength < 0) {
    throw new CapsuleTreeFormatError("content length must be a non-negative safe integer");
  }
  if (header.type === "end") {
    if (header.mode !== 0 || header.pathLength !== 0 || header.contentLength !== 0) {
      throw new CapsuleTreeFormatError("end record must be all zero");
    }
    return;
  }
  if (header.pathLength < 1 || header.pathLength > CAPSULE_TREE_MAX_PATH_BYTES) {
    throw new CapsuleTreeFormatError("record path length is outside the v1 bounds");
  }
  if (header.type === "directory") {
    if (header.mode !== 0o755 || header.contentLength !== 0) {
      throw new CapsuleTreeFormatError("directory records require mode 0755 and no content");
    }
    return;
  }
  if (header.mode !== 0o644 && header.mode !== 0o755) {
    throw new CapsuleTreeFormatError("file mode must be 0644 or 0755");
  }
  if (header.contentLength > CAPSULE_TREE_MAX_FILE_BYTES) {
    throw new CapsuleTreeFormatError(`file exceeds ${CAPSULE_TREE_MAX_FILE_BYTES} bytes`);
  }
}

function invalid(message: string): never {
  throw new CapsuleTreeFormatError(message);
}
