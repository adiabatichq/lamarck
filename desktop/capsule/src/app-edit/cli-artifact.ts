import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import type { Writable } from "node:stream";
import { CliStreamReader, encodeCliFrame, parseCliFrame, writeCliBytes } from "@lamarck/cli/transport";

export const MANAGED_CLI_MAX_BYTES = 16 * 1024 * 1024;
export const MANAGED_CLI_FILENAME = "lamarck-managed.mjs";

export interface ManagedCliArtifactV1 {
  readonly type: "cli.artifact";
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly bytes: number;
}

export function parseManagedCliArtifact(value: unknown): ManagedCliArtifactV1 {
  const raw = value as Partial<ManagedCliArtifactV1> | null;
  if (!raw || Array.isArray(raw)
    || Object.keys(raw).sort().join(",") !== "bytes,digest,schemaVersion,type"
    || raw.type !== "cli.artifact" || raw.schemaVersion !== 1
    || typeof raw.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw.digest)
    || !Number.isSafeInteger(raw.bytes) || raw.bytes! < 1 || raw.bytes! > MANAGED_CLI_MAX_BYTES) {
    throw new Error("Managed CLI artifact is missing or has an invalid descriptor");
  }
  return raw as ManagedCliArtifactV1;
}

export function verifyManagedCliBytes(descriptor: ManagedCliArtifactV1, bytes: Uint8Array): void {
  parseManagedCliArtifact(descriptor);
  if (bytes.byteLength !== descriptor.bytes
    || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== descriptor.digest) {
    throw new Error("Managed CLI artifact integrity verification failed");
  }
}

/** Sent only on the ticket-authenticated Host stream, before capabilities. */
export async function writeManagedCliArtifact(
  stream: Writable,
  artifact: { descriptor: ManagedCliArtifactV1; bytes: Uint8Array },
): Promise<void> {
  verifyManagedCliBytes(artifact.descriptor, artifact.bytes);
  await writeCliBytes(stream, encodeCliFrame(artifact.descriptor));
  await writeCliBytes(stream, artifact.bytes);
}

/** The caller owns the private bridge directory; no App-selected paths. */
export async function receiveManagedCliArtifact(reader: CliStreamReader, bridgeRoot: string): Promise<void> {
  const descriptor = parseManagedCliArtifact(parseCliFrame(await reader.readFrame()));
  const bytes = await reader.readExact(descriptor.bytes);
  verifyManagedCliBytes(descriptor, bytes);
  const path = `${bridgeRoot}/${MANAGED_CLI_FILENAME}`;
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o500);
  try {
    await file.writeFile(bytes);
    await file.chmod(0o555);
    await file.sync();
  } catch (error) {
    await unlink(path);
    throw error;
  } finally {
    await file.close();
  }
}
