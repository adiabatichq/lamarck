#!/usr/bin/env node

// Portable, non-privileged source verification. Native hardware, Docker Guest
// boot, signing, notarization, and publication remain explicit release gates.

import { spawnSync } from "node:child_process";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assertSupportedNode();
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
const env = {
  ...process.env,
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
};

const gates = [
  ["Toolchain alignment", ["run", "verify:toolchain"]],
  ["Repository module boundaries", ["run", "verify:module-boundaries"]],
  ["System SDK consumer alignment", ["run", "verify:system-sdk-consumers"]],
  ["System SDK consumer sync tests", ["run", "test:system-sdk-consumer-sync"]],
  ["R2 object store tests", ["run", "test:r2-object-store"]],
  ["Desktop production build", ["run", "build"]],
  ["Core typecheck", ["--workspace", "@lamarck/core", "run", "typecheck"]],
  ["Core tests", ["--workspace", "@lamarck/core", "run", "test"]],
  ["Shell tests", ["--workspace", "@lamarck/shell", "run", "test"]],
  ["System SDK typecheck", ["--workspace", "@lamarck/system", "run", "typecheck"]],
  ["System SDK tests", ["--workspace", "@lamarck/system", "run", "test"]],
  ["Capsule typecheck", ["--workspace", "@lamarck/capsule", "run", "typecheck"]],
  ["Capsule tests", ["--workspace", "@lamarck/capsule", "run", "test"]],
  ["Capsule Guest typecheck", ["--workspace", "@lamarck/capsule-guest", "run", "typecheck"]],
  ["Capsule Guest tests", ["--workspace", "@lamarck/capsule-guest", "run", "test"]],
  ["macOS release contract tests", ["run", "package:macos:test"]],
];

for (const [label, args] of gates) {
  console.log(`\n[verify] ${label}`);
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\n[verify] All portable source gates passed");

function assertSupportedNode() {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 12)) {
    throw new Error(`Lamarck verification requires Node 24.12+ (current: ${process.version})`);
  }
}
