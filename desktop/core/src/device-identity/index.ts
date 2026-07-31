import {
  DEVICE_IDENTITY_SCHEMES,
  clearMutableBytes,
  isCanonicalVaultId,
  reduceDeviceIdentity,
  type DeviceIdentityPlatform,
} from "./reduce";
import {
  DARWIN_IDENTITY_UNAVAILABLE_REASON,
  readDarwinMachineIdentifier,
  type DarwinMachineIdentifierState,
} from "./platform/darwin";
import {
  WINDOWS_IDENTITY_UNAVAILABLE_REASON,
  readWindowsMachineIdentifier,
  type WindowsMachineIdentifierState,
} from "./platform/win32";
import {
  LINUX_IDENTITY_UNAVAILABLE_REASON,
  readLinuxMachineIdentifier,
  type LinuxMachineIdentifierState,
} from "./platform/linux";

export type DeviceIdentityState =
  | { status: "resolved"; value: string }
  | { status: "unavailable"; reason: string };

type PlatformMachineIdentifierState =
  | DarwinMachineIdentifierState
  | WindowsMachineIdentifierState
  | LinuxMachineIdentifierState;

export type DeviceIdentityResolverOptions = {
  platform?: string;
  darwin?: () => Promise<PlatformMachineIdentifierState>;
  win32?: () => Promise<PlatformMachineIdentifierState>;
  linux?: () => Promise<PlatformMachineIdentifierState>;
};

export const INVALID_VAULT_IDENTITY_REASON =
  "The workspace vault identity is missing or invalid.";
export const UNSUPPORTED_DEVICE_PLATFORM_REASON =
  "Device identity is unsupported on this platform.";

const PLATFORM_UNAVAILABLE_REASONS: Record<DeviceIdentityPlatform, string> = {
  darwin: DARWIN_IDENTITY_UNAVAILABLE_REASON,
  win32: WINDOWS_IDENTITY_UNAVAILABLE_REASON,
  linux: LINUX_IDENTITY_UNAVAILABLE_REASON,
};

function unavailable(reason: string): DeviceIdentityState {
  return { status: "unavailable", reason };
}

export async function resolveDeviceIdentity(
  vaultId: string,
  options: DeviceIdentityResolverOptions = {},
): Promise<DeviceIdentityState> {
  if (!isCanonicalVaultId(vaultId)) return unavailable(INVALID_VAULT_IDENTITY_REASON);

  const platform = options.platform ?? process.platform;
  let read: (() => Promise<PlatformMachineIdentifierState>) | undefined;
  switch (platform) {
    case "darwin":
      read = options.darwin ?? readDarwinMachineIdentifier;
      break;
    case "win32":
      read = options.win32 ?? readWindowsMachineIdentifier;
      break;
    case "linux":
      read = options.linux ?? readLinuxMachineIdentifier;
      break;
    default:
      return unavailable(UNSUPPORTED_DEVICE_PLATFORM_REASON);
  }

  const supportedPlatform = platform as DeviceIdentityPlatform;
  let identifier: unknown;
  try {
    const state = await read();
    if (state.status !== "resolved") {
      return unavailable(PLATFORM_UNAVAILABLE_REASONS[supportedPlatform]);
    }
    identifier = state.bytes;
    if (!Buffer.isBuffer(identifier)) {
      return unavailable(PLATFORM_UNAVAILABLE_REASONS[supportedPlatform]);
    }
    return {
      status: "resolved",
      value: reduceDeviceIdentity(
        supportedPlatform,
        DEVICE_IDENTITY_SCHEMES[supportedPlatform],
        vaultId,
        identifier,
      ),
    };
  } catch {
    return unavailable(PLATFORM_UNAVAILABLE_REASONS[supportedPlatform]);
  } finally {
    clearMutableBytes(identifier);
  }
}
