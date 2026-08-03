import { cp, mkdir } from "node:fs/promises";
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shellDir = resolve(root, "desktop/shell");
const coreDir = resolve(root, "desktop/core");
const outDir = resolve(shellDir, "dist-electron");
const buildIdentity = await resolveBuildSystemIdentity({ root });
const buildIdentityDefine = systemIdentityEsbuildDefine(buildIdentity);

await mkdir(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [resolve(shellDir, "electron/main.ts")],
  outfile: resolve(outDir, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  define: buildIdentityDefine,
});
await esbuild.build({
  entryPoints: [resolve(coreDir, "src/guard-service/entry.ts")],
  outfile: resolve(outDir, "guard-service.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["node:sqlite"],
  define: buildIdentityDefine,
});
await esbuild.build({
  entryPoints: [resolve(coreDir, "src/index.ts")],
  outfile: resolve(outDir, "core.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["node:sqlite"],
  define: buildIdentityDefine,
});
await esbuild.build({
  entryPoints: [resolve(coreDir, "src/connectors/runner-child.ts")],
  outfile: resolve(outDir, "connector-runner.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  define: buildIdentityDefine,
});
await esbuild.build({
  entryPoints: [resolve(shellDir, "electron/app-preload.ts")],
  outfile: resolve(outDir, "app-preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  define: buildIdentityDefine,
});
await cp(resolve(shellDir, "electron/preload.cjs"), resolve(outDir, "preload.cjs"));
await cp(resolve(coreDir, "src/pty-helper.cjs"), resolve(outDir, "pty-helper.cjs"));
await buildDeviceIdentityNative({
  bundleDirectory: outDir,
  nativeRoot: resolve(outDir, "native"),
});
