import { createHash } from "node:crypto";

export const DEVICE_IDENTITY_DOMAIN = "lamarck.device-identity.v1";

export const DEVICE_IDENTITY_SCHEMES = {
  darwin: "gethostuuid.v1",
  win32: "sysid-publisher.v1",
  linux: "machine-id.v1",
} as const;

export type DeviceIdentityPlatform = keyof typeof DEVICE_IDENTITY_SCHEMES;
export type DeviceIdentityScheme = (typeof DEVICE_IDENTITY_SCHEMES)[DeviceIdentityPlatform];

const CANONICAL_VAULT_ID = /^[A-Za-z0-9_-]{22}$/;
const DEVICE_IDENTITY_BYTES = 16;

export function isCanonicalVaultId(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_VAULT_ID.test(value)) return false;

  const decoded = Buffer.from(value, "base64url");
  try {
    return decoded.length === 16 && decoded.toString("base64url") === value;
  } finally {
    decoded.fill(0);
  }
}

function assertFramingInputs(
  platform: DeviceIdentityPlatform,
  scheme: DeviceIdentityScheme,
  vaultId: string,
  rawIdentifier: Buffer,
): void {
  if (!Object.hasOwn(DEVICE_IDENTITY_SCHEMES, platform)) {
    throw new TypeError("Invalid device identity platform.");
  }
  if (DEVICE_IDENTITY_SCHEMES[platform] !== scheme) {
    throw new TypeError("Invalid device identity scheme.");
  }
  if (!isCanonicalVaultId(vaultId)) {
    throw new TypeError("Invalid workspace vault identity.");
  }
  if (!Buffer.isBuffer(rawIdentifier) || rawIdentifier.length === 0) {
    throw new TypeError("Invalid platform machine identifier.");
  }
}

export function clearMutableBytes(value: unknown): void {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value.fill(0);
}

export function frameDeviceIdentity(
  platform: DeviceIdentityPlatform,
  scheme: DeviceIdentityScheme,
  vaultId: string,
  rawIdentifier: Buffer,
): Buffer {
  assertFramingInputs(platform, scheme, vaultId, rawIdentifier);
  const prefix = Buffer.from(
    `${DEVICE_IDENTITY_DOMAIN}\0${platform}\0${scheme}\0${vaultId}\0`,
    "utf8",
  );
  try {
    return Buffer.concat([prefix, rawIdentifier]);
  } finally {
    prefix.fill(0);
  }
}

export function reduceDeviceIdentity(
  platform: DeviceIdentityPlatform,
  scheme: DeviceIdentityScheme,
  vaultId: string,
  rawIdentifier: Buffer,
): string {
  let framed: Buffer | undefined;
  let digest: Buffer | undefined;
  try {
    framed = frameDeviceIdentity(platform, scheme, vaultId, rawIdentifier);
    digest = createHash("sha256").update(framed).digest();
    return digest.subarray(0, DEVICE_IDENTITY_BYTES).toString("hex");
  } finally {
    clearMutableBytes(digest);
    clearMutableBytes(framed);
    clearMutableBytes(rawIdentifier);
  }
}
