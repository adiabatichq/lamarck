import { join, resolve } from "node:path";

export const DEVICE_IDENTITY_NATIVE_DIRECTORY = "device-identity";
export const DEVICE_IDENTITY_NATIVE_FILENAME = "lamarck_device_identity.node";
export const DEVICE_IDENTITY_NATIVE_RESOURCE_PATH =
  `./native/${DEVICE_IDENTITY_NATIVE_DIRECTORY}/${DEVICE_IDENTITY_NATIVE_FILENAME}`;

export function deviceIdentityNativeAddonPath(nativeRoot) {
  return join(
    resolve(nativeRoot),
    DEVICE_IDENTITY_NATIVE_DIRECTORY,
    DEVICE_IDENTITY_NATIVE_FILENAME,
  );
}

export function assertDeviceIdentityNativeResourceLayout(bundleDirectory, nativeRoot) {
  const runtimePath = resolve(bundleDirectory, DEVICE_IDENTITY_NATIVE_RESOURCE_PATH);
  const stagedPath = resolve(deviceIdentityNativeAddonPath(nativeRoot));
  if (runtimePath !== stagedPath) {
    throw new Error("Device identity native resource does not match the Core lookup path.");
  }
  return stagedPath;
}
