import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ConnectorPackageArchiveStore } from "../src/connectors/connector-package-archive";
import {
  hashConnectorPackage,
  hashConnectorPackageTree,
} from "../src/connectors/registry";

const TAR_BLOCK_SIZE = 512;
const ARBITRARY_DIGEST = `sha256:${"0".repeat(64)}`;

describe("ConnectorPackageArchiveStore", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-connector-archive-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("publishes and resolves the exact existing logical package tree", async () => {
    const connectorDir = join(workspace, "connectors", "example");
    mkdirSync(join(connectorDir, "nested"), { recursive: true });
    mkdirSync(join(connectorDir, ".git"), { recursive: true });
    mkdirSync(join(connectorDir, "nested", "node_modules"), { recursive: true });
    writeFileSync(join(connectorDir, "z.txt"), "last\n");
    writeFileSync(join(connectorDir, "nested", "a.txt"), "first\n");
    writeFileSync(join(connectorDir, ".git", "ignored"), "git\n");
    writeFileSync(join(connectorDir, "nested", "node_modules", "ignored"), "module\n");
    symlinkSync("a.txt", join(connectorDir, "nested", "current.txt"));

    const digest = await hashConnectorPackage(connectorDir);
    const digestHex = digest.slice("sha256:".length);
    const store = new ConnectorPackageArchiveStore(workspace);
    const published = await store.publish(connectorDir, digest);

    // Fixed black-box vectors freeze the pre-Marketplace Connector logical
    // identity and canonical archive representation.
    expect(digest).toBe("sha256:a0bfc5019a32d9fd678550bd075951e847c26bfafb1a35e8c6df698fd64c19d9");
    expect(createHash("sha256").update(readFileSync(published.path)).digest("hex"))
      .toBe("1e7ca4bb628d06da9c5a9522a11fb4417d6e2689bcd93488c5171bfe4b57df9f");

    expect(published).toEqual({
      digest,
      created: true,
      path: join(
        workspace,
        ".lamarck",
        "blobs",
        "connector-package",
        "v1",
        "sha256",
        digestHex.slice(0, 2),
        digestHex.slice(2, 4),
        `${digestHex}.tar.gz`,
      ),
    });

    const resolved = await store.resolve(digest);
    expect(resolved.entries.map((entry) => [
      entry.kind,
      entry.relativePath,
      entry.kind === "file" ? entry.bytes.toString("utf8") : entry.target,
    ])).toEqual([
      ["file", "nested/a.txt", "first\n"],
      ["symlink", "nested/current.txt", "a.txt"],
      ["file", "z.txt", "last\n"],
    ]);
    expect(hashConnectorPackageTree(resolved.entries)).toBe(digest);
  });

  test("uses deterministic tar metadata and put-if-absent publication", async () => {
    const secondWorkspace = mkdtempSync(join(tmpdir(), "lamarck-connector-archive-copy-"));
    try {
      const firstDir = join(workspace, "connectors", "same");
      const secondDir = join(secondWorkspace, "connectors", "same");
      mkdirSync(firstDir, { recursive: true });
      mkdirSync(secondDir, { recursive: true });
      writeFileSync(join(firstDir, "index.mjs"), "export default 1;\n");
      writeFileSync(join(secondDir, "index.mjs"), "export default 1;\n");
      utimesSync(join(firstDir, "index.mjs"), new Date(1_000), new Date(2_000));
      utimesSync(join(secondDir, "index.mjs"), new Date(3_000), new Date(4_000));

      const digest = await hashConnectorPackage(firstDir);
      expect(await hashConnectorPackage(secondDir)).toBe(digest);
      const firstStore = new ConnectorPackageArchiveStore(workspace);
      const secondStore = new ConnectorPackageArchiveStore(secondWorkspace);
      const first = await firstStore.publish(firstDir, digest);
      const second = await secondStore.publish(secondDir, digest);
      expect(readFileSync(first.path)).toEqual(readFileSync(second.path));

      const original = readFileSync(first.path);
      const repeated = await firstStore.publish(firstDir, digest);
      expect(repeated.created).toBe(false);
      expect(readFileSync(first.path)).toEqual(original);
    } finally {
      rmSync(secondWorkspace, { recursive: true, force: true });
    }
  });

  test("concurrent put-if-absent publishers converge on one complete archive", async () => {
    const connectorDir = join(workspace, "connectors", "concurrent");
    mkdirSync(connectorDir, { recursive: true });
    writeFileSync(join(connectorDir, "large.bin"), Buffer.alloc(512 * 1024, 0x5a));
    const digest = await hashConnectorPackage(connectorDir);
    const store = new ConnectorPackageArchiveStore(workspace);

    const results = await Promise.all([
      store.publish(connectorDir, digest),
      store.publish(connectorDir, digest),
    ]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect((await store.resolve(digest)).digest).toBe(digest);
  });

  test("round-trips PAX paths and symlink targets longer than ustar fields", async () => {
    const connectorDir = join(workspace, "connectors", "long-fields");
    mkdirSync(connectorDir, { recursive: true });
    const longName = `${"long-name-".repeat(13)}.txt`;
    const longTarget = `${"target-".repeat(16)}.txt`;
    writeFileSync(join(connectorDir, longName), "long path\n");
    symlinkSync(longTarget, join(connectorDir, "long-target-link"));

    const digest = await hashConnectorPackage(connectorDir);
    const store = new ConnectorPackageArchiveStore(workspace);
    await store.publish(connectorDir, digest);
    const resolved = await store.resolve(digest);

    expect(resolved.entries.map((entry) => entry.relativePath)).toEqual([
      longName,
      "long-target-link",
    ]);
    expect(resolved.entries.find((entry) => entry.relativePath === "long-target-link"))
      .toMatchObject({
      kind: "symlink",
      target: longTarget,
    });
  });

  test("round-trips package-external, absolute, and backslash symlink targets", async () => {
    const connectorDir = join(workspace, "connectors", "permissive-links");
    mkdirSync(join(connectorDir, "nested"), { recursive: true });
    const externalTarget = join(workspace, "outside.txt");
    writeFileSync(externalTarget, "outside\n");
    symlinkSync("../../../outside.txt", join(connectorDir, "nested", "external-link"));
    symlinkSync(externalTarget, join(connectorDir, "absolute-link"));
    symlinkSync("..\\outside.txt", join(connectorDir, "backslash-link"));

    const digest = await hashConnectorPackage(connectorDir);
    const store = new ConnectorPackageArchiveStore(workspace);
    await store.publish(connectorDir, digest);
    const resolved = await store.resolve(digest);

    expect(resolved.entries).toEqual([
      {
        kind: "symlink",
        relativePath: "absolute-link",
        target: externalTarget,
      },
      {
        kind: "symlink",
        relativePath: "backslash-link",
        target: "..\\outside.txt",
      },
      {
        kind: "symlink",
        relativePath: "nested/external-link",
        target: "../../../outside.txt",
      },
    ]);
    expect(hashConnectorPackageTree(resolved.entries)).toBe(digest);
  });

  test("fails before publication when the directory no longer has the admitted digest", async () => {
    const connectorDir = join(workspace, "connectors", "changed");
    mkdirSync(connectorDir, { recursive: true });
    writeFileSync(join(connectorDir, "index.mjs"), "export default 1;\n");
    const admittedDigest = await hashConnectorPackage(connectorDir);
    writeFileSync(join(connectorDir, "index.mjs"), "export default 2;\n");

    const store = new ConnectorPackageArchiveStore(workspace);
    await expect(store.publish(connectorDir, admittedDigest)).rejects.toThrow(
      "changed while archiving",
    );
    await expect(store.resolve(admittedDigest)).rejects.toThrow("archive is missing");
  });

  test("never overwrites an existing archive that resolves to different content", async () => {
    const firstDir = join(workspace, "packages", "first");
    const secondDir = join(workspace, "packages", "second");
    mkdirSync(firstDir, { recursive: true });
    mkdirSync(secondDir, { recursive: true });
    writeFileSync(join(firstDir, "value.txt"), "first\n");
    writeFileSync(join(secondDir, "value.txt"), "second\n");
    const firstDigest = await hashConnectorPackage(firstDir);
    const secondDigest = await hashConnectorPackage(secondDir);
    const store = new ConnectorPackageArchiveStore(workspace);
    const second = await store.publish(secondDir, secondDigest);
    const firstPath = store.archivePath(firstDigest);
    mkdirSync(dirname(firstPath), { recursive: true });
    copyFileSync(second.path, firstPath);
    const conflictingBytes = readFileSync(firstPath);

    await expect(store.publish(firstDir, firstDigest)).rejects.toThrow("digest mismatch");
    expect(readFileSync(firstPath)).toEqual(conflictingBytes);
  });

  test("rejects corrupt gzip and logical digest mismatch", async () => {
    const store = new ConnectorPackageArchiveStore(workspace);
    writeArchiveBytes(store, ARBITRARY_DIGEST, Buffer.from("not gzip"));
    await expect(store.resolve(ARBITRARY_DIGEST)).rejects.toThrow("not valid gzip");

    writeArchiveBytes(store, ARBITRARY_DIGEST, gzipSync(makeTar([
      { path: "value.txt", type: "0", body: Buffer.from("different\n") },
    ])));
    await expect(store.resolve(ARBITRARY_DIGEST)).rejects.toThrow("digest mismatch");
  });

  test("requires the exact archive path to exist as a regular file without resolving it", async () => {
    const store = new ConnectorPackageArchiveStore(workspace);
    const path = store.archivePath(ARBITRARY_DIGEST);

    await expect(store.requireExists(ARBITRARY_DIGEST)).rejects.toThrow(
      "archive is missing",
    );

    writeArchiveBytes(store, ARBITRARY_DIGEST, Buffer.from("not gzip"));
    await expect(store.requireExists(ARBITRARY_DIGEST)).resolves.toEqual({
      digest: ARBITRARY_DIGEST,
      path,
    });
    await expect(store.resolve(ARBITRARY_DIGEST)).rejects.toThrow("not valid gzip");

    rmSync(path, { force: true });
    mkdirSync(path);
    await expect(store.requireExists(ARBITRARY_DIGEST)).rejects.toThrow(
      "not a regular file",
    );

    rmSync(path, { recursive: true, force: true });
    const symlinkTarget = join(workspace, "archive-target");
    writeFileSync(symlinkTarget, "target");
    symlinkSync(symlinkTarget, path);
    await expect(store.requireExists(ARBITRARY_DIGEST)).rejects.toThrow(
      "not a regular file",
    );
  });

  test.each([
    {
      label: "absolute path",
      entries: [{ path: "/escape", type: "0" as const, body: Buffer.alloc(0) }],
      message: "must be relative",
    },
    {
      label: "parent traversal",
      entries: [{ path: "../escape", type: "0" as const, body: Buffer.alloc(0) }],
      message: "contains traversal",
    },
    {
      label: "duplicate path",
      entries: [
        { path: "same", type: "0" as const, body: Buffer.from("a") },
        { path: "same", type: "0" as const, body: Buffer.from("b") },
      ],
      message: "duplicate path",
    },
    {
      label: "unsupported entry kind",
      entries: [{ path: "directory", type: "5" as const, body: Buffer.alloc(0) }],
      message: "kind is unsupported",
    },
    {
      label: "symlink with content",
      entries: [{
        path: "link",
        type: "2" as const,
        body: Buffer.from("not allowed"),
        linkName: "target",
      }],
      message: "has file content",
    },
  ])("rejects unsafe tar material: $label", async ({ entries, message }) => {
    const store = new ConnectorPackageArchiveStore(workspace);
    writeArchiveBytes(store, ARBITRARY_DIGEST, gzipSync(makeTar(entries)));
    await expect(store.resolve(ARBITRARY_DIGEST)).rejects.toThrow(message);
  });

  test("strictly validates logical package digests", async () => {
    const store = new ConnectorPackageArchiveStore(workspace);
    expect(() => store.archivePath("sha256:abcd")).toThrow("64 lowercase hex");
    expect(() => store.archivePath(`sha256:${"A".repeat(64)}`)).toThrow(
      "64 lowercase hex",
    );
    await expect(store.resolve("not-a-digest")).rejects.toThrow("64 lowercase hex");
    await expect(store.requireExists("not-a-digest")).rejects.toThrow(
      "64 lowercase hex",
    );
  });
});

interface TestTarEntry {
  path: string;
  type: "0" | "2" | "5";
  body: Buffer;
  linkName?: string;
}

function writeArchiveBytes(
  store: ConnectorPackageArchiveStore,
  digest: string,
  bytes: Buffer,
): void {
  const path = store.archivePath(digest);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function makeTar(entries: TestTarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(TAR_BLOCK_SIZE);
    header.write(entry.path, 0, 100, "utf8");
    writeOctal(header, 100, 8, entry.type === "2" ? 0o777 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.body.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = entry.type.charCodeAt(0);
    if (entry.linkName) header.write(entry.linkName, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header, entry.body);
    const remainder = entry.body.byteLength % TAR_BLOCK_SIZE;
    if (remainder !== 0) chunks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

function writeOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}
