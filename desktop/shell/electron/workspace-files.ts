import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isCanonicalWorkspaceVaultVerifier } from "./workspace-vault-crypto";
import { isWorkspaceVaultId } from "./workspace-vault-state";

export interface WorkspaceDescriptor {
  path: string;
  vaultId: string;
}

export type WorkspaceValidationCode =
  | "WORKSPACE_PATH_REQUIRED"
  | "WORKSPACE_PATH_INVALID"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_DIRECTORY"
  | "WORKSPACE_NOT_INITIALIZED"
  | "WORKSPACE_SETTINGS_INVALID"
  | "WORKSPACE_ID_INVALID"
  | "WORKSPACE_VAULT_VERIFIER_INVALID"
  | "WORKSPACE_ALREADY_EXISTS"
  | "WORKSPACE_RESERVED_CONTENT"
  | "WORKSPACE_NOT_EMPTY";

export class WorkspaceValidationError extends Error {
  constructor(
    readonly code: WorkspaceValidationCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceValidationError";
  }
}

const CREATE_IGNORED_ENTRIES = new Set([".DS_Store"]);
const WORKSPACE_RESERVED_ENTRIES = new Set([
  ".lamarck",
  "apps",
  "connectors",
  "pages",
]);

export function normalizeWorkspacePath(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    throw new WorkspaceValidationError(
      "WORKSPACE_PATH_REQUIRED",
      "Workspace path is required",
    );
  }
  if (normalized === "~") {
    return resolve(homedir());
  }
  if (normalized.startsWith("~/")) {
    return join(homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("~")) {
    throw new WorkspaceValidationError(
      "WORKSPACE_PATH_INVALID",
      'Workspace paths may use "~" or "~/…", but not named-home shortcuts such as "~other"',
    );
  }
  return resolve(normalized);
}

export function inspectWorkspaceForOpen(input: string): WorkspaceDescriptor {
  const requestedPath = normalizeWorkspacePath(input);
  if (!existsSync(requestedPath)) {
    throw new WorkspaceValidationError(
      "WORKSPACE_NOT_FOUND",
      "Workspace folder does not exist",
    );
  }
  if (!statSync(requestedPath).isDirectory()) {
    throw new WorkspaceValidationError(
      "WORKSPACE_NOT_DIRECTORY",
      "Workspace path must be a folder",
    );
  }

  const path = realpathSync(requestedPath);
  const settingsPath = join(path, ".lamarck", "settings.json");
  if (!existsSync(settingsPath)) {
    throw new WorkspaceValidationError(
      "WORKSPACE_NOT_INITIALIZED",
      "This folder is not an initialized Lamarck Workspace",
    );
  }
  if (!statSync(settingsPath).isFile()) {
    throw new WorkspaceValidationError(
      "WORKSPACE_SETTINGS_INVALID",
      "Workspace settings must be a regular file",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new WorkspaceValidationError(
      "WORKSPACE_SETTINGS_INVALID",
      "Workspace settings are not valid JSON",
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspaceValidationError(
      "WORKSPACE_SETTINGS_INVALID",
      "Workspace settings must be a JSON object",
    );
  }

  const vaultId = (parsed as { vaultId?: unknown }).vaultId;
  if (!isWorkspaceVaultId(vaultId)) {
    throw new WorkspaceValidationError(
      "WORKSPACE_ID_INVALID",
      "Workspace ID is missing or invalid",
    );
  }
  const vaultKeyVerifier = (parsed as { vaultKeyVerifier?: unknown }).vaultKeyVerifier;
  if (!isCanonicalWorkspaceVaultVerifier(vaultKeyVerifier)) {
    throw new WorkspaceValidationError(
      "WORKSPACE_VAULT_VERIFIER_INVALID",
      "Workspace vault key verifier is missing or invalid",
    );
  }
  return Object.freeze({ path, vaultId });
}

export function inspectWorkspaceForCreate(input: string): string {
  const requestedPath = normalizeWorkspacePath(input);
  if (existsSync(requestedPath)) {
    if (!statSync(requestedPath).isDirectory()) {
      throw new WorkspaceValidationError(
        "WORKSPACE_NOT_DIRECTORY",
        "Workspace path must be a folder",
      );
    }
    const entries = readdirSync(requestedPath)
      .filter((entry) => !CREATE_IGNORED_ENTRIES.has(entry));
    if (entries.length > 0) {
      const normalizedEntries = new Set(entries.map((entry) => entry.toLowerCase()));
      if (normalizedEntries.has(".lamarck")) {
        throw new WorkspaceValidationError(
          "WORKSPACE_ALREADY_EXISTS",
          "This folder is already a Lamarck Workspace. Use Open Workspace instead.",
        );
      }
      const reserved = [...normalizedEntries]
        .filter((entry) => WORKSPACE_RESERVED_ENTRIES.has(entry))
        .sort();
      if (reserved.length > 0) {
        throw new WorkspaceValidationError(
          "WORKSPACE_RESERVED_CONTENT",
          `This folder contains Lamarck-reserved content (${reserved.join(", ")}). Create Workspace will not modify it.`,
        );
      }
      throw new WorkspaceValidationError(
        "WORKSPACE_NOT_EMPTY",
        "Create Workspace requires an empty folder",
      );
    }
    return realpathSync(requestedPath);
  }
  return requestedPath;
}

export function initializeWorkspaceDirectory(
  input: string,
  options: {
    finalize?: (path: string) => void;
  } = {},
): string {
  const requestedPath = inspectWorkspaceForCreate(input);
  const rootAlreadyExisted = existsSync(requestedPath);
  const createdEntries: string[] = [];
  let createdRoot = false;

  try {
    if (!rootAlreadyExisted) {
      mkdirSync(requestedPath, { recursive: true });
      createdRoot = true;
    }

    const path = realpathSync(requestedPath);
    for (const entry of [".lamarck", "apps", "connectors", "pages"]) {
      const entryPath = join(path, entry);
      mkdirSync(entryPath);
      createdEntries.push(entryPath);
    }
    options.finalize?.(path);
    return path;
  } catch (error) {
    const rollbackErrors: unknown[] = [];

    for (const entryPath of createdEntries.reverse()) {
      try {
        rmSync(entryPath, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (createdRoot && existsSync(requestedPath)) {
      try {
        if (readdirSync(requestedPath).length === 0) {
          rmdirSync(requestedPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Workspace creation failed and could not be fully rolled back",
        { cause: error },
      );
    }
    throw error;
  }
}
