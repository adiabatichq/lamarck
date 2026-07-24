import { describe, expect, test } from "vitest";
import {
  isWorkspaceVaultId,
  WorkspaceVaultStateController,
  withEncryptedVaultRecord,
} from "./workspace-vault-state";

describe("Workspace vault state", () => {
  test("accepts only canonical 128-bit base64url vault identities", () => {
    expect(isWorkspaceVaultId("AbCdEfGhIjKlMnOpQrStUv")).toBe(true);
    expect(isWorkspaceVaultId("__proto__")).toBe(false);
    expect(isWorkspaceVaultId("constructor")).toBe(false);
    expect(isWorkspaceVaultId("AbCdEfGhIjKlMnOpQrStU=")).toBe(false);
  });

  test("clears the old plaintext key as soon as another Workspace is selected", () => {
    const state = new WorkspaceVaultStateController();
    const workspaceA = state.begin("/workspace-a", "vault-a");
    expect(state.unlock(workspaceA, "key-a")).toBe(true);
    expect(state.recoveryCode("/workspace-a")).toBe("key-a");

    state.begin("/workspace-b", "vault-b");

    expect(() => state.recoveryCode("/workspace-a")).toThrow(
      "Workspace vault is not unlocked",
    );
    expect(() => state.recoveryCode("/workspace-b")).toThrow(
      "Workspace vault is not unlocked",
    );
  });

  test("rejects a stale Keychain result after the selection generation changes", () => {
    const state = new WorkspaceVaultStateController();
    const workspaceA = state.begin("/workspace-a", "vault-a");
    const workspaceB = state.begin("/workspace-b", "vault-b");

    expect(state.unlock(workspaceA, "key-a")).toBe(false);
    expect(state.unlock(workspaceB, "key-b")).toBe(true);
    expect(state.recoveryCode("/workspace-b")).toBe("key-b");
  });

  test("does not expose an unpublished first-run vault identity", () => {
    const state = new WorkspaceVaultStateController();
    const pending = state.begin("/new-workspace");

    expect(pending.vaultId).toBe("");
    expect(() => state.recoveryCode("/new-workspace")).toThrow(
      "Workspace vault is not unlocked",
    );
  });

  test("updates only the selected encrypted record", () => {
    const existing = Object.freeze({
      "vault-a": "ciphertext-a",
      "vault-other": "ciphertext-other",
    });

    const updated = withEncryptedVaultRecord(existing, "vault-b", "ciphertext-b");

    expect(updated).toEqual({
      "vault-a": "ciphertext-a",
      "vault-other": "ciphertext-other",
      "vault-b": "ciphertext-b",
    });
    expect(existing).toEqual({
      "vault-a": "ciphertext-a",
      "vault-other": "ciphertext-other",
    });
  });
});
