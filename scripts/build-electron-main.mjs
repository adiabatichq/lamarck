import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shellDir = resolve(root, "desktop/shell");
const coreDir = resolve(root, "desktop/core");
const outDir = resolve(shellDir, "dist-electron");

await mkdir(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [resolve(shellDir, "electron/main.ts")],
  outfile: resolve(outDir, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});
await esbuild.build({
  entryPoints: [resolve(coreDir, "src/guard-service/entry.ts")],
  outfile: resolve(outDir, "guard-service.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["node:sqlite"],
});
await esbuild.build({
  entryPoints: [resolve(coreDir, "src/index.ts")],
  outfile: resolve(outDir, "core.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["node:sqlite"],
});
await esbuild.build({
  entryPoints: [resolve(coreDir, "src/connectors/runner-child.ts")],
  outfile: resolve(outDir, "connector-runner.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
});
await esbuild.build({
  entryPoints: [resolve(shellDir, "electron/app-preload.ts")],
  outfile: resolve(outDir, "app-preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});
await cp(resolve(shellDir, "electron/preload.cjs"), resolve(outDir, "preload.cjs"));
await cp(resolve(coreDir, "src/pty-helper.cjs"), resolve(outDir, "pty-helper.cjs"));
