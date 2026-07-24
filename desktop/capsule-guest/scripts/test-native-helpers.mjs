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
const RELAY_MAGIC = Buffer.from("LVRM", "ascii");
const RELAY_VERSION = 2;
const RELAY_KIND_DATA = 1;
const RELAY_KIND_FIN = 2;
const RELAY_KIND_RESET = 3;
const RELAY_KIND_CLOSE = 4;
const RELAY_HEADER_BYTES = 12;
const RELAY_DATA_BYTES = 64 * 1024;
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

  testRelayLiteralFrames();
  try {
    await testRelayProtocol(executable);
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
  assert(netSource.includes("GET / HTTP/1.1"), "net helper readiness does not probe the viewer protocol");
  assert(netSource.includes("response[index - 3] == '\\r'"), "net helper readiness does not require complete HTTP headers");
  assert(netSource.includes("signal(SIGPIPE, SIG_IGN)"), "net helper readiness can terminate on a transient peer reset");
  assert(netSource.includes("SOCK_NONBLOCK"), "net helper readiness connect can exceed its absolute deadline");
  assert(netSource.includes("bounded_deadline"), "net helper readiness attempts are not bounded by the global deadline");
  if (process.platform === "linux") {
    const netCompile = spawnSync(compiler, [
      "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsyntax-only",
      join(guest, "native", "net-helper.c"),
    ], { encoding: "utf8" });
    if (netCompile.error) throw netCompile.error;
    if (netCompile.status !== 0) throw new Error(`net helper compile failed:\n${netCompile.stderr}`);

    const netStatusExecutable = join(root, "net-status-test");
    const netStatusCompile = spawnSync(compiler, [
      "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-o", netStatusExecutable,
      join(guest, "native", "net-helper-status-test.c"),
    ], { encoding: "utf8" });
    if (netStatusCompile.error) throw netStatusCompile.error;
    if (netStatusCompile.status !== 0) {
      throw new Error(`net helper status test compile failed:\n${netStatusCompile.stderr}`);
    }
    const netStatus = spawnSync(netStatusExecutable, [], { encoding: "utf8" });
    if (netStatus.error) throw netStatus.error;
    if (netStatus.status !== 0) {
      throw new Error(`net helper status test failed with status ${netStatus.status}`);
    }
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

function testRelayLiteralFrames() {
  assert(
    encodeRelayFrame(RELAY_KIND_DATA, Buffer.from("A")).toString("hex")
      === "4c56524d000200010000000141",
    "relay DATA literal frame changed",
  );
  assert(
    encodeRelayFrame(RELAY_KIND_FIN).toString("hex")
      === "4c56524d0002000200000000",
    "relay FIN literal frame changed",
  );
  assert(
    encodeRelayFrame(RELAY_KIND_RESET).toString("hex")
      === "4c56524d0002000300000000",
    "relay RESET literal frame changed",
  );
  assert(
    encodeRelayFrame(RELAY_KIND_CLOSE).toString("hex")
      === "4c56524d0002000400000000",
    "relay CLOSE literal frame changed",
  );
}

async function testRelayProtocol(executablePath) {
  await testRelayIntegration(executablePath);
  await testRelayPrematurePhysicalEof(executablePath);
  await testRelayDestroyedSocket(executablePath);
  await testRelayMalformedFrames(executablePath);
  await testRelayFinResetRaces(executablePath);
}

async function testRelayIntegration(executablePath) {
  const harness = await openRelay(executablePath);
  const { relay, relayExit, hostSocket, guestSocket } = harness;
  const hostReader = createRelayFrameReader(hostSocket);
  const guestReader = createRelayFrameReader(guestSocket);
  const hostReadableEnd = waitForReadableEnd(hostSocket);
  const guestReadableEnd = waitForReadableEnd(guestSocket);
  try {
    const hostMessage = Buffer.from("host-to-guest");
    const hostFrame = encodeRelayFrame(RELAY_KIND_DATA, hostMessage);
    const localWire = collectRawBytes(guestSocket, hostFrame.byteLength);
    await writeFragmented(
      hostSocket,
      hostFrame,
      [1, 2, 3, 1, 5, 2],
    );
    assert((await bounded(localWire, 3_000, "fragmented Host DATA wire")).equals(hostFrame),
      "Host-to-Guest relay did not preserve the exact validated DATA frame");
    const firstHostFrame = await bounded(guestReader.next(), 3_000, "Guest-local DATA frame");
    assert(firstHostFrame.kind === RELAY_KIND_DATA,
      "Guest-local Host DATA used the wrong frame kind");
    assert(firstHostFrame.payload.equals(hostMessage),
      "Guest-local Host DATA changed payload bytes");

    const guestMessage = Buffer.from("guest-to-host");
    const guestFrame = encodeRelayFrame(RELAY_KIND_DATA, guestMessage);
    const hostWire = collectRawBytes(hostSocket, guestFrame.byteLength);
    await writeFragmented(
      guestSocket,
      guestFrame,
      [3, 1, 4, 2],
    );
    assert((await bounded(hostWire, 3_000, "fragmented Guest DATA wire")).equals(guestFrame),
      "Guest-to-Host relay did not preserve the exact validated DATA frame");
    const firstGuestFrame = await bounded(hostReader.next(), 3_000, "Guest DATA frame");
    assert(firstGuestFrame.kind === RELAY_KIND_DATA, "Guest DATA used the wrong frame kind");
    assert(firstGuestFrame.payload.equals(guestMessage),
      "Guest-to-Host framed relay changed bytes");

    // More than three complete LVRM windows prove the relay continues to make
    // progress with only one bounded 64-KiB record buffered per direction.
    const hostBulk = patternedBytes(3 * 256 * 1024 + 61_003, 0xa5);
    const hostBulkResult = collectFramedDataUntilFin(guestReader, "Host bulk FIN");
    for (let offset = 0; offset < hostBulk.byteLength; offset += RELAY_DATA_BYTES) {
      await writeSocket(
        hostSocket,
        encodeRelayFrame(
          RELAY_KIND_DATA,
          hostBulk.subarray(offset, Math.min(offset + RELAY_DATA_BYTES, hostBulk.byteLength)),
        ),
      );
    }
    await writeFragmented(hostSocket, encodeRelayFrame(RELAY_KIND_FIN), [1, 1, 2, 3]);
    assert(
      (await bounded(hostBulkResult, 10_000, "multi-window Host DATA")).equals(hostBulk),
      "multi-window Host-to-Guest framed relay changed bytes",
    );
    assert(!guestSocket.readableEnded,
      "Host FIN was exposed as ambiguous Guest-local EOF instead of an LVRM FIN");
    assert(relay.exitCode === null, "relay exited after only the Host direction reached FIN");

    // The opposite framed Guest direction remains independently usable after
    // the Host FIN record has reached its peer.
    const guestBulk = patternedBytes(3 * 256 * 1024 + 63_177, 0x5a);
    const guestBulkResult = collectFramedDataUntilFin(hostReader, "Guest bulk FIN");
    for (let offset = 0; offset < guestBulk.byteLength; offset += RELAY_DATA_BYTES) {
      await writeSocket(
        guestSocket,
        encodeRelayFrame(
          RELAY_KIND_DATA,
          guestBulk.subarray(offset, Math.min(offset + RELAY_DATA_BYTES, guestBulk.byteLength)),
        ),
      );
    }
    await writeFragmented(guestSocket, encodeRelayFrame(RELAY_KIND_FIN), [2, 1, 4, 1]);
    assert(
      (await bounded(guestBulkResult, 10_000, "multi-window Guest DATA")).equals(guestBulk),
      "multi-window Guest-to-Host relay changed bytes",
    );

    // FIN only closes one logical DATA direction. Successful transport teardown
    // requires an explicit CLOSE from each endpoint after both FINs crossed.
    await writeFragmented(hostSocket, encodeRelayFrame(RELAY_KIND_CLOSE), [1, 2, 1]);
    const hostClose = await bounded(guestReader.next(), 3_000, "Host CLOSE");
    assert(hostClose.kind === RELAY_KIND_CLOSE && hostClose.payload.byteLength === 0,
      "Host CLOSE did not cross as an exact empty LVRM record");
    assert(relay.exitCode === null, "relay exited after only one CLOSE record");

    await writeFragmented(guestSocket, encodeRelayFrame(RELAY_KIND_CLOSE), [2, 3, 1]);
    const guestClose = await bounded(hostReader.next(), 3_000, "Guest CLOSE");
    assert(guestClose.kind === RELAY_KIND_CLOSE && guestClose.payload.byteLength === 0,
      "Guest CLOSE did not cross as an exact empty LVRM record");
    const exit = await bounded(relayExit, 3_000, "normal framed relay exit");
    assert(exit.code === 0 && exit.signal === null,
      `framed relay exited unexpectedly: ${JSON.stringify(exit)}`);
    await Promise.all([
      bounded(hostReadableEnd, 3_000, "Host EOF after two CLOSE records"),
      bounded(guestReadableEnd, 3_000, "Guest EOF after two CLOSE records"),
    ]);
  } finally {
    await harness.close();
  }
}

async function testRelayPrematurePhysicalEof(executablePath) {
  for (const sourceName of ["Host", "Guest"]) {
    const harness = await openRelay(executablePath);
    const source = sourceName === "Host" ? harness.hostSocket : harness.guestSocket;
    const destinationReader = createRelayFrameReader(
      sourceName === "Host" ? harness.guestSocket : harness.hostSocket,
    );
    try {
      source.end();
      const reset = await bounded(
        destinationReader.next(),
        3_000,
        `${sourceName} physical EOF RESET`,
      );
      assert(reset.kind === RELAY_KIND_RESET && reset.payload.byteLength === 0,
        `${sourceName} physical EOF did not produce explicit RESET`);
      const exit = await bounded(
        harness.relayExit,
        3_000,
        `${sourceName} physical EOF exit`,
      );
      assert(exit.code === 114 && exit.signal === null,
        `relay treated ${sourceName} physical EOF as normal: ${JSON.stringify(exit)}`);
    } finally {
      await harness.close();
    }
  }

  // EOF in the middle of either header or payload is likewise explicit
  // failure, never an inferred FIN.
  for (const sourceName of ["Host", "Guest"]) {
    const harness = await openRelay(executablePath);
    const source = sourceName === "Host" ? harness.hostSocket : harness.guestSocket;
    const destinationReader = createRelayFrameReader(
      sourceName === "Host" ? harness.guestSocket : harness.hostSocket,
    );
    try {
      const partial = encodeRelayFrame(
        RELAY_KIND_DATA,
        Buffer.from("truncated-payload"),
      ).subarray(0, RELAY_HEADER_BYTES + 3);
      source.end(partial);
      const reset = await bounded(
        destinationReader.next(),
        3_000,
        `${sourceName} partial frame RESET`,
      );
      assert(reset.kind === RELAY_KIND_RESET,
        `${sourceName} partial frame EOF did not produce RESET`);
      const exit = await bounded(
        harness.relayExit,
        3_000,
        `${sourceName} partial frame EOF exit`,
      );
      assert(exit.code === 114 && exit.signal === null,
        `${sourceName} partial frame EOF did not fail the relay`);
    } finally {
      await harness.close();
    }
  }
}

async function testRelayDestroyedSocket(executablePath) {
  for (const sourceName of ["Host", "Guest"]) {
    const harness = await openRelay(executablePath);
    const source = sourceName === "Host" ? harness.hostSocket : harness.guestSocket;
    const destinationReader = createRelayFrameReader(
      sourceName === "Host" ? harness.guestSocket : harness.hostSocket,
    );
    try {
      source.destroy();
      const reset = await bounded(
        destinationReader.next(),
        3_000,
        `${sourceName} destroy RESET`,
      );
      assert(reset.kind === RELAY_KIND_RESET,
        `${sourceName} destroy did not produce explicit RESET`);
      const exit = await bounded(
        harness.relayExit,
        3_000,
        `${sourceName} destroy exit`,
      );
      assert(exit.code === 114 && exit.signal === null,
        `${sourceName} destroy did not fail the relay`);
    } finally {
      await harness.close();
    }
  }
}

async function testRelayMalformedFrames(executablePath) {
  const malformed = [
    Buffer.from("0056524d0002000200000000", "hex"),
    Buffer.from("4c56524d0001000200000000", "hex"),
    Buffer.from("4c56524d0002000100000000", "hex"),
    Buffer.from("4c56524d0002000200000001ff", "hex"),
    Buffer.from("4c56524d0002000300000001ff", "hex"),
    Buffer.from("4c56524d0002000400000001ff", "hex"),
    Buffer.from("4c56524d0002000500000000", "hex"),
    Buffer.from("4c56524d0002000100010001", "hex"),
  ];

  for (const sourceName of ["Host", "Guest"]) {
    for (let index = 0; index < malformed.length; index += 1) {
      const harness = await openRelay(executablePath);
      const source = sourceName === "Host" ? harness.hostSocket : harness.guestSocket;
      const destinationReader = createRelayFrameReader(
        sourceName === "Host" ? harness.guestSocket : harness.hostSocket,
      );
      try {
        await writeFragmented(source, malformed[index], index === 0 ? [1] : [3, 2, 5]);
        const reset = await bounded(
          destinationReader.next(),
          3_000,
          `${sourceName} malformed frame ${index} RESET`,
        );
        assert(reset.kind === RELAY_KIND_RESET && reset.payload.byteLength === 0,
          `${sourceName} malformed frame ${index} did not produce RESET`);
        const exit = await bounded(
          harness.relayExit,
          3_000,
          `${sourceName} malformed frame ${index} exit`,
        );
        assert(exit.code === 114 && exit.signal === null,
          `${sourceName} malformed frame ${index} was not terminal`);
      } finally {
        await harness.close();
      }
    }
  }

  const violations = [
    {
      label: "duplicate FIN",
      bytes: Buffer.concat([
        encodeRelayFrame(RELAY_KIND_FIN),
        encodeRelayFrame(RELAY_KIND_FIN),
      ]),
      prefixKinds: [RELAY_KIND_FIN],
    },
    {
      label: "DATA after FIN",
      bytes: Buffer.concat([
        encodeRelayFrame(RELAY_KIND_FIN),
        encodeRelayFrame(RELAY_KIND_DATA, Buffer.from("late")),
      ]),
      prefixKinds: [RELAY_KIND_FIN],
    },
    {
      label: "CLOSE before FIN",
      bytes: encodeRelayFrame(RELAY_KIND_CLOSE),
      prefixKinds: [],
    },
    {
      label: "CLOSE before opposite FIN",
      bytes: Buffer.concat([
        encodeRelayFrame(RELAY_KIND_FIN),
        encodeRelayFrame(RELAY_KIND_CLOSE),
      ]),
      prefixKinds: [RELAY_KIND_FIN],
    },
  ];
  for (const sourceName of ["Host", "Guest"]) {
    for (const violation of violations) {
      await expectProtocolViolation(
        executablePath,
        sourceName,
        violation.label,
        violation.bytes,
        violation.prefixKinds,
      );
    }
    await expectPostCloseViolation(
      executablePath,
      sourceName,
      "duplicate CLOSE",
      RELAY_KIND_CLOSE,
    );
    await expectPostCloseViolation(
      executablePath,
      sourceName,
      "RESET after CLOSE",
      RELAY_KIND_RESET,
    );
  }
}

async function testRelayFinResetRaces(executablePath) {
  for (const sourceName of ["Host", "Guest"]) {
    const harness = await openRelay(executablePath);
    const source = sourceName === "Host" ? harness.hostSocket : harness.guestSocket;
    const destinationReader = createRelayFrameReader(
      sourceName === "Host" ? harness.guestSocket : harness.hostSocket,
    );
    try {
      const beforeFin = Buffer.from(`${sourceName}-before-fin-reset`);
      await writeFragmented(
        source,
        Buffer.concat([
          encodeRelayFrame(RELAY_KIND_DATA, beforeFin),
          encodeRelayFrame(RELAY_KIND_FIN),
          encodeRelayFrame(RELAY_KIND_RESET),
        ]),
        [2, 1, 3, 5],
      );
      const data = await bounded(
        destinationReader.next(),
        3_000,
        `${sourceName} DATA before FIN→RESET`,
      );
      assert(data.kind === RELAY_KIND_DATA && data.payload.equals(beforeFin),
        `${sourceName} DATA before FIN→RESET changed`);
      const fin = await bounded(
        destinationReader.next(),
        3_000,
        `${sourceName} FIN before RESET`,
      );
      assert(fin.kind === RELAY_KIND_FIN,
        `${sourceName} FIN→RESET did not forward FIN first`);
      const reset = await bounded(
        destinationReader.next(),
        3_000,
        `${sourceName} RESET after FIN`,
      );
      assert(reset.kind === RELAY_KIND_RESET && reset.payload.byteLength === 0,
        `${sourceName} FIN→RESET race lost explicit RESET`);
      const exit = await bounded(
        harness.relayExit,
        3_000,
        `${sourceName} FIN→RESET exit`,
      );
      assert(exit.code === 114 && exit.signal === null,
        `${sourceName} FIN→RESET was treated as normal`);
    } finally {
      await harness.close();
    }
  }
}

async function expectProtocolViolation(
  executablePath,
  sourceName,
  label,
  bytes,
  prefixKinds,
) {
  const harness = await openRelay(executablePath);
  const source = sourceName === "Host" ? harness.hostSocket : harness.guestSocket;
  const destinationReader = createRelayFrameReader(
    sourceName === "Host" ? harness.guestSocket : harness.hostSocket,
  );
  try {
    await writeFragmented(source, bytes, [1, 4, 2, 7]);
    for (const expectedKind of prefixKinds) {
      const frame = await bounded(
        destinationReader.next(),
        3_000,
        `${sourceName} ${label} prefix`,
      );
      assert(frame.kind === expectedKind,
        `${sourceName} ${label} did not preserve its valid prefix`);
    }
    const reset = await bounded(
      destinationReader.next(),
      3_000,
      `${sourceName} ${label} RESET`,
    );
    assert(reset.kind === RELAY_KIND_RESET && reset.payload.byteLength === 0,
      `${sourceName} ${label} did not produce RESET`);
    const exit = await bounded(
      harness.relayExit,
      3_000,
      `${sourceName} ${label} exit`,
    );
    assert(exit.code === 114 && exit.signal === null,
      `${sourceName} ${label} did not fail the relay`);
  } finally {
    await harness.close();
  }
}

async function expectPostCloseViolation(
  executablePath,
  sourceName,
  label,
  trailingKind,
) {
  const harness = await openRelay(executablePath);
  const hostReader = createRelayFrameReader(harness.hostSocket);
  const guestReader = createRelayFrameReader(harness.guestSocket);
  try {
    await writeSocket(harness.hostSocket, encodeRelayFrame(RELAY_KIND_FIN));
    assert((await bounded(guestReader.next(), 3_000, "Host FIN setup")).kind
      === RELAY_KIND_FIN, "Host FIN setup did not cross");
    await writeSocket(harness.guestSocket, encodeRelayFrame(RELAY_KIND_FIN));
    assert((await bounded(hostReader.next(), 3_000, "Guest FIN setup")).kind
      === RELAY_KIND_FIN, "Guest FIN setup did not cross");

    const source = sourceName === "Host" ? harness.hostSocket : harness.guestSocket;
    const destinationReader = sourceName === "Host" ? guestReader : hostReader;
    await writeSocket(
      source,
      Buffer.concat([
        encodeRelayFrame(RELAY_KIND_CLOSE),
        encodeRelayFrame(trailingKind),
      ]),
    );
    assert((await bounded(
      destinationReader.next(),
      3_000,
      `${sourceName} first CLOSE`,
    )).kind === RELAY_KIND_CLOSE, `${sourceName} first CLOSE did not cross`);
    await expectReaderEndsWithoutFrame(
      destinationReader,
      `${sourceName} ${label}`,
    );
    const exit = await bounded(
      harness.relayExit,
      3_000,
      `${sourceName} ${label} exit`,
    );
    assert(exit.code === 114 && exit.signal === null,
      `${sourceName} ${label} did not fail the relay`);
  } finally {
    await harness.close();
  }
}

async function expectReaderEndsWithoutFrame(reader, label) {
  let error;
  try {
    const frame = await bounded(reader.next(), 3_000, `${label} EOF`);
    throw new Error(`${label} unexpectedly emitted frame kind ${frame.kind}`);
  } catch (caught) {
    error = caught;
  }
  assert(
    /socket (?:ended|closed) before another framed record/.test(error?.message ?? ""),
    `${label} did not terminate through physical EOF: ${error?.message ?? error}`,
  );
}

async function openRelay(executablePath) {
  let guestConnections = 0;
  const guestSocketPromise = deferred();
  const guestServer = createServer({ allowHalfOpen: true }, (socket) => {
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
  const hostServer = createServer({ allowHalfOpen: true }, (socket) => hostSocketPromise.resolve(socket));
  await listen(hostServer, hostData);
  const [hostSocket, guestSocket] = await Promise.all([
    bounded(hostSocketPromise.promise, 3_000, "Host relay connection"),
    bounded(guestSocketPromise.promise, 3_000, "Guest relay connection"),
  ]);
  await waitFor(() => Buffer.concat(diagnostics).toString("utf8").startsWith("READY\n"), 3_000);

  return {
    relay,
    relayExit,
    hostSocket,
    guestSocket,
    diagnostics,
    async close() {
      hostSocket.destroy();
      guestSocket.destroy();
      if (relay.exitCode === null && relay.signalCode === null) {
        relay.kill("SIGKILL");
        await bounded(relayExit, 3_000, "forced relay cleanup").catch(() => {});
      }
      await Promise.all([closeServer(hostServer), closeServer(guestServer)]);
    },
  };
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

function encodeRelayFrame(kind, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  if (
    (kind === RELAY_KIND_DATA && (payload.byteLength < 1 || payload.byteLength > RELAY_DATA_BYTES))
    || ([RELAY_KIND_FIN, RELAY_KIND_RESET, RELAY_KIND_CLOSE].includes(kind)
      && payload.byteLength !== 0)
    || ![RELAY_KIND_DATA, RELAY_KIND_FIN, RELAY_KIND_RESET, RELAY_KIND_CLOSE].includes(kind)
  ) {
    throw new Error("invalid test relay frame");
  }
  const frame = Buffer.alloc(RELAY_HEADER_BYTES + payload.byteLength);
  RELAY_MAGIC.copy(frame, 0);
  frame.writeUInt16BE(RELAY_VERSION, 4);
  frame.writeUInt16BE(kind, 6);
  frame.writeUInt32BE(payload.byteLength, 8);
  payload.copy(frame, RELAY_HEADER_BYTES);
  return frame;
}

function createRelayFrameReader(socket) {
  let buffered = Buffer.alloc(0);
  let terminalError;
  const frames = [];
  const waiters = [];

  const settle = () => {
    while (frames.length > 0 && waiters.length > 0) {
      waiters.shift().resolve(frames.shift());
    }
    if (terminalError) {
      while (waiters.length > 0) waiters.shift().reject(terminalError);
    }
  };
  const fail = (error) => {
    terminalError ??= error instanceof Error ? error : new Error(String(error));
    settle();
  };
  const parse = () => {
    try {
      for (;;) {
        if (buffered.byteLength < RELAY_HEADER_BYTES) return;
        if (!buffered.subarray(0, 4).equals(RELAY_MAGIC)) {
          throw new Error("relay emitted a frame with invalid magic");
        }
        const version = buffered.readUInt16BE(4);
        const kind = buffered.readUInt16BE(6);
        const payloadLength = buffered.readUInt32BE(8);
        if (version !== RELAY_VERSION) throw new Error("relay emitted an unsupported frame version");
        if (
          (kind === RELAY_KIND_DATA && (payloadLength < 1 || payloadLength > RELAY_DATA_BYTES))
          || ([RELAY_KIND_FIN, RELAY_KIND_RESET, RELAY_KIND_CLOSE].includes(kind)
            && payloadLength !== 0)
          || ![RELAY_KIND_DATA, RELAY_KIND_FIN, RELAY_KIND_RESET, RELAY_KIND_CLOSE].includes(kind)
        ) {
          throw new Error("relay emitted an invalid frame kind or payload length");
        }
        const frameBytes = RELAY_HEADER_BYTES + payloadLength;
        if (buffered.byteLength < frameBytes) return;
        frames.push({
          kind,
          payload: Buffer.from(buffered.subarray(RELAY_HEADER_BYTES, frameBytes)),
        });
        buffered = buffered.subarray(frameBytes);
      }
    } catch (error) {
      fail(error);
    } finally {
      settle();
    }
  };

  socket.on("data", (chunk) => {
    buffered = buffered.byteLength === 0
      ? Buffer.from(chunk)
      : Buffer.concat([buffered, chunk]);
    parse();
  });
  socket.once("end", () => fail(new Error("relay socket ended before another framed record")));
  socket.once("error", fail);
  socket.once("close", () => {
    if (!terminalError && waiters.length > 0) {
      fail(new Error("relay socket closed before another framed record"));
    }
  });

  return {
    next() {
      if (frames.length > 0) return Promise.resolve(frames.shift());
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolvePromise, reject) => {
        waiters.push({ resolve: resolvePromise, reject });
      });
    },
  };
}

async function collectFramedDataUntilFin(reader, label) {
  const chunks = [];
  for (;;) {
    const frame = await bounded(reader.next(), 5_000, label);
    if (frame.kind === RELAY_KIND_DATA) {
      chunks.push(frame.payload);
      continue;
    }
    if (frame.kind === RELAY_KIND_FIN) return Buffer.concat(chunks);
    throw new Error(`${label} received terminal RESET`);
  }
}

function collectRawBytes(socket, expectedBytes) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk) => {
      chunks.push(Buffer.from(chunk));
      bytes += chunk.byteLength;
      if (bytes < expectedBytes) return;
      cleanup();
      const result = Buffer.concat(chunks);
      if (result.byteLength !== expectedBytes) {
        reject(new Error("raw relay emitted more bytes than expected"));
      } else {
        resolvePromise(result);
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`raw relay ended at ${bytes} bytes; expected ${expectedBytes}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

function waitForReadableEnd(socket) {
  if (socket.readableEnded) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onEnd = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Guest-local socket closed without a readable EOF"));
    };
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function writeFragmented(socket, bytes, fragmentSizes) {
  let offset = 0;
  let fragmentIndex = 0;
  while (offset < bytes.byteLength) {
    const requested = fragmentSizes[fragmentIndex % fragmentSizes.length];
    const end = Math.min(offset + requested, bytes.byteLength);
    await writeSocket(socket, bytes.subarray(offset, end));
    offset = end;
    fragmentIndex += 1;
  }
}

function writeSocket(socket, bytes) {
  return new Promise((resolvePromise, reject) => {
    socket.write(bytes, (error) => error ? reject(error) : resolvePromise());
  });
}

function patternedBytes(length, seed) {
  const value = Buffer.allocUnsafe(length);
  for (let index = 0; index < value.byteLength; index += 1) {
    value[index] = (seed + index * 31) & 0xff;
  }
  return value;
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
