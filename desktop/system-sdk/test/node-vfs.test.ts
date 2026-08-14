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
});
