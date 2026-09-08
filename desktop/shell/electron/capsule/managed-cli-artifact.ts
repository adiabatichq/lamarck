import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  MANAGED_CLI_FILENAME,
  MANAGED_CLI_MAX_BYTES,
  parseManagedCliArtifact,
  verifyManagedCliBytes,
} from "@lamarck/capsule";

/** The directory is the signed Desktop bundle, never an App or npm location. */
export async function loadManagedCliArtifact(bundleDirectory: string) {
  const descriptor = parseManagedCliArtifact(JSON.parse(
    (await readArtifactFile(join(bundleDirectory, "managed-cli.json"), 4096)).toString("utf8"),
  ));
  const bytes = await readArtifactFile(join(bundleDirectory, MANAGED_CLI_FILENAME), MANAGED_CLI_MAX_BYTES);
  verifyManagedCliBytes(descriptor, bytes);
  return { descriptor, bytes };
}

async function readArtifactFile(path: string, maximum: number): Promise<Buffer> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) throw new Error("invalid size or file type");
      const bytes = await file.readFile();
      const after = await file.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("file changed while being read");
      return bytes;
    } finally { await file.close(); }
  } catch (cause) {
    throw new Error(`Managed CLI artifact is missing or invalid: ${path}`, { cause });
  }
}
