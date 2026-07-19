import { spawnSync } from "node:child_process";
import { resolveNode24Runtime } from "./node24-runtime.mjs";

const runtime = resolveNode24Runtime();
const result = spawnSync(runtime.command, ["--test", "test-node/guard-service.node.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    LAMARCK_GUARD_TEST_DIRECT: "1",
    ...runtime.env,
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
