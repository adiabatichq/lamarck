import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rm, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { validateArtifactDigest } from "@lamarck/capsule";
import { GuestBlobStore } from "./blob-store";
import { recoverGuestEphemeralState } from "./boot-recovery";
import { GuestBuildManager } from "./build-manager";
import { DEFAULT_GUEST_PATHS, GUEST_ROOT } from "./config";
import { GuestResourceAdmission } from "./resource-admission";
import { GuestResourceManager } from "./resource-manager";
import { CapsuleGuestSupervisor } from "./supervisor";

const CONTROL_SOCKET = "/run/lamarck/supervisor-control.sock";
const DATA_SOCKET = "/run/lamarck/supervisor-data.sock";
const SUPERVISOR_VERSION = "0.1.0";

export function parseTrustedImageDigestFromCmdline(cmdline: string): string {
  const values = cmdline
    .trim()
    .split(/\s+/)
    .filter((item) => item.startsWith("lamarck.image_digest="))
    .map((item) => item.slice("lamarck.image_digest=".length));
  if (values.length !== 1) {
    throw new Error("kernel cmdline must contain exactly one lamarck.image_digest parameter");
  }
  return validateArtifactDigest(values[0], "kernel lamarck.image_digest");
}

export async function startGuestSupervisor(): Promise<void> {
  const imageDigest = parseTrustedImageDigestFromCmdline(await readFile("/proc/cmdline", "utf8"));
  const architecture = process.arch === "arm64"
    ? "arm64"
    : process.arch === "x64"
      ? "x64"
      : undefined;
  if (!architecture) throw new Error(`unsupported Guest architecture ${process.arch}`);
  const bootId = randomBytes(16).toString("base64url");
  await recoverGuestEphemeralState({
    runtimeRoot: DEFAULT_GUEST_PATHS.runtimeRoot,
    buildRoot: DEFAULT_GUEST_PATHS.buildRoot,
    blobRoot: DEFAULT_GUEST_PATHS.blobRoot,
    cgroupRoot: DEFAULT_GUEST_PATHS.cgroupRoot,
  });
  const admission = await GuestResourceAdmission.fromSystem({ stateRoot: GUEST_ROOT });
  const blobs = new GuestBlobStore(DEFAULT_GUEST_PATHS.blobRoot, { admission });
  const resources = new GuestResourceManager(blobs, { admission });
  const builds = new GuestBuildManager(blobs, {
    imageDigest,
    admission,
    artifactMountRegistry: resources.artifactMountRegistry,
  });
  const supervisor = new CapsuleGuestSupervisor({
    bootId,
    imageDigest,
    architecture,
    supervisorVersion: SUPERVISOR_VERSION,
    blobs,
    builds,
    resources,
    admission,
  });

  await mkdir("/run/lamarck", { recursive: true, mode: 0o700 });
  await removeStaleSocket(CONTROL_SOCKET);
  await removeStaleSocket(DATA_SOCKET);
  const control = createServer((socket) => supervisor.attachControl(socket));
  const data = createServer((socket) => supervisor.attachData(socket));
  await Promise.all([
    listenUnix(control, CONTROL_SOCKET),
    listenUnix(data, DATA_SOCKET),
  ]);
  await Promise.all([chmod(CONTROL_SOCKET, 0o600), chmod(DATA_SOCKET, 0o600)]);

  const terminate = () => {
    control.close();
    data.close();
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isSocket()) throw new Error(`refusing to replace non-socket management path ${path}`);
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function listenUnix(server: ReturnType<typeof createServer>, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startGuestSupervisor().catch((error) => {
    process.stderr.write(`capsule Guest supervisor fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
