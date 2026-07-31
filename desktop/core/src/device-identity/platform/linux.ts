import { open } from "node:fs/promises";
import { clearMutableBytes } from "../reduce";

export const LINUX_MACHINE_ID_PATH = "/etc/machine-id";
export const LINUX_IDENTITY_UNAVAILABLE_REASON =
  "The Linux machine identifier is unavailable.";

const CANONICAL_MACHINE_ID_BYTES = 33;
const BOUNDED_READ_BYTES = CANONICAL_MACHINE_ID_BYTES + 1;

export type LinuxMachineIdentifierState =
  | { status: "resolved"; bytes: Buffer }
  | { status: "unavailable"; reason: string };

export type LinuxMachineIdReader = () => Promise<unknown>;

async function readMachineIdFile(): Promise<Buffer> {
  const handle = await open(LINUX_MACHINE_ID_PATH, "r");
  const scratch = Buffer.alloc(BOUNDED_READ_BYTES);
  let result: Buffer | undefined;
  try {
    const { bytesRead } = await handle.read(scratch, 0, scratch.length, 0);
    result = Buffer.from(scratch.subarray(0, bytesRead));
    return result;
  } catch (error) {
    clearMutableBytes(result);
    throw error;
  } finally {
    scratch.fill(0);
    try {
      await handle.close();
    } catch (error) {
      clearMutableBytes(result);
      throw error;
    }
  }
}

function decodeNibble(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

export function parseLinuxMachineId(contents: Buffer): Buffer {
  if (!Buffer.isBuffer(contents) || contents.length !== CANONICAL_MACHINE_ID_BYTES) {
    throw new TypeError("Invalid Linux machine identifier.");
  }
  if (contents[CANONICAL_MACHINE_ID_BYTES - 1] !== 0x0a) {
    throw new TypeError("Invalid Linux machine identifier.");
  }

  const decoded = Buffer.alloc(16);
  try {
    for (let index = 0; index < 16; index += 1) {
      const high = decodeNibble(contents[index * 2]);
      const low = decodeNibble(contents[index * 2 + 1]);
      if (high < 0 || low < 0) throw new TypeError("Invalid Linux machine identifier.");
      decoded[index] = (high << 4) | low;
    }
    if (decoded.every((byte) => byte === 0)) {
      throw new TypeError("Invalid Linux machine identifier.");
    }
    return decoded;
  } catch (error) {
    decoded.fill(0);
    throw error;
  }
}

function unavailable(): LinuxMachineIdentifierState {
  return { status: "unavailable", reason: LINUX_IDENTITY_UNAVAILABLE_REASON };
}

export async function readLinuxMachineIdentifier(
  reader: LinuxMachineIdReader = readMachineIdFile,
): Promise<LinuxMachineIdentifierState> {
  let contents: unknown;
  try {
    contents = await reader();
    if (!Buffer.isBuffer(contents)) {
      clearMutableBytes(contents);
      return unavailable();
    }
    return { status: "resolved", bytes: parseLinuxMachineId(contents) };
  } catch {
    return unavailable();
  } finally {
    clearMutableBytes(contents);
  }
}
