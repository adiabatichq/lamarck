import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  collectAppPackageTree,
  hashAppPackageTree,
  materializeAppPackageTree,
  validateAppPackageTree,
  type AppPackageEntry,
} from "../src/apps/package-tree";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical App package projection", () => {
  test("pins the V1 logical digest vector", () => {
    expect(hashAppPackageTree([
      file("a.txt", Buffer.from("A")),
      file("é.txt", Buffer.from("B")),
    ])).toBe("sha256:460d26f45d5025aa7257912c78b2a7a8749a9dabbb718c6285406da77757e367");
  });

  test("includes ignored, untracked, dist, and reference SQL while excluding private roots", async () => {
    const app = await fixture();
    await writeFile(join(app, ".gitignore"), "dist/\nignored.txt\n");
    await writeFile(join(app, "ignored.txt"), "included anyway\n");
    await mkdir(join(app, "dist"));
    await writeFile(join(app, "dist", "bundle.js"), "built bytes\n");
    await writeFile(join(app, "schema.sql"), "CREATE TABLE reference_only(id TEXT);\n");
    await mkdir(join(app, ".git"));
    await writeFile(join(app, ".git", "HEAD"), "private\n");
    await mkdir(join(app, ".lamarck"));
    await writeFile(join(app, ".lamarck", "state"), "private\n");
    await mkdir(join(app, "node_modules", "dep"), { recursive: true });
    await writeFile(join(app, "node_modules", "dep", "index.js"), "private\n");
    await mkdir(join(app, "src", ".git"), { recursive: true });
    await writeFile(join(app, "src", ".git", "config"), "nested package content\n");
    await mkdir(join(app, "src", ".lamarck"), { recursive: true });
    await writeFile(join(app, "src", ".lamarck", "state"), "nested package content\n");
    await mkdir(join(app, "vendor", "node_modules"), { recursive: true });
    await writeFile(join(app, "vendor", "node_modules", "reference.js"), "nested package content\n");

    const packageValue = validateAppPackageTree(await collectAppPackageTree(app), "example");
    expect(packageValue.entries.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "dist/bundle.js",
      "ignored.txt",
      "manifest.json",
      "schema.sql",
      "src/.git/config",
      "src/.lamarck/state",
      "src/index.ts",
      "vendor/node_modules/reference.js",
    ]);
    expect(packageValue.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const before = packageValue.digest;
    await writeFile(join(app, ".git", "HEAD"), "changed private bytes\n");
    await writeFile(join(app, "node_modules", "dep", "index.js"), "changed private bytes\n");
    const after = hashAppPackageTree(await collectAppPackageTree(app));
    expect(after).toBe(before);
  });

  test("orders unsigned UTF-8 bytes and ignores Host file mode", async () => {
    const app = await fixture();
    await writeFile(join(app, "z.txt"), "z");
    await writeFile(join(app, "é.txt"), "accent");
    const first = validateAppPackageTree(await collectAppPackageTree(app), "example");
    await chmod(join(app, "src", "index.ts"), 0o755);
    const second = validateAppPackageTree(await collectAppPackageTree(app), "example");
    expect(second.digest).toBe(first.digest);
    expect(second.entries.map((entry) => entry.path)).toEqual([
      "manifest.json",
      "src/index.ts",
      "z.txt",
      "é.txt",
    ]);
  });

  test("rejects symlinks, excluded upload paths, portable collisions, and wrong manifest identity", async () => {
    const app = await fixture();
    await symlink("src/index.ts", join(app, "linked.ts"));
    await expect(collectAppPackageTree(app)).rejects.toThrow("symlinks are not supported");

    const manifest = Buffer.from(JSON.stringify(validManifest("example")));
    expect(() => validateAppPackageTree([
      file("manifest.json", manifest),
      file(".git/config", Buffer.from("forged")),
    ], "example")).toThrow("Invalid package path");
    expect(() => validateAppPackageTree([
      file("manifest.json", manifest),
      file("src/.git/config", Buffer.from("ordinary nested content")),
      file("src/.lamarck/state", Buffer.from("ordinary nested content")),
      file("vendor/node_modules/reference.js", Buffer.from("ordinary nested content")),
    ], "example")).not.toThrow();
    expect(() => validateAppPackageTree([
      file("manifest.json", manifest),
      file("Readme.md", Buffer.from("one")),
      file("README.md", Buffer.from("two")),
    ], "example")).toThrow("portable filesystem");
    expect(() => validateAppPackageTree([
      file("manifest.json", manifest),
    ], "different-app")).toThrow("does not match expected id");
  });

  test("materializes the same validated V1 package without metadata authority", async () => {
    const app = await fixture();
    const packageValue = validateAppPackageTree(await collectAppPackageTree(app), "example");
    const destination = join(roots[0], "materialized");
    await materializeAppPackageTree(packageValue.entries, destination);
    const roundTrip = validateAppPackageTree(await collectAppPackageTree(destination), "example");
    expect(roundTrip.digest).toBe(packageValue.digest);
    expect(await readFile(join(destination, "src", "index.ts"), "utf8")).toBe("export {};\n");
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lamarck-app-package-"));
  roots.push(root);
  const app = join(root, "example");
  await mkdir(join(app, "src"), { recursive: true });
  await writeFile(join(app, "manifest.json"), `${JSON.stringify(validManifest("example"))}\n`);
  await writeFile(join(app, "src", "index.ts"), "export {};\n", { mode: 0o600 });
  return app;
}

function validManifest(id: string) {
  return {
    manifestVersion: 1,
    id,
    name: "Example",
    description: "An example App.",
    runtime: { ui: { command: ["npm", "run", "start"], port: 3000 } },
    permissions: { writes: { files: [], tables: [] } },
  };
}

function file(path: string, bytes: Uint8Array): AppPackageEntry {
  return { path, kind: "file", bytes };
}
