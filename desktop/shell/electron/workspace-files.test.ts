import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  WorkspaceValidationError,
  initializeWorkspaceDirectory,
  inspectWorkspaceForOpen,
  normalizeWorkspacePath,
  validateWorkspaceFilesMountPath,
} from "./workspace-files";
import { createWorkspaceVaultVerifier } from "./workspace-vault-crypto";

const roots: string[] = [];
const VAULT_ID = "AbCdEfGhIjKlMnOpQrStUv";
const RECOVERY_CODE = Buffer.alloc(32, 7).toString("base64url");
const VAULT_KEY_VERIFIER = createWorkspaceVaultVerifier(VAULT_ID, RECOVERY_CODE);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lamarck-workspace-files-"));
  roots.push(root);
  return root;
}

function expectCode(operation: () => unknown, code: WorkspaceValidationError["code"]): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceValidationError);
    expect((error as WorkspaceValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("Workspace filesystem lifecycle", () => {
  test("expands only unambiguous home-relative Workspace paths", () => {
    expect(normalizeWorkspacePath(" ~ ")).toBe(resolve(homedir()));
    expect(normalizeWorkspacePath("~/Lamarck")).toBe(join(homedir(), "Lamarck"));
    expect(normalizeWorkspacePath("~/Workspaces/../Lamarck")).toBe(
      join(homedir(), "Lamarck"),
    );
    expectCode(
      () => normalizeWorkspacePath("~another-user/Lamarck"),
      "WORKSPACE_PATH_INVALID",
    );
  });

  test("creates a deterministic empty Workspace without copying Host state", () => {
    const root = temporaryRoot();
    const target = join(root, "new-workspace");
    const path = initializeWorkspaceDirectory(target);

    expect(readdirSync(path).sort()).toEqual([".lamarck", "apps", "connectors", "pages"]);
    expect(readdirSync(join(path, ".lamarck"))).toEqual([]);
    expect(readdirSync(join(path, "apps"))).toEqual([]);
    expect(readdirSync(join(path, "connectors"))).toEqual([]);
  });

  test("accepts an empty folder and harmless Finder metadata", () => {
    const root = temporaryRoot();
    const target = join(root, "empty");
    mkdirSync(target);
    writeFileSync(join(target, ".DS_Store"), "");

    initializeWorkspaceDirectory(target);

    expect(readdirSync(target).sort()).toEqual([
      ".DS_Store",
      ".lamarck",
      "apps",
      "connectors",
      "pages",
    ]);
  });

  test("rolls back a failed finalize and preserves existing Finder metadata", () => {
    const root = temporaryRoot();
    const target = join(root, "empty");
    mkdirSync(target);
    writeFileSync(join(target, ".DS_Store"), "existing metadata");
    const failure = new Error("settings write failed");

    expect(() => initializeWorkspaceDirectory(target, {
      finalize(path) {
        writeFileSync(join(path, ".lamarck", "settings.json"), "partial");
        throw failure;
      },
    })).toThrow(failure);

    expect(readdirSync(target)).toEqual([".DS_Store"]);
    expect(readFileSync(join(target, ".DS_Store"), "utf8")).toBe("existing metadata");

    const path = initializeWorkspaceDirectory(target, {
      finalize(finalizedPath) {
        writeFileSync(
          join(finalizedPath, ".lamarck", "settings.json"),
          JSON.stringify({
            vaultId: VAULT_ID,
            vaultKeyVerifier: VAULT_KEY_VERIFIER,
          }),
        );
      },
    });
    expect(inspectWorkspaceForOpen(path)).toEqual({
      path: realpathSync(target),
      vaultId: VAULT_ID,
    });
  });

  test("refuses existing, reserved, and generic non-empty targets without modifying them", () => {
    const root = temporaryRoot();

    const existing = join(root, "existing");
    mkdirSync(join(existing, ".lamarck"), { recursive: true });
    expectCode(
      () => initializeWorkspaceDirectory(existing),
      "WORKSPACE_ALREADY_EXISTS",
    );
    expect(readdirSync(existing)).toEqual([".lamarck"]);

    const reserved = join(root, "reserved");
    mkdirSync(join(reserved, "pages"), { recursive: true });
    expectCode(
      () => initializeWorkspaceDirectory(reserved),
      "WORKSPACE_RESERVED_CONTENT",
    );
    expect(readdirSync(reserved)).toEqual(["pages"]);

    const nonempty = join(root, "nonempty");
    mkdirSync(nonempty);
    writeFileSync(join(nonempty, "notes.txt"), "mine");
    expectCode(
      () => initializeWorkspaceDirectory(nonempty),
      "WORKSPACE_NOT_EMPTY",
    );
    expect(readdirSync(nonempty)).toEqual(["notes.txt"]);
  });

  test("opens only an initialized folder with a valid Workspace ID", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, ".lamarck"), { recursive: true });
    writeFileSync(
      join(workspace, ".lamarck", "settings.json"),
      JSON.stringify({
        vaultId: VAULT_ID,
        vaultKeyVerifier: VAULT_KEY_VERIFIER,
      }),
    );

    expect(inspectWorkspaceForOpen(workspace)).toEqual({
      path: realpathSync(workspace),
      vaultId: VAULT_ID,
    });

    const missing = join(root, "missing");
    expectCode(() => inspectWorkspaceForOpen(missing), "WORKSPACE_NOT_FOUND");

    const uninitialized = join(root, "uninitialized");
    mkdirSync(uninitialized);
    expectCode(() => inspectWorkspaceForOpen(uninitialized), "WORKSPACE_NOT_INITIALIZED");

    writeFileSync(
      join(workspace, ".lamarck", "settings.json"),
      JSON.stringify({
        vaultId: "not-an-id",
        vaultKeyVerifier: VAULT_KEY_VERIFIER,
      }),
    );
    expectCode(() => inspectWorkspaceForOpen(workspace), "WORKSPACE_ID_INVALID");

    writeFileSync(
      join(workspace, ".lamarck", "settings.json"),
      JSON.stringify({ vaultId: VAULT_ID }),
    );
    expectCode(
      () => inspectWorkspaceForOpen(workspace),
      "WORKSPACE_VAULT_VERIFIER_INVALID",
    );

    writeFileSync(
      join(workspace, ".lamarck", "settings.json"),
      JSON.stringify({
        vaultId: VAULT_ID,
        vaultKeyVerifier: "not-a-verifier",
      }),
    );
    expectCode(
      () => inspectWorkspaceForOpen(workspace),
      "WORKSPACE_VAULT_VERIFIER_INVALID",
    );
  });

  test("accepts only the canonical physical Workspace files directory for VM mounting", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    const files = join(workspace, "files");
    mkdirSync(files, { recursive: true });

    expect(validateWorkspaceFilesMountPath(workspace)).toBe(realpathSync(files));

    const workspaceAlias = join(root, "workspace-alias");
    symlinkSync(workspace, workspaceAlias);
    expect(validateWorkspaceFilesMountPath(workspaceAlias)).toBe(realpathSync(files));

    rmSync(files, { recursive: true });
    const external = join(root, "external-files");
    mkdirSync(external);
    symlinkSync(external, files);
    expect(() => validateWorkspaceFilesMountPath(workspace)).toThrow("physical directory");

    rmSync(files);
    writeFileSync(files, "not a directory");
    expect(() => validateWorkspaceFilesMountPath(workspace)).toThrow("physical directory");
  });
});
