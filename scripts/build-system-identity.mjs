import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function resolveBuildSystemIdentity({
  root: rootValue,
  env = process.env,
  requireClean = false,
} = {}) {
  const root = resolve(rootValue ?? process.cwd());
  const packageValue = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = boundedValue(
    env.LAMARCK_BUILD_VERSION ?? env.LAMARCK_RELEASE_VERSION ?? packageValue.version,
    "Lamarck build version",
  );

  const suppliedCommit = env.LAMARCK_BUILD_COMMIT;
  const headCommit = requireClean
    ? runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim()
    : undefined;
  let commit = suppliedCommit ?? headCommit;
  if (commit === undefined) {
    commit = runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  }
  if (!FULL_COMMIT_PATTERN.test(commit)) {
    throw new Error("Lamarck build commit must be a full lowercase Git commit");
  }

  if (requireClean) {
    if (commit !== headCommit) {
      throw new Error("Lamarck build commit must match the checked-out Git HEAD");
    }
    const status = runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.length > 0) {
      throw new Error("Lamarck release source must be a clean Git revision");
    }
  }

  return Object.freeze({ version, commit });
}

export function systemIdentityEsbuildDefine(identity) {
  const version = boundedValue(identity?.version, "Lamarck build version");
  if (!FULL_COMMIT_PATTERN.test(identity?.commit ?? "")) {
    throw new Error("Lamarck build commit must be a full lowercase Git commit");
  }
  return Object.freeze({
    __LAMARCK_PRODUCT_VERSION__: JSON.stringify(version),
    __LAMARCK_REPOSITORY_COMMIT__: JSON.stringify(identity.commit),
  });
}

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not resolve Lamarck Git identity: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function boundedValue(value, label) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 200
    || value.trim() !== value
    || value === "unknown"
    || /[\r\n\0]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
