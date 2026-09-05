#!/usr/bin/env node

// Canonical Desktop production build.
//
// Local builds and the hermetic macOS release builder call this same recipe.
// Distribution-only work (native staging, signing, notarization, packaging,
// and publication) deliberately remains outside it.

import { spawnSync } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deviceIdentityNativeAddonPath,
} from "../desktop/core/src/device-identity/native/resource-path.mjs";
import {
  deviceIdentityNativeRequired,
} from "../desktop/core/src/device-identity/native/build.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");

const GENERATED_HOST_PATHS = [
  "main.cjs",
  "guard-service.cjs",
  "core.mjs",
  "connector-runner.cjs",
  "preload.cjs",
  "app-preload.cjs",
  "pty-helper.cjs",
  "marketplace-trust-roots.json",
];
const APP_SCAFFOLD_FILES = [
  "index.html",
  "index.tsx",
  "main.tsx",
  "package-lock.json",
  "package.json",
  "vite.config.ts",
];

export async function buildDesktop(options = {}) {
  const context = buildContext(options);
  buildCli(context);
  await cleanHostOutputs(context);
  await rm(join(context.shellDir, "dist"), { recursive: true, force: true });
  buildSystemSdk(context);
  runNode(
    context,
    join(context.root, "node_modules", "vite", "bin", "vite.js"),
    ["build"],
    context.shellDir,
    "Vite production renderer",
  );
  buildElectronHost(context);
  await verifyOutputs(context, [
    join(context.shellDir, "dist", "index.html"),
    ...hostOutputPaths(context),
  ]);
}

export async function buildDesktopHost(options = {}) {
  const context = buildContext(options);
  buildCli(context);
  await cleanHostOutputs(context);
  buildSystemSdk(context);
  buildElectronHost(context);
  await verifyOutputs(context, hostOutputPaths(context));
}

function buildContext(options) {
  assertSupportedNode();
  const root = resolve(options.root ?? defaultRoot);
  return {
    root,
    cliDir: join(root, "desktop", "cli"),
    shellDir: join(root, "desktop", "shell"),
    systemSdkDir: join(root, "desktop", "system-sdk"),
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
  };
}

async function cleanHostOutputs(context) {
  await rm(join(context.systemSdkDir, "dist"), { recursive: true, force: true });
  await rm(join(context.shellDir, "dist-electron", "system-sdk"), {
    recursive: true,
    force: true,
  });
  await rm(join(context.shellDir, "dist-electron", "scaffolds"), {
    recursive: true,
    force: true,
  });
  await Promise.all(GENERATED_HOST_PATHS.map((name) =>
    rm(join(context.shellDir, "dist-electron", name), { force: true })
  ));
  // Do not remove dist-electron/native: it may contain a separately staged,
  // verified Capsule helper and Guest release used by local production runs.
}

function buildCli(context) {
  runNode(
    context,
    join(context.cliDir, "scripts", "build.mjs"),
    [],
    context.root,
    "Public CLI prerequisite",
  );
}

function buildSystemSdk(context) {
  runNode(
    context,
    join(context.root, "node_modules", "typescript", "bin", "tsc"),
    ["-p", join(context.systemSdkDir, "tsconfig.json")],
    context.root,
    "System SDK",
  );
}

function buildElectronHost(context) {
  runNode(
    context,
    join(context.root, "scripts", "build-electron-main.mjs"),
    [],
    context.root,
    "Electron/Core host bundles",
  );
}

function hostOutputPaths(context) {
  const outputRoot = join(context.shellDir, "dist-electron");
  return [
    ...GENERATED_HOST_PATHS.map((name) => join(outputRoot, name)),
    ...APP_SCAFFOLD_FILES.map((name) => join(outputRoot, "scaffolds", "app-v1", name)),
    ...(deviceIdentityNativeRequired(context.platform)
      ? [deviceIdentityNativeAddonPath(join(outputRoot, "native"))]
      : []),
  ];
}

function runNode(context, entry, args, cwd, label) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env: context.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with ${result.status ?? result.signal ?? "unknown status"}`);
  }
}

async function verifyOutputs(context, outputs) {
  for (const output of outputs) {
    const details = await stat(output);
    if (!details.isFile() || details.size < 1) {
      throw new Error(`Desktop build did not produce a non-empty regular file: ${output}`);
    }
  }
  console.log(`[desktop-build] Production outputs verified under ${context.shellDir}`);
}

function assertSupportedNode() {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 12)) {
    throw new Error(`Lamarck Desktop requires Node 24.12+ (current: ${process.version})`);
  }
}

function parseCliOptions(argv) {
  const options = { hostOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--host-only") {
      options.hostOnly = true;
      continue;
    }
    if (argument === "--source-root" && argv[index + 1]) {
      options.root = argv[++index];
      continue;
    }
    throw new Error("usage: build-desktop.mjs [--host-only] [--source-root <path>]");
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.hostOnly) await buildDesktopHost(options);
  else await buildDesktop(options);
}
