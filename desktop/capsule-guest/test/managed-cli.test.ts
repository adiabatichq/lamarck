import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build, type Plugin } from "esbuild";
import { afterEach, expect, test } from "vitest";
import { MANAGED_CLI_OPERATIONS } from "@lamarck/cli";

const execute = promisify(execFile);
const roots: string[] = [];
const records = [
  { appId: "example", version: "a".repeat(40), parentVersion: "b".repeat(40), trigger: "save", createdAt: 2 },
  { appId: "example", version: "b".repeat(40), parentVersion: null, trigger: "activate", createdAt: 1 },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("Guest artifact uses the shared managed command surface and protocol", async () => {
  const cli = await buildCli();
  const help = await execute(process.execPath, [cli, "--help"]);
  expect(help.stdout).toContain("lamarck app refresh");
  expect(help.stdout).not.toContain("file import");
  expect(help.stdout).not.toContain("file export");

  const success = await execute(process.execPath, [cli, "app", "versions", "example", "--json"]);
  expect(success.stderr).toBe("");
  expect(JSON.parse(success.stdout)).toEqual(records);

  await expect(execute(process.execPath, [cli, "file", "import", "host", "workspace", "--json"]))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("CLI_UNSUPPORTED_COMMAND") });
});

async function buildCli(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lamarck-managed-cli-test-"));
  roots.push(root);
  const outfile = join(root, "lamarck.mjs");
  await build({
    entryPoints: [join(import.meta.dirname, "..", "..", "cli", "src", "managed-entry.ts")],
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
          const operations = ${JSON.stringify(MANAGED_CLI_OPERATIONS)};
          const result = ${JSON.stringify(records)};
          function frame(value) {
            const payload = Buffer.from(JSON.stringify(value));
            const output = Buffer.alloc(4 + payload.byteLength);
            output.writeUInt32BE(payload.byteLength, 0);
            payload.copy(output, 4);
            return output;
          }
          class TestSocket extends Duplex {
            _read() {}
            _write(chunk, _encoding, callback) {
              const request = JSON.parse(Buffer.from(chunk).subarray(4).toString("utf8"));
              queueMicrotask(() => this.push(frame({ requestId: request.requestId, ok: true, result })));
              callback();
            }
          }
          export function createConnection() {
            const socket = new TestSocket();
            queueMicrotask(() => {
              socket.emit("connect");
              socket.push(frame({ protocolVersion: 1, environment: "managed", supportedOperations: operations }));
            });
            return socket;
          }
        `,
      }));
    },
  };
}
