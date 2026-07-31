import { createRequire } from "node:module";
import { clearMutableBytes } from "../reduce";
import { DEVICE_IDENTITY_NATIVE_RESOURCE_PATH } from "../native/resource-path.mjs";

// Frozen by the v1 adapter contract. Any change is an identity-boundary review.
export const WINDOWS_SYSTEM_ID_MAX_BYTES = 1024;
export const WINDOWS_IDENTITY_UNAVAILABLE_REASON =
  "The Windows system identifier is unavailable.";

const ACCEPTED_WINDOWS_SOURCES = new Set(["Tpm", "Uefi", "Registry"]);

export type WindowsMachineIdentifierState =
  | { status: "resolved"; bytes: Buffer }
  | { status: "unavailable"; reason: string };

export type WindowsNativeBoundary = {
  getSystemIdForPublisher(): unknown;
};

type WindowsNativeResult = {
  source?: unknown;
  id?: unknown;
};

const require = createRequire(import.meta.url);

function loadNativeBoundary(): WindowsNativeBoundary {
  return require(DEVICE_IDENTITY_NATIVE_RESOURCE_PATH) as WindowsNativeBoundary;
}

function unavailable(): WindowsMachineIdentifierState {
  return { status: "unavailable", reason: WINDOWS_IDENTITY_UNAVAILABLE_REASON };
}

function isObject(value: unknown): value is WindowsNativeResult {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readWindowsMachineIdentifier(
  nativeBoundary?: WindowsNativeBoundary,
): Promise<WindowsMachineIdentifierState> {
  let candidate: unknown;
  let identifier: unknown;
  try {
    const boundary = nativeBoundary ?? loadNativeBoundary();
    candidate = boundary.getSystemIdForPublisher();
    if (!isObject(candidate)) {
      clearMutableBytes(candidate);
      return unavailable();
    }

    identifier = candidate.id;
    if (!ACCEPTED_WINDOWS_SOURCES.has(candidate.source as string)) {
      clearMutableBytes(identifier);
      return unavailable();
    }
    if (
      !Buffer.isBuffer(identifier)
      || identifier.length === 0
      || identifier.length > WINDOWS_SYSTEM_ID_MAX_BYTES
    ) {
      clearMutableBytes(identifier);
      return unavailable();
    }
    return { status: "resolved", bytes: identifier };
  } catch {
    clearMutableBytes(identifier);
    clearMutableBytes(candidate);
    return unavailable();
  }
}
