import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build, type Plugin } from "esbuild";
import { afterEach, expect, test } from "vitest";

const execute = promisify(execFile);
const roots: string[] = [];
const records = [
  { schemaVersion: 1, appId: "example", version: "a".repeat(40), parentVersion: "b".repeat(40), trigger: "save", createdAt: 2 },
  { schemaVersion: 1, appId: "example", version: "b".repeat(40), parentVersion: null, trigger: "activate", createdAt: 1 },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("managed app versions exposes no pagination flags and prints the version-record array", async () => {
  const cli = await buildCli();
  const success = await execute(process.execPath, [cli, "app", "versions", "example", "--json"]);
  expect(success.stderr).toBe("");
  expect(JSON.parse(success.stdout)).toEqual(records);

  await expect(execute(process.execPath, [
    cli,
    "app",
    "versions",
    "example",
    "--cursor",
    "private-page",
    "--json",
  ])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("APP_COMMAND_UNSUPPORTED"),
  });
});

async function buildCli(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lamarck-managed-cli-test-"));
  roots.push(root);
  const outfile = join(root, "lamarck.mjs");
  await build({
    entryPoints: [join(import.meta.dirname, "..", "src", "managed-cli.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    plugins: [mockSocketPlugin()],
  });
  return outfile;
}

function mockSocketPlugin(): Plugin {
  return {
    name: "managed-cli-test-socket",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^node:net$/ }, () => ({ path: "node:net", namespace: "test" }));
      buildApi.onLoad({ filter: /.*/, namespace: "test" }, () => ({
        loader: "js",
        contents: `
          import { Duplex } from "node:stream";
          const result = ${JSON.stringify(records)};
          class TestSocket extends Duplex {
            _read() {}
            _write(_chunk, _encoding, callback) { callback(); }
          }
          export function createConnection() {
            const socket = new TestSocket();
            queueMicrotask(() => {
              socket.emit("connect");
              const payload = Buffer.from(JSON.stringify({ version: 1, requestId: 1, ok: true, result }));
              const frame = Buffer.alloc(4 + payload.byteLength);
              frame.writeUInt32BE(payload.byteLength, 0);
              payload.copy(frame, 4);
              socket.push(frame);
            });
            return socket;
          }
          export function createServer() {
            throw new Error("unexpected server creation in managed CLI test");
          }
        `,
      }));
    },
  };
}
