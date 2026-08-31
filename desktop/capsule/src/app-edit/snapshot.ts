import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  CAPSULE_TREE_HEADER_BYTES,
  CAPSULE_TREE_MAGIC,
  CAPSULE_TREE_MAX_ENTRIES,
  CAPSULE_TREE_MAX_FILE_BYTES,
  compareCapsuleTreePaths,
  encodeCapsuleTreeHeader,
  encodeCapsuleTreePath,
  validateCapsuleTreePath,
} from "../artifact/tree-format";

const EXCLUDED = new Set([".git", ".lamarck", "node_modules"]);
const MAX_BYTES = 1024 * 1024 * 1024;

type Entry =
  | { path: string; type: "directory"; absolutePath: string }
  | { path: string; type: "file"; absolutePath: string; size: number };

export interface AppEditSnapshotV1 {
  readonly schemaVersion: 1;
  readonly path: string;
  readonly archiveDigest: `sha256:${string}`;
  readonly archiveBytes: number;
  cleanup(): Promise<void>;
}

/** Builds the complete deterministic package transfer used by Capsule save. */
export async function createAppEditSnapshot(
  packageRootValue: string,
  temporaryRoot: string,
): Promise<AppEditSnapshotV1> {
  const packageRoot = resolve(packageRootValue);
  const rootInfo = await lstat(packageRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Capsule App materialization root is invalid");
  }
  const canonicalRoot = await realpath(packageRoot);
  const entries: Entry[] = [];
  let logicalBytes = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const child of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
      if (prefix === "" && EXCLUDED.has(child.name)) continue;
      const entryPath = prefix ? `${prefix}/${child.name}` : child.name;
      validateCapsuleTreePath(entryPath);
      const absolutePath = join(directory, child.name);
      const info = await lstat(absolutePath);
      assertContained(canonicalRoot, await realpath(absolutePath));
      if (info.isSymbolicLink()) throw new Error(`Package symlinks are not supported: ${entryPath}`);
      if (info.isDirectory()) {
        entries.push({ path: entryPath, type: "directory", absolutePath });
        await visit(absolutePath, entryPath);
      } else if (info.isFile()) {
        if (info.size > CAPSULE_TREE_MAX_FILE_BYTES) throw new Error(`Package file is too large: ${entryPath}`);
        logicalBytes += info.size;
        if (logicalBytes > MAX_BYTES) throw new Error("Capsule App package is too large");
        entries.push({ path: entryPath, type: "file", absolutePath, size: info.size });
      } else throw new Error(`Unsupported package entry: ${entryPath}`);
      if (entries.length > CAPSULE_TREE_MAX_ENTRIES) throw new Error("Capsule App package has too many entries");
    }
  };
  await visit(packageRoot, "");
  entries.sort((left, right) => compareCapsuleTreePaths(left.path, right.path));

  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(temporaryRoot, "app-edit-"));
  const path = join(stage, "package.tree");
  const output = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash("sha256");
  let archiveBytes = 0;
  const write = async (value: Uint8Array) => {
    await output.write(value);
    hash.update(value);
    archiveBytes += value.byteLength;
  };
  try {
    await write(CAPSULE_TREE_MAGIC);
    for (const entry of entries) {
      const pathBytes = encodeCapsuleTreePath(entry.path);
      await write(encodeCapsuleTreeHeader({
        type: entry.type,
        mode: entry.type === "directory" ? 0o755 : 0o644,
        pathLength: pathBytes.byteLength,
        contentLength: entry.type === "directory" ? 0 : entry.size,
      }));
      await write(pathBytes);
      if (entry.type === "file") {
        const input = await open(entry.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await input.stat();
          if (!before.isFile() || before.size !== entry.size) throw new Error(`Package file changed: ${entry.path}`);
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let offset = 0;
          while (offset < entry.size) {
            const read = await input.read(buffer, 0, Math.min(buffer.byteLength, entry.size - offset), offset);
            if (read.bytesRead < 1) throw new Error(`Package file was truncated: ${entry.path}`);
            offset += read.bytesRead;
            await write(buffer.subarray(0, read.bytesRead));
          }
          const after = await input.stat();
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw new Error(`Package file changed: ${entry.path}`);
          }
        } finally {
          await input.close();
        }
      }
    }
    await write(encodeCapsuleTreeHeader({ type: "end", mode: 0, pathLength: 0, contentLength: 0 }));
    await output.sync();
  } catch (error) {
    await output.close().catch(() => undefined);
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  await output.close();
  const archiveDigest = `sha256:${hash.digest("hex")}` as const;
  let cleaned = false;
  return Object.freeze({
    schemaVersion: 1,
    path,
    archiveDigest,
    archiveBytes,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(stage, { recursive: true, force: true });
    },
  });
}

function assertContained(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`))) return;
  throw new Error("Package entry escapes its private materialization");
}
