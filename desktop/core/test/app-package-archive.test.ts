import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { createAppEditSnapshot } from "../../capsule/src/app-edit/snapshot";
import { readAppPackageArchive } from "../src/apps/package-archive";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("streams and revalidates a complete archive above the transport chunk threshold", async () => {
  const root = await mkdtemp(join(tmpdir(), "lamarck-app-archive-"));
  roots.push(root);
  const appDir = join(root, "example");
  await mkdir(appDir);
  await writeFile(join(appDir, "manifest.json"), `${JSON.stringify({
    manifestVersion: 1,
    id: "example",
    name: "Example",
    description: "Archive fixture.",
    runtime: { job: { command: ["node", "job.mjs"] } },
    permissions: { writes: { files: [], tables: [] } },
  })}\n`);
  await writeFile(join(appDir, "reference.sql"), Buffer.alloc(256 * 1024, 0x61));
  const snapshot = await createAppEditSnapshot(appDir, join(root, "snapshots"));
  try {
    const metadata = {
      schemaVersion: 1,
      baseVersion: null,
      basePackageDigest: `sha256:${"b".repeat(64)}`,
      archiveDigest: snapshot.archiveDigest,
      archiveBytes: snapshot.archiveBytes,
      message: "Save reference SQL",
    };
    const body = Readable.toWeb(createReadStream(snapshot.path, { highWaterMark: 17 * 1024 })) as ReadableStream;
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: {
        "content-length": String(snapshot.archiveBytes),
        "x-lamarck-app-edit-v1": Buffer.from(JSON.stringify(metadata)).toString("base64url"),
      },
      body,
      duplex: "half",
    } as unknown as RequestInit);
    const decoded = await readAppPackageArchive(request, join(root, "staging"));
    expect(decoded.metadata).toEqual(metadata);
    expect(decoded.entries.map((entry) => entry.path)).toEqual(["manifest.json", "reference.sql"]);
    expect(decoded.entries[1]?.kind === "file" && decoded.entries[1].bytes.byteLength)
      .toBe(256 * 1024);
  } finally {
    await snapshot.cleanup();
  }
});
