import { constants } from "node:fs";
import { mkdir, open, readdir, rename, stat } from "fs/promises";
import { join } from "path";
import { validateD1Grant } from "@lamarck/system/internal/vfs";
import {
  APP_MANIFEST_MAX_BYTES,
  digestNormalizedAppManifest,
  type AppManifestDigest,
} from "../../capsule/src/app-manifest-authority";
import {
  ENTRY_ID_PATTERN,
  PACKAGE_ID_PATTERN,
  SCOPED_PACKAGE_ID_PATTERN,
} from "./package-id";

// App Loader — scans apps/ directory, reads manifests, builds registry.

export interface AppManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  description: string;
  createdFrom?: {
    packageId: string;
    releaseId: string;
  };
  runtime: {
    ui?: {
      command: string[];
      port: number;
    };
    services?: Record<string, AppWorkload>;
    jobs?: Record<string, AppWorkload>;
  };
  permissions: {
    writes: {
      // D1 file grants beyond the implicit home prefix `apps/<appId>/`.
      // Each grant is a path prefix ending in "/" or an exact real file path.
      files: string[];
      // D2 tables this app can write to.
      tables: string[];
    };
  };
}

export interface AppWorkload {
  command: string[];
}

export type AppWorkloadIdentity =
  | { kind: "ui" }
  | { kind: "service"; entryId: string }
  | { kind: "job"; entryId: string; runId?: string };

export interface LoadedApp {
  manifest: AppManifest;
  /** Digest of the exact normalized authority-bearing manifest snapshot. */
  manifestDigest: AppManifestDigest;
  dir: string;
}

export interface AppRegistry {
  apps: Map<string, LoadedApp>;
  getTableGrants(appId: string): string[];
  getFileGrants(appId: string): string[];
}

export type AppManifestValidationResult =
  | { ok: true; manifest: AppManifest }
  | { ok: false; error: string };

const MANIFEST_FIELDS = new Set([
  "manifestVersion",
  "id",
  "name",
  "description",
  "createdFrom",
  "runtime",
  "permissions",
]);
const RUNTIME_FIELDS = new Set(["ui", "services", "jobs"]);
const UI_FIELDS = new Set(["command", "port"]);
const WORKLOAD_FIELDS = new Set(["command"]);
const PERMISSION_FIELDS = new Set(["writes"]);
const WRITE_PERMISSION_FIELDS = new Set(["files", "tables"]);
const MANIFEST_SETTLE_ATTEMPTS = 3;
const MANIFEST_SETTLE_DELAY_MS = 20;

export function sourceForAppUi(appId: string): string {
  return sourceForAppWorkload(appId, { kind: "ui" });
}

export function sourceForAppWorkload(appId: string, workload: AppWorkloadIdentity): string {
  if (!PACKAGE_ID_PATTERN.test(appId)) {
    throw new Error(`Invalid app id: ${appId}`);
  }
  if (workload.kind === "ui") return `app:${appId}:ui`;
  if (!ENTRY_ID_PATTERN.test(workload.entryId)) {
    throw new Error(`Invalid ${workload.kind} entry id: ${workload.entryId}`);
  }
  return `app:${appId}:${workload.kind}:${workload.entryId}`;
}

export async function loadApps(appsDir: string): Promise<AppRegistry> {
  const apps = new Map<string, LoadedApp>();

  let entries;
  try {
    entries = await readdir(appsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      // apps/ doesn't exist yet — that's fine
      return createRegistry(apps);
    }
    throw error;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;

    const appDir = join(appsDir, entry.name);
    const manifestPath = join(appDir, "manifest.json");

    const validation = await loadSettledManifest(manifestPath, entry.name);
    if (!validation.ok) {
      console.warn(`[app-loader] Skipping ${entry.name}: ${validation.error}`);
      continue;
    }

    apps.set(validation.manifest.id, {
      manifest: validation.manifest,
      manifestDigest: digestNormalizedAppManifest(validation.manifest),
      dir: appDir,
    });
  }

  return createRegistry(apps);
}

/**
 * External editors and coding agents may replace an App manifest while Core
 * is scanning the Workspace. Read one stable file identity and give a brief
 * in-place write a bounded chance to settle; only a complete validated
 * snapshot can become a new authority generation.
 */
async function loadSettledManifest(
  path: string,
  directoryName: string,
): Promise<AppManifestValidationResult> {
  for (let attempt = 0; attempt < MANIFEST_SETTLE_ATTEMPTS; attempt += 1) {
    try {
      const raw = await readStableManifest(path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        if (attempt + 1 < MANIFEST_SETTLE_ATTEMPTS) {
          await delay(MANIFEST_SETTLE_DELAY_MS);
          continue;
        }
        return invalid("manifest.json is not valid JSON");
      }
      const validation = validateAppManifest(parsed, directoryName);
      // A complete but semantically invalid manifest is an authoritative
      // fail-closed state, not a transient snapshot to keep retrying.
      return validation;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return invalid("could not read manifest.json");
      }
      if (isNodeError(error, "ELOOP") || error instanceof InvalidManifestFileError) {
        return invalid(error instanceof Error ? error.message : String(error));
      }
      if (!(error instanceof UnstableManifestReadError)) {
        // I/O and authority failures such as EIO/EACCES must abort the whole
        // scan. The caller builds a candidate registry before retiring the
        // previous generation, so propagating here preserves the LKG registry
        // and its still-valid capabilities instead of silently dropping an
        // App from a partial filesystem observation.
        throw error;
      }
      if (attempt + 1 >= MANIFEST_SETTLE_ATTEMPTS) throw error;
    }
    if (attempt + 1 < MANIFEST_SETTLE_ATTEMPTS) await delay(MANIFEST_SETTLE_DELAY_MS);
  }
  throw new Error("manifest.json did not settle");
}

async function readStableManifest(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new InvalidManifestFileError("manifest.json is not a regular file");
    if (before.size < 1n || before.size > BigInt(APP_MANIFEST_MAX_BYTES)) {
      throw new InvalidManifestFileError(
        `manifest.json must be between 1 and ${APP_MANIFEST_MAX_BYTES} bytes`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.byteLength) !== after.size
    ) {
      throw new UnstableManifestReadError("manifest.json changed while it was being read");
    }

    // fstat only proves that the inode pinned by `handle` stayed stable. An
    // editor may atomically rename a replacement over manifest.json while the
    // old inode remains readable through that descriptor, so reopen the
    // no-follow pathname and require it to still resolve to the same identity.
    let pathnameHandle;
    try {
      pathnameHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new UnstableManifestReadError(
          "manifest.json was replaced while it was being read",
          { cause: error },
        );
      }
      throw error;
    }
    try {
      const pathname = await pathnameHandle.stat({ bigint: true });
      if (!pathname.isFile()) {
        throw new InvalidManifestFileError("manifest.json is not a regular file");
      }
      if (
        after.dev !== pathname.dev
        || after.ino !== pathname.ino
        || after.size !== pathname.size
        || after.mtimeNs !== pathname.mtimeNs
        || after.ctimeNs !== pathname.ctimeNs
      ) {
        throw new UnstableManifestReadError("manifest.json was replaced while it was being read");
      }
    } finally {
      await pathnameHandle.close();
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new InvalidManifestFileError("manifest.json is not valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}

class InvalidManifestFileError extends Error {}

class UnstableManifestReadError extends Error {}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

// Archive (not delete): retire an app by moving its folder — git history and
// all — out of apps/ into the archive root. It drops out of the active
// registry and the app-commits watcher naturally (both only look at apps/),
// and stays fully recoverable by moving the folder back. Returns the archive
// path; on id collision a timestamp suffix keeps prior archives intact.
export async function archiveApp(
  appsDir: string,
  archiveRoot: string,
  appId: string,
): Promise<string> {
  const appDir = join(appsDir, appId);
  try {
    if (!(await stat(appDir)).isDirectory()) {
      throw new Error(`App "${appId}" is not a directory`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`App "${appId}" not found`);
    }
    throw err;
  }

  await mkdir(archiveRoot, { recursive: true });
  let target = join(archiveRoot, appId);
  try {
    await stat(target);
    target = join(archiveRoot, `${appId}-${Date.now()}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  await rename(appDir, target);
  return target;
}

export function validateAppManifest(
  value: unknown,
  expectedId?: string,
): AppManifestValidationResult {
  if (!isObject(value)) {
    return invalid("manifest must be an object");
  }

  const unexpectedManifestField = findUnexpectedField(value, MANIFEST_FIELDS);
  if (unexpectedManifestField) {
    return invalid(`unknown manifest field "${unexpectedManifestField}"`);
  }
  if (value.manifestVersion !== 1) {
    return invalid("manifestVersion must be 1");
  }
  if (typeof value.id !== "string" || !PACKAGE_ID_PATTERN.test(value.id)) {
    return invalid("id must be one or more lowercase alphanumeric/hyphen segments separated by dots");
  }
  if (expectedId !== undefined && value.id !== expectedId) {
    return invalid(`manifest id "${value.id}" does not match expected id "${expectedId}"`);
  }
  if (typeof value.name !== "string" || value.name.length === 0 || value.name.trim() !== value.name) {
    return invalid("name must be a non-empty, trimmed string");
  }
  if (
    typeof value.description !== "string"
    || value.description.length === 0
    || value.description.trim() !== value.description
  ) {
    return invalid("description must be a non-empty, trimmed string");
  }

  let createdFrom: AppManifest["createdFrom"];
  if (hasOwn(value, "createdFrom")) {
    if (!isObject(value.createdFrom)) {
      return invalid("createdFrom must be an object");
    }
    const unexpectedCreatedFromField = findUnexpectedField(
      value.createdFrom,
      new Set(["packageId", "releaseId"]),
    );
    if (unexpectedCreatedFromField) {
      return invalid(`unknown createdFrom field "${unexpectedCreatedFromField}"`);
    }
    if (
      typeof value.createdFrom.packageId !== "string"
      || !SCOPED_PACKAGE_ID_PATTERN.test(value.createdFrom.packageId)
    ) {
      return invalid("createdFrom.packageId must be a scoped namespace.name package ID");
    }
    if (
      typeof value.createdFrom.releaseId !== "string"
      || value.createdFrom.releaseId.length === 0
      || value.createdFrom.releaseId.trim() !== value.createdFrom.releaseId
    ) {
      return invalid("createdFrom.releaseId must be a non-empty, trimmed string");
    }
    createdFrom = {
      packageId: value.createdFrom.packageId,
      releaseId: value.createdFrom.releaseId,
    };
  }

  if (!isObject(value.runtime)) {
    return invalid("runtime must be an object");
  }
  const unexpectedRuntimeField = findUnexpectedField(value.runtime, RUNTIME_FIELDS);
  if (unexpectedRuntimeField) {
    return invalid(`unknown runtime field "${unexpectedRuntimeField}"`);
  }

  const runtime: AppManifest["runtime"] = {};
  if (hasOwn(value.runtime, "ui")) {
    if (!isObject(value.runtime.ui)) {
      return invalid("runtime.ui must be an object");
    }
    const unexpectedUiField = findUnexpectedField(value.runtime.ui, UI_FIELDS);
    if (unexpectedUiField) {
      return invalid(`unknown runtime.ui field "${unexpectedUiField}"`);
    }
    const command = validateCommand(value.runtime.ui.command, "runtime.ui.command");
    if (!command.ok) return invalid(command.error);
    const port = value.runtime.ui.port;
    if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535) {
      return invalid("runtime.ui.port must be an integer from 1 through 65535");
    }
    runtime.ui = { command: command.command, port: Number(port) };
  }

  if (hasOwn(value.runtime, "services")) {
    const services = validateNamedWorkloads(value.runtime.services, "runtime.services");
    if (!services.ok) return invalid(services.error);
    runtime.services = services.workloads;
  }

  if (hasOwn(value.runtime, "jobs")) {
    const jobs = validateNamedWorkloads(value.runtime.jobs, "runtime.jobs");
    if (!jobs.ok) return invalid(jobs.error);
    runtime.jobs = jobs.workloads;
  }

  if (!runtime.ui && !runtime.services && !runtime.jobs) {
    return invalid("runtime must declare at least one ui, service, or job workload");
  }

  if (!isObject(value.permissions)) {
    return invalid("permissions must be an object");
  }
  const unexpectedPermissionField = findUnexpectedField(value.permissions, PERMISSION_FIELDS);
  if (unexpectedPermissionField) {
    return invalid(`unknown permissions field "${unexpectedPermissionField}"`);
  }
  if (!isObject(value.permissions.writes)) {
    return invalid("permissions.writes must be an object");
  }
  const unexpectedWritePermissionField = findUnexpectedField(
    value.permissions.writes,
    WRITE_PERMISSION_FIELDS,
  );
  if (unexpectedWritePermissionField) {
    return invalid(`unknown permissions.writes field "${unexpectedWritePermissionField}"`);
  }
  const files = value.permissions.writes.files;
  if (!Array.isArray(files)) {
    return invalid("permissions.writes.files must be an array");
  }
  const badFileGrant = files.find((grant) => !isValidFileGrant(grant));
  if (badFileGrant !== undefined) {
    return invalid(`invalid D1 file grant ${JSON.stringify(badFileGrant)}`);
  }
  const tables = value.permissions.writes.tables;
  if (!Array.isArray(tables) || tables.some((table) => !isValidTableGrant(table))) {
    return invalid("permissions.writes.tables must contain only concrete, non-empty table names");
  }

  return {
    ok: true,
    manifest: {
      manifestVersion: 1,
      id: value.id,
      name: value.name,
      description: value.description,
      ...(createdFrom === undefined ? {} : { createdFrom }),
      runtime,
      permissions: {
        writes: {
          files: [...files] as string[],
          tables: [...tables] as string[],
        },
      },
    },
  };
}

function invalid(error: string): AppManifestValidationResult {
  return { ok: false, error };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function findUnexpectedField(value: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key));
}

type CommandValidation =
  | { ok: true; command: string[] }
  | { ok: false; error: string };

function validateCommand(value: unknown, path: string): CommandValidation {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string")) {
    return { ok: false, error: `${path} must be a non-empty array of strings` };
  }
  if (value[0].length === 0) {
    return { ok: false, error: `${path}[0] must be non-empty` };
  }
  return { ok: true, command: [...value] as string[] };
}

type NamedWorkloadValidation =
  | { ok: true; workloads: Record<string, AppWorkload> }
  | { ok: false; error: string };

function validateNamedWorkloads(value: unknown, path: string): NamedWorkloadValidation {
  if (!isObject(value) || Object.keys(value).length === 0) {
    return { ok: false, error: `${path} must be a non-empty object` };
  }

  // Workload ids are data, never JavaScript object capabilities. A null
  // prototype keeps names such as "constructor" ordinary and makes future
  // lookups independent of Object.prototype.
  const workloads = Object.create(null) as Record<string, AppWorkload>;
  for (const [entryId, rawWorkload] of Object.entries(value)) {
    if (!ENTRY_ID_PATTERN.test(entryId)) {
      return { ok: false, error: `${path} entry id "${entryId}" must match ^[a-z0-9][a-z0-9-]*$` };
    }
    if (!isObject(rawWorkload)) {
      return { ok: false, error: `${path}.${entryId} must be an object` };
    }
    const unexpectedField = findUnexpectedField(rawWorkload, WORKLOAD_FIELDS);
    if (unexpectedField) {
      return { ok: false, error: `unknown ${path}.${entryId} field "${unexpectedField}"` };
    }
    const command = validateCommand(rawWorkload.command, `${path}.${entryId}.command`);
    if (!command.ok) return command;
    workloads[entryId] = { command: command.command };
  }
  return { ok: true, workloads };
}

function isValidFileGrant(grant: unknown): boolean {
  try {
    validateD1Grant(grant as string);
    return true;
  } catch {
    return false;
  }
}

function isValidTableGrant(table: unknown): table is string {
  return typeof table === "string" && table.length > 0 && table !== "*" && table.trim() === table;
}

function createRegistry(apps: Map<string, LoadedApp>): AppRegistry {
  return {
    apps,
    getTableGrants(appId: string): string[] {
      return apps.get(appId)?.manifest.permissions.writes.tables ?? [];
    },
    getFileGrants(appId: string): string[] {
      const app = apps.get(appId);
      if (!app) return [];
      return [`apps/${appId}/`, ...app.manifest.permissions.writes.files];
    },
  };
}
