import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import {
  createOciBundlePlan,
  createCapsuleRuntimeStoragePlan,
  generateOpaqueId,
  LinuxRuncDriver,
  TicketRegistry,
  type OciExpectedIdentity,
  type OciPlanInput,
  type RuncExecution,
} from "@lamarck/capsule";
import { GuestBlobStore } from "./blob-store";
import {
  DEFAULT_GUEST_PATHS,
  GUEST_ROOT,
  MKFS_EROFS_PATH,
} from "./config";
import { runFixedCommand } from "./fixed-command";
import { GuestResourceAdmission, type GuestResourceLease } from "./resource-admission";
import { GuestResourceManager } from "./resource-manager";

export const RELEASE_RUNC_SMOKE_MARKER = "LAMARCK_RELEASE_RUNC_SMOKE_OK";
export const RELEASE_RUNC_SMOKE_COW = "release-runc-smoke-cow.txt";
export const RELEASE_RUNC_SMOKE_PACKAGE_SOURCE = `${JSON.stringify({
  name: "lamarck-release-runc-smoke",
  private: true,
  type: "module",
  scripts: { start: "node release-runc-smoke.mjs" },
}, null, 2)}\n`;

export function generateReleaseRuncSmokeSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export function formatReleaseRuncSmokeError(error: unknown): string {
  const seen = new Set<unknown>();
  const format = (value: unknown, depth: number): string => {
    if (depth > 8) return "[nested error depth exceeded]";
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      if (seen.has(value)) return "[circular error]";
      seen.add(value);
    }
    const header = value instanceof Error
      ? value.stack ?? `${value.name}: ${value.message}`
      : String(value);
    const nested: string[] = [];
    if (value instanceof AggregateError) {
      for (const [index, child] of [...value.errors].slice(0, 16).entries()) {
        nested.push(`aggregate[${index}]:\n${format(child, depth + 1)}`);
      }
      if (value.errors.length > 16) nested.push("[additional aggregate errors omitted]");
    }
    if (value instanceof Error && value.cause !== undefined) {
      nested.push(`cause:\n${format(value.cause, depth + 1)}`);
    }
    return nested.length > 0 ? `${header}\n${nested.join("\n")}` : header;
  };
  return format(error, 0);
}

const EXPECTED_NODE_VERSION = "v24.18.0";
const EXPECTED_NODE_MODULES_ABI = "137";
const EXPECTED_GLIBC_VERSION = "2.43";
const SMOKE_ROOT = "/run/lamarck/release-runc-smoke";
const SDK_SOCKET = `${SMOKE_ROOT}/sdk.sock`;
const ARTIFACT_SOURCE = `${SMOKE_ROOT}/artifact-source`;
const ARTIFACT_IMAGE = `${SMOKE_ROOT}/artifact.erofs`;
const ARTIFACT_REFERENCE = "release-runc-smoke:artifact";

export const RELEASE_RUNC_SMOKE_WORKLOAD_SOURCE = `
import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";

const header = process.report.getReport().header;
if (
  process.version !== ${JSON.stringify(EXPECTED_NODE_VERSION)}
  || process.arch !== "arm64"
  || process.versions.modules !== ${JSON.stringify(EXPECTED_NODE_MODULES_ABI)}
  || header.glibcVersionRuntime !== ${JSON.stringify(EXPECTED_GLIBC_VERSION)}
  || process.getuid?.() !== 1_000
  || process.getgid?.() !== 1_000
) {
  throw new Error("signed Guest production runtime ABI or user mapping is invalid");
}
writeFileSync(
  "/app/${RELEASE_RUNC_SMOKE_COW}",
  "production-runc-cow-ok\\n",
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
const sdkPath = process.env.LAMARCK_SDK_SOCKET;
if (sdkPath !== "/run/lamarck/system.sock") {
  throw new Error("fixed workload SDK socket is unavailable after npm launch");
}
const sdk = createConnection(sdkPath);
await new Promise((resolve, reject) => {
  sdk.once("error", reject);
  sdk.end(${JSON.stringify(`${RELEASE_RUNC_SMOKE_MARKER}\n`)}, resolve);
});
sdk.destroy();
`;

export function createReleaseRuncSmokePlan(options: {
  appHandle: string;
  workloadHandle: string;
  artifactDigest: string;
  mappedHostUid?: number;
  mappedHostGid?: number;
}): { plan: ReturnType<typeof createOciBundlePlan>; expectedIdentity: OciExpectedIdentity } {
  const resources = {
    memoryBytes: 256 * 1024 * 1024,
    pids: 64,
    cpuQuotaMicros: 100_000,
  };
  const input: OciPlanInput = {
    appHandle: options.appHandle,
    workloadHandle: options.workloadHandle,
    workloadKind: "job",
    artifactDigest: options.artifactDigest,
    mappedHostUid: options.mappedHostUid ?? 100_000,
    mappedHostGid: options.mappedHostGid ?? 200_000,
    argv: ["npm", "run", "start"],
    cwd: "/app",
    environment: {},
    resources,
  };
  return {
    plan: createOciBundlePlan(input),
    expectedIdentity: {
      appHandle: input.appHandle,
      workloadHandle: input.workloadHandle,
      workloadKind: input.workloadKind,
      artifactDigest: input.artifactDigest,
      mappedHostUid: input.mappedHostUid,
      mappedHostGid: input.mappedHostGid,
      argv: [...input.argv],
      cwd: input.cwd,
      environment: {},
      resources,
    },
  };
}

/**
 * Release-only signed-image gate. It uses the exact production CAS, resource
 * manager, OCI compiler, ticket authority, and Linux runc driver, then proves
 * authoritative teardown before returning to the init script.
 */
export async function runReleaseRuncSmoke(): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error("release runc smoke requires the signed Linux arm64 Guest");
  }
  await rm(SMOKE_ROOT, { recursive: true, force: true });
  await mkdir(ARTIFACT_SOURCE, { recursive: true, mode: 0o755 });
  const workloadSourcePath = `${ARTIFACT_SOURCE}/release-runc-smoke.mjs`;
  const packageSourcePath = `${ARTIFACT_SOURCE}/package.json`;
  await writeFile(workloadSourcePath, RELEASE_RUNC_SMOKE_WORKLOAD_SOURCE, {
    encoding: "utf8",
    mode: 0o555,
    flag: "wx",
  });
  await chmod(workloadSourcePath, 0o555);
  await writeFile(packageSourcePath, RELEASE_RUNC_SMOKE_PACKAGE_SOURCE, {
    encoding: "utf8",
    mode: 0o444,
    flag: "wx",
  });
  await chmod(packageSourcePath, 0o444);
  await runFixedCommand(MKFS_EROFS_PATH, [
    "--all-root",
    "-T",
    "0",
    ARTIFACT_IMAGE,
    ARTIFACT_SOURCE,
  ], { timeoutMs: 60_000 });

  const ownerKey = createHash("sha256").update("lamarck-release-runc-smoke-v1").digest("hex");
  const appHandle = generateOpaqueId();
  const workloadHandle = generateOpaqueId();
  const sessionId = generateReleaseRuncSmokeSessionId();
  const admission = await GuestResourceAdmission.fromSystem({ stateRoot: GUEST_ROOT });
  const blobs = new GuestBlobStore(DEFAULT_GUEST_PATHS.blobRoot, { admission });
  const resources = new GuestResourceManager(blobs, { admission });
  const runc = new LinuxRuncDriver();
  if (!runc.available) throw new Error("signed Guest production runc driver is unavailable");

  let imported: Awaited<ReturnType<GuestBlobStore["importLocalFile"]>> | undefined;
  let appPrepared = false;
  let execution: RuncExecution | undefined;
  let executionDeleted = false;
  let workloadLease: GuestResourceLease | undefined;
  let sockets: UnixSocketPair | undefined;
  const cleanupFailures: unknown[] = [];
  let primaryFailure: unknown;
  try {
    imported = await blobs.importLocalFile("artifact", ARTIFACT_IMAGE, {
      ownerKey,
      referenceId: ARTIFACT_REFERENCE,
    });
    const storage = createCapsuleRuntimeStoragePlan(imported.bytes);
    await resources.prepareApp({
      ownerKey,
      appHandle,
      artifactDigest: imported.digest,
      artifactBytes: imported.bytes,
      artifactBlobHandle: ARTIFACT_REFERENCE,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
      storagePlanVersion: storage.version,
      scratchBytes: storage.scratchBytes,
    });
    appPrepared = true;

    sockets = await createUnixSocketPair(SDK_SOCKET);
    const tickets = new TicketRegistry();
    const issued = tickets.issue({
      sessionId,
      kind: "sdk",
      appHandle,
      subjectHandle: workloadHandle,
      ttlMs: 60_000,
    });
    const consumedTicket = tickets.consume(issued.ticket, sessionId, "sdk");
    const { plan, expectedIdentity } = createReleaseRuncSmokePlan({
      appHandle,
      workloadHandle,
      artifactDigest: imported.digest,
    });
    workloadLease = await admission.reserve(`workload:${workloadHandle}`, {
      memoryBytes: expectedIdentity.resources.memoryBytes,
    });
    execution = await runc.start({
      plan,
      expectedIdentity,
      sessionId,
      sdkChannel: {
        source: sockets.inherited,
        consumedTicket,
      },
    });
    const [exit, marker] = await Promise.all([
      execution.wait(),
      readExactLine(sockets.peer, 15_000),
    ]);
    if (exit.exitCode !== 0 || exit.signal !== null) {
      throw new Error(`production runc smoke workload exited ${exit.exitCode ?? exit.signal}`);
    }
    if (marker !== RELEASE_RUNC_SMOKE_MARKER) {
      throw new Error("production runc smoke returned an invalid SDK Unix-socket marker");
    }
    await runc.delete(execution.containerId);
    executionDeleted = true;
    workloadLease.release();
    workloadLease = undefined;

    const app = resources.getApp(appHandle);
    if (
      await readFile(`${app.runtimeRoot}/merged/${RELEASE_RUNC_SMOKE_COW}`, "utf8")
      !== "production-runc-cow-ok\n"
    ) throw new Error("production runc smoke did not write through the App overlay");
    await resources.stopApp(appHandle);
    appPrepared = false;
    await resources.drain();
    const released = await blobs.releaseExpected({
      ownerKey,
      referenceId: ARTIFACT_REFERENCE,
      kind: "artifact",
      digest: imported.digest,
      bytes: imported.bytes,
    });
    if (!released) throw new Error("production runc smoke artifact reference disappeared");
    imported = undefined;
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (execution && !executionDeleted) {
      try {
        await runc.stop(execution.containerId, 0);
        await runc.delete(execution.containerId);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      workloadLease?.release();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (appPrepared) {
      try {
        await resources.stopApp(appHandle);
        appPrepared = false;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await resources.drain();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (imported) {
      try {
        await blobs.releaseExpected({
          ownerKey,
          referenceId: ARTIFACT_REFERENCE,
          kind: "artifact",
          digest: imported.digest,
          bytes: imported.bytes,
        });
        imported = undefined;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await blobs.releaseAll();
    } catch (error) {
      cleanupFailures.push(error);
    }
    sockets?.inherited.destroy();
    sockets?.peer.destroy();
    await sockets?.close().catch((error) => cleanupFailures.push(error));
    try {
      await rm(SMOKE_ROOT, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
    const blobSnapshot = blobs.snapshot();
    const admissionSnapshot = admission.snapshot();
    if (
      blobSnapshot.blobs !== 0
      || blobSnapshot.references !== 0
      || admissionSnapshot.reservations !== 0
      || admissionSnapshot.reservedDiskBytes !== 0
      || admissionSnapshot.reservedMemoryBytes !== 0
    ) cleanupFailures.push(new Error("production runc smoke retained Guest resource authority"));
  }

  if (primaryFailure || cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures].filter((value) => value !== undefined),
      "signed Guest production runc smoke failed or could not prove teardown",
    );
  }
  process.stdout.write("signed Guest production runc/OCI/npm/SDK-UDS/teardown smoke passed\n");
}

interface UnixSocketPair {
  inherited: Socket;
  peer: Socket;
  close(): Promise<void>;
}

async function createUnixSocketPair(path: string): Promise<UnixSocketPair> {
  await rm(path, { force: true });
  const server = createServer();
  let inheritedResolve!: (socket: Socket) => void;
  let inheritedReject!: (error: Error) => void;
  const inheritedPromise = new Promise<Socket>((resolveSocket, reject) => {
    inheritedResolve = resolveSocket;
    inheritedReject = reject;
  });
  server.once("connection", inheritedResolve);
  server.once("error", inheritedReject);
  await listen(server, path);
  const peer = connect(path);
  await new Promise<void>((resolveConnect, reject) => {
    peer.once("connect", resolveConnect);
    peer.once("error", reject);
  });
  const inherited = await inheritedPromise;
  const serverClosed = new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  await rm(path, { force: true });
  return {
    inherited,
    peer,
    close: async () => {
      await serverClosed;
      await rm(path, { force: true });
    },
  };
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, resolveListen);
  });
}

async function readExactLine(socket: Socket, timeoutMs: number): Promise<string> {
  return await new Promise<string>((resolveLine, reject) => {
    let source = "";
    const timeout = setTimeout(() => finish(new Error("production runc SDK marker timed out")), timeoutMs);
    const onData = (chunk: Buffer) => {
      source += chunk.toString("utf8");
      if (Buffer.byteLength(source, "utf8") > 4_096) {
        finish(new Error("production runc SDK marker exceeded its byte limit"));
        return;
      }
      const newline = source.indexOf("\n");
      if (newline >= 0) {
        if (newline !== source.length - 1) {
          finish(new Error("production runc SDK marker contained trailing bytes"));
        } else finish(undefined, source.slice(0, -1));
      }
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("production runc SDK marker ended early"));
    const finish = (error?: Error, line?: string) => {
      clearTimeout(timeout);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      if (error) reject(error);
      else resolveLine(line!);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReleaseRuncSmoke().catch((error) => {
    process.stderr.write(`signed Guest runc smoke fatal:\n${formatReleaseRuncSmokeError(error)}\n`);
    process.exitCode = 1;
  });
}
