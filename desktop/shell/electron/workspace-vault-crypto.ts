import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { isWorkspaceVaultId } from "./workspace-vault-state";

const CANONICAL_32_BYTE_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WORKSPACE_VAULT_VERIFIER_DOMAIN = Buffer.from(
  "lamarck.workspace-vault-verifier.v1\0",
  "utf8",
);

export type WorkspaceVaultCryptoErrorCode =
  | "RECOVERY_CODE_INVALID"
  | "WORKSPACE_ID_INVALID";

export class WorkspaceVaultCryptoError extends Error {
  constructor(
    readonly code: WorkspaceVaultCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceVaultCryptoError";
  }
}

interface CanonicalBase64UrlValue {
  bytes: Buffer;
  value: string;
}

function decodeCanonical32ByteBase64Url(
  input: unknown,
  options: { trim: boolean },
): CanonicalBase64UrlValue | null {
  if (typeof input !== "string") return null;
  const value = options.trim ? input.trim() : input;
  if (!CANONICAL_32_BYTE_BASE64URL_PATTERN.test(value)) return null;

  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.byteLength !== 32
    || bytes.toString("base64url") !== value
  ) {
    return null;
  }
  return { bytes, value };
}

function requireWorkspaceVaultId(vaultId: unknown): asserts vaultId is string {
  if (!isWorkspaceVaultId(vaultId)) {
    throw new WorkspaceVaultCryptoError(
      "WORKSPACE_ID_INVALID",
      "Workspace ID is missing or invalid",
    );
  }
}

/**
 * Returns the canonical, unpadded base64url form of a 32-byte recovery key.
 * Only surrounding whitespace is normalized; padded or otherwise ambiguous
 * encodings are rejected.
 */
export function normalizeRecoveryCode(input: unknown): string {
  const decoded = decodeCanonical32ByteBase64Url(input, { trim: true });
  if (!decoded) {
    throw new WorkspaceVaultCryptoError(
      "RECOVERY_CODE_INVALID",
      "Recovery code must be a canonical 32-byte base64url value",
    );
  }
  return decoded.value;
}

/**
 * Creates the Workspace-owned verifier persisted alongside the vault ID.
 * The domain prefix prevents this digest from being reused as another HMAC,
 * while the vault ID prevents a verifier from authenticating another vault.
 */
export function createWorkspaceVaultVerifier(
  vaultId: string,
  recoveryCode: string,
): string {
  requireWorkspaceVaultId(vaultId);
  const normalizedRecoveryCode = normalizeRecoveryCode(recoveryCode);
  const key = Buffer.from(normalizedRecoveryCode, "base64url");

  return createHmac("sha256", key)
    .update(WORKSPACE_VAULT_VERIFIER_DOMAIN)
    .update(vaultId, "utf8")
    .digest("base64url");
}

export function isCanonicalWorkspaceVaultVerifier(
  input: unknown,
): input is string {
  return decodeCanonical32ByteBase64Url(input, { trim: false }) !== null;
}

/**
 * Authenticates a recovery key without persisting it. Malformed input is a
 * normal validation failure; valid verifier bytes are compared in constant
 * time.
 */
export function validateWorkspaceVaultVerifier(
  vaultId: string,
  recoveryCode: string,
  verifier: unknown,
): boolean {
  try {
    const expected = decodeCanonical32ByteBase64Url(verifier, { trim: false });
    if (!expected) return false;

    const actual = Buffer.from(
      createWorkspaceVaultVerifier(vaultId, recoveryCode),
      "base64url",
    );
    return timingSafeEqual(actual, expected.bytes);
  } catch {
    return false;
  }
}
