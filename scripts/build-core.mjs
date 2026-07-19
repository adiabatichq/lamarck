import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = resolve(root, "desktop/core");
const outDir = resolve(coreDir, "dist");

await mkdir(outDir, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  external: ["node:sqlite"],
};

await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: [resolve(coreDir, "src/index.ts")],
    outfile: resolve(outDir, "core.mjs"),
    format: "esm",
  }),
  esbuild.build({
    ...common,
    entryPoints: [resolve(coreDir, "src/guard-service/entry.ts")],
    outfile: resolve(outDir, "guard-service.cjs"),
    format: "cjs",
  }),
  esbuild.build({
    ...common,
    entryPoints: [resolve(coreDir, "src/connectors/runner-child.ts")],
    outfile: resolve(outDir, "connector-runner.cjs"),
    format: "cjs",
  }),
  esbuild.build({
    ...common,
    entryPoints: [resolve(coreDir, "src/cli.ts")],
    outfile: resolve(outDir, "cli.mjs"),
    format: "esm",
  }),
  cp(resolve(coreDir, "src/pty-helper.cjs"), resolve(outDir, "pty-helper.cjs")),
]);
