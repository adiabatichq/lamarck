import { createHash } from "node:crypto";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  hashConnectorPackageTree,
  validateConnectorPackageRelativePath,
  type ConnectorPackageTreeEntry,
} from "../connectors/registry";
import { parseConnectorManifestDocument } from "../connectors/manifest";
import { SCOPED_PACKAGE_ID_PATTERN } from "../package-id";
import {
  MARKETPLACE_ARTIFACT_FORMAT,
  MARKETPLACE_MAX_ARTIFACT_BYTES,
  type MarketplacePackageKind,
} from "./resolve";

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const CONNECTOR_MANIFEST_NAMES = [
  "connector.yaml",
  "connector.yml",
  "connector.json",
] as const;

export interface MarketplaceArtifactLimits {
  readonly maxCompressedBytes: number;
  readonly maxUncompressedBytes: number;
  readonly maxEntries: number;
  readonly maxPathBytes: number;
  readonly maxFileBytes: number;
  readonly maxManifestBytes: number;
}

export const DEFAULT_MARKETPLACE_ARTIFACT_LIMITS: MarketplaceArtifactLimits =
  Object.freeze({
    maxCompressedBytes: MARKETPLACE_MAX_ARTIFACT_BYTES,
    maxUncompressedBytes: 256 * 1024 * 1024,
    maxEntries: 10_000,
    maxPathBytes: 1_024,
    maxFileBytes: 128 * 1024 * 1024,
    maxManifestBytes: 1024 * 1024,
  });

export type MarketplaceArtifactEntry = ConnectorPackageTreeEntry;

export interface MarketplaceArtifactManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface VerifiedMarketplaceArtifact {
  readonly artifactFormat: typeof MARKETPLACE_ARTIFACT_FORMAT;
  readonly kind: MarketplacePackageKind;
  readonly packageId: string;
  readonly contentHash: string;
  readonly compressedBytes: number;
  readonly manifest: MarketplaceArtifactManifest;
  readonly entries: readonly MarketplaceArtifactEntry[];
}

export interface VerifyMarketplaceArtifactOptions {
  readonly kind: MarketplacePackageKind;
  readonly packageId: string;
  readonly contentHash: string;
  readonly archiveBytes: Uint8Array;
  readonly limits?: Partial<MarketplaceArtifactLimits>;
}

/**
 * Consumer-only verification for `marketplace-tar-gzip-v1`. This decoder does
 * not create producer archives or derive storage keys. It accepts only the
 * release representation, recomputes logical identity, and binds the package
 * manifest to the signed kind and package ID. Irrelevant gzip and tar metadata
 * is not part of logical identity and is not treated as runtime policy.
 */
export function verifyMarketplaceArtifact(
  options: VerifyMarketplaceArtifactOptions,
): VerifiedMarketplaceArtifact {
  if (options.kind !== "app" && options.kind !== "connector") {
    throw new Error("Marketplace artifact kind is invalid");
  }
  if (!SCOPED_PACKAGE_ID_PATTERN.test(options.packageId)) {
    throw new Error("Marketplace artifact package ID must be scoped");
  }
  if (!CONTENT_HASH_PATTERN.test(options.contentHash)) {
    throw new Error("Marketplace artifact content hash is invalid");
  }
  if (!(options.archiveBytes instanceof Uint8Array)) {
    throw new Error("Marketplace artifact bytes are invalid");
  }

  const limits = resolveLimits(options.limits);
  const compressed = Buffer.from(
    options.archiveBytes.buffer,
    options.archiveBytes.byteOffset,
    options.archiveBytes.byteLength,
  );
  if (compressed.byteLength < 1 || compressed.byteLength > limits.maxCompressedBytes) {
    throw new Error("Marketplace artifact compressed size exceeds the limit");
  }
  let tarBytes: Buffer;
  try {
    tarBytes = gunzipSync(compressed, {
      maxOutputLength: limits.maxUncompressedBytes,
    });
  } catch (error) {
    throw new Error(`Marketplace artifact gzip decoding failed: ${errorMessage(error)}`);
  }
  if (tarBytes.byteLength > limits.maxUncompressedBytes) {
    throw new Error("Marketplace artifact expanded size exceeds the limit");
  }

  const entries = decodeReleaseTar(tarBytes, options.kind, limits);
  const manifest = options.kind === "app"
    ? validateAppArtifactManifest(entries, options.packageId, limits)
    : validateConnectorArtifactManifest(entries, options.packageId, limits);
  const actualHash = options.kind === "app"
    ? hashAppPackageTree(entries)
    : hashConnectorPackageTree(entries);
  if (actualHash !== options.contentHash) {
    throw new Error(
      `Marketplace artifact logical hash mismatch: expected ${options.contentHash}, got ${actualHash}`,
    );
  }

  return Object.freeze({
    artifactFormat: MARKETPLACE_ARTIFACT_FORMAT,
    kind: options.kind,
    packageId: options.packageId,
    contentHash: options.contentHash,
    compressedBytes: compressed.byteLength,
    manifest,
    entries: Object.freeze(entries.map(cloneEntry)),
  });
}

/**
 * Materialize a previously verified tree into one new staging directory.
 * Parent directories and regular files use local normalized modes; archive
 * ownership, timestamps, ACLs, xattrs, and file modes are never restored.
 */
export async function extractVerifiedMarketplaceArtifact(
  artifact: VerifiedMarketplaceArtifact,
  destinationPath: string,
): Promise<void> {
  let created = false;
  try {
    await mkdir(destinationPath, { recursive: false, mode: 0o755 });
    created = true;
    await chmod(destinationPath, 0o755);
    for (const entry of artifact.entries) {
      const target = join(destinationPath, ...entry.relativePath.split("/"));
      await ensureNormalizedParentDirectories(destinationPath, entry.relativePath);
      if (entry.kind === "file") {
        await writeFile(target, entry.bytes, { flag: "wx", mode: 0o644 });
        await chmod(target, 0o644);
      } else {
        await symlink(entry.target, target);
      }
    }
  } catch (error) {
    if (created) await rm(destinationPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function ensureNormalizedParentDirectories(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split("/").slice(0, -1);
  let directory = root;
  for (const segment of segments) {
    directory = join(directory, segment);
    try {
      await mkdir(directory, { recursive: false, mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // mkdir's mode is masked by umask. This path is a verifier-owned real
    // directory (path-prefix collisions forbid an archive symlink here).
    await chmod(directory, 0o755);
  }
}

function resolveLimits(
  overrides: Partial<MarketplaceArtifactLimits> | undefined,
): MarketplaceArtifactLimits {
  const limits = { ...DEFAULT_MARKETPLACE_ARTIFACT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Marketplace artifact limit ${name} is invalid`);
    }
  }
  if (limits.maxCompressedBytes > MARKETPLACE_MAX_ARTIFACT_BYTES) {
    throw new Error("Marketplace artifact compressed limit exceeds the signed-download limit");
  }
  return limits;
}

function decodeReleaseTar(
  tarBytes: Buffer,
  kind: MarketplacePackageKind,
  limits: MarketplaceArtifactLimits,
): MarketplaceArtifactEntry[] {
  if (tarBytes.byteLength < TAR_END_BYTES || tarBytes.byteLength % TAR_BLOCK_BYTES !== 0) {
    throw new Error("Marketplace artifact has a truncated tar stream");
  }

  const entries: MarketplaceArtifactEntry[] = [];
  const seenPaths = new Set<string>();
  let offset = 0;
  let pendingPax: Map<string, string> | undefined;
  let sawEnd = false;
  let physicalEntries = 0;

  while (offset < tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      if (pendingPax) throw new Error("Marketplace artifact ends after a PAX header");
      const second = tarBytes.subarray(offset + TAR_BLOCK_BYTES, offset + TAR_END_BYTES);
      if (second.byteLength !== TAR_BLOCK_BYTES || !isZeroBlock(second)) {
        throw new Error("Marketplace artifact is missing its second tar end block");
      }
      if (!isZeroBlock(tarBytes.subarray(offset + TAR_END_BYTES))) {
        throw new Error("Marketplace artifact contains data after its tar end blocks");
      }
      sawEnd = true;
      break;
    }

    physicalEntries += 1;
    if (physicalEntries > limits.maxEntries * 3) {
      throw new Error("Marketplace artifact transport entry count exceeds the limit");
    }
    verifyTarHeader(header);
    const typeByte = header[156];
    const typeFlag = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    if (typeFlag !== "0" && typeFlag !== "2" && typeFlag !== "5" && typeFlag !== "x") {
      throw new Error(`Marketplace artifact entry kind is unsupported: ${typeFlag}`);
    }
    const physicalPath = tarHeaderPath(header);
    validateWirePath(physicalPath, limits.maxPathBytes);
    const size = readTarOctal(header.subarray(124, 136), "size");
    if (size > limits.maxFileBytes) {
      throw new Error(`Marketplace artifact entry is too large: ${physicalPath}`);
    }
    const bodyStart = offset + TAR_BLOCK_BYTES;
    const bodyEnd = bodyStart + size;
    const nextOffset = bodyStart + roundUpTarBlock(size);
    if (bodyEnd > tarBytes.byteLength || nextOffset > tarBytes.byteLength) {
      throw new Error("Marketplace artifact contains a truncated tar entry");
    }
    const body = tarBytes.subarray(bodyStart, bodyEnd);
    if (!isZeroBlock(tarBytes.subarray(bodyEnd, nextOffset))) {
      throw new Error("Marketplace artifact contains non-zero tar padding");
    }
    offset = nextOffset;

    if (typeFlag === "x") {
      if (pendingPax) throw new Error("Marketplace artifact has consecutive PAX headers");
      pendingPax = decodePax(body);
      continue;
    }

    if (entries.length >= limits.maxEntries) {
      throw new Error("Marketplace artifact entry count exceeds the limit");
    }
    const pax = pendingPax;
    pendingPax = undefined;
    const logicalPath = pax?.get("path") ?? physicalPath;
    validateWirePath(logicalPath, limits.maxPathBytes);

    if (typeFlag === "5") {
      if (size !== 0) throw new Error(`Marketplace artifact directory has content: ${logicalPath}`);
      continue;
    }

    if (kind === "app") {
      validateAppPath(logicalPath);
      if (typeFlag !== "0") {
        throw new Error(`Marketplace App artifact contains a symlink: ${logicalPath}`);
      }
    } else {
      validateConnectorPackageRelativePath(logicalPath);
    }
    if (seenPaths.has(logicalPath)) {
      throw new Error(`Marketplace artifact contains duplicate path: ${logicalPath}`);
    }
    assertNoPathPrefixCollision(seenPaths, logicalPath);
    seenPaths.add(logicalPath);
    const headerTarget = readTarText(header.subarray(157, 257), "linkname");
    const paxTarget = pax?.get("linkpath");
    if (typeFlag === "0") {
      if (headerTarget !== "" || paxTarget !== undefined) {
        throw new Error(`Marketplace artifact file has a link target: ${logicalPath}`);
      }
      entries.push({ kind: "file", relativePath: logicalPath, bytes: Buffer.from(body) });
    } else {
      if (size !== 0) {
        throw new Error(`Marketplace Connector symlink has file content: ${logicalPath}`);
      }
      const target = paxTarget ?? headerTarget;
      if (
        target.length === 0
        || target.includes("\0")
      ) {
        throw new Error(`Marketplace Connector symlink target is malformed: ${logicalPath}`);
      }
      entries.push({ kind: "symlink", relativePath: logicalPath, target });
    }
  }

  if (!sawEnd) throw new Error("Marketplace artifact is missing tar end blocks");
  if (entries.length === 0) throw new Error("Marketplace artifact is empty");
  return entries;
}

function validateWirePath(path: string, maxBytes: number): void {
  if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path, "utf8") > maxBytes) {
    throw new Error("Marketplace artifact path is outside the bounded wire contract");
  }
  if (
    path.includes("\0")
    || path.includes("\\")
    || path.startsWith("/")
    || /^[A-Za-z]:/.test(path)
  ) {
    throw new Error(`Marketplace artifact path is unsafe: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Marketplace artifact path contains traversal: ${path}`);
  }
}

function validateAppPath(path: string): void {
  const segments = path.split("/");
  const excluded = segments.find((segment) =>
    segment === ".git"
    || segment === ".lamarck"
    || segment === "node_modules"
    || segment === "__MACOSX"
    || segment.startsWith("._"));
  if (excluded) {
    throw new Error(`Marketplace App artifact contains excluded path segment: ${excluded}`);
  }
}

function assertNoPathPrefixCollision(seen: Set<string>, path: string): void {
  const segments = path.split("/");
  let prefix = "";
  for (let index = 0; index < segments.length - 1; index += 1) {
    prefix = prefix === "" ? segments[index] : `${prefix}/${segments[index]}`;
    if (seen.has(prefix)) {
      throw new Error(`Marketplace artifact path descends through an entry: ${path}`);
    }
  }
  for (const existing of seen) {
    if (existing.startsWith(`${path}/`)) {
      throw new Error(`Marketplace artifact entry shadows another path: ${path}`);
    }
  }
}

function hashAppPackageTree(entries: readonly MarketplaceArtifactEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath))) {
    if (entry.kind !== "file") {
      throw new Error("Marketplace App logical tree contains a non-file entry");
    }
    hash.update("file");
    hash.update("\0");
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function validateAppArtifactManifest(
  entries: readonly MarketplaceArtifactEntry[],
  packageId: string,
  limits: MarketplaceArtifactLimits,
): MarketplaceArtifactManifest {
  const entry = requireRegularFile(entries, "manifest.json");
  if (entry.bytes.byteLength > limits.maxManifestBytes) {
    throw new Error("Marketplace App manifest exceeds the limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(entry.bytes, "Marketplace App manifest"));
  } catch (error) {
    throw new Error(`Marketplace App manifest is invalid JSON: ${errorMessage(error)}`);
  }
  const manifest = projectManifestIdentity(parsed, packageId, "App");
  if ((parsed as Record<string, unknown>).createdFrom !== undefined) {
    throw new Error("Published Marketplace App manifest must not contain createdFrom");
  }
  return manifest;
}

function validateConnectorArtifactManifest(
  entries: readonly MarketplaceArtifactEntry[],
  packageId: string,
  limits: MarketplaceArtifactLimits,
): MarketplaceArtifactManifest {
  const names = CONNECTOR_MANIFEST_NAMES.filter((name) =>
    entries.some((entry) => entry.relativePath === name));
  if (names.length !== 1) {
    throw new Error("Marketplace Connector artifact must contain exactly one root manifest");
  }
  const manifestEntry = requireRegularFile(entries, names[0]);
  if (manifestEntry.bytes.byteLength > limits.maxManifestBytes) {
    throw new Error("Marketplace Connector manifest exceeds the limit");
  }
  let parsed: unknown;
  try {
    parsed = parseConnectorManifestDocument(
      names[0],
      decodeUtf8(manifestEntry.bytes, "Marketplace Connector manifest"),
    );
  } catch (error) {
    throw new Error(`Marketplace Connector manifest is invalid: ${errorMessage(error)}`);
  }
  return projectManifestIdentity(parsed, packageId, "Connector");
}

function projectManifestIdentity(
  value: unknown,
  packageId: string,
  kind: "App" | "Connector",
): MarketplaceArtifactManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Marketplace ${kind} manifest must be an object`);
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.manifestVersion !== 1) {
    throw new Error(`Marketplace ${kind} manifestVersion must be 1`);
  }
  if (manifest.id !== packageId) {
    throw new Error(
      `Marketplace ${kind} manifest id "${String(manifest.id)}" does not match "${packageId}"`,
    );
  }
  for (const field of ["name", "description"] as const) {
    const fieldValue = manifest[field];
    if (typeof fieldValue !== "string" || fieldValue.length === 0 || fieldValue.trim() !== fieldValue) {
      throw new Error(`Marketplace ${kind} manifest requires a valid ${field}`);
    }
  }
  return Object.freeze({
    id: packageId,
    name: manifest.name as string,
    description: manifest.description as string,
  });
}

function requireRegularFile(
  entries: readonly MarketplaceArtifactEntry[],
  path: string,
): Extract<MarketplaceArtifactEntry, { kind: "file" }> {
  const entry = entries.find((candidate) => candidate.relativePath === path);
  if (!entry || entry.kind !== "file") {
    throw new Error(`Marketplace artifact requires regular file: ${path}`);
  }
  return entry;
}

function cloneEntry(entry: MarketplaceArtifactEntry): MarketplaceArtifactEntry {
  return entry.kind === "file"
    ? Object.freeze({ kind: "file", relativePath: entry.relativePath, bytes: Buffer.from(entry.bytes) })
    : Object.freeze({ kind: "symlink", relativePath: entry.relativePath, target: entry.target });
}

function verifyTarHeader(header: Buffer): void {
  if (
    !header.subarray(257, 263).equals(Buffer.from("ustar\0", "ascii"))
    || !header.subarray(263, 265).equals(Buffer.from("00", "ascii"))
  ) {
    throw new Error("Marketplace artifact uses an unsupported tar format");
  }
  const expected = readTarOctal(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error("Marketplace artifact tar checksum mismatch");
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
    return UTF8.decode(bytes);
  } catch (error) {
    throw new Error(`Marketplace artifact tar ${name} is not UTF-8: ${errorMessage(error)}`);
  }
}

function readTarOctal(field: Buffer, name: string): number {
  const text = field.toString("ascii").replace(/[\0 ]+$/g, "").replace(/^ +/g, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`Marketplace artifact tar ${name} is not octal`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Marketplace artifact tar ${name} is too large`);
  }
  return value;
}

function decodePax(body: Buffer): Map<string, string> {
  const fields = new Map<string, string>();
  let offset = 0;
  while (offset < body.byteLength) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) throw new Error("Marketplace artifact PAX record has no length");
    const lengthText = body.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) {
      throw new Error("Marketplace artifact PAX record length is malformed");
    }
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > body.byteLength || body[end - 1] !== 0x0a) {
      throw new Error("Marketplace artifact PAX record is truncated");
    }
    const record = body.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new Error("Marketplace artifact PAX record has no value");
    const key = record.subarray(0, equals).toString("ascii");
    const value = decodeUtf8(record.subarray(equals + 1), "Marketplace artifact PAX value");
    if (value.includes("\0")) throw new Error(`Marketplace artifact PAX ${key} contains a null`);
    if (key === "path" || key === "linkpath") {
      if (fields.has(key)) throw new Error(`Marketplace artifact PAX field is duplicated: ${key}`);
      fields.set(key, value);
    }
    offset = end;
  }
  if (fields.size === 0) throw new Error("Marketplace artifact PAX header is empty");
  return fields;
}

function roundUpTarBlock(size: number): number {
  return Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
}

function isZeroBlock(bytes: Buffer): boolean {
  return bytes.every((byte) => byte === 0);
}

function decodeUtf8(bytes: Uint8Array, context: string): string {
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    throw new Error(`${context} is not valid UTF-8: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
