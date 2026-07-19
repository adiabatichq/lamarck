#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import {
  rewritePackageLockForBroker,
  validateDependencyBundle,
} from "./dependency-bundle";

const lockPath = process.argv[2];
const manifestPath = process.argv[3];
if (!lockPath || !manifestPath || !lockPath.startsWith("/workspace/") || manifestPath !== "/dependencies/manifest.json") {
  throw new Error("lamarck-offline-npm requires the fixed workspace lock and dependency manifest paths");
}

const dependencyRoot = dirname(manifestPath);
const originalLock = await readFile(lockPath);
const packagePath = "/workspace/package.json";
const originalPackage = await readFile(packagePath);
const originalDigest = createHash("sha256").update(originalLock).digest("hex");
const originalPackageDigest = createHash("sha256").update(originalPackage).digest("hex");
const manifest = await validateDependencyBundle(dependencyRoot);
const entryByPath = new Map<string, (typeof manifest.entries)[number]>(
  manifest.entries.map((entry) => [`/${entry.file}`, entry]),
);
const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", Connection: "close" });
    response.end();
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(request.url ?? "", "http://127.0.0.1");
  } catch {
    response.writeHead(400, { Connection: "close" });
    response.end();
    return;
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    response.writeHead(404, { Connection: "close" });
    response.end();
    return;
  }
  const entry = entryByPath.get(parsed.pathname);
  if (!entry) {
    response.writeHead(404, { Connection: "close" });
    response.end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(entry.bytes),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const source = createReadStream(`${dependencyRoot}/${entry.file}`);
  source.once("error", () => response.destroy());
  source.pipe(response);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("offline npm broker did not bind TCP");
const origin = `http://127.0.0.1:${address.port}`;

let npmExit = 255;
try {
  const lockValue = JSON.parse(originalLock.toString("utf8")) as unknown;
  const rewritten = rewritePackageLockForBroker(lockValue, manifest, origin);
  await atomicWrite(lockPath, Buffer.from(`${JSON.stringify(rewritten.lock, null, 2)}\n`, "utf8"));
  npmExit = await runNpm(origin);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await atomicWrite(lockPath, originalLock);
  await atomicWrite(packagePath, originalPackage);
  const restored = await readFile(lockPath);
  const restoredDigest = createHash("sha256").update(restored).digest("hex");
  if (restoredDigest !== originalDigest || !restored.equals(originalLock)) {
    throw new Error("offline npm wrapper failed to restore the exact original package-lock bytes");
  }
  const restoredPackage = await readFile(packagePath);
  const restoredPackageDigest = createHash("sha256").update(restoredPackage).digest("hex");
  if (restoredPackageDigest !== originalPackageDigest || !restoredPackage.equals(originalPackage)) {
    throw new Error("offline npm wrapper failed to restore the exact original package.json bytes");
  }
}
process.exitCode = npmExit;

async function runNpm(origin: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/usr/local/bin/npm", [
      "ci",
      "--audit=false",
      "--fund=false",
      "--ignore-scripts=false",
      "--update-notifier=false",
    ], {
      cwd: "/workspace",
      env: {
        AR: "/usr/bin/ar",
        CC: "/usr/bin/cc",
        CXX: "/usr/bin/c++",
        HOME: "/home/build",
        LANG: "C.UTF-8",
        LD_LIBRARY_PATH: "/opt/lamarck/toolchain/lib",
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_CACHE: "/home/build/.npm",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_REGISTRY: `${origin}/blocked/`,
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        PKG_CONFIG_LIBDIR: [
          "/opt/lamarck/toolchain/aarch64-buildroot-linux-gnu/sysroot/usr/lib/pkgconfig",
          "/opt/lamarck/toolchain/aarch64-buildroot-linux-gnu/sysroot/usr/share/pkgconfig",
        ].join(":"),
        PKG_CONFIG_SYSROOT_DIR: "/opt/lamarck/toolchain/aarch64-buildroot-linux-gnu/sysroot",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        PYTHON: "/usr/bin/python3",
        TMPDIR: "/tmp",
        npm_config_nodedir: "/usr/local",
        npm_config_python: "/usr/bin/python3",
      },
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal === null ? code ?? 255 : 128));
  });
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.lamarck-${process.pid}`;
  await rm(temporary, { force: true });
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
