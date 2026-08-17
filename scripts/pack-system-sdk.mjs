#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkDirectory = join(root, "desktop", "system-sdk");
const outputDirectory = join(root, ".lamarck", "build", "system-sdk");
const outputPath = join(outputDirectory, "lamarck-system.tgz");
const firstPackDirectory = join(outputDirectory, "pack-1");
const secondPackDirectory = join(outputDirectory, "pack-2");
const verifyRelease = process.argv.includes("--verify-release");
const packageDocument = JSON.parse(await readFile(join(sdkDirectory, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(packageDocument.version)) {
  throw new Error("System SDK releases require a stable canonical SemVer version");
}
if (packageDocument.lamarckSystemProtocol !== 1) {
  throw new Error("System SDK releases must declare System protocol V1 compatibility");
}
const expectedTag = `system-sdk-v${packageDocument.version}`;

if (verifyRelease) {
  const actualTag = process.env.GITHUB_REF_TYPE === "tag"
    ? process.env.GITHUB_REF_NAME
    : undefined;
  if (actualTag !== expectedTag) {
    throw new Error(`SDK release must run from tag ${expectedTag}; received ${actualTag ?? "no tag"}`);
  }
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(firstPackDirectory, { recursive: true });
await mkdir(secondPackDirectory, { recursive: true });
const first = await pack(firstPackDirectory);
const second = await pack(secondPackDirectory);
const firstTarball = await readFile(join(firstPackDirectory, first.filename));
const secondTarball = await readFile(join(secondPackDirectory, second.filename));
if (!firstTarball.equals(secondTarball)) {
  throw new Error("npm pack did not produce reproducible System SDK bytes");
}
const expectedFiles = [
  "LICENSE",
  "README.md",
  "dist/browser.d.ts",
  "dist/browser.js",
  "dist/create-system.d.ts",
  "dist/create-system.js",
  "dist/node-system.d.ts",
  "dist/node-system.js",
  "dist/node-transport.d.ts",
  "dist/node-transport.js",
  "dist/node.d.ts",
  "dist/node.js",
  "dist/protocol.d.ts",
  "dist/protocol.js",
  "dist/vfs-internal.d.ts",
  "dist/vfs-internal.js",
  "package.json",
];
const actualFiles = first.files?.map((entry) => entry.path);
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(`System SDK tarball file set changed: ${JSON.stringify(actualFiles)}`);
}
await rename(join(firstPackDirectory, first.filename), outputPath);
await rm(firstPackDirectory, { recursive: true, force: true });
await rm(secondPackDirectory, { recursive: true, force: true });
const tarball = firstTarball;
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
if (first.integrity !== integrity || second.integrity !== integrity) {
  throw new Error("npm pack integrity does not match the independently computed SHA-512");
}

await verifyConsumer(outputPath);

process.stdout.write(`${outputPath}\n${integrity}\n`);

async function verifyConsumer(tarballPath) {
  const consumer = await mkdtemp(join(tmpdir(), "lamarck-system-consumer-"));
  try {
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({
      private: true,
      type: "module",
    })}\n`);
    await run("npm", [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      tarballPath,
    ], consumer);
    await run(process.execPath, [
      "--input-type=module",
      "--eval",
      `await Promise.all([
        import("@lamarck/system"),
        import("@lamarck/system/browser"),
        import("@lamarck/system/node"),
        import("@lamarck/system/protocol"),
      ]);`,
    ], consumer);
    await writeFile(join(consumer, "index.ts"), `
      import { LAMARCK_SDK_SOCKET_ENV, system, type System } from "@lamarck/system";
      import { system as browserSystem } from "@lamarck/system/browser";
      import { system as nodeSystem } from "@lamarck/system/node";
      import { SYSTEM_OPERATIONS, type SystemOperation } from "@lamarck/system/protocol";
      const systems: readonly System[] = [system, browserSystem, nodeSystem];
      const operation: SystemOperation = SYSTEM_OPERATIONS[0];
      const nodeOnlyRootExport: "LAMARCK_SDK_SOCKET" = LAMARCK_SDK_SOCKET_ENV;
      void systems;
      void operation;
      void nodeOnlyRootExport;
    `);
    await writeFile(join(consumer, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        skipLibCheck: true,
      },
      files: ["index.ts"],
    })}\n`);
    await run(process.execPath, [
      join(root, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      join(consumer, "tsconfig.json"),
    ], consumer);
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

async function pack(destination) {
  const stdout = (await run("npm", [
    "pack",
    "--silent",
    "--json",
    "--pack-destination",
    destination,
  ], sdkDirectory)).trim();
  const result = JSON.parse(stdout);
  if (
    !Array.isArray(result)
    || result.length !== 1
    || typeof result[0]?.filename !== "string"
    || typeof result[0]?.integrity !== "string"
    || !Array.isArray(result[0]?.files)
  ) {
    throw new Error("npm pack did not return one complete package artifact");
  }
  return result[0];
}

async function run(command, args, cwd) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || code !== 0) {
        reject(new Error(`${command} exited with ${signal ?? code}`));
      } else {
        resolveRun(stdout);
      }
    });
  });
}
