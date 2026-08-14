import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { ConnectorPackageArchiveStore } from "../src/connectors/connector-package-archive";
import { hashConnectorPackage } from "../src/connectors/registry";
import {
  DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
  extractVerifiedMarketplaceArtifact,
  verifyMarketplaceArtifact,
} from "../src/marketplace/artifact";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Marketplace artifact consumer", () => {
  test("uses one centralized set of generous archive bounds", () => {
    expect(DEFAULT_MARKETPLACE_ARTIFACT_LIMITS).toEqual({
      maxCompressedBytes: 64 * 1024 * 1024,
      maxUncompressedBytes: 256 * 1024 * 1024,
      maxEntries: 10_000,
      maxPathBytes: 1_024,
      maxFileBytes: 128 * 1024 * 1024,
      maxManifestBytes: 1024 * 1024,
    });
  });

  test("verifies and safely extracts an App logical tree", async () => {
    const manifest = appManifest("lamarck.tools");
    const entries = [
      { path: "index.tsx", bytes: Buffer.from("export default function App() { return null; }\n") },
      { path: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) },
      { path: "public/icon.bin", bytes: Buffer.from([0, 1, 2, 255]) },
    ];
    const contentHash = hashFiles(entries);
    const verified = verifyMarketplaceArtifact({
      kind: "app",
      packageId: "lamarck.tools",
      contentHash,
      archiveBytes: makeArchive(entries),
    });

    expect(verified.manifest).toEqual({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
    });
    expect(verified.contentHash).toBe(contentHash);
    const root = await temporaryRoot();
    const destination = join(root, "extracted");
    await extractVerifiedMarketplaceArtifact(verified, destination);
    expect(await readFile(join(destination, "public", "icon.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect((await lstat(destination)).mode & 0o777).toBe(0o755);
    expect((await lstat(join(destination, "public"))).mode & 0o777).toBe(0o755);
    expect((await lstat(join(destination, "index.tsx"))).mode & 0o777).toBe(0o644);
  });

  test("uses the public UTF-8 byte-wise logical-tree compatibility vector", async () => {
    const vectorRoot = new URL(
      "../../../test-vectors/marketplace/app-tree-v1/",
      import.meta.url,
    );
    const vector = JSON.parse(await readFile(
      new URL("expected.json", vectorRoot),
      "utf8",
    )) as LogicalTreeVector;
    const archiveBytes = await readFile(new URL("canonical.tar.gz", vectorRoot));

    expect(archiveBytes.byteLength).toBe(vector.canonicalArchiveBytes);
    expect(createHash("sha256").update(archiveBytes).digest("hex"))
      .toBe(vector.canonicalArchiveSha256);

    expect(verifyMarketplaceArtifact({
      kind: vector.kind,
      packageId: vector.packageId,
      contentHash: vector.contentHash,
      archiveBytes,
    }).contentHash).toBe(vector.contentHash);
  });

  test("consumes the existing Connector logical hash and archive bytes unchanged", async () => {
    const root = await temporaryRoot();
    const connectorDir = join(root, "source", "lamarck.sample");
    await mkdir(connectorDir, { recursive: true });
    await writeFile(join(connectorDir, "connector.yaml"), `manifestVersion: 1
id: lamarck.sample
name: Sample
description: A Marketplace verifier compatibility fixture.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
auth:
  type: none
`);
    await writeFile(join(connectorDir, "events.json"), JSON.stringify({
      catalogVersion: 1,
      eventTypes: {
        "sample.event": {
          description: "A sample event.",
          payloadSchema: { type: "object" },
        },
      },
    }));
    await writeFile(join(connectorDir, "index.mjs"), "export default { async run() {} };\n");
    await symlink("index.mjs", join(connectorDir, "current.mjs"));

    const contentHash = await hashConnectorPackage(connectorDir);
    const store = new ConnectorPackageArchiveStore(root);
    const publication = await store.publish(connectorDir, contentHash);
    const archiveBytes = await readFile(publication.path);
    const verified = verifyMarketplaceArtifact({
      kind: "connector",
      packageId: "lamarck.sample",
      contentHash,
      archiveBytes,
    });

    expect(verified.contentHash).toBe(contentHash);
    expect(verified.manifest).toMatchObject({ id: "lamarck.sample" });
    expect(verified.entries.some((entry) => entry.kind === "symlink")).toBe(true);
    const destination = join(root, "extracted");
    await extractVerifiedMarketplaceArtifact(verified, destination);
    expect(await readlink(join(destination, "current.mjs"))).toBe("index.mjs");
  });

  test("rejects a hash mismatch and never creates an extraction target", async () => {
    const entries = [
      { path: "index.tsx", bytes: Buffer.from("export default null;\n") },
      { path: "manifest.json", bytes: Buffer.from(JSON.stringify(appManifest("lamarck.sample"))) },
    ];
    expect(() => verifyMarketplaceArtifact({
      kind: "app",
      packageId: "lamarck.sample",
      contentHash: `sha256:${"0".repeat(64)}`,
      archiveBytes: makeArchive(entries),
    })).toThrow("logical hash mismatch");
  });

  test.each([
    ["parent traversal", "../escape"],
    ["absolute path", "/escape"],
    ["backslash path", "bad\\path"],
    ["excluded git path", ".git/config"],
    ["excluded dependency path", "src/node_modules/module.js"],
    ["macOS metadata directory", "__MACOSX/source.ts"],
    ["macOS resource fork", "assets/._icon.png"],
  ])("rejects App %s", (_label, unsafePath) => {
    const manifest = appManifest("lamarck.sample");
    const entries = [
      { path: unsafePath, bytes: Buffer.from("unsafe") },
      { path: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) },
    ].sort((left, right) => left.path.localeCompare(right.path));
    expect(() => verifyMarketplaceArtifact({
      kind: "app",
      packageId: manifest.id,
      contentHash: hashFiles(entries),
      archiveBytes: makeArchive(entries),
    })).toThrow();
  });

  test("rejects App symlinks but ignores irrelevant tar mode metadata", () => {
    const manifest = appManifest("lamarck.sample");
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const contentHash = hashFiles([{ path: "manifest.json", bytes: manifestBytes }]);
    expect(() => verifyMarketplaceArtifact({
      kind: "app",
      packageId: manifest.id,
      contentHash,
      archiveBytes: makeArchive([
        { path: "manifest.json", bytes: manifestBytes },
        { path: "shortcut", bytes: Buffer.alloc(0), type: "2", linkName: "manifest.json" },
      ]),
    })).toThrow("contains a symlink");

    expect(verifyMarketplaceArtifact({
      kind: "app",
      packageId: manifest.id,
      contentHash,
      archiveBytes: makeArchive([
        { path: "manifest.json", bytes: manifestBytes, mode: 0o755 },
      ]),
    }).contentHash).toBe(contentHash);
  });

  test("does not invent Unicode path normalization and rejects path-prefix collisions", () => {
    const manifest = appManifest("lamarck.sample");
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const decomposed = "assets/cafe\u0301.txt";
    const decomposedEntries = [
      { path: decomposed, bytes: Buffer.from("accent") },
      { path: "manifest.json", bytes: manifestBytes },
    ].sort((left, right) => left.path.localeCompare(right.path));
    expect(verifyMarketplaceArtifact({
      kind: "app",
      packageId: manifest.id,
      contentHash: hashFiles(decomposedEntries),
      archiveBytes: makeArchive(decomposedEntries),
    }).contentHash).toBe(hashFiles(decomposedEntries));

    const collisions = [
      { path: "manifest.json", bytes: manifestBytes },
      { path: "src", bytes: Buffer.from("file") },
      { path: "src/index.ts", bytes: Buffer.from("child") },
    ];
    expect(() => verifyMarketplaceArtifact({
      kind: "app",
      packageId: manifest.id,
      contentHash: hashFiles(collisions),
      archiveBytes: makeArchive(collisions),
    })).toThrow("descends through an entry");
  });

  test("rejects createdFrom in a published App and enforces bounded expansion", () => {
    const manifest = {
      ...appManifest("lamarck.sample"),
      createdFrom: { packageId: "lamarck.other", releaseId: "rel_1" },
    };
    const entries = [{ path: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) }];
    expect(() => verifyMarketplaceArtifact({
      kind: "app",
      packageId: manifest.id,
      contentHash: hashFiles(entries),
      archiveBytes: makeArchive(entries),
    })).toThrow("must not contain createdFrom");

    const cleanManifest = Buffer.from(JSON.stringify(appManifest("lamarck.sample")));
    const largeEntries = [
      { path: "large.bin", bytes: Buffer.alloc(8_192, 0x61) },
      { path: "manifest.json", bytes: cleanManifest },
    ];
    expect(() => verifyMarketplaceArtifact({
      kind: "app",
      packageId: "lamarck.sample",
      contentHash: hashFiles(largeEntries),
      archiveBytes: makeArchive(largeEntries),
      limits: { maxUncompressedBytes: 2_048 },
    })).toThrow("gzip decoding failed");
  });

  test("rolls back extraction when the destination already exists", async () => {
    const manifest = appManifest("lamarck.sample");
    const entries = [{ path: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) }];
    const verified = verifyMarketplaceArtifact({
      kind: "app",
      packageId: manifest.id,
      contentHash: hashFiles(entries),
      archiveBytes: makeArchive(entries),
    });
    const root = await temporaryRoot();
    const destination = join(root, "existing");
    await mkdir(destination);
    await writeFile(join(destination, "keep"), "user data");
    await expect(extractVerifiedMarketplaceArtifact(verified, destination)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("user data");
  });

  test("normalizes extraction modes even under a restrictive process umask", async () => {
    const manifest = appManifest("lamarck.sample");
    const entries = [
      { path: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) },
      { path: "nested/source.ts", bytes: Buffer.from("export {};\n") },
    ];
    const verified = verifyMarketplaceArtifact({
      kind: "app",
      packageId: manifest.id,
      contentHash: hashFiles(entries),
      archiveBytes: makeArchive(entries),
    });
    const root = await temporaryRoot();
    const destination = join(root, "restrictive-umask");
    const priorUmask = process.umask(0o077);
    try {
      await extractVerifiedMarketplaceArtifact(verified, destination);
    } finally {
      process.umask(priorUmask);
    }
    expect((await lstat(destination)).mode & 0o777).toBe(0o755);
    expect((await lstat(join(destination, "nested"))).mode & 0o777).toBe(0o755);
    expect((await lstat(join(destination, "nested", "source.ts"))).mode & 0o777).toBe(0o644);
  });

});

function appManifest(id: string) {
  return {
    manifestVersion: 1 as const,
    id,
    name: "Sample",
    description: "A Marketplace artifact compatibility fixture.",
    runtime: { ui: { command: ["npm", "run", "start"], port: 3000 } },
    permissions: { writes: { files: [], tables: [] } },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lamarck-marketplace-artifact-"));
  roots.push(root);
  return root;
}

interface TestEntry {
  path: string;
  bytes: Buffer;
  type?: "0" | "2";
  linkName?: string;
  mode?: number;
}

interface LogicalTreeVector {
  kind: "app";
  packageId: string;
  contentHash: string;
  canonicalArchiveBytes: number;
  canonicalArchiveSha256: string;
}

function hashFiles(entries: readonly Pick<TestEntry, "path" | "bytes">[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")))) {
    hash.update("file\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function makeArchive(entries: readonly TestEntry[]): Buffer {
  const blocks: Buffer[] = [];
  const pushEntry = (
    path: string,
    type: "0" | "2" | "x",
    body: Buffer,
    linkName: string,
    mode: number,
  ) => {
    const header = Buffer.alloc(512);
    writeText(header, 0, 100, path);
    writeOctal(header, 100, 8, mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = type.charCodeAt(0);
    writeText(header, 157, 100, linkName);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = [...header].reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body);
    if (body.byteLength % 512 !== 0) {
      blocks.push(Buffer.alloc(512 - (body.byteLength % 512)));
    }
  };
  for (const entry of entries) {
    const type = entry.type ?? "0";
    const body = type === "0" ? entry.bytes : Buffer.alloc(0);
    pushEntry(
      entry.path,
      type,
      body,
      entry.linkName ?? "",
      entry.mode ?? (type === "2" ? 0o777 : 0o644),
    );
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function writeText(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error("test tar path is too long");
  bytes.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}
