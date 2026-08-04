import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  buildDeviceIdentityNative,
} from "../desktop/core/src/device-identity/native/build.mjs";
import {
  resolveBuildSystemIdentity,
  systemIdentityEsbuildDefine,
} from "./build-system-identity.mjs";
import { writeMarketplaceTrustRootResource } from "./marketplace-trust-roots.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = resolve(root, "desktop/core");
const outDir = resolve(coreDir, "dist");
const buildIdentity = await resolveBuildSystemIdentity({ root });
await mkdir(outDir, { recursive: true });
await rm(resolve(outDir, "scaffolds"), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  external: ["node:sqlite"],
  define: systemIdentityEsbuildDefine(buildIdentity),
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
  cp(
    resolve(coreDir, "scaffolds/app-v1"),
    resolve(outDir, "scaffolds/app-v1"),
    { recursive: true, force: false, errorOnExist: true },
  ),
  writeMarketplaceTrustRootResource(
    resolve(outDir, "marketplace-trust-roots.json"),
    process.env,
  ),
  buildDeviceIdentityNative({
    bundleDirectory: outDir,
    nativeRoot: resolve(outDir, "native"),
  }),
]);
