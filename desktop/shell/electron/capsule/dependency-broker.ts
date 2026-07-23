import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createCapsuleVirtualTreeSnapshot,
  readCapsuleTreeFile,
  type CapsuleTreeSnapshot,
  type CapsuleVirtualTreeEntry,
} from "./package-snapshot";
import {
  normalizeCapsuleStorageError,
  type CapsuleStorageBudgetLike,
  type CapsuleStorageReservation,
} from "./storage-budget";

export const NPM_DEPENDENCY_BUNDLE_FORMAT = "npm-dependency-bundle-v1" as const;

const HARD_MAX_LOCK_BYTES = 64 * 1024 * 1024;
const HARD_MAX_PACKAGES = 99_998;
const HARD_MAX_TARBALL_BYTES = 512 * 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 896 * 1024 * 1024;
const HARD_MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const HARD_MAX_CONCURRENCY = 16;
const HARD_MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface NpmDependencyBrokerLimits {
  readonly lockBytes: number;
  readonly packages: number;
  readonly tarballBytes: number;
  readonly totalBytes: number;
  readonly concurrency: number;
  readonly requestTimeoutMs: number;
}

export interface NpmDependencyBundle {
  readonly format: typeof NPM_DEPENDENCY_BUNDLE_FORMAT;
  readonly snapshot: CapsuleTreeSnapshot;
  readonly entries: number;
  readonly tarballBytes: number;
}

interface LockedTarball {
  readonly resolved: string;
  readonly integrity: string;
  readonly digestHex: string;
  readonly identity: string;
}

interface DependencyManifestEntry {
  readonly resolved: string;
  readonly integrity: string;
  readonly bytes: number;
  readonly file: string;
}

interface CasTarball {
  readonly path: string;
  readonly resolved: string;
  readonly integrity: string;
  readonly digestHex: string;
  readonly bytes: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly modifiedNs: bigint;
}

interface NpmDependencyWriterDependencies {
  removeTemporary(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  afterPublication(published: boolean): Promise<void>;
}

const DEFAULT_DEPENDENCY_WRITER_DEPENDENCIES: NpmDependencyWriterDependencies = {
  async removeTemporary(path) {
    await rm(path, { force: true });
  },
  syncDirectory,
  async afterPublication() {},
};

const TARBALL_PUBLICATION_TAILS = new Map<string, Promise<void>>();
const TARBALL_PUBLICATION_QUARANTINE = new Map<string, Error>();

const DEFAULT_LIMITS: NpmDependencyBrokerLimits = Object.freeze({
  lockBytes: 16 * 1024 * 1024,
  packages: 50_000,
  tarballBytes: 256 * 1024 * 1024,
  totalBytes: 768 * 1024 * 1024,
  concurrency: 4,
  requestTimeoutMs: 60_000,
});

export async function createNpmDependencyBundle(options: {
  packageSnapshot: Pick<CapsuleTreeSnapshot, "path" | "digest" | "bytes">;
  cacheDir: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  limits?: Partial<NpmDependencyBrokerLimits>;
  ownerKey?: string;
  storageBudget?: CapsuleStorageBudgetLike;
  /** Deterministic managed-writer seams; production uses unlink(2) and directory fsync. */
  dependencyWriter?: Partial<NpmDependencyWriterDependencies>;
}): Promise<NpmDependencyBundle> {
  const limits = normalizeLimits(options.limits);
  throwIfAborted(options.signal);
  const lockBytes = await readCapsuleTreeFile(
    options.packageSnapshot,
    "package-lock.json",
    limits.lockBytes,
  );
  if (!lockBytes) throw new Error("App package snapshot must contain package-lock.json");
  const lockedTarballs = parseLockedTarballs(lockBytes, limits.packages);
  const cacheRoot = await preparePrivateDirectory(options.cacheDir, "npm dependency cache");
  const tarballCache = await preparePrivateDirectory(join(cacheRoot, "tarballs"), "npm tarball cache");
  const treeCache = await preparePrivateDirectory(join(cacheRoot, "trees"), "npm dependency tree cache");
  const budget = new TotalByteBudget(limits.totalBytes);
  const tarballs = await loadTarballsConcurrently(
    lockedTarballs,
    tarballCache,
    options.fetch ?? globalThis.fetch,
    limits,
    budget,
    options.signal,
    options.ownerKey,
    options.storageBudget,
    dependencyWriter(options.dependencyWriter),
  );

  const manifestEntries: DependencyManifestEntry[] = tarballs.map((tarball) => ({
    resolved: tarball.resolved,
    integrity: tarball.integrity,
    bytes: tarball.bytes,
    file: `tarballs/${tarball.digestHex}.tgz`,
  }));
  const manifestBytes = Buffer.from(`${JSON.stringify({
    version: 1,
    entries: manifestEntries,
  })}\n`, "utf8");
  if (manifestBytes.byteLength > HARD_MAX_MANIFEST_BYTES) {
    throw new Error("npm dependency manifest exceeds 64 MiB");
  }

  const entries: CapsuleVirtualTreeEntry[] = [
    {
      type: "file",
      path: "manifest.json",
      contentBytes: manifestBytes.byteLength,
      content: manifestBytes,
    },
    { type: "directory", path: "tarballs" },
    ...tarballs.map((tarball): CapsuleVirtualTreeEntry => ({
      type: "file",
      path: `tarballs/${tarball.digestHex}.tgz`,
      contentBytes: tarball.bytes,
      content: streamVerifiedCasTarball(tarball),
    })),
  ];
  const snapshot = await createCapsuleVirtualTreeSnapshot({
    entries,
    cacheDir: treeCache,
    ...(options.ownerKey === undefined ? {} : { ownerKey: options.ownerKey }),
    ...(options.storageBudget === undefined ? {} : { storageBudget: options.storageBudget }),
    storageScope: "dependency-cache",
  });
  return Object.freeze({
    format: NPM_DEPENDENCY_BUNDLE_FORMAT,
    snapshot,
    entries: manifestEntries.length,
    tarballBytes: budget.used,
  });
}

function normalizeLimits(input: Partial<NpmDependencyBrokerLimits> | undefined): NpmDependencyBrokerLimits {
  const value = { ...DEFAULT_LIMITS, ...input };
  assertLimit("lockBytes", value.lockBytes, 1, HARD_MAX_LOCK_BYTES);
  assertLimit("packages", value.packages, 0, HARD_MAX_PACKAGES);
  assertLimit("tarballBytes", value.tarballBytes, 1, HARD_MAX_TARBALL_BYTES);
  assertLimit("totalBytes", value.totalBytes, 1, HARD_MAX_TOTAL_BYTES);
  assertLimit("concurrency", value.concurrency, 1, HARD_MAX_CONCURRENCY);
  assertLimit("requestTimeoutMs", value.requestTimeoutMs, 1, HARD_MAX_REQUEST_TIMEOUT_MS);
  if (value.tarballBytes > value.totalBytes) {
    throw new Error("npm dependency tarballBytes cannot exceed totalBytes");
  }
  return Object.freeze(value);
}

function dependencyWriter(
  overrides: Partial<NpmDependencyWriterDependencies> | undefined,
): NpmDependencyWriterDependencies {
  return { ...DEFAULT_DEPENDENCY_WRITER_DEPENDENCIES, ...overrides };
}

function assertLimit(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`npm dependency limit ${name} is outside the allowed range`);
  }
}

function parseLockedTarballs(lockBytes: Buffer, maxPackages: number): LockedTarball[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(lockBytes);
  } catch (error) {
    throw new Error(`package-lock.json is not valid UTF-8: ${String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`package-lock.json is not valid JSON: ${String(error)}`);
  }
  if (!isPlainObject(value)) throw new Error("package-lock.json must contain an object");
  if (value.lockfileVersion !== 2 && value.lockfileVersion !== 3) {
    throw new Error("package-lock.json lockfileVersion must be 2 or 3");
  }
  if (!isPlainObject(value.packages)) {
    throw new Error("package-lock.json packages must contain an object");
  }
  const packages = Object.entries(value.packages);
  if (packages.length < 1 || packages.length - 1 > maxPackages) {
    throw new Error(`package-lock.json exceeds the ${maxPackages} package cap`);
  }
  const root = value.packages[""];
  if (!isPlainObject(root)) throw new Error("package-lock.json must contain the root packages entry");

  const localTargets = new Set<string>();
  for (const [packagePath, rawPackage] of packages) {
    if (packagePath === "") continue;
    if (!isPlainObject(rawPackage)) {
      throw new Error(`package-lock package ${packagePath} must contain an object`);
    }
    if (rawPackage.link !== undefined && typeof rawPackage.link !== "boolean") {
      throw new Error(`package-lock package ${packagePath}.link must be boolean`);
    }
    if (rawPackage.link !== true) continue;
    validateInstalledPackagePath(packagePath);
    const target = validatePackageLocalTarget(
      rawPackage.resolved,
      `${packagePath}.resolved`,
    );
    if (!Object.hasOwn(value.packages, target) || !isPlainObject(value.packages[target])) {
      throw new Error(`package-lock link ${packagePath} target is absent from captured packages: ${target}`);
    }
    localTargets.add(target);
  }

  const identities = new Map<string, LockedTarball>();
  const integrityOwners = new Map<string, string>();
  const resolvedOwners = new Map<string, string>();
  for (const [packagePath, rawPackage] of packages) {
    if (packagePath === "") continue;
    if (!isPlainObject(rawPackage)) {
      throw new Error(`package-lock package ${packagePath} must contain an object`);
    }
    if (rawPackage.link === true) continue;
    if (localTargets.has(packagePath)) {
      validatePackageLocalTarget(packagePath, `package-lock local package ${packagePath}`);
      continue;
    }
    validateInstalledPackagePath(packagePath);
    const resolved = validateRegistryTarballUrl(rawPackage.resolved, `${packagePath}.resolved`);
    const { integrity, digestHex } = validateSha512Integrity(
      rawPackage.integrity,
      `${packagePath}.integrity`,
    );
    const identity = `${resolved}\0${integrity}`;
    const integrityOwner = integrityOwners.get(integrity);
    if (integrityOwner !== undefined && integrityOwner !== resolved) {
      throw new Error("package-lock maps one sha512 integrity to multiple resolved URLs");
    }
    const resolvedOwner = resolvedOwners.get(resolved);
    if (resolvedOwner !== undefined && resolvedOwner !== integrity) {
      throw new Error("package-lock maps one resolved URL to multiple sha512 integrities");
    }
    integrityOwners.set(integrity, resolved);
    resolvedOwners.set(resolved, integrity);
    identities.set(identity, { resolved, integrity, digestHex, identity });
  }
  const result = [...identities.values()];
  result.sort((left, right) => compareUtf8(left.identity, right.identity));
  if (result.length > HARD_MAX_PACKAGES) throw new Error("package-lock has too many unique tarballs");
  return result;
}

function validateInstalledPackagePath(value: string): void {
  if (
    value.length < 1
    || value.length > 4_096
    || value !== value.normalize("NFC")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error(`package-lock package path is invalid: ${JSON.stringify(value)}`);
  }
  const segments = value.split("/");
  let index = 0;
  while (index < segments.length) {
    if (segments[index] !== "node_modules") {
      throw new Error(`package-lock package path is not an npm install path: ${value}`);
    }
    index += 1;
    const first = segments[index];
    if (!first || first === "." || first === "..") {
      throw new Error(`package-lock package path is invalid: ${value}`);
    }
    if (first.startsWith("@")) {
      if (!validPackageComponent(first.slice(1)) || !validPackageComponent(segments[index + 1])) {
        throw new Error(`package-lock scoped package path is invalid: ${value}`);
      }
      index += 2;
    } else {
      if (!validPackageComponent(first)) {
        throw new Error(`package-lock package path is invalid: ${value}`);
      }
      index += 1;
    }
  }
}

function validatePackageLocalTarget(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new Error(`${label} must be a bounded safe package-local target`);
  }
  const segments = value.split("/");
  if (
    value !== value.normalize("NFC")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("//")
    || value.includes("\\")
    || value.includes("\0")
    || value.includes(":")
    || segments.some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || segment === ".git"
      || segment === ".lamarck"
      || segment === "node_modules"
    ))
  ) {
    throw new Error(`${label} must be a canonical relative target inside the captured package`);
  }
  return value;
}

function validateRegistryTarballUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new Error(`${label} must be a bounded URL string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  const parts = url.pathname.slice(1).split("/");
  const unscoped = parts.length === 3
    && validPackageComponent(parts[0])
    && parts[1] === "-";
  const scoped = parts.length === 4
    && parts[0]?.startsWith("@")
    && validPackageComponent(parts[0].slice(1))
    && validPackageComponent(parts[1])
    && parts[2] === "-";
  const file = parts.at(-1);
  if (
    url.protocol !== "https:"
    || url.hostname !== "registry.npmjs.org"
    || url.host !== "registry.npmjs.org"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.href !== value
    || url.pathname.includes("%")
    || (!unscoped && !scoped)
    || !file
    || !/^[A-Za-z0-9][A-Za-z0-9._+~-]*\.tgz$/.test(file)
  ) {
    throw new Error(`${label} must be an exact registry.npmjs.org HTTPS tarball URL`);
  }
  return value;
}

function validPackageComponent(value: string | undefined): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value);
}

function validateSha512Integrity(
  value: unknown,
  label: string,
): { integrity: string; digestHex: string } {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) {
    throw new Error(`${label} must be one canonical sha512 SRI value`);
  }
  const base64 = value.slice("sha512-".length);
  const digest = Buffer.from(base64, "base64");
  if (digest.byteLength !== 64 || digest.toString("base64") !== base64) {
    throw new Error(`${label} must be canonical sha512 base64`);
  }
  return { integrity: value, digestHex: digest.toString("hex") };
}

async function loadTarballsConcurrently(
  locked: readonly LockedTarball[],
  cacheDir: string,
  fetchImpl: typeof globalThis.fetch,
  limits: NpmDependencyBrokerLimits,
  budget: TotalByteBudget,
  parentSignal: AbortSignal | undefined,
  ownerKey: string | undefined,
  storageBudget: CapsuleStorageBudgetLike | undefined,
  writer: NpmDependencyWriterDependencies,
): Promise<CasTarball[]> {
  if (typeof fetchImpl !== "function") throw new Error("npm dependency fetch implementation is unavailable");
  const operation = new AbortController();
  const onParentAbort = () => operation.abort(abortReason(parentSignal));
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal?.aborted) operation.abort(abortReason(parentSignal));
  const results = new Array<CasTarball>(locked.length);
  let next = 0;
  let firstError: unknown;

  const worker = async () => {
    while (!operation.signal.aborted) {
      const index = next;
      next += 1;
      if (index >= locked.length) return;
      try {
        results[index] = await loadTarball(
          locked[index]!,
          cacheDir,
          fetchImpl,
          limits,
          budget,
          operation.signal,
          ownerKey,
          storageBudget,
          writer,
        );
      } catch (error) {
        if (firstError === undefined) firstError = error;
        operation.abort(error);
        return;
      }
    }
  };
  try {
    await Promise.all(Array.from(
      { length: Math.min(limits.concurrency, Math.max(1, locked.length)) },
      () => worker(),
    ));
  } finally {
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
  if (firstError !== undefined) throw firstError;
  if (operation.signal.aborted) throw abortReason(operation.signal);
  return results;
}

async function loadTarball(
  locked: LockedTarball,
  cacheDir: string,
  fetchImpl: typeof globalThis.fetch,
  limits: NpmDependencyBrokerLimits,
  budget: TotalByteBudget,
  signal: AbortSignal,
  ownerKey: string | undefined,
  storageBudget: CapsuleStorageBudgetLike | undefined,
  writer: NpmDependencyWriterDependencies,
): Promise<CasTarball> {
  throwIfAborted(signal);
  const finalPath = join(cacheDir, `${locked.digestHex}.tgz`);
  const cached = await withTarballPublicationLock(finalPath, async () => {
    assertTarballPublicationAvailable(finalPath);
    const candidate = await verifyCachedTarball(finalPath, locked, limits.tarballBytes);
    if (candidate) {
      budget.reserve(candidate.bytes);
      if (ownerKey && storageBudget) {
        await storageBudget.claim({
          owner: ownerKey,
          scope: "dependency-cache",
          path: candidate.path,
          bytes: candidate.bytes,
        });
      }
    }
    return candidate;
  });
  if (cached) return cached;

  const request = childTimeoutSignal(signal, limits.requestTimeoutMs);
  let response: Response | undefined;
  let completed = false;
  try {
    response = await abortable(fetchImpl(locked.resolved, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { accept: "application/octet-stream" },
      signal: request.signal,
    }), request.signal);
    validateRegistryResponse(response, locked.resolved);
    const contentLength = parseContentLength(response.headers.get("content-length"));
    if (contentLength > limits.tarballBytes) {
      throw new Error(`npm tarball exceeds the ${limits.tarballBytes} byte per-file cap`);
    }
    budget.reserve(contentLength);
    const reservation = ownerKey && storageBudget
      ? await storageBudget.reserve({
          owner: ownerKey,
          scope: "dependency-cache",
          bytes: contentLength,
        })
      : undefined;
    await downloadTarball(
      response,
      finalPath,
      locked,
      contentLength,
      request.signal,
      reservation,
      ownerKey,
      storageBudget,
      writer,
    );
    completed = true;
  } finally {
    if (!completed && response?.body && !response.body.locked) {
      await response.body.cancel().catch(() => {});
    }
    request.dispose();
  }
  const downloaded = await verifyCachedTarball(finalPath, locked, limits.tarballBytes);
  if (!downloaded) throw new Error("npm tarball CAS publication disappeared");
  return downloaded;
}

function validateRegistryResponse(response: Response, requestedUrl: string): void {
  if (
    response.status !== 200
    || response.redirected
    || response.type === "opaqueredirect"
    || (response.url !== "" && response.url !== requestedUrl)
  ) {
    throw new Error("npm registry tarball request redirected or returned a non-200 response");
  }
  if (response.headers.has("content-encoding") || response.headers.has("content-range")) {
    throw new Error("npm registry tarball response used unsupported content transformation");
  }
  if (!response.body) throw new Error("npm registry tarball response has no body");
}

function parseContentLength(value: string | null): number {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error("npm registry tarball response requires one canonical Content-Length");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new Error("npm registry tarball Content-Length exceeds the safe integer range");
  }
  return length;
}

async function downloadTarball(
  response: Response,
  finalPath: string,
  locked: LockedTarball,
  expectedBytes: number,
  signal: AbortSignal,
  reservation: CapsuleStorageReservation | undefined,
  ownerKey: string | undefined,
  storageBudget: CapsuleStorageBudgetLike | undefined,
  writer: NpmDependencyWriterDependencies,
): Promise<void> {
  const temporaryPath = join(
    dirname(finalPath),
    `.download-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  let output: Awaited<ReturnType<typeof open>>;
  try {
    output = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    await reservation?.release();
    throw normalizeCapsuleStorageError(error, "npm dependency cache storage is full");
  }
  const hash = createHash("sha512");
  let bytes = 0;
  const reader = response.body!.getReader();
  try {
    for (;;) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      const chunk = item.value;
      if (!(chunk instanceof Uint8Array)) throw new Error("npm registry emitted a non-byte body chunk");
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > expectedBytes) throw new Error("npm registry tarball body exceeded Content-Length");
      hash.update(value);
      await writeAll(output, value);
    }
    if (bytes !== expectedBytes) throw new Error("npm registry tarball body was truncated");
    if (`sha512-${hash.digest("base64")}` !== locked.integrity) {
      throw new Error("npm registry tarball sha512 integrity mismatch");
    }
    await output.sync();
    await output.chmod(0o400);
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await reader.cancel(error);
    } catch (cancelError) {
      failures.push(cancelError);
    }
    try {
      await output.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    try {
      await removeTarballTemporaryDurably(temporaryPath, dirname(finalPath), writer);
    } catch (cleanupError) {
      failures.push(cleanupError);
      const failure = combinedDependencyWriterError("npm tarball temporary cleanup failed", failures);
      TARBALL_PUBLICATION_QUARANTINE.set(finalPath, failure);
      throw normalizeCapsuleStorageError(failure, "npm dependency cache cleanup failed");
    }
    await reservation?.release();
    throw normalizeCapsuleStorageError(
      combinedDependencyWriterError("npm tarball write failed", failures),
      "npm dependency cache storage is full",
    );
  } finally {
    reader.releaseLock();
  }
  try {
    await output.close();
  } catch (error) {
    try {
      await removeTarballTemporaryDurably(temporaryPath, dirname(finalPath), writer);
    } catch (cleanupError) {
      const failure = combinedDependencyWriterError(
        "npm tarball temporary cleanup failed",
        [error, cleanupError],
      );
      TARBALL_PUBLICATION_QUARANTINE.set(finalPath, failure);
      throw normalizeCapsuleStorageError(failure, "npm dependency cache cleanup failed");
    }
    await reservation?.release();
    throw normalizeCapsuleStorageError(error, "npm dependency cache storage is full");
  }

  let published = false;
  let cleanupAttempted = false;
  let cleanupConfirmed = false;
  try {
    await withTarballPublicationLock(finalPath, async () => {
      assertTarballPublicationAvailable(finalPath);
      let publicationError: unknown;
      try {
        await link(temporaryPath, finalPath);
        published = true;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          publicationError = error;
        } else {
          try {
            const existing = await verifyCachedTarball(finalPath, locked, expectedBytes);
            if (!existing || existing.bytes !== expectedBytes) {
              throw new Error("npm tarball CAS collision");
            }
          } catch (winnerError) {
            publicationError = winnerError;
          }
        }
      }
      if (publicationError === undefined) {
        try {
          await writer.afterPublication(published);
        } catch (error) {
          publicationError = error;
        }
      }

      cleanupAttempted = true;
      try {
        await removeTarballTemporaryDurably(temporaryPath, dirname(finalPath), writer);
        cleanupConfirmed = true;
      } catch (cleanupError) {
        const failure = combinedDependencyWriterError(
          "npm tarball temporary cleanup failed",
          publicationError === undefined
            ? [cleanupError]
            : [publicationError, cleanupError],
        );
        TARBALL_PUBLICATION_QUARANTINE.set(finalPath, failure);
        throw failure;
      }
      if (publicationError !== undefined) {
        if (published) {
          TARBALL_PUBLICATION_QUARANTINE.set(finalPath, asDependencyWriterError(publicationError));
        }
        throw publicationError;
      }

      try {
        await reservation?.commit(
          published ? expectedBytes : 0,
          published ? finalPath : undefined,
        );
        if (ownerKey && storageBudget) {
          await storageBudget.claim({
            owner: ownerKey,
            scope: "dependency-cache",
            path: finalPath,
            bytes: expectedBytes,
          });
        }
      } catch (error) {
        if (published) {
          TARBALL_PUBLICATION_QUARANTINE.set(finalPath, asDependencyWriterError(error));
        }
        throw error;
      }
    });
  } catch (error) {
    if (!cleanupAttempted) {
      try {
        cleanupAttempted = true;
        await removeTarballTemporaryDurably(temporaryPath, dirname(finalPath), writer);
        cleanupConfirmed = true;
      } catch (cleanupError) {
        const failure = combinedDependencyWriterError(
          "npm tarball temporary cleanup failed",
          [error, cleanupError],
        );
        TARBALL_PUBLICATION_QUARANTINE.set(finalPath, failure);
        throw normalizeCapsuleStorageError(failure, "npm dependency cache cleanup failed");
      }
    }
    if (!published && cleanupConfirmed) await reservation?.release();
    throw normalizeCapsuleStorageError(error, "npm dependency cache publication failed");
  }
}

async function verifyCachedTarball(
  path: string,
  locked: LockedTarball,
  maxBytes: number,
): Promise<CasTarball | undefined> {
  let input: Awaited<ReturnType<typeof open>>;
  try {
    input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw new Error(`npm tarball CAS is not a safe regular file: ${locked.digestHex}`, { cause: error });
  }
  try {
    const before = await input.stat({ bigint: true });
    assertCasStats(before, maxBytes, locked.digestHex);
    const hash = createHash("sha512");
    let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error(`npm tarball CAS exceeds per-file cap: ${locked.digestHex}`);
      hash.update(chunk);
    }
    const after = await input.stat({ bigint: true });
    if (
      bytes !== Number(before.size)
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || (Number(after.mode) & 0o777) !== 0o400
      || `sha512-${hash.digest("base64")}` !== locked.integrity
    ) {
      throw new Error(`npm tarball CAS integrity failure: ${locked.digestHex}`);
    }
    return {
      path,
      resolved: locked.resolved,
      integrity: locked.integrity,
      digestHex: locked.digestHex,
      bytes,
      device: after.dev,
      inode: after.ino,
      modifiedNs: after.mtimeNs,
    };
  } finally {
    await input.close();
  }
}

function assertCasStats(info: BigIntStats, maxBytes: number, digestHex: string): void {
  if (
    !info.isFile()
    || info.size < 1n
    || info.size > BigInt(maxBytes)
    || (Number(info.mode) & 0o777) !== 0o400
  ) {
    throw new Error(`npm tarball CAS metadata failure: ${digestHex}`);
  }
}

async function* streamVerifiedCasTarball(tarball: CasTarball): AsyncIterable<Uint8Array> {
  const input = await open(
    tarball.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const hash = createHash("sha512");
  let bytes = 0;
  try {
    assertSameCasTarball(tarball, await input.stat({ bigint: true }));
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      bytes += chunk.byteLength;
      if (bytes > tarball.bytes) throw new Error("npm tarball CAS changed while bundling");
      hash.update(chunk);
      yield chunk;
    }
    const after = await input.stat({ bigint: true });
    assertSameCasTarball(tarball, after);
    if (bytes !== tarball.bytes || `sha512-${hash.digest("base64")}` !== tarball.integrity) {
      throw new Error("npm tarball CAS changed while bundling");
    }
  } finally {
    await input.close();
  }
}

function assertSameCasTarball(tarball: CasTarball, info: BigIntStats): void {
  if (
    !info.isFile()
    || info.dev !== tarball.device
    || info.ino !== tarball.inode
    || info.size !== BigInt(tarball.bytes)
    || info.mtimeNs !== tarball.modifiedNs
    || (Number(info.mode) & 0o777) !== 0o400
  ) {
    throw new Error("npm tarball CAS changed while bundling");
  }
}

async function preparePrivateDirectory(path: string, label: string): Promise<string> {
  const requested = resolve(path);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const info = await lstat(requested, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  const canonical = await realpath(requested);
  await chmod(canonical, 0o700);
  return canonical;
}

class TotalByteBudget {
  #used = 0;

  constructor(private readonly maximum: number) {}

  get used(): number {
    return this.#used;
  }

  reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || this.#used + bytes > this.maximum) {
      throw new Error(`npm dependencies exceed the ${this.maximum} byte total cap`);
    }
    this.#used += bytes;
  }
}

function childTimeoutSignal(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(abortReason(parent));
  parent.addEventListener("abort", onParentAbort, { once: true });
  if (parent.aborted) controller.abort(abortReason(parent));
  const timeout = setTimeout(() => {
    controller.abort(new Error(`npm registry tarball request exceeded ${timeoutMs} ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      cleanup();
      rejectPromise(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        cleanup();
        rejectPromise(error);
      },
    );
  });
}

async function writeAll(
  output: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = await output.write(chunk, offset, chunk.byteLength - offset);
    if (written.bytesWritten < 1) throw new Error("npm tarball CAS write made no progress");
    offset += written.bytesWritten;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error("npm dependency operation aborted");
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function removeTarballTemporaryDurably(
  path: string,
  directory: string,
  writer: NpmDependencyWriterDependencies,
): Promise<void> {
  await writer.removeTemporary(path);
  await writer.syncDirectory(directory);
}

async function withTarballPublicationLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = TARBALL_PUBLICATION_TAILS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  TARBALL_PUBLICATION_TAILS.set(key, current);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (TARBALL_PUBLICATION_TAILS.get(key) === current) {
      TARBALL_PUBLICATION_TAILS.delete(key);
    }
  }
}

function assertTarballPublicationAvailable(path: string): void {
  const quarantined = TARBALL_PUBLICATION_QUARANTINE.get(path);
  if (quarantined) {
    throw new Error("npm tarball publication is quarantined", { cause: quarantined });
  }
}

function asDependencyWriterError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function combinedDependencyWriterError(message: string, errors: readonly unknown[]): Error {
  return errors.length === 1
    ? asDependencyWriterError(errors[0])
    : new AggregateError(errors, message);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
