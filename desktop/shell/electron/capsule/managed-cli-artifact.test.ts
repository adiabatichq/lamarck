import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadManagedCliArtifact } from "./managed-cli-artifact";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("loads only the pinned Desktop artifact and fails closed on missing, changed or substituted files", async () => {
  const root = await mkdtemp("/tmp/lamarck-cli-artifact-"); roots.push(root);
  const bytes = Buffer.from("#!/usr/local/bin/node\nconsole.log('managed');\n");
  await expect(loadManagedCliArtifact(root)).rejects.toThrow("missing or invalid");
  const descriptor = { type: "cli.artifact", schemaVersion: 1,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.length };
  await writeFile(join(root, "managed-cli.json"), JSON.stringify(descriptor));
  await expect(loadManagedCliArtifact(root)).rejects.toThrow("missing or invalid");
  await writeFile(join(root, "lamarck-managed.mjs"), bytes);
  expect(await loadManagedCliArtifact(root)).toEqual({ descriptor, bytes });
  await writeFile(join(root, "lamarck-managed.mjs"), Buffer.alloc(bytes.length));
  await expect(loadManagedCliArtifact(root)).rejects.toThrow("integrity");
  await rm(join(root, "lamarck-managed.mjs"));
  await writeFile(join(root, "replacement"), bytes);
  await symlink("replacement", join(root, "lamarck-managed.mjs"));
  await expect(loadManagedCliArtifact(root)).rejects.toThrow("missing or invalid");
});
