import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import {
  WorkspaceVaultCryptoError,
  createWorkspaceVaultVerifier,
  isCanonicalWorkspaceVaultVerifier,
  normalizeRecoveryCode,
  validateWorkspaceVaultVerifier,
} from "./workspace-vault-crypto";

const VAULT_ID = "AbCdEfGhIjKlMnOpQrStUv";
const OTHER_VAULT_ID = "ZyXwVuTsRqPoNmLkJiHgFe";
const RECOVERY_CODE = Buffer.alloc(32, 1).toString("base64url");
const OTHER_RECOVERY_CODE = Buffer.alloc(32, 2).toString("base64url");

function expectCryptoCode(
  operation: () => unknown,
  code: WorkspaceVaultCryptoError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceVaultCryptoError);
    expect((error as WorkspaceVaultCryptoError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("Workspace vault recovery cryptography", () => {
  test("normalizes only surrounding whitespace around a canonical recovery code", () => {
    expect(RECOVERY_CODE).toHaveLength(43);
    expect(normalizeRecoveryCode(` \n${RECOVERY_CODE}\t`)).toBe(RECOVERY_CODE);
  });

  test("rejects padded, non-URL-safe, wrong-length, and non-canonical encodings", () => {
    expectCryptoCode(
      () => normalizeRecoveryCode(`${RECOVERY_CODE}=`),
      "RECOVERY_CODE_INVALID",
    );
    expectCryptoCode(
      () => normalizeRecoveryCode(`/${RECOVERY_CODE.slice(1)}`),
      "RECOVERY_CODE_INVALID",
    );
    expectCryptoCode(
      () => normalizeRecoveryCode(RECOVERY_CODE.slice(1)),
      "RECOVERY_CODE_INVALID",
    );

    const alternatePadBits = `${RECOVERY_CODE.slice(0, -1)}F`;
    expect(Buffer.from(alternatePadBits, "base64url")).toEqual(
      Buffer.from(RECOVERY_CODE, "base64url"),
    );
    expectCryptoCode(
      () => normalizeRecoveryCode(alternatePadBits),
      "RECOVERY_CODE_INVALID",
    );
  });

  test("creates a deterministic canonical verifier bound to the Workspace ID", () => {
    const verifier = createWorkspaceVaultVerifier(VAULT_ID, RECOVERY_CODE);

    expect(verifier).toBe("QnHV0j_1sub7CQ6LW9Lh5x4V-0fzyvuRjC_k5twshoE");
    expect(isCanonicalWorkspaceVaultVerifier(verifier)).toBe(true);
    expect(isCanonicalWorkspaceVaultVerifier(` ${verifier}`)).toBe(false);
    expect(createWorkspaceVaultVerifier(VAULT_ID, ` ${RECOVERY_CODE} `)).toBe(
      verifier,
    );
    expect(createWorkspaceVaultVerifier(OTHER_VAULT_ID, RECOVERY_CODE)).not.toBe(
      verifier,
    );
  });

  test("rejects an invalid Workspace ID when creating a verifier", () => {
    expectCryptoCode(
      () => createWorkspaceVaultVerifier("not-a-vault-id", RECOVERY_CODE),
      "WORKSPACE_ID_INVALID",
    );
  });

  test("validates only the matching recovery key, vault ID, and canonical verifier", () => {
    const verifier = createWorkspaceVaultVerifier(VAULT_ID, RECOVERY_CODE);

    expect(validateWorkspaceVaultVerifier(
      VAULT_ID,
      RECOVERY_CODE,
      verifier,
    )).toBe(true);
    expect(validateWorkspaceVaultVerifier(
      VAULT_ID,
      OTHER_RECOVERY_CODE,
      verifier,
    )).toBe(false);
    expect(validateWorkspaceVaultVerifier(
      OTHER_VAULT_ID,
      RECOVERY_CODE,
      verifier,
    )).toBe(false);
    expect(validateWorkspaceVaultVerifier(
      VAULT_ID,
      RECOVERY_CODE,
      `${verifier.slice(0, -1)}A`,
    )).toBe(false);
    expect(validateWorkspaceVaultVerifier(
      VAULT_ID,
      RECOVERY_CODE,
      `${verifier}=`,
    )).toBe(false);
    expect(validateWorkspaceVaultVerifier(
      "invalid",
      RECOVERY_CODE,
      verifier,
    )).toBe(false);
    expect(validateWorkspaceVaultVerifier(
      VAULT_ID,
      "invalid",
      verifier,
    )).toBe(false);
  });
});
