import { spawnSync } from "node:child_process";

run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "test:unit"]);
run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "test:guard-engine"]);
run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "test:guard-service"]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
