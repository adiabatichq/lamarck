#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const guest = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "lvr-"));
const hostControl = join(root, "hc.sock");
const hostData = join(root, "hd.sock");
const guestControl = join(root, "gc.sock");
const guestData = join(root, "gd.sock");
const executable = join(root, "relay");
try {
  const compiler = process.env.CC || "cc";
  const compile = spawnSync(compiler, [
    "-O2",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-DLAMARCK_TEST_HOST_CONTROL_SOCKET=\"${hostControl}\"`,
    `-DLAMARCK_TEST_HOST_DATA_SOCKET=\"${hostData}\"`,
    `-DLAMARCK_GUEST_CONTROL_SOCKET=\"${guestControl}\"`,
    `-DLAMARCK_GUEST_DATA_SOCKET=\"${guestData}\"`,
    "-o",
    executable,
    join(guest, "native", "vsock-relay.c"),
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) throw new Error(`vsock relay compile failed:\n${compile.stderr}`);

  try {
    await testRelayIntegration(executable);
  } catch (error) {
    if (error?.code !== "EPERM" || process.env.LAMARCK_NATIVE_HELPER_REQUIRE_INTEGRATION === "1") {
      throw error;
    }
    process.stderr.write("native relay integration skipped: execution sandbox forbids local sockets\n");
  }

  const invalid = spawnSync(executable, ["bogus"], { encoding: "utf8" });
  assert(invalid.status === 2, "relay accepted an unknown mode");

  const netSource = await readFile(join(guest, "native", "net-helper.c"), "utf8");
  assert(netSource.includes("key[0] == 'a' || key[0] == 'b'"), "net helper does not admit only App/Build namespace prefixes");
  assert(netSource.includes("request.ifr_flags |= IFF_UP"), "net helper does not bring loopback up");
  if (process.platform === "linux") {
    const netCompile = spawnSync(compiler, [
      "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsyntax-only",
      join(guest, "native", "net-helper.c"),
    ], { encoding: "utf8" });
    if (netCompile.error) throw netCompile.error;
    if (netCompile.status !== 0) throw new Error(`net helper compile failed:\n${netCompile.stderr}`);
  }
  process.stdout.write("native helper tests passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

function listen(server, path) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });
}

async function testRelayIntegration(executablePath) {
  let guestConnections = 0;
  const guestSocketPromise = deferred();
  const guestServer = createServer((socket) => {
    guestConnections += 1;
    guestSocketPromise.resolve(socket);
  });
  await listen(guestServer, guestData);

  const relay = spawn(executablePath, ["data"], { stdio: ["ignore", "pipe", "pipe"] });
  const relayExit = childExit(relay);
  const diagnostics = [];
  relay.stderr.on("data", (chunk) => diagnostics.push(Buffer.from(chunk)));
  await delay(150);
  assert(guestConnections === 0, "relay attached Guest UDS before the Host listener existed");

  const hostSocketPromise = deferred();
  const hostServer = createServer((socket) => hostSocketPromise.resolve(socket));
  await listen(hostServer, hostData);
  const [hostSocket, guestSocket] = await Promise.all([
    bounded(hostSocketPromise.promise, 3_000, "Host relay connection"),
    bounded(guestSocketPromise.promise, 3_000, "Guest relay connection"),
  ]);
  await waitFor(() => Buffer.concat(diagnostics).toString("utf8").startsWith("READY\n"), 3_000);

  const fromHost = onceData(guestSocket);
  hostSocket.write("host-to-guest");
  assert((await bounded(fromHost, 3_000, "Host-to-Guest relay")).toString() === "host-to-guest", "Host-to-Guest bytes changed");
  const fromGuest = onceData(hostSocket);
  guestSocket.write("guest-to-host");
  assert((await bounded(fromGuest, 3_000, "Guest-to-Host relay")).toString() === "guest-to-host", "Guest-to-Host bytes changed");
  hostSocket.end();
  guestSocket.end();
  const exit = await bounded(relayExit, 3_000, "relay exit");
  assert(exit.code === 0 && exit.signal === null, `relay exited unexpectedly: ${JSON.stringify(exit)}`);
  await closeServer(hostServer);
  await closeServer(guestServer);
}

function closeServer(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

function childExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

function onceData(socket) {
  return new Promise((resolvePromise, reject) => {
    socket.once("data", resolvePromise);
    socket.once("error", reject);
  });
}

function deferred() {
  let resolvePromise;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("condition was not reached before timeout");
}

function bounded(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)),
  ]);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
