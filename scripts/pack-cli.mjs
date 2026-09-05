#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliDirectory = join(root, "desktop", "cli");
const outputDirectory = join(root, ".lamarck", "build", "cli");
const outputPath = join(outputDirectory, "lamarck-cli.tgz");
const verifyRelease = process.argv.includes("--verify-release");
const packageDocument = JSON.parse(await readFile(join(cliDirectory, "package.json"), "utf8"));
const EXPECTED_FILES = [
  "LICENSE",
  "README.md",
  "dist/command-registry.d.ts", "dist/command-registry.js",
  "dist/errors.d.ts", "dist/errors.js",
  "dist/host-entry.d.ts", "dist/host-entry.js",
  "dist/host-transport.d.ts", "dist/host-transport.js",
  "dist/index.d.ts", "dist/index.js",
  "dist/lamarck-managed.mjs", "dist/lamarck.mjs",
  "dist/managed-entry.d.ts", "dist/managed-entry.js",
  "dist/managed-transport.d.ts", "dist/managed-transport.js",
  "dist/operations.d.ts", "dist/operations.js",
  "dist/parser.d.ts", "dist/parser.js",
  "dist/protocol.d.ts", "dist/protocol.js",
  "dist/render-human.d.ts", "dist/render-human.js",
  "dist/render-json.d.ts", "dist/render-json.js",
  "dist/runtime.d.ts", "dist/runtime.js",
  "dist/stream.d.ts", "dist/stream.js",
  "dist/wire.d.ts", "dist/wire.js",
  "package.json",
];
if (packageDocument.name !== "@lamarck/cli" || !/^\d+\.\d+\.\d+$/.test(packageDocument.version)) {
  throw new Error("CLI releases require the canonical package name and a stable SemVer version");
}
if (packageDocument.engines?.node !== ">=24.12.0") {
  throw new Error("CLI releases require the declared Node 24 engine floor");
}
const expectedTag = `cli-v${packageDocument.version}`;
if (verifyRelease) {
  const actualTag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  if (actualTag !== expectedTag) throw new Error(`CLI release must run from tag ${expectedTag}; received ${actualTag ?? "no tag"}`);
}

await run(process.execPath, [join(cliDirectory, "scripts", "build.mjs")], root);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
const firstStage = await stagePackage();
const secondStage = await stagePackage();
try {
  const first = await pack(firstStage);
  const second = await pack(secondStage);
  const firstTarball = await readFile(join(firstStage, first.filename));
  const secondTarball = await readFile(join(secondStage, second.filename));
  if (!firstTarball.equals(secondTarball)) throw new Error("npm pack did not produce reproducible CLI bytes");
  const actualFiles = first.files?.map((entry) => entry.path);
  if (JSON.stringify(actualFiles) !== JSON.stringify(EXPECTED_FILES)) {
    throw new Error(`CLI tarball file set changed: ${JSON.stringify(actualFiles)}`);
  }
  await inspectPublishedText(firstStage);
  const integrity = `sha512-${createHash("sha512").update(firstTarball).digest("base64")}`;
  if (first.integrity !== integrity || second.integrity !== integrity) {
    throw new Error("npm pack integrity does not match the independently computed SHA-512");
  }
  await rename(join(firstStage, first.filename), outputPath);
  await verifyConsumer(outputPath);
  process.stdout.write(`${outputPath}\n${integrity}\n`);
} finally {
  await rm(firstStage, { recursive: true, force: true });
  await rm(secondStage, { recursive: true, force: true });
}

async function stagePackage() {
  const stage = await mkdtemp(join(tmpdir(), "lamarck-cli-pack-"));
  await Promise.all([
    cp(join(cliDirectory, "dist"), join(stage, "dist"), { recursive: true }),
    cp(join(cliDirectory, "LICENSE"), join(stage, "LICENSE")),
    cp(join(cliDirectory, "README.md"), join(stage, "README.md")),
    cp(join(cliDirectory, "package.json"), join(stage, "package.json")),
  ]);
  return stage;
}

async function pack(stage) {
  const stdout = (await run("npm", ["pack", "--ignore-scripts", "--silent", "--json", "--pack-destination", stage], stage)).trim();
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0]?.filename !== "string"
    || typeof result[0]?.integrity !== "string" || !Array.isArray(result[0]?.files)) {
    throw new Error("npm pack did not return one complete CLI artifact");
  }
  return result[0];
}

async function inspectPublishedText(stage) {
  for (const path of EXPECTED_FILES) {
    if (!/\.(?:js|mjs|json|d\.ts|md)$/.test(path)) continue;
    const text = await readFile(join(stage, path), "utf8");
    if (text.includes(root) || text.includes("LAMARCK_CORE_TOKEN") || text.includes("sourceMappingURL=")) {
      throw new Error(`CLI published file contains private build material: ${path}`);
    }
  }
}

async function verifyConsumer(tarballPath) {
  const consumer = await mkdtemp(join(tmpdir(), "lamarck-cli-consumer-"));
  let server;
  try {
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
    await run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--no-save", tarballPath], consumer);
    const cli = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "lamarck.cmd" : "lamarck");
    const help = await runCaptured(cli, ["--help"], consumer, cleanEnvironment(consumer, "stopped"));
    if (!help.stdout.includes("lamarck app list") || help.stdout.includes("lamarck app refresh")) {
      throw new Error("Clean consumer received an invalid Host help surface");
    }
    const stopped = await runCaptured(cli, ["app", "list"], consumer, cleanEnvironment(consumer, "stopped"), true);
    if (stopped.code !== 1 || stopped.stdout !== "" || stopped.stderr !== "Lamarck is not running.\n") {
      throw new Error("Clean consumer stopped-Desktop behavior changed");
    }

    const cliModule = await import(pathToFileURL(join(cliDirectory, "dist", "index.js")).href);
    const operations = cliModule.HOST_CLI_OPERATIONS;
    const requests = [];
    server = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${"t".repeat(43)}`) {
        response.writeHead(401).end(); return;
      }
      if (request.url === "/cli/v1/hello") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ protocolVersion: 1, environment: "host", supportedOperations: operations }));
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const controlBytes = body.readUInt32BE(0);
      const value = cliModule.parseCliFrame(body.subarray(4, 4 + controlBytes));
      requests.push(value);
      response.setHeader("Content-Type", "application/octet-stream");
      response.end(cliModule.encodeCliHttpResponse(value.operation, {
        requestId: value.requestId,
        ok: true,
        result: [{ id: "fixture" }],
      }));
    });
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture gateway did not bind");
    const environment = cleanEnvironment(consumer, "running");
    const descriptorDirectory = runtimeDirectory(environment);
    await mkdir(descriptorDirectory, { recursive: true, mode: 0o700 });
    await chmod(descriptorDirectory, 0o700);
    await writeFile(join(descriptorDirectory, "runtime.json"), JSON.stringify({
      port: address.port,
      token: "t".repeat(43),
    }), { mode: 0o600 });
    const connected = await runCaptured(cli, ["app", "list", "--json"], consumer, environment);
    if (JSON.stringify(JSON.parse(connected.stdout)) !== JSON.stringify([{ id: "fixture" }])
      || requests.length !== 1 || requests[0].operation !== "app.list") {
      throw new Error("Clean consumer fixture gateway handshake failed");
    }
  } finally {
    if (server?.listening) await new Promise((resolveClose) => server.close(resolveClose));
    await rm(consumer, { recursive: true, force: true });
  }
}

function cleanEnvironment(consumer, suffix) {
  const home = join(consumer, `home-${suffix}`);
  return { ...process.env, HOME: home, ...(process.platform === "linux" ? { XDG_RUNTIME_DIR: join(home, "runtime") } : {}) };
}

function runtimeDirectory(environment) {
  if (process.platform === "darwin") return join(environment.HOME, "Library", "Application Support", "Lamarck", "cli");
  if (process.platform === "win32") return join(environment.LOCALAPPDATA ?? join(environment.HOME, "AppData", "Local"), "Lamarck", "cli");
  return join(environment.XDG_RUNTIME_DIR ?? join(environment.HOME, ".local", "run"), "lamarck", "cli");
}

async function run(command, args, cwd) {
  const environment = command === "npm"
    ? { ...process.env, npm_config_cache: join(tmpdir(), "lamarck-cli-npm-cache") }
    : process.env;
  const result = await runCaptured(command, args, cwd, environment, true);
  if (result.code !== 0) throw new Error(`${command} exited with ${result.code}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function runCaptured(command, args, cwd, environment, allowFailure = false) {
  return await new Promise((resolveRun, reject) => {
    const env = { ...environment, PATH: `${dirname(process.execPath)}:${environment.PATH ?? ""}` };
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || (!allowFailure && code !== 0)) reject(new Error(`${command} exited with ${signal ?? code}: ${stderr}`));
      else resolveRun({ code, stdout, stderr });
    });
  });
}
