#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDocument = JSON.parse(await readFile(join(root, "desktop", "cli", "package.json"), "utf8"));
const tarball = await readFile(join(root, ".lamarck", "build", "cli", "lamarck-cli.tgz"));
const expectedIntegrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
const expectedTarball = `https://registry.npmjs.org/@lamarck/cli/-/cli-${packageDocument.version}.tgz`;
const metadataUrl = `https://registry.npmjs.org/@lamarck%2fcli/${packageDocument.version}`;
const wait = process.argv.includes("--wait");
const attempts = wait ? 13 : 1;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const response = await fetch(metadataUrl, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) {
    if (attempt < attempts) { await new Promise((resolveWait) => setTimeout(resolveWait, 5_000)); continue; }
    await setOutput("published", "false");
    if (wait) throw new Error(`@lamarck/cli@${packageDocument.version} was not visible after publication`);
    process.stdout.write(`@lamarck/cli@${packageDocument.version} is not published\n`);
    process.exit(0);
  }
  if (!response.ok) throw new Error(`npm registry metadata request failed with ${response.status}`);
  const metadata = await response.json();
  if (metadata?.name !== "@lamarck/cli" || metadata?.version !== packageDocument.version
    || metadata?.dist?.integrity !== expectedIntegrity || metadata?.dist?.tarball !== expectedTarball) {
    throw new Error(`npm registry contains different immutable bytes for @lamarck/cli@${packageDocument.version}`);
  }
  const artifactResponse = await fetch(metadata.dist.tarball, {
    headers: { Accept: "application/octet-stream" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!artifactResponse.ok || artifactResponse.status !== 200 || !artifactResponse.body) {
    throw new Error(`npm registry tarball request failed with ${artifactResponse.status}`);
  }
  const registryTarball = await readBoundedTarball(artifactResponse.body, tarball.byteLength);
  const registryIntegrity = `sha512-${createHash("sha512").update(registryTarball).digest("base64")}`;
  if (registryIntegrity !== metadata.dist.integrity) {
    throw new Error(`downloaded @lamarck/cli@${packageDocument.version} bytes do not match registry integrity`);
  }
  if (!registryTarball.equals(tarball)) {
    throw new Error(`downloaded @lamarck/cli@${packageDocument.version} differs from the pre-publish release artifact`);
  }
  await verifyDownloadedConsumer(registryTarball);
  await setOutput("published", "true");
  process.stdout.write(`@lamarck/cli@${packageDocument.version} registry tarball matches ${expectedIntegrity} and passed a clean-consumer help smoke test\n`);
  process.exit(0);
}

async function readBoundedTarball(stream, expectedBytes) {
  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > expectedBytes) {
        await reader.cancel("registry tarball exceeded the release artifact size").catch(() => {});
        throw new Error("npm registry tarball is larger than the pre-publish release artifact");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedBytes) {
    throw new Error("npm registry tarball size differs from the pre-publish release artifact");
  }
  return Buffer.concat(chunks, total);
}

async function verifyDownloadedConsumer(bytes) {
  const consumer = await mkdtemp(join(tmpdir(), "lamarck-cli-registry-consumer-"));
  try {
    const downloadedTarball = join(consumer, "lamarck-cli-registry.tgz");
    await Promise.all([
      writeFile(join(consumer, "package.json"), `${JSON.stringify({ private: true })}\n`),
      writeFile(downloadedTarball, bytes),
    ]);
    const environment = {
      ...process.env,
      npm_config_cache: join(consumer, "npm-cache"),
    };
    await run("npm", [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      downloadedTarball,
    ], consumer, environment);
    const cli = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "lamarck.cmd" : "lamarck");
    const result = await run(cli, ["--help"], consumer, environment);
    if (!result.stdout.includes("lamarck app list") || result.stdout.includes("lamarck app refresh")) {
      throw new Error("downloaded npm artifact exposed an invalid Host CLI help surface");
    }
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

async function run(command, args, cwd, environment) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...environment, PATH: `${dirname(process.execPath)}:${environment.PATH ?? ""}` },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal !== null || code !== 0) {
        rejectRun(new Error(`${command} exited with ${signal ?? code}: ${stderr || stdout}`));
      } else {
        resolveRun({ stdout, stderr });
      }
    });
  });
}

async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}
