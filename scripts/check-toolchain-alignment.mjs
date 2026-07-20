#!/usr/bin/env node

// Verifies that every copy of the pinned Node toolchain agrees, and that the
// pin matches the Node runtime Electron embeds. The pin is written into the
// CI workflows and the hermetic macOS release contracts, while Electron
// carries the runtime the shipped desktop actually runs; letting these drift
// apart is how a Node 24.12-only sqlite API reached a CI toolchain pinned at
// 24.10 undetected.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_NODE = "24.18.0";
const PINNED_NPM = "11.16.0";
const ENGINES_FLOOR = ">=24.12.0";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

// CI workflows must pin exactly the canonical toolchain. Zero matches means
// the workflows no longer look like this gate expects, which must fail rather
// than silently pass.
const workflowDir = join(root, ".github", "workflows");
let workflowPinMatches = 0;
for (const name of readdirSync(workflowDir)) {
  const text = readFileSync(join(workflowDir, name), "utf8");
  for (const [, version] of text.matchAll(/node-version:\s*"([^"]+)"/g)) {
    workflowPinMatches += 1;
    check(version === PINNED_NODE, `${name}: node-version ${version} is not ${PINNED_NODE}`);
  }
  for (const [, version] of text.matchAll(/node --version\)" = "v([^"]+)"/g)) {
    workflowPinMatches += 1;
    check(version === PINNED_NODE, `${name}: node assert v${version} is not v${PINNED_NODE}`);
  }
  for (const [, version] of text.matchAll(/npm --version\)" = "([^"]+)"/g)) {
    workflowPinMatches += 1;
    check(version === PINNED_NPM, `${name}: npm assert ${version} is not ${PINNED_NPM}`);
  }
}
check(workflowPinMatches >= 3, "workflow toolchain pins were not found; update this gate's patterns");

// The hermetic macOS release contracts must pin the same toolchain.
for (const relative of ["scripts/macos-release-source.mjs", "scripts/build-macos-release-shell-inside.mjs"]) {
  const text = readFileSync(join(root, relative), "utf8");
  check(text.includes(`"v${PINNED_NODE}"`), `${relative} does not pin Node v${PINNED_NODE}`);
  check(text.includes(`"${PINNED_NPM}"`), `${relative} does not pin npm ${PINNED_NPM}`);
}

// package.json toolchain metadata must agree with the pin and the floor.
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
check(
  rootPackage.packageManager === `npm@${PINNED_NPM}`,
  `package.json packageManager ${rootPackage.packageManager} is not npm@${PINNED_NPM}`,
);
for (const workspace of [".", ...rootPackage.workspaces]) {
  const manifest = JSON.parse(readFileSync(join(root, workspace, "package.json"), "utf8"));
  check(
    manifest.engines?.node === ENGINES_FLOOR,
    `${workspace}: engines.node ${manifest.engines?.node ?? "(missing)"} is not ${ENGINES_FLOOR}`,
  );
}

// Electron must embed exactly the pinned Node runtime. Electron writes
// path.txt beside its package only after its install script has fetched the
// binary; requiring the package instead would trigger a download attempt.
// Environments that block dependency scripts still verify every static pin
// above.
const electronDir = join(root, "node_modules", "electron");
const pathFile = join(electronDir, "path.txt");
const electronBinary = existsSync(pathFile)
  ? join(electronDir, "dist", readFileSync(pathFile, "utf8").trim())
  : null;
if (electronBinary && existsSync(electronBinary)) {
  const embedded = execFileSync(electronBinary, ["-p", "process.versions.node"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  }).trim();
  check(embedded === PINNED_NODE, `Electron embeds Node ${embedded}; the toolchain pin is ${PINNED_NODE}`);
  if (embedded === PINNED_NODE) {
    console.log(`[toolchain] Electron-embedded Node ${embedded} matches the pinned toolchain`);
  }
} else {
  console.log("[toolchain] Electron binary is not installed; skipped the embedded-runtime comparison");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[toolchain] ${failure}`);
  process.exit(1);
}
console.log(`[toolchain] All pins agree on Node ${PINNED_NODE} / npm ${PINNED_NPM} (floor ${ENGINES_FLOOR})`);
