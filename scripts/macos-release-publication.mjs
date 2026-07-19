import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

export function compileRenameExclHelper(sourceValue, outputValue, options = {}) {
  const source = resolve(sourceValue);
  const output = resolve(outputValue);
  const platform = options.platform ?? process.platform;
  const command = platform === "darwin" ? "xcrun" : "cc";
  const args = platform === "darwin"
    ? ["clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output]
    : ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output];
  if (!new Set(["darwin", "linux"]).has(platform)) {
    throw new Error(`exclusive release publication is unsupported on ${platform}`);
  }
  run(command, args, options.spawnSync ?? spawnSync);
  return output;
}

export async function publishDirectoryNoReplace(
  sourceValue,
  destinationValue,
  helperValue,
  options = {},
) {
  const source = resolve(sourceValue);
  const destination = resolve(destinationValue);
  const helper = resolve(helperValue);
  await requireRealDirectory(source, "release publication source");
  const helperHandle = await open(helper, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await helperHandle.stat();
    if (!details.isFile() || details.nlink !== 1 || (details.mode & 0o111) === 0) {
      throw new Error("release publication helper is not an executable single-link regular file");
    }
  } finally {
    await helperHandle.close();
  }
  await options.beforeRename?.();
  run(helper, [source, destination], options.spawnSync ?? spawnSync);
}

async function requireRealDirectory(path, label) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
}

function run(command, args, spawn) {
  const result = spawn(command, args, {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with ${result.status ?? result.signal}: ${String(result.stderr ?? "").trim()}`,
    );
  }
}
