import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../../cli/scripts/build-transport.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "dist");
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: {
    "build-phase-worker": resolve(root, "src", "build-phase-worker.ts"),
    supervisor: resolve(root, "src", "main.ts"),
    "offline-npm": resolve(root, "src", "offline-npm.ts"),
    "release-runc-smoke": resolve(root, "src", "release-runc-smoke.ts"),
  },
  outdir: outputDirectory,
  plugins: [{ name: "guest-cli-boundary", setup(build) {
    build.onResolve({ filter: /^@lamarck\/cli$/ }, () => {
      throw new Error("Guest programs must not import the CLI business catalog");
    });
  } }],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
});
// An old local output must never be included in a new Guest image.
await rm(resolve(outputDirectory, "lamarck.js"), { force: true });
