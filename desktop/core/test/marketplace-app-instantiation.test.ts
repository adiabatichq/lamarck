import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { instantiateMarketplaceApp } from "../src/marketplace/app-instantiation";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lamarck-marketplace-app-"));
  const source = join(root, "verified");
  const apps = join(root, "apps");
  await mkdir(join(source, "src"), { recursive: true });
  const manifest = {
    manifestVersion: 1,
    id: "lamarck.notes",
    name: "Notes",
    description: "Editable notes.",
    runtime: { ui: { command: ["npm", "run", "start"], port: 3000 } },
    permissions: { writes: { files: [], tables: [] } },
  };
  await writeFile(join(source, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(source, "src", "index.tsx"), "export default null;\n", { mode: 0o755 });
  await writeFile(join(source, "src", "manifest.json"), '{"nested":true}\n');
  return { root, source, apps };
}

describe("Marketplace App instantiation", () => {
  test("adds provenance only to a normalized editable local copy", async () => {
    const { source, apps } = await fixture();
    const result = await instantiateMarketplaceApp({
      verifiedSourceDir: source,
      appsDir: apps,
      packageId: "lamarck.notes",
      releaseId: "release-1",
      initializeRepository: async (dir) => await mkdir(join(dir, ".git")),
    });
    expect(result.id).toBe("lamarck.notes");
    expect(result.manifest.createdFrom).toEqual({
      packageId: "lamarck.notes",
      releaseId: "release-1",
    });
    expect(JSON.parse(await readFile(join(source, "manifest.json"), "utf8")))
      .not.toHaveProperty("createdFrom");
    expect((await stat(result.dir)).mode & 0o777).toBe(0o755);
    expect((await stat(join(result.dir, "src"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(result.dir, "src", "index.tsx"))).mode & 0o777).toBe(0o644);
    expect(await readFile(join(result.dir, "src", "manifest.json"), "utf8"))
      .toBe('{"nested":true}\n');
    expect((await stat(join(result.dir, ".git"))).isDirectory()).toBe(true);
  });

  test("rewrites only the local identity after an explicit collision choice", async () => {
    const { source, apps } = await fixture();
    await mkdir(join(apps, "lamarck.notes"), { recursive: true });
    const result = await instantiateMarketplaceApp({
      verifiedSourceDir: source,
      appsDir: apps,
      packageId: "lamarck.notes",
      releaseId: "release-2",
      localId: "my-notes",
      initializeRepository: async (dir) => await mkdir(join(dir, ".git")),
    });
    expect(result.id).toBe("my-notes");
    expect(result.manifest.id).toBe("my-notes");
    expect(result.manifest.createdFrom?.packageId).toBe("lamarck.notes");
  });

  test("does not replace an existing local App", async () => {
    const { source, apps } = await fixture();
    await mkdir(join(apps, "lamarck.notes"), { recursive: true });
    await expect(instantiateMarketplaceApp({
      verifiedSourceDir: source,
      appsDir: apps,
      packageId: "lamarck.notes",
      releaseId: "release-1",
      initializeRepository: async () => {},
    })).rejects.toMatchObject({ code: "EEXIST" });
  });

  test("rolls back when repository initialization fails", async () => {
    const { source, apps } = await fixture();
    await expect(instantiateMarketplaceApp({
      verifiedSourceDir: source,
      appsDir: apps,
      packageId: "lamarck.notes",
      releaseId: "release-1",
      initializeRepository: async () => { throw new Error("repository unavailable"); },
    })).rejects.toThrow("repository unavailable");

    await expect(stat(join(apps, "lamarck.notes"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
