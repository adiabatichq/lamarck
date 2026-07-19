import { open, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { runFixedCommand } from "./fixed-command";

export interface BoundedVolumeOptions {
  imagePath: string;
  mountPath: string;
  bytes: number;
  label: string;
  mkfsPath?: string;
  mountPathBinary?: string;
  umountPathBinary?: string;
  signal?: AbortSignal;
}

/** A disposable sparse ext4 volume is the hard disk ceiling for one Capsule scope. */
export async function createBoundedVolume(options: BoundedVolumeOptions): Promise<void> {
  if (!Number.isSafeInteger(options.bytes) || options.bytes < 64 * 1024 * 1024 || options.bytes > 16 * 1024 * 1024 * 1024) {
    throw new Error("bounded volume size is outside the Guest policy");
  }
  if (!/^[A-Z0-9_-]{1,16}$/.test(options.label)) throw new Error("invalid ext4 volume label");
  throwIfAborted(options.signal);
  await mkdir(dirname(options.imagePath), { recursive: true, mode: 0o700 });
  await rm(options.imagePath, { force: true });
  await rm(options.mountPath, { recursive: true, force: true });
  await mkdir(options.mountPath, { recursive: true, mode: 0o700 });
  const image = await open(options.imagePath, "wx", 0o600);
  try {
    await image.truncate(options.bytes);
    await image.sync();
  } finally {
    await image.close();
  }
  throwIfAborted(options.signal);
  await runFixedCommand(options.mkfsPath ?? "/sbin/mkfs.ext4", [
    "-F",
    "-q",
    "-m",
    "0",
    "-L",
    options.label,
    "--",
    options.imagePath,
  ], { timeoutMs: 60_000, signal: options.signal });
  throwIfAborted(options.signal);
  await runFixedCommand(options.mountPathBinary ?? "/bin/mount", [
    "-t",
    "ext4",
    "-o",
    "loop,rw,nodev,nosuid,noatime",
    "--",
    options.imagePath,
    options.mountPath,
  ], { signal: options.signal });
}

export async function destroyBoundedVolume(options: {
  imagePath: string;
  mountPath: string;
  umountPathBinary?: string;
}): Promise<void> {
  await runFixedCommand(options.umountPathBinary ?? "/bin/umount", ["--", options.mountPath], {
    allowExitCodes: [0, 1, 32],
  });
  if (await isMountPoint(options.mountPath)) {
    throw new Error(`bounded volume remained mounted at ${options.mountPath}`);
  }
  await rm(options.mountPath, { recursive: true, force: true });
  await rm(options.imagePath, { force: true });
}

async function isMountPoint(path: string): Promise<boolean> {
  const resolved = resolve(path);
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  return mountInfo.split("\n").some((line) => {
    const fields = line.split(" ");
    return fields.length > 4 && fields[4] === resolved;
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("bounded volume creation aborted");
}
