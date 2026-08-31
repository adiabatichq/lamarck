import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CAPSULE_TREE_HEADER_BYTES,
  CAPSULE_TREE_MAGIC,
  CAPSULE_TREE_MAX_ENTRIES,
  capsuleTreeParent,
  decodeCapsuleTreeHeader,
  decodeCapsuleTreePath,
} from "../../../capsule/src/artifact/tree-format";
import {
  APP_PACKAGE_MAX_BYTES,
  validateAppPackagePath,
  type AppPackageEntry,
} from "./package-tree";

const MAX_ARCHIVE_BYTES = APP_PACKAGE_MAX_BYTES
  + CAPSULE_TREE_MAX_ENTRIES * (4_096 + CAPSULE_TREE_HEADER_BYTES)
  + CAPSULE_TREE_MAGIC.byteLength
  + CAPSULE_TREE_HEADER_BYTES;
const MAX_CONCURRENT_UPLOADS = 4;
const UPLOAD_TIMEOUT_MS = 120_000;
let activeUploads = 0;

export interface AppEditUploadMetadataV1 {
  readonly schemaVersion: 1;
  readonly baseVersion: string | null;
  readonly basePackageDigest: `sha256:${string}`;
  readonly archiveDigest: `sha256:${string}`;
  readonly archiveBytes: number;
  readonly message?: string;
  readonly author?: string;
}

export async function readAppPackageArchive(
  request: Request,
  stagingRoot: string,
): Promise<{ metadata: AppEditUploadMetadataV1; entries: readonly AppPackageEntry[] }> {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) throw new ArchiveHttpError(429, "too many App uploads");
  activeUploads += 1;
  let stage: string | undefined;
  try {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    stage = await mkdtemp(join(stagingRoot, "upload-"));
    const archivePath = join(stage, "package.tree");
    const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
    const metadata = parseMetadata(request.headers.get("x-lamarck-app-edit-v1"));
    if (!request.body) throw new ArchiveHttpError(400, "App package upload body is required");
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared !== metadata.archiveBytes) {
      throw new ArchiveHttpError(400, "App package upload length mismatch");
    }
    const output = await open(
      archivePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    let bytes = 0;
    const reader = request.body.getReader();
    try {
      for (;;) {
        const read = await withDeadline(reader.read(), deadline);
        if (read.done) break;
        bytes += read.value.byteLength;
        if (bytes > MAX_ARCHIVE_BYTES || bytes > metadata.archiveBytes) {
          throw new ArchiveHttpError(413, "App package upload is too large");
        }
        hash.update(read.value);
        await output.write(read.value);
      }
      await output.sync();
    } finally {
      reader.releaseLock();
      await output.close();
    }
    if (
      bytes !== metadata.archiveBytes
      || `sha256:${hash.digest("hex")}` !== metadata.archiveDigest
    ) throw new ArchiveHttpError(400, "App package upload digest mismatch");
    return { metadata, entries: await decodeArchive(archivePath, bytes) };
  } finally {
    activeUploads -= 1;
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}

async function withDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ArchiveHttpError(408, "App package upload timed out");
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ArchiveHttpError(408, "App package upload timed out")),
          remaining,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export class ArchiveHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function decodeArchive(path: string, expectedBytes: number): Promise<readonly AppPackageEntry[]> {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let offset = 0;
  const readExact = async (bytes: number): Promise<Buffer> => {
    const value = Buffer.allocUnsafe(bytes);
    const read = await input.read(value, 0, bytes, offset);
    if (read.bytesRead !== bytes) throw new ArchiveHttpError(400, "truncated App package archive");
    offset += bytes;
    return value;
  };
  try {
    if (!(await readExact(CAPSULE_TREE_MAGIC.byteLength)).equals(CAPSULE_TREE_MAGIC)) {
      throw new ArchiveHttpError(400, "App package archive magic mismatch");
    }
    const directories = new Set<string>();
    const entries: AppPackageEntry[] = [];
    let prior: Buffer | undefined;
    for (let count = 0; count <= CAPSULE_TREE_MAX_ENTRIES; count += 1) {
      const header = decodeCapsuleTreeHeader(await readExact(CAPSULE_TREE_HEADER_BYTES));
      if (header.type === "end") {
        if (offset !== expectedBytes) throw new ArchiveHttpError(400, "App package archive has trailing bytes");
        return Object.freeze(entries);
      }
      const pathBytes = await readExact(header.pathLength);
      if (prior && Buffer.compare(prior, pathBytes) >= 0) {
        throw new ArchiveHttpError(400, "App package archive paths are not ordered");
      }
      prior = pathBytes;
      const entryPath = decodeCapsuleTreePath(pathBytes);
      validateAppPackagePath(entryPath);
      const parent = capsuleTreeParent(entryPath);
      if (parent && !directories.has(parent)) {
        throw new ArchiveHttpError(400, `App package archive parent is missing: ${entryPath}`);
      }
      if (header.type === "directory") {
        directories.add(entryPath);
        continue;
      }
      entries.push(Object.freeze({
        path: entryPath,
        kind: "file" as const,
        bytes: Uint8Array.from(await readExact(header.contentLength)),
      }));
    }
    throw new ArchiveHttpError(413, "App package archive has too many entries");
  } finally {
    await input.close();
  }
}

function parseMetadata(raw: string | null): AppEditUploadMetadataV1 {
  try {
    if (!raw) throw new Error("missing metadata");
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<AppEditUploadMetadataV1>;
    if (
      value.schemaVersion !== 1
      || (value.baseVersion !== null && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value.baseVersion ?? ""))
      || !/^sha256:[0-9a-f]{64}$/.test(value.basePackageDigest ?? "")
      || !/^sha256:[0-9a-f]{64}$/.test(value.archiveDigest ?? "")
      || !Number.isSafeInteger(value.archiveBytes)
      || (value.archiveBytes ?? 0) < CAPSULE_TREE_MAGIC.byteLength + CAPSULE_TREE_HEADER_BYTES
      || (value.archiveBytes ?? 0) > MAX_ARCHIVE_BYTES
      || (value.message !== undefined && typeof value.message !== "string")
      || (value.author !== undefined && typeof value.author !== "string")
    ) throw new Error("invalid metadata");
    return value as AppEditUploadMetadataV1;
  } catch {
    throw new ArchiveHttpError(400, "invalid App package upload metadata");
  }
}
