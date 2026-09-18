import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function assertMacOsReleaseHandoffIdentity(identity, expected) {
  if (!identity || !/^sha256:[a-f0-9]{64}$/.test(expected.builderImageId ?? "")
    || ["sourceManifestDigest", "version", "commit", "builderImageId"].some((key) => identity[key] !== expected[key])) {
    throw new Error("Shell handoff does not match this source, version, commit and CI builder");
  }
}

export async function buildShellFromSnapshot(snapshotRoot, exportRoot, manifestDigest, buildIdentity) {
  if (!/^sha256:[a-f0-9]{64}$/.test(manifestDigest)) {
    throw new Error("macOS release source snapshot digest is invalid");
  }
  const dockerfile = join(
    snapshotRoot,
    "desktop", "capsule-guest", "buildroot", "Dockerfile",
  );
  const dockerContext = dirname(dockerfile);
  const builderImageIdFile = join(dirname(exportRoot), "builder-image-id");
  run("docker", [
    "build",
    "--platform", "linux/arm64",
    "--file", dockerfile,
    "--iidfile", builderImageIdFile,
    dockerContext,
  ]);

  const builderImageId = (await readFile(builderImageIdFile, "utf8")).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(builderImageId)) {
    throw new Error("pinned macOS release builder has an invalid immutable image identity");
  }
  const user = `${process.getuid()}:${process.getgid()}`;
  run("docker", [
    "run", "--rm",
    "--platform", "linux/arm64",
    "--network", "bridge",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit", "512",
    "--memory", "12g",
    "--user", user,
    "--tmpfs", "/work:rw,nosuid,nodev,exec,size=8589934592,mode=1777",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=1073741824,mode=1777",
    "--volume", `${snapshotRoot}:/snapshot:ro`,
    "--volume", `${exportRoot}:/export:rw`,
    "--env", `LAMARCK_BUILDER_IMAGE_ID=${builderImageId}`,
    "--env", `LAMARCK_BUILD_VERSION=${buildIdentity.version}`,
    "--env", `LAMARCK_BUILD_COMMIT=${buildIdentity.commit}`,
    "--env", `LAMARCK_MARKETPLACE_SIGNING_KEY_ID=${process.env.LAMARCK_MARKETPLACE_SIGNING_KEY_ID}`,
    "--env", `LAMARCK_MARKETPLACE_SIGNING_PUBLIC_KEY=${process.env.LAMARCK_MARKETPLACE_SIGNING_PUBLIC_KEY}`,
    builderImageId,
    "/usr/local/bin/node",
    "/snapshot/scripts/build-macos-release-shell-inside.mjs",
    "/snapshot",
    "/export",
  ]);
  return builderImageId;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}
