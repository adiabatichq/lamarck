import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ContentBlobRef } from "@lamarck/system/protocol";
import { ContentBlobStore } from "./blob-store";
import {
  assertSafeD1Parents,
  d1PathsConflict,
  isReservedD1Path,
  validateD1Path,
} from "@lamarck/system/internal/vfs";
import type { D1ObserverFile, D1RecordedChange } from "./d1-observer-state";

const require = createRequire(import.meta.url);
const { createTwoFilesPatch } = require("diff") as {
  createTwoFilesPatch(
    oldPath: string,
    newPath: string,
    before: string,
    after: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number },
  ): string;
};

export const INLINE_PATCH_BYTES = 8 * 1024;
export const PATCH_PREVIEW_BYTES = 4 * 1024;
export const INLINE_CHANGES_BYTES = 256 * 1024;
const D1_HASH_CHUNK_BYTES = 64 * 1024;

export interface D1FileSnapshot extends D1ObserverFile {
  bytes: Buffer;
  markdown: boolean;
}

export type D1FileChange =
  | { kind: "added"; path: string; digest: string; patch?: string; patchPreview?: string; patchRef?: ContentBlobRef }
  | { kind: "modified"; path: string; prevDigest: string; digest: string; patch?: string; patchPreview?: string; patchRef?: ContentBlobRef }
  | { kind: "deleted"; path: string; digest: string; patch?: string; patchPreview?: string; patchRef?: ContentBlobRef }
  | { kind: "moved"; from: string; path: string; digest: string };

export interface FileChangePayload {
  changes?: D1FileChange[];
  changesRef?: ContentBlobRef;
  changesSummary?: { count: number; commonRoot: string | null; digest: string };
}

export async function scanD1Files(
  filesRoot: string,
  options: {
    isExcluded?: (path: string) => boolean;
    onWarning?: (message: string) => void;
    onDeferred?: (path: string) => void;
    onRead?: (path: string) => void;
    previous?: ReadonlyMap<string, D1FileSnapshot>;
    roots?: readonly string[];
  } = {},
): Promise<Map<string, D1FileSnapshot>> {
  const snapshots = new Map<string, D1FileSnapshot>();
  const admittedPaths: string[] = [];

  const visitDirectory = async (relativeDirectory: string): Promise<void> => {
    const directory = relativeDirectory ? join(filesRoot, relativeDirectory) : filesRoot;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      await visitPath(path, true);
    }
  };

  const visitPath = async (path: string, deferIfMissing: boolean): Promise<void> => {
    if (isReservedD1Path(path) || options.isExcluded?.(path)) return;
    try {
      validateD1Path(path);
    } catch (error) {
      options.onWarning?.(`Ignoring unsupported D1 path ${JSON.stringify(path)}: ${errorMessage(error)}`);
      return;
    }
    const collision = admittedPaths.find((candidate) => d1PathsConflict(candidate, path));
    if (collision) {
      options.onWarning?.(`Ignoring D1 path ${JSON.stringify(path)} because it collides with ${JSON.stringify(collision)}`);
      return;
    }

    let info: BigIntStats;
    try {
      await assertSafeD1Parents(filesRoot, path);
      info = await lstat(join(filesRoot, ...path.split("/")), { bigint: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        if (deferIfMissing) options.onDeferred?.(path);
        return;
      }
      options.onWarning?.(`Deferring unstable or unsupported D1 file ${JSON.stringify(path)}: ${errorMessage(error)}`);
      options.onDeferred?.(path);
      return;
    }

    if (info.isDirectory()) {
      admittedPaths.push(path);
      await visitDirectory(path);
      return;
    }
    if (info.isFile() && info.nlink !== 1n) {
      options.onWarning?.(
        `Deferring unstable or unsupported D1 file ${JSON.stringify(path)}: D1 admits only regular, non-hard-linked files`,
      );
      options.onDeferred?.(path);
      return;
    }
    if (!info.isFile()) {
      options.onWarning?.(`Ignoring unsupported D1 filesystem entry ${JSON.stringify(path)}`);
      options.onDeferred?.(path);
      return;
    }

    const fingerprint = statFingerprint(info);
    const previous = options.previous?.get(path);
    if (
      previous
      && previous.statFingerprint === fingerprint
      && BigInt(previous.byteLength) === info.size
    ) {
      admittedPaths.push(path);
      snapshots.set(path, previous);
      return;
    }

    try {
      options.onRead?.(path);
      const snapshot = await readStableD1File(filesRoot, path);
      admittedPaths.push(path);
      snapshots.set(path, snapshot);
    } catch (error) {
      options.onWarning?.(`Deferring unstable or unsupported D1 file ${JSON.stringify(path)}: ${errorMessage(error)}`);
      options.onDeferred?.(path);
    }
  };

  if (options.roots === undefined) {
    await visitDirectory("");
  } else {
    for (const path of normalizeRoots(options.roots)) {
      await visitPath(path, false);
    }
  }
  return snapshots;
}

export async function readStableD1File(filesRoot: string, path: string): Promise<D1FileSnapshot> {
  validateD1Path(path);
  await assertSafeD1Parents(filesRoot, path);
  const filePath = join(filesRoot, ...path.split("/"));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) {
        throw new Error("D1 admits only regular, non-hard-linked files");
      }
      const markdownPath = isMarkdownPath(path);
      let bytes = Buffer.alloc(0);
      let byteLength = 0;
      let digest: string;
      if (markdownPath) {
        bytes = Buffer.from(await handle.readFile());
        byteLength = bytes.byteLength;
        digest = digestBytes(bytes);
      } else {
        const hash = createHash("sha256");
        const chunk = Buffer.allocUnsafe(D1_HASH_CHUNK_BYTES);
        for (;;) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, byteLength);
          if (bytesRead === 0) break;
          hash.update(chunk.subarray(0, bytesRead));
          byteLength += bytesRead;
        }
        digest = `sha256:${hash.digest("hex")}`;
      }
      const after = await handle.stat({ bigint: true });
      if (
        before.dev === after.dev
        && before.ino === after.ino
        && before.size === after.size
        && before.mtimeNs === after.mtimeNs
        && before.ctimeNs === after.ctimeNs
        && BigInt(byteLength) === after.size
      ) {
        const markdown = markdownPath && decodeUtf8(bytes) !== null;
        return {
          path,
          digest,
          byteLength,
          markdownBaseline: markdown ? Buffer.from(bytes) : null,
          statFingerprint: statFingerprint(after),
          bytes: markdownPath ? Buffer.from(bytes) : Buffer.alloc(0),
          markdown,
        };
      }
    } finally {
      await handle.close();
    }
  }
  throw new Error("file changed while it was being read");
}

export function observerFilesToSnapshots(
  files: readonly D1ObserverFile[],
): Map<string, D1FileSnapshot> {
  return new Map(files.map((file) => [file.path, {
    ...file,
    bytes: file.markdownBaseline ?? Buffer.alloc(0),
    markdown: file.markdownBaseline !== null,
  }]));
}

export function compareFileSnapshots(
  before: ReadonlyMap<string, D1FileSnapshot>,
  after: ReadonlyMap<string, D1FileSnapshot>,
): D1FileChange[] {
  const changes: D1FileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort(comparePaths)) {
    const previous = before.get(path);
    const current = after.get(path);
    if (!previous && current) {
      changes.push(withMarkdownPatch(
        { kind: "added", path, digest: current.digest },
        null,
        current,
      ));
    } else if (previous && !current) {
      changes.push(withMarkdownPatch(
        { kind: "deleted", path, digest: previous.digest },
        previous,
        null,
      ));
    } else if (previous && current && previous.digest !== current.digest) {
      changes.push(withMarkdownPatch(
        { kind: "modified", path, prevDigest: previous.digest, digest: current.digest },
        previous,
        current,
      ));
    }
  }
  return changes;
}

export function metadataOnlyFileSnapshots(
  before: ReadonlyMap<string, D1FileSnapshot>,
  after: ReadonlyMap<string, D1FileSnapshot>,
): Map<string, D1FileSnapshot> {
  const updates = new Map<string, D1FileSnapshot>();
  for (const [path, current] of after) {
    const previous = before.get(path);
    if (
      previous
      && previous.digest === current.digest
      && current.statFingerprint !== null
      && (
        previous.byteLength !== current.byteLength
        || previous.statFingerprint !== current.statFingerprint
      )
    ) {
      updates.set(path, current);
    }
  }
  return updates;
}

export function externalizeFileChanges(
  changes: readonly D1FileChange[],
  blobStore: ContentBlobStore,
): FileChangePayload {
  const patched = changes.map((change) => {
    if (!("patch" in change) || change.patch === undefined) return change;
    if (Buffer.byteLength(change.patch, "utf8") <= INLINE_PATCH_BYTES) return change;
    const { patch, ...compact } = change;
    return {
      ...compact,
      patchPreview: utf8Prefix(patch, PATCH_PREVIEW_BYTES),
      patchRef: blobStore.writeText({ text: patch }).ref,
    } as D1FileChange;
  });
  const manifest = JSON.stringify(patched);
  if (Buffer.byteLength(manifest, "utf8") <= INLINE_CHANGES_BYTES) {
    return { changes: patched };
  }
  const digest = digestBytes(Buffer.from(manifest, "utf8"));
  return {
    changesRef: blobStore.writeText({ text: manifest, mediaType: "application/json" }).ref,
    changesSummary: {
      count: patched.length,
      commonRoot: commonRoot(patched),
      digest,
    },
  };
}

export function recordedChanges(changes: readonly D1FileChange[]): D1RecordedChange[] {
  return changes.map((change) => ({
    kind: change.kind,
    path: change.path,
    ...(change.kind === "moved" ? { from: change.from } : {}),
    digest: change.digest,
    ...(change.kind === "modified" ? { prevDigest: change.prevDigest } : {}),
  }));
}

export function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function isMarkdownPath(path: string): boolean {
  return path.toLocaleLowerCase("en-US").endsWith(".md");
}

function withMarkdownPatch<T extends D1FileChange>(
  change: T,
  before: D1FileSnapshot | null,
  after: D1FileSnapshot | null,
): T {
  const markdown = (before?.markdown ?? true) && (after?.markdown ?? true)
    && (before?.markdown === true || after?.markdown === true);
  if (!markdown) return change;
  const beforeText = before ? decodeUtf8(before.bytes) : "";
  const afterText = after ? decodeUtf8(after.bytes) : "";
  if (beforeText === null || afterText === null) return change;
  const patch = createTwoFilesPatch(
    before ? `a/${change.path}` : "/dev/null",
    after ? `b/${change.path}` : "/dev/null",
    beforeText,
    afterText,
    "",
    "",
    { context: 3 },
  ).replace(/^={3,}\n/, "");
  return { ...change, patch };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  for (let end = maxBytes; end > 0; end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {}
  }
  return "";
}

function commonRoot(changes: readonly D1FileChange[]): string | null {
  if (changes.length === 0) return null;
  const parts = changes.map((change) => change.path.split("/"));
  let length = Math.min(...parts.map((value) => value.length)) - 1;
  for (let index = 0; index < length; index += 1) {
    if (parts.some((value) => value[index] !== parts[0]![index])) {
      length = index;
      break;
    }
  }
  return length > 0 ? parts[0]!.slice(0, length).join("/") + "/" : null;
}

function comparePaths(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function statFingerprint(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

function normalizeRoots(roots: readonly string[]): string[] {
  const normalized = [...new Set(roots)].sort(comparePaths);
  for (const path of normalized) validateD1Path(path);
  return normalized.filter((path, index) => !normalized.some((candidate, candidateIndex) => (
    candidateIndex !== index && path.startsWith(`${candidate}/`)
  )));
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
