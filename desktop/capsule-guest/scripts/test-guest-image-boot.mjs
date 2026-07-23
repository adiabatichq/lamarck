#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGuestRelease } from "./release-contract.mjs";
import { readDockerImageId } from "./docker-image-id.mjs";

const MARKER = "LAMARCK_GUEST_BOOT_SMOKE_OK";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const guestRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(guestRoot, "..", "..");
const releaseRoot = resolve(
  process.argv[2] ?? join(repoRoot, ".lamarck", "build", "capsule-guest", "release"),
);

const release = await validateGuestRelease(releaseRoot);
const kernel = join(release.bundle, artifactPath(release.manifest, "kernel"));
const rootfs = join(release.bundle, artifactPath(release.manifest, "rootfs"));
const scratch = await mkdtemp(join(tmpdir(), "lamarck-guest-boot-"));
const state = join(scratch, "state.ext4");

let dockerContainer;
try {
  const stateHandle = await open(state, "wx", 0o600);
  try {
    // Match CapsuleVmStateDiskManager.defaultSize. This remains a sparse Host
    // file but gives the supervisor the same admission headroom as a VZ boot.
    await stateHandle.truncate(8 * 1024 * 1024 * 1024);
  } finally {
    await stateHandle.close();
  }
  const commandLine = [
    "console=ttyAMA0",
    "root=/dev/vda",
    "rootwait",
    "ro",
    "panic=-1",
    `lamarck.image_digest=${release.descriptor.manifestDigest}`,
    "lamarck.state_device=/dev/vdb",
    "lamarck.state_label=LAMARCK_STATE",
    "lamarck.boot_smoke=1",
  ].join(" ");
  const qemuArgs = (imagePath, rootfsPath, statePath) => [
    "-machine", "virt,accel=tcg",
    "-cpu", "max",
    "-smp", "2",
    "-m", "2048",
    "-nographic",
    "-no-reboot",
    "-nic", "none",
    "-kernel", imagePath,
    "-append", commandLine,
    "-drive", `if=none,id=rootfs,format=raw,readonly=on,file=${rootfsPath}`,
    // QEMU's virt machine assigns implicit virtio-mmio devices from bus 31
    // downward, while Linux probes the device-tree MMIO nodes from bus 0
    // upward. Relying on command order therefore reverses rootfs/state into
    // vdb/vda. Pin both buses so the kernel contract remains vda/vdb.
    "-device", "virtio-blk-device,drive=rootfs,bus=virtio-mmio-bus.0",
    "-drive", `if=none,id=state,format=raw,file=${statePath}`,
    "-device", "virtio-blk-device,drive=state,bus=virtio-mmio-bus.1",
    "-device", "virtio-rng-device",
  ];

  let executable = process.env.LAMARCK_QEMU_AARCH64;
  let args;
  if (executable) {
    executable = resolve(executable);
    args = qemuArgs(kernel, rootfs, state);
  } else if (hasCommand("qemu-system-aarch64", ["--version"])) {
    executable = "qemu-system-aarch64";
    args = qemuArgs(kernel, rootfs, state);
  } else {
    requireCommand("docker", ["version"]);
    const imageIdFile = join(scratch, "qemu-builder-image-id");
    run("docker", [
      "build",
      "--platform", "linux/arm64",
      "--iidfile", imageIdFile,
      "-f", join(guestRoot, "test-boot", "Dockerfile"),
      join(guestRoot, "test-boot"),
    ]);
    const imageId = await readDockerImageId(imageIdFile);
    dockerContainer = `lamarck-qemu-smoke-${process.pid}-${randomBytes(6).toString("hex")}`;
    executable = "docker";
    args = [
      "run", "--rm",
      "--platform", "linux/arm64",
      "--name", dockerContainer,
      "--network", "none",
      "--read-only",
      "--user", dockerHostIdentity(),
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "256",
      "-v", `${release.bundle}:/release:ro`,
      "-v", `${scratch}:/scratch`,
      imageId,
      ...qemuArgs("/release/Image", "/release/rootfs.ext4", "/scratch/state.ext4"),
    ];
  }

  await runBoot(executable, args);
  process.stdout.write("signed Guest image QEMU TCG boot smoke passed\n");
} finally {
  if (dockerContainer) {
    spawnSync("docker", ["rm", "-f", dockerContainer], { stdio: "ignore" });
  }
  await rm(scratch, { recursive: true, force: true });
}

function artifactPath(manifest, role) {
  const artifact = manifest.artifacts.find((candidate) => candidate.role === role);
  if (!artifact) throw new Error(`Guest manifest is missing ${role}`);
  return artifact.path;
}

function hasCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function requireCommand(command, args) {
  if (!hasCommand(command, args)) {
    throw new Error(`Guest boot smoke requires ${command} or LAMARCK_QEMU_AARCH64`);
  }
}

function dockerHostIdentity() {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("Guest boot smoke Docker fallback requires a POSIX Host UID and GID");
  }
  return `${uid}:${gid}`;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

async function runBoot(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let markerSeen = false;
  let outputBytes = 0;
  let tail = "";
  const consume = (chunk, target) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      child.kill("SIGKILL");
      return;
    }
    target.write(chunk);
    tail = `${tail}${chunk.toString("utf8")}`.slice(-16 * 1024);
    if (tail.includes(MARKER)) markerSeen = true;
  };
  child.stdout.on("data", (chunk) => consume(chunk, process.stdout));
  child.stderr.on("data", (chunk) => consume(chunk, process.stderr));

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, TIMEOUT_MS);
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  clearTimeout(timeout);
  if (timedOut) throw new Error("Guest boot smoke timed out");
  if (outputBytes > MAX_OUTPUT_BYTES) throw new Error("Guest boot smoke output exceeded its bound");
  if (!markerSeen) throw new Error("Guest boot smoke exited without its success marker");
  if (result.code !== 0) {
    throw new Error(`Guest boot smoke exited with ${result.code ?? result.signal}`);
  }
}
