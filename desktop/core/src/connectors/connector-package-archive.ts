import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  comparePackageTreePaths,
  hashConnectorPackageTree,
  readConnectorPackageTree,
  validateConnectorPackageRelativePath,
  type ConnectorPackageTreeEntry,
} from "./registry";

const TAR_BLOCK_SIZE = 512;
const TAR_END_SIZE = TAR_BLOCK_SIZE * 2;
const PACKAGE_DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ConnectorPackageArchivePublication {
  digest: string;
  path: string;
  created: boolean;
}

export interface ResolvedConnectorPackageArchive {
  digest: string;
  path: string;
  compressedBytes: number;
  entries: ConnectorPackageTreeEntry[];
}

export interface ConnectorPackageArchivePresence {
  digest: string;
  path: string;
}

/**
 * Immutable storage for the exact logical package tree already identified by
 * hashConnectorPackage(). Tar and gzip are representation only: publication
 * and explicit resolution parse and re-hash through the registry's package
 * identity function.
 */
export class ConnectorPackageArchiveStore {
  private readonly workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = resolve(workspacePath);
  }

  archivePath(logicalDigest: string): string {
    const digestHex = parseLogicalDigest(logicalDigest);
    return join(
      this.workspacePath,
      ".lamarck",
      "blobs",
      "connector-package",
      "v1",
      "sha256",
      digestHex.slice(0, 2),
      digestHex.slice(2, 4),
      `${digestHex}.tar.gz`,
    );
  }

  async publish(
    connectorDir: string,
    logicalDigest: string,
  ): Promise<ConnectorPackageArchivePublication> {
    parseLogicalDigest(logicalDigest);
    const entries = await readConnectorPackageTree(connectorDir);
    const actualDigest = hashConnectorPackageTree(entries);
    if (actualDigest !== logicalDigest) {
      throw new Error(
        `Connector package changed while archiving: expected ${logicalDigest}, got ${actualDigest}`,
      );
    }

    const archiveBytes = gzipSync(encodeTar(entries), { level: 9 });
    const path = this.archivePath(logicalDigest);
    const archiveDir = dirname(path);
    await mkdir(archiveDir, { recursive: true });
    const tempPath = join(archiveDir, `.publish-${randomUUID()}.tmp`);
    let created = true;
    try {
      await writeFile(tempPath, archiveBytes, { flag: "wx" });
      try {
        // A hard link publishes only complete bytes and never replaces an
        // existing CAS object. Concurrent publishers converge on one target.
        await link(tempPath, path);
      } catch (error) {
        if (!isNodeErrorCode(error, "EEXIST")) throw error;
        created = false;
      }
    } finally {
      await unlink(tempPath).catch((error) => {
        if (!isNodeErrorCode(error, "ENOENT")) throw error;
      });
    }

    // Put-if-absent is only successful when either the bytes just written or
    // the pre-existing object resolve back to the requested logical digest.
    await this.resolve(logicalDigest);
    return { digest: logicalDigest, path, created };
  }

  async resolve(logicalDigest: string): Promise<ResolvedConnectorPackageArchive> {
    parseLogicalDigest(logicalDigest);
    const path = this.archivePath(logicalDigest);
    let compressed: Buffer;
    try {
      compressed = await readFile(path);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        throw new Error(`Connector package archive is missing: ${logicalDigest}`);
      }
      throw error;
    }

    let tarBytes: Buffer;
    try {
      tarBytes = gunzipSync(compressed);
    } catch (error) {
      throw new Error(
        `Connector package archive is not valid gzip: ${errorMessage(error)}`,
      );
    }

    const entries = decodeTar(tarBytes);
    const actualDigest = hashConnectorPackageTree(entries);
    if (actualDigest !== logicalDigest) {
      throw new Error(
        `Connector package archive digest mismatch: expected ${logicalDigest}, got ${actualDigest}`,
      );
    }
    return {
      digest: logicalDigest,
      path,
      compressedBytes: compressed.byteLength,
      entries,
    };
  }

  /**
   * Checks only that the immutable object exists at its exact CAS path as a
   * regular file. Publication and explicit resolution remain responsible for
   * decompressing and verifying the logical package digest.
   */
  async requireExists(logicalDigest: string): Promise<ConnectorPackageArchivePresence> {
    parseLogicalDigest(logicalDigest);
    const path = this.archivePath(logicalDigest);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        throw new Error(`Connector package archive is missing: ${logicalDigest}`);
      }
      throw error;
    }
    if (!metadata.isFile()) {
      throw new Error(`Connector package archive is not a regular file: ${logicalDigest}`);
    }
    return { digest: logicalDigest, path };
  }
}

function parseLogicalDigest(logicalDigest: string): string {
  if (typeof logicalDigest !== "string") {
    throw new Error("Connector package digest must be a string");
  }
  const match = PACKAGE_DIGEST_PATTERN.exec(logicalDigest);
  if (!match) {
    throw new Error(
      "Connector package digest must use sha256:<64 lowercase hex characters>",
    );
  }
  return match[1];
}

function encodeTar(entries: readonly ConnectorPackageTreeEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const sorted = [...entries].sort((a, b) =>
    comparePackageTreePaths(a.relativePath, b.relativePath));

  for (const [index, entry] of sorted.entries()) {
    validateConnectorPackageRelativePath(entry.relativePath);
    if (entry.kind === "symlink") {
      validateSymlinkTarget(entry.relativePath, entry.target);
    }

    const pathParts = splitUstarPath(entry.relativePath);
    const linkFits = entry.kind === "file"
      || Buffer.byteLength(entry.target, "utf8") <= 100;
    const paxFields: Array<["path" | "linkpath", string]> = [];
    if (!pathParts) paxFields.push(["path", entry.relativePath]);
    if (!linkFits && entry.kind === "symlink") {
      paxFields.push(["linkpath", entry.target]);
    }

    if (paxFields.length > 0) {
      const paxBody = Buffer.concat(paxFields.map(([key, value]) =>
        encodePaxRecord(key, value)));
      const paxPath = `PaxHeaders/${String(index).padStart(8, "0")}`;
      chunks.push(createTarHeader({
        name: paxPath,
        prefix: "",
        typeFlag: "x",
        size: paxBody.byteLength,
        linkName: "",
      }));
      chunks.push(paxBody, tarPadding(paxBody.byteLength));
    }

    const fallbackPath = `PaxEntry/${String(index).padStart(8, "0")}`;
    const storedPath = pathParts ?? { name: fallbackPath, prefix: "" };
    const body = entry.kind === "file" ? entry.bytes : Buffer.alloc(0);
    chunks.push(createTarHeader({
      name: storedPath.name,
      prefix: storedPath.prefix,
      typeFlag: entry.kind === "file" ? "0" : "2",
      size: body.byteLength,
      linkName: entry.kind === "symlink" && linkFits ? entry.target : "",
    }));
    if (body.byteLength > 0) chunks.push(body, tarPadding(body.byteLength));
  }

  chunks.push(Buffer.alloc(TAR_END_SIZE));
  return Buffer.concat(chunks);
}

function createTarHeader(input: {
  name: string;
  prefix: string;
  typeFlag: "0" | "2" | "x";
  size: number;
  linkName: string;
}): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  writeTarText(header, 0, 100, input.name, "name");
  writeTarOctal(header, 100, 8, input.typeFlag === "2" ? 0o777 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, input.size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = input.typeFlag.charCodeAt(0);
  writeTarText(header, 157, 100, input.linkName, "linkname");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeTarText(header, 345, 155, input.prefix, "prefix");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encodedChecksum = `${checksum.toString(8).padStart(6, "0")}\0 `;
  header.write(encodedChecksum, 148, 8, "ascii");
  return header;
}

function writeTarText(
  header: Buffer,
  offset: number,
  length: number,
  value: string,
  field: string,
): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length) {
    throw new Error(`Connector package tar ${field} is too long`);
  }
  encoded.copy(header, offset);
}

function writeTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Connector package tar contains an invalid numeric value");
  }
  const octal = value.toString(8);
  if (octal.length > length - 1) {
    throw new Error("Connector package tar numeric value is too large");
  }
  header.write(`${octal.padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function splitUstarPath(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path, "utf8") <= 100) {
    return { name: path, prefix: "" };
  }
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155
      && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
  }
  return undefined;
}

function encodePaxRecord(key: "path" | "linkpath", value: string): Buffer {
  const suffix = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(suffix, "utf8") + 1;
  while (true) {
    const next = Buffer.byteLength(suffix, "utf8") + String(length).length;
    if (next === length) break;
    length = next;
  }
  return Buffer.from(`${length}${suffix}`, "utf8");
}

function tarPadding(size: number): Buffer {
  const remainder = size % TAR_BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(TAR_BLOCK_SIZE - remainder);
}

function decodeTar(tarBytes: Buffer): ConnectorPackageTreeEntry[] {
  if (tarBytes.byteLength % TAR_BLOCK_SIZE !== 0) {
    throw new Error("Connector package archive has a truncated tar block");
  }

  const entries: ConnectorPackageTreeEntry[] = [];
  const seenPaths = new Set<string>();
  let offset = 0;
  let sawEnd = false;
  let pendingPax: Map<string, string> | undefined;

  while (offset < tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isZeroBlock(header)) {
      if (pendingPax) {
        throw new Error("Connector package archive ends after a PAX header");
      }
      const secondEnd = tarBytes.subarray(
        offset + TAR_BLOCK_SIZE,
        offset + TAR_END_SIZE,
      );
      if (secondEnd.byteLength !== TAR_BLOCK_SIZE || !isZeroBlock(secondEnd)) {
        throw new Error("Connector package archive is missing its second end block");
      }
      const trailing = tarBytes.subarray(offset + TAR_END_SIZE);
      if (!isZeroBlock(trailing)) {
        throw new Error("Connector package archive contains data after its end blocks");
      }
      sawEnd = true;
      break;
    }

    verifyTarHeader(header);
    const physicalPath = tarHeaderPath(header);
    validateConnectorPackageRelativePath(physicalPath);
    const typeByte = header[156];
    const typeFlag = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const size = readTarOctal(header.subarray(124, 136), "size");
    const bodyStart = offset + TAR_BLOCK_SIZE;
    const bodyEnd = bodyStart + size;
    const nextOffset = bodyStart + roundUpTarBlock(size);
    if (bodyEnd > tarBytes.byteLength || nextOffset > tarBytes.byteLength) {
      throw new Error("Connector package archive contains a truncated entry");
    }
    const body = tarBytes.subarray(bodyStart, bodyEnd);
    if (!isZeroBlock(tarBytes.subarray(bodyEnd, nextOffset))) {
      throw new Error("Connector package archive contains non-zero tar padding");
    }
    offset = nextOffset;

    if (typeFlag === "x") {
      if (pendingPax) {
        throw new Error("Connector package archive contains consecutive PAX headers");
      }
      if (readTarText(header.subarray(157, 257), "linkname") !== "") {
        throw new Error("Connector package PAX header contains a link target");
      }
      pendingPax = decodePax(body);
      continue;
    }

    if (typeFlag !== "0" && typeFlag !== "2") {
      throw new Error(`Connector package archive entry kind is unsupported: ${typeFlag}`);
    }

    const pax = pendingPax;
    pendingPax = undefined;
    const logicalPath = pax?.get("path") ?? physicalPath;
    validateConnectorPackageRelativePath(logicalPath);
    if (seenPaths.has(logicalPath)) {
      throw new Error(`Connector package archive contains duplicate path: ${logicalPath}`);
    }
    seenPaths.add(logicalPath);

    const headerLinkName = readTarText(header.subarray(157, 257), "linkname");
    const paxLinkName = pax?.get("linkpath");
    if (typeFlag === "0") {
      if (headerLinkName !== "" || paxLinkName !== undefined) {
        throw new Error(`Connector package file has a link target: ${logicalPath}`);
      }
      entries.push({
        kind: "file",
        relativePath: logicalPath,
        bytes: Buffer.from(body),
      });
      continue;
    }

    if (size !== 0) {
      throw new Error(`Connector package symlink has file content: ${logicalPath}`);
    }
    const target = paxLinkName ?? headerLinkName;
    validateSymlinkTarget(logicalPath, target);
    entries.push({ kind: "symlink", relativePath: logicalPath, target });
  }

  if (!sawEnd) {
    throw new Error("Connector package archive is missing tar end blocks");
  }
  return entries;
}

function verifyTarHeader(header: Buffer): void {
  if (header.byteLength !== TAR_BLOCK_SIZE) {
    throw new Error("Connector package archive contains a truncated header");
  }
  if (!header.subarray(257, 263).equals(Buffer.from("ustar\0", "ascii"))
    || !header.subarray(263, 265).equals(Buffer.from("00", "ascii"))) {
    throw new Error("Connector package archive uses an unsupported tar format");
  }
  const expected = readTarOctal(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) {
    throw new Error("Connector package archive tar checksum mismatch");
  }
}

function tarHeaderPath(header: Buffer): string {
  const name = readTarText(header.subarray(0, 100), "name");
  const prefix = readTarText(header.subarray(345, 500), "prefix");
  return prefix === "" ? name : `${prefix}/${name}`;
}

function readTarText(field: Buffer, name: string): string {
  const zero = field.indexOf(0);
  const bytes = zero === -1 ? field : field.subarray(0, zero);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new Error(`Connector package tar ${name} is not UTF-8: ${errorMessage(error)}`);
  }
}

function readTarOctal(field: Buffer, name: string): number {
  const text = field.toString("ascii").replace(/[\0 ]+$/g, "").replace(/^ +/g, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`Connector package tar ${name} is not octal`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Connector package tar ${name} is too large`);
  }
  return value;
}

function decodePax(body: Buffer): Map<string, string> {
  const fields = new Map<string, string>();
  let offset = 0;
  while (offset < body.byteLength) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) throw new Error("Connector package PAX record has no length separator");
    const lengthText = body.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) {
      throw new Error("Connector package PAX record length is malformed");
    }
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1) {
      throw new Error("Connector package PAX record length is invalid");
    }
    const end = offset + length;
    if (end > body.byteLength || body[end - 1] !== 0x0a) {
      throw new Error("Connector package PAX record is truncated");
    }
    const record = body.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new Error("Connector package PAX record has no value");
    const key = record.subarray(0, equals).toString("ascii");
    if (key !== "path" && key !== "linkpath") {
      throw new Error(`Connector package PAX attribute is unsupported: ${key}`);
    }
    if (fields.has(key)) {
      throw new Error(`Connector package PAX attribute is duplicated: ${key}`);
    }
    let value: string;
    try {
      value = UTF8_DECODER.decode(record.subarray(equals + 1));
    } catch (error) {
      throw new Error(`Connector package PAX value is not UTF-8: ${errorMessage(error)}`);
    }
    if (value.includes("\0")) {
      throw new Error(`Connector package PAX ${key} contains a null byte`);
    }
    fields.set(key, value);
    offset = end;
  }
  if (fields.size === 0) {
    throw new Error("Connector package PAX header is empty");
  }
  return fields;
}

function validateSymlinkTarget(relativePath: string, target: string): void {
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
    throw new Error(`Connector package symlink target is malformed: ${relativePath}`);
  }
}

function roundUpTarBlock(size: number): number {
  return Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}

function isZeroBlock(bytes: Buffer): boolean {
  return bytes.every((byte) => byte === 0);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
