import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { CliStreamReader, encodeCliFrame } from "@lamarck/cli/transport";
import { receiveManagedCliArtifact } from "../src/app-edit/cli-artifact";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("receives exactly the pinned executable, seals its mode, and refuses replacement", async () => {
  const root = await mkdtemp("/tmp/lamarck-guest-cli-"); roots.push(root);
  const bytes = Buffer.from("#!/usr/local/bin/node\nprocess.exit(0);\n");
  const descriptor = { type: "cli.artifact", schemaVersion: 1,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.length };
  const reader = () => new CliStreamReader(Readable.from(Buffer.concat([encodeCliFrame(descriptor), bytes])));
  await receiveManagedCliArtifact(reader(), root);
  expect(await readFile(`${root}/lamarck-managed.mjs`)).toEqual(bytes);
  expect((await stat(`${root}/lamarck-managed.mjs`)).mode & 0o777).toBe(0o555);
  await expect(receiveManagedCliArtifact(reader(), root)).rejects.toThrow("EEXIST");
});

test("rejects missing descriptors, tampering, truncation and oversized artifacts before writing", async () => {
  const root = await mkdtemp("/tmp/lamarck-invalid-cli-"); roots.push(root);
  for (const [descriptor, bytes, error] of [
    [{ protocolVersion: 1, environment: "managed", supportedOperations: [] }, Buffer.alloc(0), "missing"],
    [{ type: "cli.artifact", schemaVersion: 1, digest: `sha256:${"a".repeat(64)}`, bytes: 2 }, Buffer.from("xx"), "integrity"],
    [{ type: "cli.artifact", schemaVersion: 1, digest: `sha256:${"a".repeat(64)}`, bytes: 2 }, Buffer.from("x"), "ended"],
    [{ type: "cli.artifact", schemaVersion: 1, digest: `sha256:${"a".repeat(64)}`, bytes: 16 * 1024 * 1024 + 1 }, Buffer.alloc(0), "invalid"],
  ] as const) {
    const reader = new CliStreamReader(Readable.from(Buffer.concat([encodeCliFrame(descriptor), bytes])));
    await expect(receiveManagedCliArtifact(reader, root)).rejects.toThrow(error);
    await expect(stat(`${root}/lamarck-managed.mjs`)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
