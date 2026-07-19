import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "dist");
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: {
    supervisor: resolve(root, "src", "main.ts"),
    "offline-npm": resolve(root, "src", "offline-npm.ts"),
    "release-runc-smoke": resolve(root, "src", "release-runc-smoke.ts"),
  },
  outdir: outputDirectory,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
});
