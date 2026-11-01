import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  collectAppPackageTree,
  hashAppPackageTree,
  materializeAppPackageTree,
  validateAppPackageTree,
  type AppPackageEntry,
} from "../src/apps/package-tree";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

  test.each([
    ["file", "src/index.ts"],
    ["root directory", "."],
    ["nested directory", "src"],
  ])("accepts timestamp-only changes to a %s during the first read", async (_kind, path) => {
    const app = await fixture();
    const target = join(app, path);
    const baseline = await collectAppPackageTree(app);
    const before = await lstat(target, { bigint: true });
    const probe = await open(join(app, "src", "index.ts"), "r");
    const prototype = Object.getPrototypeOf(probe) as { readFile: typeof probe.readFile };
    const originalReadFile = prototype.readFile;
    await probe.close();
    const read = vi.spyOn(prototype, "readFile").mockImplementation(async function (
      this: typeof probe,
      options,
    ) {
      const bytes = await originalReadFile.call(this, options);
      // The second file is src/index.ts: both directories and the file have
      // already been statted, and their post-read checks are still pending.
      if (read.mock.calls.length === 2) {
        await utimes(target, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
      }
      return bytes;
    });

    const entries = await collectAppPackageTree(app);
    expect(read).toHaveBeenCalledTimes(2);
    expect(entries).toEqual(baseline);
    expect(hashAppPackageTree(entries)).toBe(hashAppPackageTree(baseline));
    const after = await lstat(target, { bigint: true });
    expect(after.mtimeNs).not.toBe(before.mtimeNs);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
  });

  test("rejects hard links and unsupported file types", async () => {
    const app = await fixture();
    const hardlink = join(app, "linked.ts");
    await link(join(app, "src", "index.ts"), hardlink);
    await expect(collectAppPackageTree(app)).rejects.toThrow("hard links are not supported");
    await rm(hardlink);
    execFileSync("mkfifo", [join(app, "pipe")]);
    await expect(collectAppPackageTree(app)).rejects.toThrow("Unsupported package file type");
  });

  test.each(["../escape", "/absolute", "nested/../../escape", "nested\\escape"])(
    "rejects unsafe package path %s",
    (path) => {
      expect(() => hashAppPackageTree([file(path, Buffer.from("unsafe"))])).toThrow("Invalid package path");
    },
  );

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
