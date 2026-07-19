import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNode24Runtime } from "./node24-runtime.mjs";

const require = createRequire(import.meta.url);
const runtime = resolveNode24Runtime();
const vitestEntry = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const filters = process.argv.slice(2);
const result = spawnSync(runtime.command, [
  vitestEntry,
  "run",
  ...(filters.length ? filters : ["test"]),
  "--maxWorkers=1",
  "--no-file-parallelism",
], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    LAMARCK_CONNECTOR_RUNNER_ENTRY: fileURLToPath(new URL("../dist/connector-runner.cjs", import.meta.url)),
    LAMARCK_TEST_NODE_BIN: process.execPath,
    ...runtime.env,
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
