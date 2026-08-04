#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const [snapshotValue, exportValue] = process.argv.slice(2);
if (!snapshotValue || !exportValue || process.argv.length !== 4) {
  throw new Error("usage: build-macos-release-shell-inside.mjs <snapshot> <export>");
}
if (process.version !== "v24.18.0") throw new Error("macOS release builder requires Node v24.18.0");

const snapshot = resolve(snapshotValue);
const exportRoot = resolve(exportValue);
const source = "/work/source";
const home = "/work/home";
const npmCache = "/work/npm-cache";
const npmCli = "/usr/local/lib/node_modules/npm/bin/npm-cli.js";
const builderImageId = process.env.LAMARCK_BUILDER_IMAGE_ID;
if (!/^sha256:[a-f0-9]{64}$/.test(builderImageId ?? "")) {
  throw new Error("macOS release builder image identity is missing");
}
const buildVersion = process.env.LAMARCK_BUILD_VERSION;
const buildCommit = process.env.LAMARCK_BUILD_COMMIT;
if (
  typeof buildVersion !== "string"
  || buildVersion.length < 1
  || buildVersion.trim() !== buildVersion
  || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(buildCommit ?? "")
) {
  throw new Error("macOS release System identity is missing or malformed");
}

await assertEmptyDirectory(exportRoot);
await mkdir(home, { recursive: false, mode: 0o700 });
await mkdir(npmCache, { recursive: false, mode: 0o700 });
await cp(snapshot, source, {
  recursive: true,
  force: false,
  errorOnExist: true,
  preserveTimestamps: true,
});
await makeTreeWritable(source);

const environment = {
  HOME: home,
  PATH: "/usr/local/bin:/usr/bin:/bin",
  npm_config_userconfig: "/dev/null",
  npm_config_cache: npmCache,
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_registry: "https://registry.npmjs.org",
  LAMARCK_BUILD_VERSION: buildVersion,
  LAMARCK_BUILD_COMMIT: buildCommit,
  LAMARCK_MARKETPLACE_SIGNING_KEY_ID: process.env.LAMARCK_MARKETPLACE_SIGNING_KEY_ID,
  LAMARCK_MARKETPLACE_SIGNING_PUBLIC_KEY: process.env.LAMARCK_MARKETPLACE_SIGNING_PUBLIC_KEY,
};
run(process.execPath, [npmCli, "ci",
  "--workspace", "@lamarck/shell",
  "--workspace", "@lamarck/system",
  "--workspace", "@lamarck/core",
  "--include-workspace-root=true",
  "--ignore-scripts",
  "--audit=false",
  "--fund=false",
  "--update-notifier=false",
  "--registry=https://registry.npmjs.org",
  `--cache=${npmCache}`,
  "--userconfig=/dev/null",
], { cwd: source, env: environment });

const npmPackage = JSON.parse(await readFile("/usr/local/lib/node_modules/npm/package.json", "utf8"));
if (npmPackage.version !== "11.16.0") throw new Error("macOS release builder requires npm 11.16.0");

const lock = JSON.parse(await readFile(join(source, "package-lock.json"), "utf8"));
const toolSpecs = {
  vite: {
    packageName: "vite",
    version: "6.4.1",
    packagePath: "node_modules/vite/package.json",
    entryPath: "node_modules/vite/bin/vite.js",
  },
  typescript: {
    packageName: "typescript",
    version: "5.9.3",
    packagePath: "node_modules/typescript/package.json",
    entryPath: "node_modules/typescript/bin/tsc",
  },
  esbuild: {
    packageName: "esbuild",
    version: "0.25.12",
    packagePath: "node_modules/esbuild/package.json",
    entryPath: "node_modules/@esbuild/linux-arm64/bin/esbuild",
  },
  osxSign: {
    packageName: "@electron/osx-sign",
    version: "2.4.0",
    packagePath: "node_modules/@electron/osx-sign/package.json",
    entryPath: "node_modules/@electron/osx-sign/dist/index.js",
  },
  nodePty: {
    packageName: "node-pty",
    version: "1.1.0",
    packagePath: "node_modules/node-pty/package.json",
    entryPath: "node_modules/node-pty/lib/index.js",
  },
  nodeAddonApi: {
    packageName: "node-addon-api",
    version: "7.1.1",
    packagePath: "node_modules/node-addon-api/package.json",
    entryPath: "node_modules/node-addon-api/index.js",
  },
};
const tools = {};
for (const [name, spec] of Object.entries(toolSpecs)) {
  const lockEntry = lock.packages?.[`node_modules/${spec.packageName}`];
  const packagePath = join(source, spec.packagePath);
  const packageValue = JSON.parse(await readFile(packagePath, "utf8"));
  if (
    lock.lockfileVersion !== 3
    || packageValue.version !== spec.version
    || lockEntry?.version !== spec.version
    || typeof lockEntry.resolved !== "string"
    || !lockEntry.resolved.startsWith("https://registry.npmjs.org/")
    || typeof lockEntry.integrity !== "string"
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(lockEntry.integrity)
  ) throw new Error(`macOS release ${name} does not match the exact package lock identity`);
  tools[name] = {
    version: spec.version,
    resolved: lockEntry.resolved,
    integrity: lockEntry.integrity,
    packageJsonSha256: `sha256:${await sha256File(packagePath)}`,
    entrySha256: `sha256:${await sha256File(join(source, spec.entryPath))}`,
  };
}

run(process.execPath, [
  join(source, "scripts/build-desktop.mjs"),
  "--source-root",
  source,
], {
  cwd: source,
  env: environment,
});

await copyOutputTree(join(source, "desktop/shell/dist"), join(exportRoot, "dist"));
await copyOutputTree(
  join(source, "desktop/shell/dist-electron"),
  join(exportRoot, "dist-electron"),
);
await exportHostToolClosure(source, "@electron/osx-sign", join(exportRoot, "host-tools"));
await exportNodePtyRuntime(source, join(exportRoot, "runtime-dependencies"));
const outputs = await describeOutputTrees(
  exportRoot,
  ["dist", "dist-electron", "host-tools", "runtime-dependencies"],
);
const sourceManifestPath = join(snapshot, "macos-release-source-v1.json");
const inventory = {
  schemaVersion: 1,
  sourceManifestDigest: `sha256:${await sha256File(sourceManifestPath)}`,
  packageLockSha256: `sha256:${await sha256File(join(snapshot, "package-lock.json"))}`,
  builderImageId,
  runtime: {
    nodeVersion: process.version,
    nodeExecutableSha256: `sha256:${await sha256File(process.execPath)}`,
    npmVersion: npmPackage.version,
    npmCliSha256: `sha256:${await sha256File(npmCli)}`,
  },
  tools,
  outputs,
};
await writeFile(
  join(exportRoot, "builder-inventory.json"),
  `${JSON.stringify(inventory)}\n`,
  { encoding: "utf8", mode: 0o400, flag: "wx" },
);

async function copyOutputTree(sourcePath, destinationPath, options = {}) {
  const details = await lstat(sourcePath);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`macOS release build output is not a real directory: ${sourcePath}`);
  }
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  await mkdir(destinationPath, { mode: 0o700 });
  const entries = await readdir(sourcePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (options.omitDirectNodeModules && entry.name === "node_modules") continue;
    const from = join(sourcePath, entry.name);
    const to = join(destinationPath, entry.name);
    const sourceDetails = await lstat(from);
    if (sourceDetails.isSymbolicLink()) throw new Error(`macOS release build output contains link: ${from}`);
    if (sourceDetails.isDirectory()) await copyOutputTree(from, to);
    else if (sourceDetails.isFile()) {
      if (sourceDetails.nlink !== 1 || sourceDetails.size > 64 * 1024 * 1024) {
        throw new Error(`macOS release build output is not a bounded single-link file: ${from}`);
      }
      await copyStableOutputFile(
        from,
        to,
        (sourceDetails.mode & 0o111) === 0 ? 0o644 : 0o755,
      );
    } else throw new Error(`macOS release build output contains special file: ${from}`);
  }
}

async function exportHostToolClosure(sourceRoot, rootPackageName, destinationRoot) {
  const installedRoot = join(sourceRoot, "node_modules");
  const queue = [findInstalledPackage(installedRoot, sourceRoot, rootPackageName)];
  const visited = new Set();
  while (queue.length > 0) {
    const packageRoot = queue.shift();
    const relativePath = packageRoot.slice(`${installedRoot}/`.length);
    if (
      packageRoot === installedRoot
      || packageRoot.startsWith(`${installedRoot}/`) === false
      || relativePath.includes("../")
    ) throw new Error("Host signing tool dependency escaped clean node_modules");
    if (visited.has(packageRoot)) continue;
    visited.add(packageRoot);
    const packageValue = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (typeof packageValue.name !== "string" || typeof packageValue.version !== "string") {
      throw new Error("Host signing tool dependency has an invalid package identity");
    }
    await copyOutputTree(
      packageRoot,
      join(destinationRoot, "node_modules", relativePath),
      { omitDirectNodeModules: true },
    );
    const dependencyNames = Object.keys({
      ...(packageValue.dependencies ?? {}),
      ...(packageValue.optionalDependencies ?? {}),
    }).sort((left, right) => left.localeCompare(right, "en"));
    for (const dependencyName of dependencyNames) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(dependencyName)) {
        throw new Error(`Host signing tool has an invalid dependency name ${dependencyName}`);
      }
      queue.push(findInstalledPackage(installedRoot, packageRoot, dependencyName));
    }
  }
}

async function exportNodePtyRuntime(sourceRoot, destinationRoot) {
  const installedRoot = join(sourceRoot, "node_modules");
  const packageRoot = findInstalledPackage(installedRoot, sourceRoot, "node-pty");
  const packageValue = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (
    packageValue.name !== "node-pty"
    || packageValue.version !== "1.1.0"
    || JSON.stringify(packageValue.dependencies) !== JSON.stringify({
      "node-addon-api": "^7.1.0",
    })
  ) throw new Error("clean node-pty package has an unexpected runtime dependency contract");

  const destination = join(destinationRoot, "node_modules", "node-pty");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of ["LICENSE", "package.json"]) {
    await copyStableOutputFile(join(packageRoot, name), join(destination, name), 0o644);
  }
  await copyOutputTree(join(packageRoot, "lib"), join(destination, "lib"));
  const prebuildDestination = join(destination, "prebuilds", "darwin-arm64");
  await mkdir(prebuildDestination, { recursive: true, mode: 0o700 });
  await copyStableOutputFile(
    join(packageRoot, "prebuilds", "darwin-arm64", "pty.node"),
    join(prebuildDestination, "pty.node"),
    0o644,
  );
  await copyStableOutputFile(
    join(packageRoot, "prebuilds", "darwin-arm64", "spawn-helper"),
    join(prebuildDestination, "spawn-helper"),
    0o755,
  );
  await exportHostToolClosure(sourceRoot, "node-addon-api", destinationRoot);
}

function findInstalledPackage(installedRoot, fromPath, packageName) {
  let current = fromPath;
  while (current === installedRoot || current.startsWith(`${installedRoot}/`)) {
    const candidate = join(current, "node_modules", ...packageName.split("/"));
    try {
      const details = lstatSync(candidate);
      if (details.isDirectory() && !details.isSymbolicLink()) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (current === installedRoot) break;
    current = dirname(current);
  }
  const rootCandidate = join(installedRoot, ...packageName.split("/"));
  try {
    const details = lstatSync(rootCandidate);
    if (details.isDirectory() && !details.isSymbolicLink()) return rootCandidate;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  throw new Error(`Host signing tool dependency ${packageName} is absent from the clean install`);
}

async function copyStableOutputFile(sourcePath, destinationPath, mode) {
  const sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationHandle;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 64n * 1024n * 1024n) {
      throw new Error(`macOS release build output is not a bounded single-link file: ${sourcePath}`);
    }
    destinationHandle = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, Number(before.size) - offset),
        offset,
      );
      if (bytesRead < 1) throw new Error(`macOS release build output ended during copy: ${sourcePath}`);
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          offset + written,
        );
        if (result.bytesWritten < 1) throw new Error("macOS release output copy made no progress");
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await destinationHandle.sync();
    await destinationHandle.chmod(mode);
    await destinationHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error(`macOS release build output changed during copy: ${sourcePath}`);
  } finally {
    await destinationHandle?.close();
    await sourceHandle.close();
  }
}

async function describeOutputTrees(root, directories) {
  const paths = [];
  for (const directory of directories) await collectFiles(root, directory, paths);
  paths.sort((left, right) => left.localeCompare(right, "en"));
  return await Promise.all(paths.map(async (relativePath) => {
    const path = join(root, relativePath);
    const details = await lstat(path);
    return {
      path: relativePath,
      size: details.size,
      mode: details.mode & 0o777,
      sha256: `sha256:${await sha256File(path)}`,
    };
  }));
}

async function collectFiles(root, relativeDirectory, result) {
  const entries = await readdir(join(root, relativeDirectory), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) await collectFiles(root, relativePath, result);
    else if (entry.isFile()) result.push(relativePath);
    else throw new Error(`macOS release build output contains unsupported entry ${relativePath}`);
  }
}

async function makeTreeWritable(root) {
  // Normalize the private work copy before npm creates build output in it.
  await chmod(root, 0o700);
  const visitWritable = async (directory) => {
    await chmod(directory, 0o700);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visitWritable(path);
      else if (entry.isFile()) await chmod(path, (await lstat(path)).mode & 0o111 ? 0o500 : 0o400);
      else throw new Error(`macOS release source copy contains unsupported entry: ${path}`);
    }
  };
  await visitWritable(root);
}

async function assertEmptyDirectory(path) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || (await readdir(path)).length !== 0) {
    throw new Error("macOS release build export must be an empty real directory");
  }
}

async function sha256File(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 256n * 1024n * 1024n) {
      throw new Error(`${path} is not a bounded single-link regular file`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error(`${path} changed while it was hashed`);
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    await handle.close();
  }
}

function run(command, args, { cwd, env }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}
