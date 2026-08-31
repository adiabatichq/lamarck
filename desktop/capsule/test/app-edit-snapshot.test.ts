import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  CAPSULE_TREE_HEADER_BYTES,
  CAPSULE_TREE_MAGIC,
  decodeCapsuleTreeHeader,
  decodeCapsuleTreePath,
} from "../src/artifact/tree-format";
import { createAppEditSnapshot } from "../src/app-edit/snapshot";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("Capsule save snapshots exclude only top-level private roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "lamarck-app-edit-snapshot-"));
  roots.push(root);
  const app = join(root, "app");
  await mkdir(app);
  await writeFile(join(app, "manifest.json"), "{}\n");
  for (const excluded of [".git", ".lamarck", "node_modules"]) {
    await mkdir(join(app, excluded), { recursive: true });
    await writeFile(join(app, excluded, "private"), "excluded");
  }
  for (const nested of ["src/.git", "src/.lamarck", "vendor/node_modules"]) {
    await mkdir(join(app, nested), { recursive: true });
    await writeFile(join(app, nested, "reference"), nested);
  }

  const snapshot = await createAppEditSnapshot(app, join(root, "temporary"));
  try {
    const paths = decodePaths(await readFile(snapshot.path));
    for (const excluded of [".git", ".lamarck", "node_modules"]) {
      expect(paths.some((path) => path === excluded || path.startsWith(`${excluded}/`))).toBe(false);
    }
    expect(paths).toEqual(expect.arrayContaining([
      "src/.git/reference",
      "src/.lamarck/reference",
      "vendor/node_modules/reference",
    ]));
  } finally {
    await snapshot.cleanup();
  }
});

function decodePaths(bytes: Buffer): string[] {
  expect(bytes.subarray(0, CAPSULE_TREE_MAGIC.byteLength).equals(CAPSULE_TREE_MAGIC)).toBe(true);
  const paths: string[] = [];
  let offset = CAPSULE_TREE_MAGIC.byteLength;
  for (;;) {
    const header = decodeCapsuleTreeHeader(bytes.subarray(offset, offset + CAPSULE_TREE_HEADER_BYTES));
    offset += CAPSULE_TREE_HEADER_BYTES;
    if (header.type === "end") break;
    const path = decodeCapsuleTreePath(bytes.subarray(offset, offset + header.pathLength));
    offset += header.pathLength + header.contentLength;
    paths.push(path);
  }
  expect(offset).toBe(bytes.byteLength);
  return paths;
}
