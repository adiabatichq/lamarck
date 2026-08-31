import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, expect, test } from "vitest";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("Host app versions --json returns the complete version-record array", async () => {
  const root = await mkdtemp(join(tmpdir(), "lamarck-app-cli-test-"));
  roots.push(root);
  const cli = join(root, "cli.mjs");
  await build({
    entryPoints: [join(import.meta.dirname, "..", "src", "cli.ts")],
    outfile: cli,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
  });
  const records = [
    { schemaVersion: 1, appId: "example", version: "a".repeat(40), parentVersion: "b".repeat(40), trigger: "save", createdAt: 2 },
    { schemaVersion: 1, appId: "example", version: "b".repeat(40), parentVersion: null, trigger: "activate", createdAt: 1 },
  ];
  const script = `
    const records = ${JSON.stringify(records)};
    globalThis.fetch = async (input) => String(input).includes("cursor=next")
      ? Response.json({ versions: [records[1]], nextCursor: null })
      : Response.json({ versions: [records[0]], nextCursor: "next" });
    process.argv = [process.execPath, "lamarck", "app", "versions", "example", "--json"];
    await import(${JSON.stringify(pathToFileURL(cli).href)});
  `;
  const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, LAMARCK_CORE_TOKEN: "test-token" },
  });

  expect(JSON.parse(stdout)).toEqual(records);
});
