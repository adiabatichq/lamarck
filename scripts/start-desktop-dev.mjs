#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { buildDesktopHost } from "./build-desktop.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shellDir = join(root, "desktop", "shell");
await buildDesktopHost({ root });

const server = await createServer({
  root: shellDir,
  configFile: join(shellDir, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});

let electron;
const signalHandlers = new Map();
try {
  await server.listen();
  server.printUrls();

  const require = createRequire(import.meta.url);
  const electronPath = require("electron");
  const env = { ...process.env, NODE_ENV: "development" };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(electronPath, [shellDir], {
    cwd: root,
    env,
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (electron.exitCode === null && electron.signalCode === null) electron.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  const [code] = await Promise.race([
    once(electron, "exit"),
    once(electron, "error").then(([error]) => Promise.reject(error)),
  ]);
  process.exitCode = typeof code === "number" ? code : 1;
} finally {
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  if (electron && electron.exitCode === null && electron.signalCode === null) electron.kill("SIGKILL");
  await server.close();
}
