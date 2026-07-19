import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const roots = [
  "desktop/core/src",
  "desktop/core/test",
  "desktop/shell/electron",
  "desktop/shell/src",
  "desktop/template/apps",
];

describe("@lamarck/system single source", () => {
  test("has no ambient declaration copies or source-relative consumers", async () => {
    const violations: string[] = [];
    for (const root of roots) {
      await walk(join(repositoryRoot, root), async (path) => {
        if (path.endsWith("/system-sdk/test/single-source.test.ts")) return;
        if (path.endsWith("/lamarck-system.d.ts")) violations.push(path);
        if (!/\.(?:[cm]?[jt]sx?|d\.ts)$/.test(path)) return;
        const source = await readFile(path, "utf8");
        if (source.includes(`declare module "@lamarck/system"`)) violations.push(path);
        if (source.includes("system-sdk/src/")) violations.push(path);
        if (source.includes("LAMARCK_SYSTEM_DTS")) violations.push(path);
      });
    }
    expect([...new Set(violations)]).toEqual([]);
  });
});

async function walk(root: string, visit: (path: string) => void | Promise<void>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walk(path, visit);
    else if (entry.isFile()) await visit(path);
  }
}
