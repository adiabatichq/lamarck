import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const NODE_PTY_SMOKE_SOURCE = String.raw`
const { realpathSync, writeSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");

const [appResourcesValue, expectedPlatform, expectedArchitecture] = process.argv.slice(1);
const appResources = realpathSync(appResourcesValue);
if (process.platform !== expectedPlatform || process.arch !== expectedArchitecture) {
  throw new Error(
    "packaged node-pty smoke runtime identity mismatch: "
      + process.platform + "/" + process.arch,
  );
}

const loader = createRequire(join(appResources, "dist-electron", "pty-helper.cjs"));
const expectedEntry = realpathSync(join(
  appResources,
  "node_modules", "node-pty", "lib", "index.js",
));
const expectedPackage = realpathSync(join(
  appResources,
  "node_modules", "node-pty", "package.json",
));
const resolvedEntry = realpathSync(loader.resolve("node-pty"));
const resolvedPackage = realpathSync(loader.resolve("node-pty/package.json"));
if (resolvedEntry !== expectedEntry || resolvedPackage !== expectedPackage) {
  throw new Error("node-pty resolved outside the exact packaged runtime closure");
}

const pty = loader("node-pty");
if (
  typeof pty.spawn !== "function"
  || typeof pty.open !== "function"
  || typeof pty.native !== "object"
  || pty.native === null
  || typeof pty.native.fork !== "function"
  || typeof pty.native.open !== "function"
) throw new Error("packaged node-pty did not load its native runtime API");

const expectedOutput = "lamarck-pty-spawn-ok";
const startMarker = "lamarck-pty-start";
const exitMarker = "lamarck-pty-exit";
let output = "";
let sentExitMarker = false;
let settled = false;
const terminal = pty.spawn("/bin/sh", [
  "-c",
  'IFS= read -r marker; [ "$marker" = lamarck-pty-start ] || exit 9; '
    + 'printf lamarck-pty-spawn-ok; '
    + 'IFS= read -r marker; [ "$marker" = lamarck-pty-exit ] || exit 10',
], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: appResources,
  env: {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TERM: "xterm-256color",
  },
});
let timeout;
let dataSubscription;
let exitSubscription;

const dispose = () => {
  if (timeout) clearTimeout(timeout);
  dataSubscription?.dispose?.();
  exitSubscription?.dispose?.();
};
const fail = (message) => {
  if (settled) return;
  settled = true;
  dispose();
  try { terminal.kill(); } catch {}
  try { writeSync(2, message + "\n"); } catch {}
  process.exit(1);
};

dataSubscription = terminal.onData((data) => {
  output += data;
  if (Buffer.byteLength(output, "utf8") > 1_024) {
    fail("packaged node-pty fixed-command smoke exceeded its output limit");
    return;
  }
  if (!sentExitMarker && output.includes(expectedOutput)) {
    sentExitMarker = true;
    terminal.write(exitMarker + "\r");
  }
});
exitSubscription = terminal.onExit(({ exitCode, signal }) => {
  if (exitCode !== 0 || (signal !== 0 && signal !== null && signal !== undefined)) {
    fail(
      "packaged node-pty fixed-command smoke did not exit cleanly: "
        + exitCode + "/" + signal,
    );
    return;
  }
  if (!sentExitMarker || !output.includes(expectedOutput)) {
    fail("packaged node-pty fixed-command smoke returned unexpected output");
    return;
  }
  if (settled) return;
  settled = true;
  dispose();
  writeSync(1, JSON.stringify({
    ok: true,
    platform: process.platform,
    architecture: process.arch,
    modulesAbi: process.versions.modules,
    napi: process.versions.napi,
    spawnedFixedCommand: true,
  }));
  process.exit(0);
});
timeout = setTimeout(() => {
  fail("packaged node-pty fixed-command smoke timed out");
}, 5_000);
terminal.write(startMarker + "\r");
`;

/**
 * Resolve and load node-pty from the packaged Resources/app closure in a fresh
 * runtime process. Production passes Electron with ELECTRON_RUN_AS_NODE=1, so
 * this checks the exact ABI that will execute pty-helper.cjs without allowing
 * NODE_PATH or ancestor node_modules fallback.
 */
export function runPackagedNodePtySmoke(appResourcesValue, options = {}) {
  const appResources = requireRealDirectory(appResourcesValue, "packaged app resources");
  const executable = requireRealFile(
    options.executable ?? process.execPath,
    "packaged node-pty smoke executable",
  );
  requireRealFile(
    join(appResources, "dist-electron", "pty-helper.cjs"),
    "packaged PTY helper",
  );
  requireRealFile(
    join(appResources, "node_modules", "node-pty", "package.json"),
    "packaged node-pty package.json",
  );
  requireRealFile(
    join(appResources, "node_modules", "node-pty", "lib", "index.js"),
    "packaged node-pty entrypoint",
  );

  const expectedPlatform = options.expectedPlatform ?? process.platform;
  const expectedArchitecture = options.expectedArchitecture ?? process.arch;
  if (!/^[a-z0-9_-]{1,32}$/.test(expectedPlatform)) {
    throw new Error("packaged node-pty smoke expected platform is invalid");
  }
  if (!/^[a-z0-9_-]{1,32}$/.test(expectedArchitecture)) {
    throw new Error("packaged node-pty smoke expected architecture is invalid");
  }

  const result = spawnSync(executable, [
    "-e",
    NODE_PTY_SMOKE_SOURCE,
    appResources,
    expectedPlatform,
    expectedArchitecture,
  ], {
    cwd: appResources,
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      HOME: process.env.HOME ?? appResources,
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    const diagnostic = result.stderr.trim();
    throw new Error(
      `packaged node-pty smoke process failed (${result.error.code ?? "unknown"})`
        + `${diagnostic ? `: ${diagnostic}` : ""}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `packaged node-pty smoke exited with ${result.status ?? result.signal}: ${result.stderr.trim()}`,
    );
  }

  let evidence;
  try {
    evidence = JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error("packaged node-pty smoke did not return exact JSON evidence", { cause });
  }
  if (
    Object.keys(evidence).sort().join(",")
      !== "architecture,modulesAbi,napi,ok,platform,spawnedFixedCommand"
    || evidence.ok !== true
    || evidence.platform !== expectedPlatform
    || evidence.architecture !== expectedArchitecture
    || evidence.spawnedFixedCommand !== true
    || !/^\d+$/.test(evidence.modulesAbi)
    || !/^\d+$/.test(evidence.napi)
  ) throw new Error("packaged node-pty smoke returned invalid runtime evidence");
  return Object.freeze(evidence);
}

function requireRealDirectory(pathValue, label) {
  const path = realpathSync(resolve(pathValue));
  const details = lstatSync(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
  return path;
}

function requireRealFile(pathValue, label) {
  const path = realpathSync(resolve(pathValue));
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1) {
    throw new Error(`${label} is not a nonempty regular file`);
  }
  return path;
}
