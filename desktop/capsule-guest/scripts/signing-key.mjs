import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAXIMUM_KEY_BYTES = 64 * 1024;
const defaultRepositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/**
 * Read the production Guest signing key from the exact regular file selected
 * by the release operator. The key is deliberately opened without following a
 * final symlink and is never copied into a build snapshot or container mount.
 */
export async function readValidatedGuestSigningKey(
  keyValue,
  { repositoryRoot = defaultRepositoryRoot } = {},
) {
  if (typeof keyValue !== "string" || keyValue.length < 1 || keyValue.includes("\0")) {
    throw new Error("Guest signing key path is required");
  }
  const keyPath = resolve(keyValue);
  const repository = await realpath(resolve(repositoryRoot));
  if (isInside(repository, keyPath)) {
    throw new Error("Guest signing key must be outside the repository and every build mount");
  }

  let handle;
  try {
    handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    throw new Error("Guest signing key must be an available non-symlink file", { cause });
  }
  try {
    const before = await handle.stat({ bigint: true });
    const effectiveUid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : undefined;
    if (!before.isFile()) throw new Error("Guest signing key is not a regular file");
    if (effectiveUid === undefined || before.uid !== effectiveUid) {
      throw new Error("Guest signing key must be owned by the current user");
    }
    if ((before.mode & 0o777n) !== 0o600n) {
      throw new Error("Guest signing key permissions must be exactly 0600");
    }
    if (before.nlink !== 1n) {
      throw new Error("Guest signing key must have exactly one hard link");
    }
    if (before.size < 1n || before.size > BigInt(MAXIMUM_KEY_BYTES)) {
      throw new Error("Guest signing key has an unsupported size");
    }

    const resolvedKey = await realpath(keyPath);
    if (isInside(repository, resolvedKey)) {
      throw new Error("Guest signing key must remain outside the real repository path");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || before.nlink !== after.nlink
      || before.mode !== after.mode
      || before.uid !== after.uid
    ) {
      throw new Error("Guest signing key changed while it was read");
    }
    return Object.freeze({ path: keyPath, bytes });
  } finally {
    await handle.close();
  }
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
