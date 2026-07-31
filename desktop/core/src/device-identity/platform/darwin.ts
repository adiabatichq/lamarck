import { createRequire } from "node:module";
import { clearMutableBytes } from "../reduce";
import { DEVICE_IDENTITY_NATIVE_RESOURCE_PATH } from "../native/resource-path.mjs";

export const DARWIN_HOST_UUID_TIMEOUT_SECONDS = 5;
export const DARWIN_IDENTITY_UNAVAILABLE_REASON =
  "The macOS machine identifier is unavailable.";

export type DarwinMachineIdentifierState =
  | { status: "resolved"; bytes: Buffer }
  | { status: "unavailable"; reason: string };

export type DarwinNativeBoundary = {
  getHostUuid(timeoutSeconds: number): unknown;
};

const require = createRequire(import.meta.url);

function loadNativeBoundary(): DarwinNativeBoundary {
  return require(DEVICE_IDENTITY_NATIVE_RESOURCE_PATH) as DarwinNativeBoundary;
}

function unavailable(): DarwinMachineIdentifierState {
  return { status: "unavailable", reason: DARWIN_IDENTITY_UNAVAILABLE_REASON };
}

export async function readDarwinMachineIdentifier(
  nativeBoundary?: DarwinNativeBoundary,
): Promise<DarwinMachineIdentifierState> {
  let candidate: unknown;
  try {
    const boundary = nativeBoundary ?? loadNativeBoundary();
    candidate = boundary.getHostUuid(DARWIN_HOST_UUID_TIMEOUT_SECONDS);
    if (!Buffer.isBuffer(candidate) || candidate.length !== 16) {
      clearMutableBytes(candidate);
      return unavailable();
    }
    if (candidate.every((byte) => byte === 0)) {
      candidate.fill(0);
      return unavailable();
    }
    return { status: "resolved", bytes: candidate };
  } catch {
    clearMutableBytes(candidate);
    return unavailable();
  }
}
