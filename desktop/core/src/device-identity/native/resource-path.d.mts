export const DEVICE_IDENTITY_NATIVE_DIRECTORY: "device-identity";
export const DEVICE_IDENTITY_NATIVE_FILENAME: "lamarck_device_identity.node";
export const DEVICE_IDENTITY_NATIVE_RESOURCE_PATH:
  "./native/device-identity/lamarck_device_identity.node";

export function deviceIdentityNativeAddonPath(nativeRoot: string): string;
export function assertDeviceIdentityNativeResourceLayout(
  bundleDirectory: string,
  nativeRoot: string,
): string;
