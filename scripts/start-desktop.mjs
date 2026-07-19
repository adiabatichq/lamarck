#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDesktop } from "./build-desktop.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await buildDesktop({ root });

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const env = { ...process.env, NODE_ENV: "production" };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(electronPath, [join(root, "desktop", "shell")], {
  cwd: root,
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
