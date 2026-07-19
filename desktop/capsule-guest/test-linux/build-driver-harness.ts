import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  createBuildOciBundlePlan,
  type BuildOciBundlePlan,
  type BuildOciPlanInput,
} from "../../capsule/src/oci/build-plan";
import {
  BuildCancellationError,
  LinuxBuildCapsuleRunner,
} from "../src/build-runner";

const RUNC = "/usr/sbin/runc";
const RUNC_ROOT = "/run/lamarck/build-runc-integration";
const CGROUP_MOUNT = "/sys/fs/cgroup";
const APP_HANDLE = "DDDDDDDDDDDDDDDDDDDDDD";
const BUILD_HANDLE = "EEEEEEEEEEEEEEEEEEEEEE";
const PACKAGE_DIGEST = `sha256:${"e".repeat(64)}`;
const MAPPED_UID = 100_000;
const MAPPED_GID = 200_000;
const ACTIVE_OFFLINE_NPM = "/opt/lamarck/rootfs/build-node24/usr/libexec/lamarck-offline-npm";
const PRODUCTION_OFFLINE_NPM = `${ACTIVE_OFFLINE_NPM}.production`;
const POLICY_PROBE = "/opt/lamarck/rootfs/build-node24/usr/libexec/lamarck-build-policy-probe";
const CANCELLATION_GRACE_MS = 300;

const input: BuildOciPlanInput = {
  appHandle: APP_HANDLE,
  buildHandle: BUILD_HANDLE,
  packageDigest: PACKAGE_DIGEST,
  mappedHostUid: MAPPED_UID,
  mappedHostGid: MAPPED_GID,
  resources: {
    memoryBytes: 256 * 1024 * 1024,
    pids: 64,
    cpuQuotaMicros: 100_000,
  },
};
const plan = createBuildOciBundlePlan(input);
const runner = new LinuxBuildCapsuleRunner({
  runcPath: RUNC,
  runcRoot: RUNC_ROOT,
  cgroupMount: CGROUP_MOUNT,
  cleanupTimeoutMs: 10_000,
});
const workspace = `${plan.buildRoot}/workspace`;
const cgroupPath = `${CGROUP_MOUNT}/${plan.config.linux.cgroupsPath}`;

assert.equal(process.version, "v24.10.0", "Build integration gate must use the Guest Node version");
assertProductionPlan(plan);

await runOfflineBuild("initial");
await runCancellation();
await runFailedLaunchAndRecovery();

process.stdout.write(
  "production LinuxBuildCapsuleRunner + offline npm + cancellation/failure recovery passed\n",
);

async function runOfflineBuild(label: string): Promise<void> {
  await installEntrypoint(PRODUCTION_OFFLINE_NPM);
  const original = await prepareWorkspace(false);
  const result = await runner.run(plan, input, 30_000);
  assert.equal(result.exitCode, 0, `${label} offline Build failed: ${result.logs}`);
  assert.deepEqual(await readFile(`${workspace}/package.json`), original.packageJson);
  assert.deepEqual(await readFile(`${workspace}/package-lock.json`), original.packageLock);
  assert.equal(await readFile(`${workspace}/build-policy-success.txt`, "utf8"), "policy-ok\n");
  const marker = await stat(`${workspace}/build-policy-success.txt`);
  assert.equal(marker.uid, MAPPED_UID + 1_000, "Build output UID did not cross the user mapping");
  assert.equal(marker.gid, MAPPED_GID + 1_000, "Build output GID did not cross the user mapping");
  assert.equal(
    existsSync("/opt/lamarck/rootfs/build-node24/rootfs-write-probe"),
    false,
    "read-only Build rootfs probe escaped into the creator namespace",
  );
  await assertRetired();
}

async function runCancellation(): Promise<void> {
  await installEntrypoint(POLICY_PROBE);
  await prepareWorkspace(true);
  const controller = new AbortController();
  const lifecycle = runner.run(plan, input, 30_000, controller.signal);
  await waitForFile(`${workspace}/cancel-ready`, 10_000);
  await waitFor(async () => (await readCgroupPids()).length >= 2, 10_000);
  const livePids = await readCgroupPids();
  assert.ok(livePids.length >= 2, "cancellation fixture did not create a descendant");
  assert.equal(await readCgroupPopulation(), 1, "active Build cgroup was not populated");

  const cancellationStarted = Date.now();
  controller.abort(new BuildCancellationError(
    "integration cancellation",
    CANCELLATION_GRACE_MS,
  ));
  let cancellation: unknown;
  try {
    await lifecycle;
  } catch (error) {
    cancellation = error;
  }
  assert.ok(cancellation instanceof BuildCancellationError, "Build cancellation reason was lost");
  assert.ok(
    Date.now() - cancellationStarted >= CANCELLATION_GRACE_MS - 50,
    "stubborn Build skipped the configured TERM grace before KILL",
  );
  assert.equal(await readFile(`${workspace}/cancel-term-seen`, "utf8"), "term-seen\n");
  await waitFor(
    async () => livePids.every((pid) => !existsSync(`/proc/${pid}`)),
    10_000,
  );
  assert.ok(
    livePids.every((pid) => !existsSync(`/proc/${pid}`)),
    "cancelled Build retained an init or descendant process",
  );
  await assertRetired();
}

async function runFailedLaunchAndRecovery(): Promise<void> {
  await prepareWorkspace(false);
  await unlink(ACTIVE_OFFLINE_NPM);
  const failed = await runner.run(plan, input, 30_000);
  assert.notEqual(failed.exitCode, 0, "missing fixed Build entrypoint unexpectedly launched");
  assert.match(
    failed.logs,
    /lamarck-offline-npm|no such file|executable file|exec/i,
    "failed launch did not retain a bounded runc diagnostic",
  );
  await assertRetired();

  // Reusing the exact identity after a failed creator is safe only if the
  // first runc state, cgroup tasks, and mutable bundle are all gone.
  await runOfflineBuild("same-identity recovery");
}

async function prepareWorkspace(cancel: boolean): Promise<{
  packageJson: Buffer;
  packageLock: Buffer;
}> {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true, mode: 0o755 });
  await chown(workspace, MAPPED_UID + 1_000, MAPPED_GID + 1_000);
  const packageValue = {
    name: "capsule-build-runc-integration",
    version: "1.0.0",
    private: true,
    scripts: {
      install: "/usr/libexec/lamarck-build-policy-probe success",
    },
  };
  const lockValue = {
    name: packageValue.name,
    version: packageValue.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: packageValue.name,
        version: packageValue.version,
        hasInstallScript: true,
      },
    },
  };
  const packageJson = Buffer.from(`${JSON.stringify(packageValue, null, 2)}\n`, "utf8");
  const packageLock = Buffer.from(`${JSON.stringify(lockValue, null, 2)}\n`, "utf8");
  await writeFile(`${workspace}/package.json`, packageJson, { mode: 0o644 });
  await writeFile(`${workspace}/package-lock.json`, packageLock, { mode: 0o644 });
  if (cancel) {
    await writeFile(`${workspace}/.lamarck-cancel-probe`, "cancel\n", { mode: 0o644 });
  }
  return { packageJson, packageLock };
}

async function installEntrypoint(source: string): Promise<void> {
  await copyFile(source, ACTIVE_OFFLINE_NPM);
  await chmod(ACTIVE_OFFLINE_NPM, 0o755);
}

async function assertRetired(): Promise<void> {
  assert.equal(existsSync(plan.bundlePath), false, "retired Build retained its mutable OCI bundle");
  const state = spawnSync(RUNC, ["--root", RUNC_ROOT, "state", plan.containerId], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.notEqual(state.status, 0, "retired Build retained runc container state");
  if (existsSync(cgroupPath)) {
    assert.equal(await readCgroupPopulation(), 0, "retired Build cgroup remained populated");
    assert.deepEqual(await readCgroupPids(), [], "retired Build cgroup retained tasks");
  }
}

function assertProductionPlan(value: BuildOciBundlePlan): void {
  assert.equal(value.config.root.readonly, true);
  assert.equal(value.config.process.noNewPrivileges, true);
  assert.deepEqual(value.config.process.capabilities, {
    ambient: [],
    bounding: [],
    effective: [],
    inheritable: [],
    permitted: [],
  });
  assert.deepEqual(value.config.linux.uidMappings, [
    { containerID: 0, hostID: MAPPED_UID, size: 65_536 },
  ]);
  assert.deepEqual(value.config.linux.gidMappings, [
    { containerID: 0, hostID: MAPPED_GID, size: 65_536 },
  ]);
  assert.equal(
    value.config.linux.namespaces.find((namespace) => namespace.type === "network")?.path,
    value.networkNamespacePath,
  );
  const denied = value.config.linux.seccomp.syscalls.flatMap((rule) => rule.names);
  for (const syscall of [
    "io_uring_setup",
    "io_uring_enter",
    "io_uring_register",
    "socket",
  ]) {
    assert.ok(denied.includes(syscall), `production Build seccomp policy must cover ${syscall}`);
  }
  const socketRules = value.config.linux.seccomp.syscalls.filter(
    (rule) => rule.names.length === 1 && rule.names[0] === "socket",
  );
  assert.deepEqual(
    socketRules.map((rule) => rule.args?.[0]?.value).sort((left, right) => (left ?? 0) - (right ?? 0)),
    [17, 40],
    "Build policy must deny AF_PACKET and AF_VSOCK by domain",
  );
}

async function readCgroupPids(): Promise<number[]> {
  try {
    return (await readFile(`${cgroupPath}/cgroup.procs`, "utf8"))
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readCgroupPopulation(): Promise<number> {
  const events = await readFile(`${cgroupPath}/cgroup.events`, "utf8");
  const match = events.match(/^populated\s+([01])$/m);
  assert.ok(match, `malformed cgroup events at ${cgroupPath}`);
  return Number(match[1]);
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  await waitFor(async () => existsSync(path), timeoutMs);
  assert.equal(existsSync(path), true, `timed out waiting for ${path}`);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
