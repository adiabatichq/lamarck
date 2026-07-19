import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { GuestContainmentError } from "./containment-error";

export interface GuestBootRecoveryOptions {
  runtimeRoot: string;
  buildRoot: string;
  blobRoot: string;
  cgroupRoot: string;
  mountInfoPath?: string;
}

/**
 * Reclaims disposable App and Build storage after a VM restart.
 *
 * Destructive recovery is allowed only after the current kernel proves that
 * neither scope has a live mount nor a process in its aggregate cgroup. A
 * supervisor restart inside the same boot therefore fails closed instead of
 * deleting storage that an old descendant may still be using.
 */
export async function recoverGuestEphemeralState(
  options: GuestBootRecoveryOptions,
): Promise<void> {
  const runtimeRoot = absoluteRoot(options.runtimeRoot, "runtimeRoot");
  const buildRoot = absoluteRoot(options.buildRoot, "buildRoot");
  const blobRoot = absoluteRoot(options.blobRoot, "blobRoot");
  const cgroupRoot = absoluteRoot(options.cgroupRoot, "cgroupRoot");
  const mountInfo = await readFile(options.mountInfoPath ?? "/proc/self/mountinfo", "utf8");
  // Guest CAS is reconstructable from the Host. Its ownership/ref ledger is
  // deliberately in-memory, so a verified reboot purges stale unreferenced
  // blobs before deriving the new disk-admission budget.
  const disposableRoots = [runtimeRoot, buildRoot, blobRoot];

  for (const mountPoint of parseMountPoints(mountInfo)) {
    const protectedRoot = disposableRoots.find((root) => isWithin(root, mountPoint));
    if (protectedRoot) {
      throw new GuestContainmentError(
        `Guest recovery refused mounted disposable state ${mountPoint} beneath ${protectedRoot}`,
      );
    }
  }

  await assertCgroupScopeIdle(`${cgroupRoot}/apps`);
  await assertCgroupScopeIdle(`${cgroupRoot}/builds`);

  // All checks complete before either tree is modified. A failed proof leaves
  // the crash evidence intact for VM quarantine and diagnostics.
  for (const root of disposableRoots) {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: false, mode: 0o700 });
  }
}

async function assertCgroupScopeIdle(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new GuestContainmentError(`Guest recovery cgroup scope is not a directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GuestContainmentError(`Guest recovery cgroup scope is missing: ${path}`, { cause: error });
    }
    throw error;
  }

  const [events, processes] = await Promise.all([
    readFile(`${path}/cgroup.events`, "utf8"),
    readFile(`${path}/cgroup.procs`, "utf8"),
  ]);
  const populated = [...events.matchAll(/^populated\s+([01])\s*$/gm)];
  if (populated.length !== 1) {
    throw new GuestContainmentError(`Guest recovery could not authenticate cgroup population at ${path}`);
  }
  if (populated[0]![1] !== "0" || processes.trim().length > 0) {
    throw new GuestContainmentError(`Guest recovery found live descendants in ${path}`);
  }
}

function parseMountPoints(source: string): string[] {
  const mountPoints: string[] = [];
  for (const line of source.split("\n")) {
    if (line.length === 0) continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || !fields[4]) {
      throw new GuestContainmentError("Guest mountinfo is malformed during recovery");
    }
    mountPoints.push(resolve(decodeMountInfoPath(fields[4])));
  }
  return mountPoints;
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function absoluteRoot(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const normalized = resolve(value);
  if (normalized === "/") throw new Error(`${label} cannot be the filesystem root`);
  return normalized;
}
