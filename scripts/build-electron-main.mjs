import { createHash } from "node:crypto";
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
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
const shellDir = resolve(root, "desktop/shell");
const coreDir = resolve(root, "desktop/core");
const outDir = resolve(shellDir, "dist-electron");
const buildIdentity = await resolveBuildSystemIdentity({ root });
const buildIdentityDefine = systemIdentityEsbuildDefine(buildIdentity);

await mkdir(outDir, { recursive: true });
await rm(resolve(outDir, "scaffolds"), { recursive: true, force: true });
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
  // isomorphic-git's package export otherwise selects its CJS build, whose
  // dynamic requires cannot execute inside Core's ESM bundle.
  alias: {
    "isomorphic-git": resolve(root, "node_modules/isomorphic-git/index.js"),
  },
  banner: {
    js: 'import { createRequire as __lamarckCreateRequire } from "node:module"; const require = __lamarckCreateRequire(import.meta.url);',
  },
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
await cp(
  resolve(coreDir, "scaffolds/app-v1"),
  resolve(outDir, "scaffolds/app-v1"),
  { recursive: true, force: false, errorOnExist: true },
);
await writeMarketplaceTrustRootResource(
  resolve(outDir, "marketplace-trust-roots.json"),
  process.env,
);
await buildDeviceIdentityNative({
  bundleDirectory: outDir,
  nativeRoot: resolve(outDir, "native"),
});

const managedCli = await readFile(resolve(root, "desktop/cli/dist/lamarck-managed.mjs"));
await writeFile(resolve(outDir, "lamarck-managed.mjs"), managedCli, { mode: 0o555 });
await writeFile(resolve(outDir, "managed-cli.json"), `${JSON.stringify({
  type: "cli.artifact", schemaVersion: 1,
  digest: `sha256:${createHash("sha256").update(managedCli).digest("hex")}`,
  bytes: managedCli.byteLength,
})}\n`);
