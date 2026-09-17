import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createNodeSystem } from "../src/node-system";

describe("Node VFS read mount", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("reads through the private mount and brokers every mutation", async () => {
    root = await mkdtemp(join(tmpdir(), "lamarck-node-vfs-"));
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes/a.md"), Buffer.from([0, 1, 255]));
    const invoke = vi.fn(async () => ({
      success: true,
      exitCode: 0,
      stdoutBase64: "",
      stderrBase64: "",
    })) as never;
    const system = createNodeSystem(invoke, root);

    const read = await system.vfs.command("cat -- notes/a.md");
    expect(read).toEqual({
      success: true,
      exitCode: 0,
      stdout: Buffer.from([0, 1, 255]),
      stderr: new Uint8Array(),
    });
    expect(invoke).not.toHaveBeenCalled();

    await system.vfs.command("tee -- notes/a.md", { stdin: "changed", author: "codex" });
    expect(invoke).toHaveBeenCalledWith("vfs.command", {
      command: "tee -- notes/a.md",
      options: { stdin: { encoding: "utf8", data: "changed" }, author: "codex" },
    });
  });

  test("rejects known stdin above 1 GiB before beginning a Node upload", async () => {
    root = await mkdtemp(join(tmpdir(), "lamarck-node-vfs-"));
    const invoke = vi.fn();
    const system = createNodeSystem(invoke as never, root);

    await expect(system.vfs.command("tee -- overflow.bin", {
      stdin: new KnownSizeBlob(1024 * 1024 * 1024 + 1),
      stdout: "ignore",
    })).rejects.toThrow("1 GiB upload limit");
    expect(invoke).not.toHaveBeenCalled();
  });

  test.each(["ls", "ls -a", "ls -l", "ls -R", "ls -alR"])(
    "%s preserves locally valid names that are not Windows-portable",
    async (command) => {
      root = await mkdtemp(join(tmpdir(), "lamarck-node-vfs-"));
      await mkdir(join(root, "notes/deep"), { recursive: true });
      await mkdir(join(root, "notes/CON"));
      await writeFile(join(root, "notes/CON/note.md"), "readable child");
      const names = ["a|b.md", "question?.md", "CON.txt", "trailing.", "trailing ", 'quote".md', "time:12.md", "a<b>*.md"];
      for (const name of names) {
        await writeFile(join(root, "notes", name), name);
        await writeFile(join(root, "notes/deep", name), name);
      }
      await writeFile(join(root, "notes/a.md"), "readable");
      await writeFile(join(root, "notes/deep/b.md"), "nested");
      await writeFile(join(root, "notes/.hidden.md"), "hidden");
      const invoke = vi.fn();
      const system = createNodeSystem(invoke as never, root);

      const result = await system.vfs.command(`${command} -- notes`);
      expect(result.success, Buffer.from(result.stderr).toString()).toBe(true);
      expect(result.exitCode).toBe(0);
      const paths = Buffer.from(result.stdout).toString().slice(0, -1).split("\n")
        .map((line) => line.split("\t").at(-1));
      expect(paths.sort()).toEqual([
        ...(command.includes("a") ? ["notes/.hidden.md"] : []),
        "notes/CON",
        "notes/a.md",
        "notes/deep",
        ...names.map((name) => `notes/${name}`),
        ...(command.includes("R") ? ["notes/CON/note.md", "notes/deep/b.md", ...names.map((name) => `notes/deep/${name}`)] : []),
      ].sort());
      for (const name of names) {
        const read = await system.vfs.command(`cat -- 'notes/${name}'`);
        expect(read.success, Buffer.from(read.stderr).toString()).toBe(true);
        expect(Buffer.from(read.stdout).toString()).toBe(name);
        const stat = await system.vfs.command(`stat -- 'notes/${name}'`);
        expect(stat.success, Buffer.from(stat.stderr).toString()).toBe(true);
      }
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  test("root listings and explicit operands preserve punctuation", async () => {
    root = await mkdtemp(join(tmpdir(), "lamarck-node-vfs-"));
    await writeFile(join(root, "a|b.md"), "readable punctuation");
    await writeFile(join(root, "valid.md"), "readable");
    const system = createNodeSystem(vi.fn() as never, root);

    const listing = await system.vfs.command("ls");
    expect(listing.success, Buffer.from(listing.stderr).toString()).toBe(true);
    expect(Buffer.from(listing.stdout).toString()).toBe("a|b.md\nvalid.md\n");
    for (const command of ["ls", "cat", "stat"]) {
      const result = await system.vfs.command(`${command} -- 'a|b.md'`);
      expect(result.success, Buffer.from(result.stderr).toString()).toBe(true);
    }
  });

  test("lists control characters safely and round-trips raw names with ls -0", async () => {
    root = await mkdtemp(join(tmpdir(), "lamarck-node-vfs-"));
    const names = ["back\\slash.md", "line\nbreak.md", "tab\tname.md"];
    for (const name of names) await writeFile(join(root, name), name);
    const system = createNodeSystem(vi.fn() as never, root);

    const listing = await system.vfs.command("ls");
    expect(listing.success, Buffer.from(listing.stderr).toString()).toBe(true);
    expect(Buffer.from(listing.stdout).toString()).toBe(`${names.map((name) => JSON.stringify(name)).join("\n")}\n`);
    const raw = await system.vfs.command("ls -0");
    expect(raw.success, Buffer.from(raw.stderr).toString()).toBe(true);
    expect(Buffer.from(raw.stdout).toString()).toBe(`${names.join("\0")}\0`);
    for (const name of names) {
      const read = await system.vfs.command(`cat -- '${name}'`);
      expect(read.success, Buffer.from(read.stderr).toString()).toBe(true);
      expect(Buffer.from(read.stdout).toString()).toBe(name);
      const stat = await system.vfs.command(`stat -- '${name}'`);
      expect(Buffer.from(stat.stdout).toString()).toBe(`${JSON.stringify(name)}\tfile\t${Buffer.byteLength(name)}\n`);
    }
  });

  test("reads existing paths beyond the former portable length limits", async () => {
    root = await mkdtemp(join(tmpdir(), "lamarck-node-vfs-"));
    const directory = Array(3).fill("a".repeat(180)).join("/");
    const name = `${"b".repeat(241)}.md`;
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, name), "deep note");
    const system = createNodeSystem(vi.fn() as never, root);
    const path = `${directory}/${name}`;

    const listing = await system.vfs.command(`ls -- '${directory}'`);
    expect(listing.success, Buffer.from(listing.stderr).toString()).toBe(true);
    expect(Buffer.from(listing.stdout).toString()).toBe(`${path}\n`);
    const read = await system.vfs.command(`cat -- '${path}'`);
    expect(read.success, Buffer.from(read.stderr).toString()).toBe(true);
    expect(Buffer.from(read.stdout).toString()).toBe("deep note");
  });
});

class KnownSizeBlob extends Blob {
  constructor(private readonly knownSize: number) {
    super([]);
  }

  override get size(): number {
    return this.knownSize;
  }
}
