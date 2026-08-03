import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { validateFullGitCommit } from "./system-identity";

const execFile = promisify(execFileCallback);
const CAPSULE_EXCLUDED_ROOTS = new Set([".git", ".lamarck", "node_modules"]);

/**
 * Resolve the exact committed App activation used for capability issuance.
 * The Capsule excludes only its fixed private/dependency roots, so every
 * other path that can enter the activation must match HEAD exactly.
 */
export async function resolveCommittedAppRevision(appDir: string): Promise<string> {
  let repositoryRoot: string;
  let activationRoot: string;
  try {
    const [repository, resolvedActivationRoot] = await Promise.all([
      execFile(
        "git",
        ["-C", appDir, "rev-parse", "--show-toplevel"],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      ),
      realpath(appDir),
    ]);
    repositoryRoot = await realpath(repository.stdout.trim());
    activationRoot = resolvedActivationRoot;
  } catch (error) {
    throw new Error("App activation must be an accessible Git repository", { cause: error });
  }
  if (repositoryRoot !== activationRoot) {
    throw new Error("App activation must be the root of its Git repository");
  }

  let status: string;
  try {
    ({ stdout: status } = await execFile(
      "git",
      [
        "-C",
        appDir,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error("App activation must be an accessible Git repository", { cause: error });
  }

  const changes = parsePorcelainStatus(status).filter((path) => !isCapsuleExcluded(path));
  if (changes.length > 0) {
    throw new Error("App activation must exactly match a committed Git revision");
  }

  try {
    await execFile(
      "git",
      ["-C", appDir, "ls-files", "--error-unmatch", "--", "manifest.json"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    throw new Error("App activation manifest.json must belong to the committed revision", {
      cause: error,
    });
  }

  let commit: string;
  try {
    const result = await execFile(
      "git",
      ["-C", appDir, "rev-parse", "--verify", "HEAD^{commit}"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    commit = result.stdout.trim();
  } catch (error) {
    throw new Error("App activation has no committed Git revision", { cause: error });
  }
  return validateFullGitCommit(commit, "App activation commit");
}

function parsePorcelainStatus(status: string): string[] {
  if (status.length === 0) return [];
  const records = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("Git returned malformed App activation status");
    }
    const statusCode = record.slice(0, 2);
    paths.push(record.slice(3));
    if (statusCode.includes("R") || statusCode.includes("C")) {
      const sourcePath = records[++index];
      if (!sourcePath) throw new Error("Git returned malformed App rename status");
      paths.push(sourcePath);
    }
  }
  return paths;
}

function isCapsuleExcluded(path: string): boolean {
  const root = path.split("/", 1)[0];
  return CAPSULE_EXCLUDED_ROOTS.has(root);
}
