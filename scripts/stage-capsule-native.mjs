#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyTreeNoLinks,
  sha256File,
  validateGuestRelease,
} from "../desktop/capsule-guest/scripts/release-contract.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function stageCapsuleNative(rootValue = defaultRoot, options = {}) {
  const root = resolve(rootValue);
  const source = resolve(
    options.sourceReleaseRoot
      ?? join(root, ".lamarck", "build", "capsule-guest", "release"),
  );
  const nativeRoot = resolve(
    options.nativeRoot
      ?? join(root, "desktop", "shell", "dist-electron", "native"),
  );
  if (source === nativeRoot || nativeRoot === root) {
    throw new Error("Capsule native staging paths must be distinct dedicated directories");
  }
  const helper = join(nativeRoot, "lamarck-capsule-vm-host");
  const destination = join(nativeRoot, "capsule-guest");
  await requireExecutableHelper(helper);
  const sourceRelease = await validateGuestRelease(source);
  await mkdir(nativeRoot, { recursive: true, mode: 0o755 });

  try {
    const existingRelease = await validateGuestRelease(destination);
    const [sourceCompliance, existingCompliance] = await Promise.all([
      sha256File(join(sourceRelease.bundle, "compliance-manifest.json")),
      sha256File(join(existingRelease.bundle, "compliance-manifest.json")),
    ]);
    if (
      existingRelease.descriptor.manifestDigest === sourceRelease.descriptor.manifestDigest
      && sourceCompliance === existingCompliance
    ) return destination;
    throw new Error("a different Capsule Guest release is already staged; refusing to overwrite it");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      const details = await lstatIfPresent(destination);
      if (details) throw error;
    }
  }

  const stagingParent = await mkdtemp(join(nativeRoot, ".capsule-guest-stage-"));
  const stagingRelease = join(stagingParent, "release");
  try {
    await copyTreeNoLinks(source, stagingRelease);
    await validateGuestRelease(stagingRelease);
    try {
      await rename(stagingRelease, destination);
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
        throw new Error("Capsule Guest stage destination appeared concurrently; refusing to overwrite it");
      }
      throw error;
    }
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
  return destination;
}

async function requireExecutableHelper(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || (details.mode & 0o111) === 0) {
      throw new Error("Capsule VM helper is not a real executable file");
    }
  } finally {
    await handle.close();
  }
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = await stageCapsuleNative(defaultRoot, {
    sourceReleaseRoot: process.env.LAMARCK_GUEST_RELEASE_ROOT,
    nativeRoot: process.env.LAMARCK_CAPSULE_NATIVE_ROOT,
  });
  process.stdout.write(`${destination}\n`);
}
