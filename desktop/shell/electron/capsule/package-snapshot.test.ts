import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  CAPSULE_TREE_HEADER_BYTES,
  decodeCapsuleTreeHeader,
  decodeCapsuleTreePath,
} from "../../../capsule/src/artifact/tree-format";
import {
  CAPSULE_TREE_FORMAT,
  CAPSULE_TREE_MAGIC,
  createCapsulePackageSnapshot,
  createCapsuleVirtualTreeSnapshot,
  readCapsuleTreeFile,
  readCapsuleTreeSelection,
  type CapsulePackageSnapshot,
  type CapsuleTreeSnapshot,
} from "./package-snapshot";
import { CapsuleStorageBudget } from "./storage-budget";
import {
  collectAppPackageTree,
  hashAppPackageTree,
} from "../../../core/src/apps/package-tree";

const temporaryRoots: string[] = [];
const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);

afterEach(async () => {
  await Promise.allSettled(temporaryRoots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("capsule-tree-v1 package snapshots", () => {
  test("emits a deterministic, canonical tree and excludes Host-only directories", async () => {
    const { packageDir, cacheDir } = await fixture();
    await mkdir(join(packageDir, "src", "components"), { recursive: true });
    await mkdir(join(packageDir, "bin"));
    await writeFile(join(packageDir, "z-last.txt"), "z");
    await writeFile(join(packageDir, "src", "main.ts"), "export {};\n");
    await writeFile(join(packageDir, "src", "components", "empty.ts"), "");
    await writeFile(join(packageDir, "bin", "run"), "#!/bin/sh\nexit 0\n");
    await chmod(join(packageDir, "bin", "run"), 0o711);
    await writeFile(join(packageDir, "caf\u00e9.txt"), "coffee");

    for (const excluded of [".git", ".lamarck", "node_modules"]) {
      await mkdir(join(packageDir, excluded), { recursive: true });
      await writeFile(join(packageDir, excluded, "secret"), excluded);
    }
    await mkdir(join(packageDir, "src", "node_modules", "nested"), { recursive: true });
    await writeFile(join(packageDir, "src", "node_modules", "nested", "reference"), "kept");
    await mkdir(join(packageDir, "src", ".git"), { recursive: true });
    await writeFile(join(packageDir, "src", ".git", "config"), "kept");
    await mkdir(join(packageDir, "src", ".lamarck"), { recursive: true });
    await writeFile(join(packageDir, "src", ".lamarck", "state"), "kept");

    const first = await createCapsulePackageSnapshot({ packageDir, cacheDir });
    // Host executable permission differences do not leak into the sealed format.
    await chmod(join(packageDir, "z-last.txt"), 0o755);
    const second = await createCapsulePackageSnapshot({ packageDir, cacheDir });
    const bytes = await readSnapshot(first);
    const records = decodeTree(bytes);

    expect(first.format).toBe(CAPSULE_TREE_FORMAT);
    expect(first.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    expect(first.packageDigest).toBe(hashAppPackageTree(await collectAppPackageTree(packageDir)));
    expect(first.bytes).toBe(bytes.byteLength);
    expect(first.entries).toBe(records.length);
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toMatchObject({
      digest: first.digest,
      packageDigest: first.packageDigest,
      bytes: first.bytes,
      entries: first.entries,
      path: first.path,
    });

    const paths = records.map((record) => record.path);
    expect(paths).toEqual([...paths].sort(compareUtf8));
    expect(paths).toEqual([
      "bin",
      "bin/run",
      "caf\u00e9.txt",
      "src",
      "src/.git",
      "src/.git/config",
      "src/.lamarck",
      "src/.lamarck/state",
      "src/components",
      "src/components/empty.ts",
      "src/main.ts",
      "src/node_modules",
      "src/node_modules/nested",
      "src/node_modules/nested/reference",
      "z-last.txt",
    ]);
    for (const excluded of [".git", ".lamarck", "node_modules"]) {
      expect(paths.some((path) => path === excluded || path.startsWith(`${excluded}/`))).toBe(false);
    }

    expect(record(records, "bin")).toMatchObject({ type: "directory", mode: 0o755, content: "" });
    expect(record(records, "bin/run")).toMatchObject({
      type: "file",
      mode: 0o755,
      content: "#!/bin/sh\nexit 0\n",
    });
    expect(record(records, "z-last.txt")).toMatchObject({ type: "file", mode: 0o755, content: "z" });
    expect(record(records, "src/components/empty.ts")).toMatchObject({
      type: "file",
      mode: 0o755,
      content: "",
    });

    const casInfo = await lstat(first.path);
    expect(casInfo.isFile()).toBe(true);
    expect(casInfo.mode & 0o777).toBe(0o400);
    expect((await readdir(cacheDir)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
  });

  test("uses one fixed executable mode and digest for App source across chmod changes", async () => {
    const { packageDir, cacheDir } = await fixture();
    const source = join(packageDir, "script.mjs");
    await writeFile(source, "console.log('same bytes');\n");
    await chmod(source, 0o600);
    const nonExecutable = await createCapsulePackageSnapshot({ packageDir, cacheDir });

    await chmod(source, 0o755);
    const executable = await createCapsulePackageSnapshot({ packageDir, cacheDir });

    expect(executable).toMatchObject({
      digest: nonExecutable.digest,
      path: nonExecutable.path,
      bytes: nonExecutable.bytes,
    });
    expect(record(decodeTree(await readSnapshot(executable)), "script.mjs")).toMatchObject({
      type: "file",
      mode: 0o755,
      content: "console.log('same bytes');\n",
    });
  });

  test("the published snapshot is independent from later source edits", async () => {
    const { packageDir, cacheDir } = await fixture();
    await writeFile(join(packageDir, "state.txt"), "before");

    const before = await createCapsulePackageSnapshot({ packageDir, cacheDir });
    const sealedBytes = await readSnapshot(before);
    await writeFile(join(packageDir, "state.txt"), "after");
    const after = await createCapsulePackageSnapshot({ packageDir, cacheDir });

    expect(after.digest).not.toBe(before.digest);
    expect((await readSnapshot(before)).equals(sealedBytes)).toBe(true);
    expect(record(decodeTree(await readSnapshot(before)), "state.txt").content).toBe("before");
    expect(record(decodeTree(await readSnapshot(after)), "state.txt").content).toBe("after");
  });

  test("encodes dependency-broker virtual files without any Host source-path contract", async () => {
    const { cacheDir } = await fixture();
    const manifest = Buffer.from('{"lockfileVersion":3}\n');
    const tarball = Buffer.from("tarball-bytes");
    const snapshot = await createCapsuleVirtualTreeSnapshot({
      cacheDir,
      entries: [
        {
          type: "file",
          path: "tarballs/pkg.tgz",
          contentBytes: tarball.byteLength,
          content: chunks(tarball.subarray(0, 4), tarball.subarray(4)),
        },
        { type: "file", path: "manifest.json", contentBytes: manifest.byteLength, content: manifest },
        { type: "directory", path: "tarballs" },
      ],
    });

    expect(decodeTree(await readSnapshot(snapshot))).toEqual([
      { type: "file", mode: 0o644, path: "manifest.json", content: manifest.toString() },
      { type: "directory", mode: 0o755, path: "tarballs", content: "" },
      { type: "file", mode: 0o644, path: "tarballs/pkg.tgz", content: tarball.toString() },
    ]);
    expect(await readCapsuleTreeFile(snapshot, "manifest.json", 1024)).toEqual(manifest);
    expect(await readCapsuleTreeFile(snapshot, "missing.json", 1024)).toBeUndefined();
  });

  test("virtual trees reject undeclared parents and byte streams that disagree with their size", async () => {
    const undeclaredParent = await fixture();
    await expect(createCapsuleVirtualTreeSnapshot({
      cacheDir: undeclaredParent.cacheDir,
      entries: [{
        type: "file",
        path: "tarballs/pkg.tgz",
        contentBytes: 1,
        content: Buffer.from("x"),
      }],
    })).rejects.toThrow("missing its parent directory");

    const shortContent = await fixture();
    await expect(createCapsuleVirtualTreeSnapshot({
      cacheDir: shortContent.cacheDir,
      entries: [{ type: "file", path: "manifest.json", contentBytes: 2, content: Buffer.from("x") }],
    })).rejects.toThrow("did not match declared size");
    expect((await readdir(shortContent.cacheDir)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);

    const longContent = await fixture();
    await expect(createCapsuleVirtualTreeSnapshot({
      cacheDir: longContent.cacheDir,
      entries: [{ type: "file", path: "manifest.json", contentBytes: 1, content: Buffer.from("xx") }],
    })).rejects.toThrow("did not match declared size");
    expect((await readdir(longContent.cacheDir)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
  });

  test("reads policy inputs from the immutable snapshot, not the subsequently changed package", async () => {
    const { packageDir, cacheDir } = await fixture();
    const lockPath = join(packageDir, "package-lock.json");
    await writeFile(lockPath, '{"name":"captured"}\n');
    const snapshot = await createCapsulePackageSnapshot({ packageDir, cacheDir });
    await writeFile(lockPath, '{"name":"live-race"}\n');

    expect((await readCapsuleTreeFile(snapshot, "package-lock.json", 1024))?.toString()).toBe(
      '{"name":"captured"}\n',
    );
    await expect(readCapsuleTreeFile(snapshot, "package-lock.json", 4)).rejects.toThrow(
      "exceeds read bound",
    );
  });

  test("selects several bounded policy files and presence sentinels in one verified pass", async () => {
    const { packageDir, cacheDir } = await fixture();
    await writeFile(join(packageDir, "package.json"), '{"name":"fixture"}');
    await writeFile(join(packageDir, "package-lock.json"), '{"lockfileVersion":3}');
    await writeFile(join(packageDir, "binding.gyp"), "large content need not be captured");
    const snapshot = await createCapsulePackageSnapshot({ packageDir, cacheDir });
    const selection = await readCapsuleTreeSelection(snapshot, [
      { path: "package.json", maxBytes: 1024 },
      { path: "package-lock.json", maxBytes: 1024 },
      { path: ".npmrc", maxBytes: 1024 },
      { path: "binding.gyp" },
    ]);
    expect(selection.present).toEqual(new Set([
      "binding.gyp",
      "package-lock.json",
      "package.json",
    ]));
    expect(selection.contents.get("package.json")?.toString()).toBe('{"name":"fixture"}');
    expect(selection.contents.has("binding.gyp")).toBe(false);
    expect(selection.present.has(".npmrc")).toBe(false);
    await expect(readCapsuleTreeSelection(snapshot, [
      { path: "package.json", maxBytes: 1024 },
      { path: "package.json" },
    ])).rejects.toThrow(/more than once/);
  });

  test("the bounded reader validates magic, headers, paths, order, end/EOF, and digest", async () => {
    const { cacheDir } = await fixture();
    const snapshot = await createCapsuleVirtualTreeSnapshot({
      cacheDir,
      entries: [
        { type: "file", path: "a", contentBytes: 1, content: Buffer.from("A") },
        { type: "file", path: "b", contentBytes: 1, content: Buffer.from("B") },
      ],
    });
    const valid = await readFile(snapshot.path);
    const firstPathOffset = CAPSULE_TREE_MAGIC.byteLength + CAPSULE_TREE_HEADER_BYTES;
    const secondPathOffset = firstPathOffset + 1 + 1 + CAPSULE_TREE_HEADER_BYTES;

    const badMagic = Buffer.from(valid);
    badMagic[0] ^= 0xff;
    await expectInvalidTree(cacheDir, "bad-magic.tree", badMagic, "a", "magic mismatch");

    const badFlags = Buffer.from(valid);
    badFlags[CAPSULE_TREE_MAGIC.byteLength + 1] = 1;
    await expectInvalidTree(cacheDir, "bad-flags.tree", badFlags, "a", "record flags must be zero");

    const badPath = Buffer.from(valid);
    badPath[firstPathOffset] = "\\".charCodeAt(0);
    await expectInvalidTree(cacheDir, "bad-path.tree", badPath, "a", "Invalid package path");

    const badOrder = Buffer.from(valid);
    badOrder[firstPathOffset] = "b".charCodeAt(0);
    badOrder[secondPathOffset] = "a".charCodeAt(0);
    await expectInvalidTree(cacheDir, "bad-order.tree", badOrder, "a", "not strictly ordered");

    const badEnd = Buffer.from(valid);
    badEnd[badEnd.length - 1] = 1;
    await expectInvalidTree(cacheDir, "bad-end.tree", badEnd, "a", "end record must be all zero");

    const trailing = Buffer.concat([valid, Buffer.from([1])]);
    await expectInvalidTree(cacheDir, "trailing.tree", trailing, "a", "byte count does not match");

    const corrupt = Buffer.from(valid);
    const contentOffset = firstPathOffset + Buffer.byteLength("a");
    corrupt[contentOffset] ^= 0xff;
    await chmod(snapshot.path, 0o600);
    await writeFile(snapshot.path, corrupt);
    await chmod(snapshot.path, 0o400);
    await expect(readCapsuleTreeFile(snapshot, "a", 16)).rejects.toThrow(
      "integrity check failed",
    );
  });

  test("concurrent publishers reuse one verified CAS object without temporary-file leaks", async () => {
    const { packageDir, cacheDir } = await fixture();
    await writeFile(join(packageDir, "index.js"), "console.log('ok');\n");

    const snapshots = await Promise.all(Array.from({ length: 8 }, () => (
      createCapsulePackageSnapshot({ packageDir, cacheDir })
    )));
    expect(new Set(snapshots.map((snapshot) => snapshot.digest)).size).toBe(1);
    expect(new Set(snapshots.map((snapshot) => snapshot.path)).size).toBe(1);
    expect(await readdir(cacheDir)).toEqual([`${snapshots[0]!.digest.slice("sha256:".length)}.tree`]);
  });

  test("retains snapshot reservation and never claims success when winner cleanup fails", async () => {
    const { packageDir, cacheDir } = await fixture();
    await writeFile(join(packageDir, "index.js"), "console.log('cleanup');\n");
    const budget = snapshotBudget(cacheDir);

    await expect(createCapsulePackageSnapshot({
      packageDir,
      cacheDir,
      ownerKey: OWNER_A,
      storageBudget: budget,
      snapshotWriter: {
        removeTemporary: async () => {
          throw new Error("injected snapshot unlink failure");
        },
      },
    })).rejects.toThrow("injected snapshot unlink failure");

    const accounting = await budget.snapshot();
    expect(accounting.usedBytes).toBe(0);
    expect(accounting.reservedBytes).toBeGreaterThan(0);
    expect(accounting.reservations).toBe(1);
    expect(accounting.ownerUsedBytes).toEqual({});
    expect(accounting.ownerReservedBytes[OWNER_A]).toBe(accounting.reservedBytes);
  });

  test("keeps same-digest snapshot losers behind winner durability and fails them cleanly", async () => {
    const { packageDir, cacheDir } = await fixture();
    await writeFile(join(packageDir, "index.js"), "console.log('boundary');\n");
    const budget = snapshotBudget(cacheDir);
    let winnerPublished!: () => void;
    const published = new Promise<void>((resolve) => {
      winnerPublished = resolve;
    });
    let failWinner!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      failWinner = resolve;
    });
    const writer = {
      afterPublication: async (isWinner: boolean) => {
        if (!isWinner) return;
        winnerPublished();
        await failureGate;
        throw new Error("injected snapshot publication boundary failure");
      },
    };

    const winner = createCapsulePackageSnapshot({
      packageDir,
      cacheDir,
      ownerKey: OWNER_A,
      storageBudget: budget,
      snapshotWriter: writer,
    });
    await published;
    const loser = createCapsulePackageSnapshot({
      packageDir,
      cacheDir,
      ownerKey: OWNER_B,
      storageBudget: budget,
      snapshotWriter: writer,
    });
    failWinner();
    const results = await Promise.allSettled([winner, loser]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    const accounting = await budget.snapshot();
    expect(accounting.usedBytes).toBe(0);
    expect(accounting.reservations).toBe(1);
    expect(accounting.ownerUsedBytes).toEqual({});
    expect(accounting.ownerReservedBytes[OWNER_A]).toBe(accounting.reservedBytes);
    expect(accounting.ownerReservedBytes[OWNER_B]).toBeUndefined();
    expect((await readdir(cacheDir)).filter((name) => name.endsWith(".tree"))).toHaveLength(1);
  });

  test("fails closed and cleans up when a source file changes during serialization", async () => {
    const { packageDir, cacheDir } = await fixture();
    const source = join(packageDir, "large.bin");
    await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 0x61));

    const snapshot = createCapsulePackageSnapshot({ packageDir, cacheDir });
    const rejection = expect(snapshot).rejects.toThrow("Package file changed while snapshotting");
    await waitForPartialSnapshot(cacheDir, 32 * 1024 * 1024);
    const input = await open(source, "r+");
    try {
      await input.write(Buffer.from("changed"), 0, 7, 0);
      await input.sync();
    } finally {
      await input.close();
    }
    await rejection;
    expect((await readdir(cacheDir)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
  });

  test("does not clobber a corrupt object already present at the CAS digest", async () => {
    const { packageDir, cacheDir } = await fixture();
    await writeFile(join(packageDir, "index.js"), "trusted");
    const snapshot = await createCapsulePackageSnapshot({ packageDir, cacheDir });
    const original = await readFile(snapshot.path);
    const corrupt = Buffer.from(original);
    corrupt[corrupt.length - CAPSULE_TREE_HEADER_BYTES - 1] ^= 0xff;
    await chmod(snapshot.path, 0o600);
    await writeFile(snapshot.path, corrupt);

    await expect(createCapsulePackageSnapshot({ packageDir, cacheDir })).rejects.toThrow(
      "App package snapshot CAS collision",
    );
    expect(await readFile(snapshot.path)).toEqual(corrupt);
    expect((await readdir(cacheDir)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
  });

  test("rejects package symlinks, hard links, and special files", async () => {
    const symlinkFixture = await fixture();
    await writeFile(join(symlinkFixture.packageDir, "target"), "target");
    await symlink("target", join(symlinkFixture.packageDir, "alias"));
    await expect(createCapsulePackageSnapshot(symlinkFixture)).rejects.toThrow(
      "Package symlinks are not supported: alias",
    );

    const hardLinkFixture = await fixture();
    await writeFile(join(hardLinkFixture.packageDir, "original"), "same inode");
    await link(join(hardLinkFixture.packageDir, "original"), join(hardLinkFixture.packageDir, "alias"));
    await expect(createCapsulePackageSnapshot(hardLinkFixture)).rejects.toThrow(
      "Package hard links are not supported",
    );

    if (process.platform !== "win32") {
      const fifoFixture = await fixture();
      execFileSync("mkfifo", [join(fifoFixture.packageDir, "pipe")]);
      await expect(createCapsulePackageSnapshot(fifoFixture)).rejects.toThrow(
        "Unsupported package file type: pipe",
      );
    }
  });

  test("rejects a symlink root, invalid POSIX paths, and unsafe cache placement", async () => {
    const rootFixture = await fixture();
    const packageAlias = join(rootFixture.root, "package-alias");
    await symlink(rootFixture.packageDir, packageAlias);
    await expect(createCapsulePackageSnapshot({
      packageDir: packageAlias,
      cacheDir: rootFixture.cacheDir,
    })).rejects.toThrow("App package root must be a real directory");

    const invalidPathFixture = await fixture();
    await writeFile(join(invalidPathFixture.packageDir, "bad\\name.ts"), "bad");
    await expect(createCapsulePackageSnapshot(invalidPathFixture)).rejects.toThrow(
      "Invalid package path",
    );

    const nonNfcFixture = await fixture();
    await writeFile(join(nonNfcFixture.packageDir, "cafe\u0301.txt"), "decomposed");
    await expect(createCapsulePackageSnapshot(nonNfcFixture)).rejects.toThrow(
      "Package path is not NFC-normalized",
    );

    const containedCacheFixture = await fixture();
    const containedCache = join(containedCacheFixture.packageDir, "cache");
    await expect(createCapsulePackageSnapshot({
      packageDir: containedCacheFixture.packageDir,
      cacheDir: containedCache,
    })).rejects.toThrow("snapshot cache must be outside the App package");
    await expect(lstat(containedCache)).rejects.toMatchObject({ code: "ENOENT" });

    const cacheSymlinkFixture = await fixture();
    const realCache = join(cacheSymlinkFixture.root, "real-cache");
    const cacheAlias = join(cacheSymlinkFixture.root, "cache-alias");
    await mkdir(realCache);
    await symlink(realCache, cacheAlias);
    await expect(createCapsulePackageSnapshot({
      packageDir: cacheSymlinkFixture.packageDir,
      cacheDir: cacheAlias,
    })).rejects.toThrow("snapshot cache must be a real directory");
  });
});

interface TreeRecord {
  type: "directory" | "file";
  mode: 0o644 | 0o755;
  path: string;
  content: string;
}

function decodeTree(value: Buffer): TreeRecord[] {
  expect(value.subarray(0, CAPSULE_TREE_MAGIC.byteLength)).toEqual(CAPSULE_TREE_MAGIC);
  let offset = CAPSULE_TREE_MAGIC.byteLength;
  const records: TreeRecord[] = [];
  for (;;) {
    const headerBytes = value.subarray(offset, offset + CAPSULE_TREE_HEADER_BYTES);
    expect(headerBytes.byteLength).toBe(CAPSULE_TREE_HEADER_BYTES);
    offset += CAPSULE_TREE_HEADER_BYTES;
    const header = decodeCapsuleTreeHeader(headerBytes);
    if (header.type === "end") {
      expect(offset).toBe(value.byteLength);
      return records;
    }
    const pathBytes = value.subarray(offset, offset + header.pathLength);
    expect(pathBytes.byteLength).toBe(header.pathLength);
    offset += header.pathLength;
    const path = decodeCapsuleTreePath(pathBytes);
    const content = value.subarray(offset, offset + header.contentLength);
    expect(content.byteLength).toBe(header.contentLength);
    offset += header.contentLength;
    records.push({
      type: header.type,
      mode: header.mode as 0o644 | 0o755,
      path,
      content: content.toString("utf8"),
    });
  }
}

function record(records: readonly TreeRecord[], path: string): TreeRecord {
  const value = records.find((candidate) => candidate.path === path);
  if (!value) throw new Error(`missing fixture record ${path}`);
  return value;
}

async function readSnapshot(snapshot: CapsuleTreeSnapshot): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of snapshot.createReadStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function fixture(): Promise<{ root: string; packageDir: string; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "lamarck-package-snapshot-"));
  temporaryRoots.push(root);
  const packageDir = join(root, "package");
  const cacheDir = join(root, "cache");
  await mkdir(packageDir);
  return { root, packageDir, cacheDir };
}

function snapshotBudget(cacheDir: string): CapsuleStorageBudget {
  return new CapsuleStorageBudget({
    roots: [cacheDir],
    aggregateBytes: 1024 * 1024,
    perAppBytes: 1024 * 1024,
    filesystemReserveBytes: 0,
    dependencies: { availableBytes: async () => 1024 * 1024 * 1024 },
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

async function installReadonlyTree(
  cacheDir: string,
  name: string,
  value: Buffer,
): Promise<Pick<CapsulePackageSnapshot, "path" | "digest" | "bytes">> {
  const path = join(cacheDir, name);
  await writeFile(path, value, { mode: 0o400 });
  return {
    path,
    bytes: value.byteLength,
    digest: `sha256:${createHash("sha256").update(value).digest("hex")}`,
  };
}

async function expectInvalidTree(
  cacheDir: string,
  name: string,
  value: Buffer,
  path: string,
  message: string,
): Promise<void> {
  const snapshot = await installReadonlyTree(cacheDir, name, value);
  await expect(readCapsuleTreeFile(snapshot, path, 16)).rejects.toThrow(message);
}

async function waitForPartialSnapshot(cacheDir: string, contentBytes: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const temporary = (await readdir(cacheDir).catch(() => []))
      .find((name) => name.startsWith(".snapshot-"));
    if (temporary) {
      const info = await stat(join(cacheDir, temporary));
      if (info.size > 64 * 1024 && info.size < contentBytes) return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("snapshot did not expose a partial serialization window");
}
