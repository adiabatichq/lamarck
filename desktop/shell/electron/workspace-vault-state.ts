export interface WorkspaceVaultSelection {
  generation: number;
  workspacePath: string;
  vaultId: string;
}

const WORKSPACE_VAULT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isWorkspaceVaultId(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_VAULT_ID_PATTERN.test(value);
}

/**
 * Keeps the selected Workspace identity separate from an unlocked plaintext
 * key. Beginning any Workspace/vault selection invalidates the prior key
 * before fallible port or Keychain work can run.
 */
export class WorkspaceVaultStateController {
  #generation = 0;
  #workspacePath = "";
  #vaultId = "";
  #vaultKey = "";

  begin(workspacePath: string, vaultId = ""): WorkspaceVaultSelection {
    this.#generation += 1;
    this.#workspacePath = workspacePath;
    this.#vaultId = vaultId;
    this.#vaultKey = "";
    return this.#selection();
  }

  current(workspacePath: string): WorkspaceVaultSelection | null {
    if (workspacePath !== this.#workspacePath) return null;
    return this.#selection();
  }

  unlock(selection: WorkspaceVaultSelection, vaultKey: string): boolean {
    if (
      selection.generation !== this.#generation
      || selection.workspacePath !== this.#workspacePath
      || selection.vaultId !== this.#vaultId
      || !selection.vaultId
      || !vaultKey
    ) return false;
    this.#vaultKey = vaultKey;
    return true;
  }

  recoveryCode(workspacePath: string): string {
    if (
      workspacePath !== this.#workspacePath
      || !this.#vaultId
      || !this.#vaultKey
    ) {
      throw new Error("Workspace vault is not unlocked");
    }
    return this.#vaultKey;
  }

  requireKey(workspacePath: string): string {
    return this.recoveryCode(workspacePath);
  }

  #selection(): WorkspaceVaultSelection {
    return Object.freeze({
      generation: this.#generation,
      workspacePath: this.#workspacePath,
      vaultId: this.#vaultId,
    });
  }
}

export function withEncryptedVaultRecord(
  records: Readonly<Record<string, string>>,
  vaultId: string,
  ciphertext: string,
): Record<string, string> {
  return { ...records, [vaultId]: ciphertext };
}
