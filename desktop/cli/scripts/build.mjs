import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliRoot = join(root, "desktop", "cli");
const dist = join(cliRoot, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const tsc = spawnSync(process.execPath, [
  join(root, "node_modules", "typescript", "bin", "tsc"),
  "-p",
  join(cliRoot, "tsconfig.build.json"),
], { cwd: root, stdio: "inherit" });
if (tsc.error) throw tsc.error;
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
};
await Promise.all([
  build({
    ...common,
    entryPoints: [join(cliRoot, "src", "host-entry.ts")],
    outfile: join(dist, "lamarck.mjs"),
    banner: { js: "#!/usr/bin/env node" },
  }),
  build({
    ...common,
    entryPoints: [join(cliRoot, "src", "managed-entry.ts")],
    outfile: join(dist, "lamarck-managed.mjs"),
    banner: { js: "#!/usr/bin/env node" },
  }),
]);
await cp(join(root, "LICENSE"), join(cliRoot, "LICENSE"));
