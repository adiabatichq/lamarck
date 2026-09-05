import fs from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import git, { type TreeEntry, type TreeObject } from "isomorphic-git";
import { PACKAGE_ID_PATTERN } from "../package-id";
import { validateFullGitCommit } from "../system-identity";
import { AppLifecycleError, AppVersionHistoryUnavailableError } from "./errors";
import {
  collectAppPackageTree,
  hashAppPackageTree,
  materializeAppPackageTree,
  replaceAppPackageTree,
  validateAppPackageTree,
  type AppPackageEntry,
  type ValidatedAppPackage,
} from "./package-tree";
import {
  APP_EXTERNAL_REF_ROOT,
  APP_VERSION_REF_ROOT,
  finalizePendingVersion,
  listPendingVersionRecords,
  readPendingVersionAuthority,
  readFinalVersionRecord,
  verifyFinalVersionRef,
  writePendingVersion,
  writePendingVersionAuthority,
  type AppVersionEventWriter,
  type AppVersionEventAuthority,
  type AppVersionTransactionHooks,
} from "./version-transaction";
import {
  validateAppVersionRecordV1,
  type AppVersionRecordV1,
  type AppVersionTrigger,
} from "./version-record";

export interface AppVersionResult {
  readonly version: string;
  readonly created: boolean;
  readonly record: AppVersionRecordV1;
  readonly packageDigest: `sha256:${string}`;
}

export interface AppVersionPage {
  readonly versions: readonly AppVersionRecordV1[];
  readonly nextCursor: string | null;
}

export interface AppVersionHistoryRebuildResultV1 {
  readonly schemaVersion: 1;
  readonly outcome: "healthy" | "reconstructed" | "reset";
  readonly currentVersion: string | null;
}

export interface AppRepositoryServiceOptions {
  readonly eventWriter: AppVersionEventWriter;
  readonly eventWriterForAuthority?: (authority: AppVersionEventAuthority) => AppVersionEventWriter;
  readonly now?: () => number;
  readonly transactionHooks?: AppVersionTransactionHooks;
}

interface CommitPackage {
  readonly entries: readonly AppPackageEntry[];
  readonly digest: `sha256:${string}`;
  readonly tree: string;
}

interface GitTreeNode {
  readonly files: Map<string, string>;
  readonly directories: Map<string, GitTreeNode>;
}

/** Core-owned standard Git repository and product-version service. */
export class AppRepositoryService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly options: AppRepositoryServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async initializeRepository(appId: string, appDir: string): Promise<void> {
    validateAppId(appId);
    await this.withLock(appId, async () => {
      await initializeOrOpenRepository(appDir);
      await this.recoverPendingUnlocked(appId, appDir);
    });
  }

  async save(options: {
    readonly appId: string;
    readonly appDir: string;
    readonly message?: string;
    readonly author?: string;
    readonly eventWriter?: AppVersionEventWriter;
    readonly eventAuthority?: AppVersionEventAuthority;
  }): Promise<AppVersionResult> {
    return this.admitCurrent({ ...options, trigger: "save" });
  }

  /** Admits and recoverably publishes one complete Capsule package projection. */
  async savePackage(options: {
    readonly appId: string;
    readonly appDir: string;
    readonly entries: readonly AppPackageEntry[];
    readonly baseVersion: string | null;
    readonly basePackageDigest: `sha256:${string}`;
    readonly message?: string;
    readonly author?: string;
    readonly eventWriter?: AppVersionEventWriter;
    readonly eventAuthority?: AppVersionEventAuthority;
  }): Promise<AppVersionResult> {
    validateAppId(options.appId);
    validateMetadata(options.message, options.author);
    return this.withLock(options.appId, async () => {
      await initializeOrOpenRepository(options.appDir);
      await this.recoverPendingUnlocked(options.appId, options.appDir);
      const currentVersion = await this.readCurrentVersionUnlocked(options.appId, options.appDir);
      const canonicalEntries = await collectAppPackageTree(options.appDir);
      const canonicalDigest = hashAppPackageTree(canonicalEntries);
      const candidate = validateProjected(options.entries, options.appId);
      if (
        currentVersion !== options.baseVersion
        || canonicalDigest !== options.basePackageDigest
      ) {
        if (currentVersion && canonicalDigest === candidate.digest) {
          const currentRecord = await requireFinalRecord(
            options.appDir,
            options.appId,
            currentVersion,
          );
          const currentPackage = await readCommitPackage(options.appDir, currentVersion);
          if (currentPackage.digest === candidate.digest) {
            return {
              version: currentVersion,
              created: false,
              record: currentRecord,
              packageDigest: candidate.digest,
            };
          }
        }
        throw new AppLifecycleError(
          "APP_VERSION_CONFLICT",
          "The Host App changed after this Capsule materialization was created",
        );
      }
      if (currentVersion) {
        const currentRecord = await requireFinalRecord(
          options.appDir,
          options.appId,
          currentVersion,
        );
        const currentPackage = await readCommitPackage(options.appDir, currentVersion);
        if (currentPackage.digest === candidate.digest) {
          if (canonicalDigest !== candidate.digest) {
            await replaceAppPackageTree(options.appDir, candidate.entries);
            await reconcileIndex(options.appDir, candidate.entries);
          }
          return {
            version: currentVersion,
            created: false,
            record: currentRecord,
            packageDigest: candidate.digest,
          };
        }
      }

      const candidateTree = await writeGitTree(options.appDir, candidate.entries);
      const head = await tryResolveHead(options.appDir);
      let version: string | undefined;
      if (head) {
        const headPackage = await readCommitPackage(options.appDir, head);
        if (
          headPackage.digest === candidate.digest
          && (!currentVersion || await isDescendant(options.appDir, head, currentVersion))
        ) version = head;
        if (version === undefined && head !== currentVersion) {
          await git.writeRef({
            fs,
            dir: options.appDir,
            ref: `${APP_EXTERNAL_REF_ROOT}/${head}`,
            value: head,
            force: true,
          });
        }
      }
      let createdAt = this.now();
      const recordMessage = options.message ?? "Save app";
      if (version === undefined) {
        const written = await writeNonCollidingCommit({
          dir: options.appDir,
          tree: candidateTree,
          parent: currentVersion,
          createdAt,
          message: recordMessage,
          author: options.author,
        });
        version = written.version;
        createdAt = written.createdAt;
      }
      const record = provisionalRecord({
        appId: options.appId,
        version,
        parentVersion: currentVersion,
        trigger: "save",
        createdAt,
        message: recordMessage,
        author: options.author,
      });
      await this.options.transactionHooks?.afterBoundary?.("after-commit-object", record);
      await writeWritebackMarker(options.appDir, record, candidate.digest);
      await this.commitVersion(options.appDir, record, async () => {
        await replaceAppPackageTree(options.appDir, candidate.entries);
        await reconcileIndex(options.appDir, candidate.entries);
      }, options);
      await deleteWritebackMarker(options.appDir, version);
      return { version, created: true, record, packageDigest: candidate.digest };
    });
  }

  async activate(options: {
    readonly appId: string;
    readonly appDir: string;
    readonly message?: string;
    readonly author?: string;
    readonly validateCandidate?: (candidate: ValidatedAppPackage) => void;
    readonly eventWriter?: AppVersionEventWriter;
    readonly eventAuthority?: AppVersionEventAuthority;
  }): Promise<AppVersionResult> {
    return this.admitCurrent({ ...options, trigger: "activate" });
  }

  async restore(options: {
    readonly appId: string;
    readonly appDir: string;
    readonly version: string;
    readonly message?: string;
    readonly author?: string;
    readonly eventWriter?: AppVersionEventWriter;
    readonly eventAuthority?: AppVersionEventAuthority;
  }): Promise<AppVersionResult> {
    validateAppId(options.appId);
    validateMetadata(options.message, options.author);
    return this.withLock(options.appId, async () => {
      await initializeOrOpenRepository(options.appDir);
      await this.recoverPendingUnlocked(options.appId, options.appDir);
      const versions = await this.readVersionChainUnlocked(options.appId, options.appDir);
      const selected = resolveRecordedVersion(versions, options.version);
      const current = versions[0];
      if (!current) {
        throw new AppLifecycleError("APP_NOT_FOUND", `App ${options.appId} has no versions`);
      }
      const selectedPackage = await readCommitPackage(options.appDir, selected.version);
      try {
        validateAppPackageTree(selectedPackage.entries, options.appId);
      } catch (error) {
        throw new AppLifecycleError(
          "APP_PACKAGE_INVALID",
          `Selected App version is not admissible: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      const currentPackage = await readCommitPackage(options.appDir, current.version);
      if (selectedPackage.digest === currentPackage.digest) {
        return {
          version: current.version,
          created: false,
          record: current,
          packageDigest: currentPackage.digest,
        };
      }

      const createdAt = this.now();
      const recordMessage = options.message ?? `Restore ${selected.version.slice(0, 12)}`;
      const commit = await writeCommitObject({
        dir: options.appDir,
        tree: selectedPackage.tree,
        parent: current.version,
        createdAt,
        message: recordMessage,
        author: options.author,
      });
      await this.options.transactionHooks?.afterBoundary?.("after-commit-object", provisionalRecord({
        appId: options.appId,
        version: commit,
        parentVersion: current.version,
        trigger: "restore",
        createdAt,
        message: recordMessage,
        author: options.author,
        restoredFrom: selected.version,
      }));
      const record = provisionalRecord({
        appId: options.appId,
        version: commit,
        parentVersion: current.version,
        trigger: "restore",
        createdAt,
        message: recordMessage,
        author: options.author,
        restoredFrom: selected.version,
      });
      await this.commitVersion(options.appDir, record, async () => {
        await replaceAppPackageTree(options.appDir, selectedPackage.entries);
        await reconcileIndex(options.appDir, selectedPackage.entries);
      }, options);
      return {
        version: commit,
        created: true,
        record,
        packageDigest: selectedPackage.digest,
      };
    });
  }

  async recoverPending(appId: string, appDir: string): Promise<void> {
    validateAppId(appId);
    await this.withLock(appId, async () => {
      if (!await hasRepository(appDir)) return;
      await initializeOrOpenRepository(appDir);
      await this.recoverPendingUnlocked(appId, appDir);
    });
  }

  async currentVersion(appId: string, appDir: string): Promise<string | null> {
    validateAppId(appId);
    return this.withLock(appId, async () => {
      if (!await hasRepository(appDir)) return null;
      await initializeOrOpenRepository(appDir);
      await this.recoverPendingUnlocked(appId, appDir);
      return this.readCurrentVersionUnlocked(appId, appDir);
    });
  }

  async listVersions(options: {
    readonly appId: string;
    readonly appDir: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<AppVersionPage> {
    validateAppId(options.appId);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AppLifecycleError(
        "APP_PACKAGE_INVALID",
        "App version page limit must be between 1 and 100",
      );
    }
    return this.withLock(options.appId, async () => {
      if (!await hasRepository(options.appDir)) return { versions: [], nextCursor: null };
      await initializeOrOpenRepository(options.appDir);
      await this.recoverPendingUnlocked(options.appId, options.appDir);
      const versions = await this.readVersionChainUnlocked(options.appId, options.appDir);
      const offset = decodeCursor(options.cursor, versions.length);
      const page = versions.slice(offset, offset + limit);
      const next = offset + page.length;
      return {
        versions: Object.freeze(page),
        nextCursor: next < versions.length ? encodeCursor(next) : null,
      };
    });
  }

  async readVersionPackage(
    appId: string,
    appDir: string,
    versionValue: string,
  ): Promise<ValidatedAppPackage & { readonly version: string }> {
    validateAppId(appId);
    return this.withLock(appId, async () => {
      if (!await hasRepository(appDir)) {
        throw new AppLifecycleError("APP_NOT_FOUND", `App ${appId} has no versions`);
      }
      await initializeOrOpenRepository(appDir);
      await this.recoverPendingUnlocked(appId, appDir);
      const versions = await this.readVersionChainUnlocked(appId, appDir);
      const version = resolveRecordedVersion(versions, versionValue).version;
      const commitPackage = await readCommitPackage(appDir, version);
      return Object.freeze({
        ...validateAppPackageTree(commitPackage.entries, appId),
        version,
      });
    });
  }

  async materializeVersion(options: {
    readonly appId: string;
    readonly appDir: string;
    readonly version: string;
    readonly destination: string;
  }): Promise<ValidatedAppPackage & { readonly version: string }> {
    const packageValue = await this.readVersionPackage(
      options.appId,
      options.appDir,
      options.version,
    );
    await materializeAppPackageTree(packageValue.entries, options.destination);
    const reread = validateAppPackageTree(
      await collectAppPackageTree(options.destination),
      options.appId,
    );
    if (reread.digest !== packageValue.digest) {
      await rm(options.destination, { recursive: true, force: true });
      throw new Error("Immutable App version materialization digest mismatch");
    }
    return packageValue;
  }

  async verifyRetainedVersions(appId: string, appDir: string): Promise<void> {
    validateAppId(appId);
    await this.withLock(appId, async () => {
      if (!await hasRepository(appDir)) return;
      await initializeOrOpenRepository(appDir);
      await this.recoverPendingUnlocked(appId, appDir);
      for (const record of await this.readVersionChainUnlocked(appId, appDir)) {
        await verifyFinalVersionRef(appDir, record);
        await readCommitPackage(appDir, record.version);
      }
    });
  }

  async packageDirty(appId: string, appDir: string): Promise<boolean> {
    validateAppId(appId);
    return this.withLock(appId, async () => {
      const projected = validateProjected(await collectAppPackageTree(appDir), appId);
      if (!await hasRepository(appDir)) return true;
      await initializeOrOpenRepository(appDir);
      await this.recoverPendingUnlocked(appId, appDir);
      const current = await this.readCurrentVersionUnlocked(appId, appDir);
      if (!current) return true;
      return (await readCommitPackage(appDir, current)).digest !== projected.digest;
    });
  }

  /** Explicit, confirmed exceptional recovery for an unusable App repository. */
  async rebuildVersionHistory(options: {
    readonly appId: string;
    readonly appDir: string;
    readonly archiveRoot: string;
  }): Promise<AppVersionHistoryRebuildResultV1> {
    validateAppId(options.appId);
    return this.withLock(options.appId, async () => {
      if (!await hasRepository(options.appDir)) {
        await initializeOrOpenRepository(options.appDir);
        return Object.freeze({
          schemaVersion: 1 as const,
          outcome: "healthy" as const,
          currentVersion: null,
        });
      }

      try {
        await initializeOrOpenRepository(options.appDir);
        const versions = await this.readVersionChainUnlocked(options.appId, options.appDir);
        return Object.freeze({
          schemaVersion: 1 as const,
          outcome: "healthy" as const,
          currentVersion: versions[0]?.version ?? null,
        });
      } catch {
        // Continue only through this explicit repair entry point. Normal App
        // lifecycle paths never delete or replace a repository.
      }

      try {
        await importMatchingArchiveObjects(
          options.appId,
          options.appDir,
          options.archiveRoot,
        );
        const versions = await reconstructReadableHistory(options.appId, options.appDir);
        if (versions.length > 0) {
          return Object.freeze({
            schemaVersion: 1 as const,
            outcome: "reconstructed" as const,
            currentVersion: versions[0].version,
          });
        }
      } catch {
        // Bounded reconstruction is best-effort. The confirmed reset below is
        // the only remaining recovery action defined by the lifecycle.
      }

      let knownVersions: string[] = [];
      try {
        knownVersions = await listRefsOrEmpty(options.appDir, APP_VERSION_REF_ROOT);
      } catch {}
      await rm(join(options.appDir, ".git"), { recursive: true, force: true });
      try {
        await git.init({ fs, dir: options.appDir, defaultBranch: "main" });
        await writeRebuildMarker(options.appDir, knownVersions);
      } catch (cause) {
        throw new AppVersionHistoryUnavailableError({ cause });
      }
      return Object.freeze({
        schemaVersion: 1 as const,
        outcome: "reset" as const,
        currentVersion: null,
      });
    });
  }

  private async admitCurrent(options: {
    readonly appId: string;
    readonly appDir: string;
    readonly trigger: Exclude<AppVersionTrigger, "restore">;
    readonly message?: string;
    readonly author?: string;
    readonly validateCandidate?: (candidate: ValidatedAppPackage) => void;
    readonly eventWriter?: AppVersionEventWriter;
    readonly eventAuthority?: AppVersionEventAuthority;
  }): Promise<AppVersionResult> {
    validateAppId(options.appId);
    validateMetadata(options.message, options.author);
    return this.withLock(options.appId, async () => {
      await initializeOrOpenRepository(options.appDir);
      await this.recoverPendingUnlocked(options.appId, options.appDir);
      const candidate = validateProjected(await collectAppPackageTree(options.appDir), options.appId);
      try {
        options.validateCandidate?.(candidate);
      } catch (error) {
        throw new AppLifecycleError(
          "APP_PACKAGE_INVALID",
          errorMessage(error),
          { cause: error },
        );
      }
      const currentVersion = await this.readCurrentVersionUnlocked(options.appId, options.appDir);
      if (currentVersion) {
        const currentRecord = await requireFinalRecord(options.appDir, options.appId, currentVersion);
        const currentPackage = await readCommitPackage(options.appDir, currentVersion);
        if (currentPackage.digest === candidate.digest) {
          return {
            version: currentVersion,
            created: false,
            record: currentRecord,
            packageDigest: candidate.digest,
          };
        }
      }

      const candidateTree = await writeGitTree(options.appDir, candidate.entries);
      const head = await tryResolveHead(options.appDir);
      let version: string | undefined;
      if (head) {
        const headPackage = await readCommitPackage(options.appDir, head);
        if (headPackage.digest === candidate.digest) {
          if (!currentVersion || await isDescendant(options.appDir, head, currentVersion)) {
            version = head;
          }
        }
        if (version === undefined && head !== currentVersion) {
          await git.writeRef({
            fs,
            dir: options.appDir,
            ref: `${APP_EXTERNAL_REF_ROOT}/${head}`,
            value: head,
            force: true,
          });
        }
      }

      let createdAt = this.now();
      const recordMessage = options.message ?? (options.trigger === "save" ? "Save app" : "Activate app");
      if (version === undefined) {
        const written = await writeNonCollidingCommit({
          dir: options.appDir,
          tree: candidateTree,
          parent: currentVersion,
          createdAt,
          message: recordMessage,
          author: options.author,
        });
        version = written.version;
        createdAt = written.createdAt;
      }
      const record = provisionalRecord({
        appId: options.appId,
        version,
        parentVersion: currentVersion,
        trigger: options.trigger,
        createdAt,
        message: recordMessage,
        author: options.author,
      });
      await this.options.transactionHooks?.afterBoundary?.("after-commit-object", record);
      await this.commitVersion(options.appDir, record, async () => {
        await reconcileIndex(options.appDir, candidate.entries);
      }, options);
      return {
        version,
        created: true,
        record,
        packageDigest: candidate.digest,
      };
    });
  }

  private async commitVersion(
    appDir: string,
    record: AppVersionRecordV1,
    publish?: () => Promise<void>,
    event?: {
      readonly eventWriter?: AppVersionEventWriter;
      readonly eventAuthority?: AppVersionEventAuthority;
    },
  ): Promise<void> {
    if ((event?.eventWriter === undefined) !== (event?.eventAuthority === undefined)) {
      throw new Error("App version event writer and authority must be supplied together");
    }
    if (event?.eventAuthority) {
      await writePendingVersionAuthority(appDir, record.version, event.eventAuthority);
    }
    await writePendingVersion({
      dir: appDir,
      record,
      hooks: this.options.transactionHooks,
    });
    await finalizePendingVersion({
      dir: appDir,
      record,
      writer: event?.eventWriter ?? this.options.eventWriter,
      currentRef: currentRef(record.appId),
      publish,
      hooks: this.options.transactionHooks,
    });
    await verifyFinalVersionRef(appDir, record);
  }

  private async recoverPendingUnlocked(appId: string, appDir: string): Promise<void> {
    const pending = await listPendingVersionRecords(appDir);
    const remaining = [...pending];
    while (remaining.length > 0) {
      const current = await tryResolveRef(appDir, currentRef(appId));
      const index = remaining.findIndex((record) =>
        record.appId === appId
        && (record.parentVersion === (current ?? null) || record.version === current));
      if (index < 0) throw new AppVersionHistoryUnavailableError();
      const [record] = remaining.splice(index, 1);
      const writeback = await readWritebackMarker(appDir, record.version);
      const authority = await readPendingVersionAuthority(appDir, record.version);
      const writer = authority === undefined
        ? this.options.eventWriter
        : this.options.eventWriterForAuthority?.(authority);
      if (!writer) throw new AppVersionHistoryUnavailableError();
      await finalizePendingVersion({
        dir: appDir,
        record,
        writer,
        currentRef: currentRef(appId),
        ...(record.trigger !== "restore" && !writeback ? {} : {
          publish: async () => {
            const packageValue = await readCommitPackage(appDir, record.version);
            await replaceAppPackageTree(appDir, packageValue.entries);
            await reconcileIndex(appDir, packageValue.entries);
          },
        }),
        hooks: this.options.transactionHooks,
      });
      await verifyFinalVersionRef(appDir, record);
      if (writeback) await deleteWritebackMarker(appDir, record.version);
    }
    await recoverCompletedWritebacks(appId, appDir);
  }

  private async readCurrentVersionUnlocked(appId: string, appDir: string): Promise<string | null> {
    const version = await tryResolveRef(appDir, currentRef(appId));
    if (!version) {
      const finalRefs = await listRefsOrEmpty(appDir, APP_VERSION_REF_ROOT);
      if (finalRefs.length > 0) throw new AppVersionHistoryUnavailableError();
      return null;
    }
    const commit = validateFullGitCommit(version, "Current App version");
    await requireFinalRecord(appDir, appId, commit);
    return commit;
  }

  private async readVersionChainUnlocked(
    appId: string,
    appDir: string,
  ): Promise<AppVersionRecordV1[]> {
    const current = await this.readCurrentVersionUnlocked(appId, appDir);
    if (!current) return [];
    const records: AppVersionRecordV1[] = [];
    const seen = new Set<string>();
    let next: string | null = current;
    while (next !== null) {
      if (seen.has(next)) throw new AppVersionHistoryUnavailableError();
      seen.add(next);
      const record = await requireFinalRecord(appDir, appId, next);
      records.push(record);
      next = record.parentVersion;
    }
    const finalRefs = await listRefsOrEmpty(appDir, APP_VERSION_REF_ROOT);
    if (finalRefs.length !== records.length || finalRefs.some((ref) => !seen.has(ref))) {
      throw new AppVersionHistoryUnavailableError();
    }
    return records;
  }

  private async withLock<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(appId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(appId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(appId) === tail) this.locks.delete(appId);
    }
  }
}

async function reconstructReadableHistory(
  appId: string,
  appDir: string,
): Promise<AppVersionRecordV1[]> {
  const pending = await listPendingVersionRecords(appDir);
  if (pending.length > 0) throw new AppVersionHistoryUnavailableError();
  const names = await listRefsOrEmpty(appDir, APP_VERSION_REF_ROOT);
  if (names.length === 0) return [];
  const records = await Promise.all(names.map(async (name) => {
    const version = validateFullGitCommit(name, "Retained App version");
    const record = await readFinalVersionRecord(appDir, version);
    if (!record || record.appId !== appId || record.version !== version) {
      throw new AppVersionHistoryUnavailableError();
    }
    await verifyFinalVersionRef(appDir, record);
    await readCommitPackage(appDir, record.version);
    return record;
  }));
  const byVersion = new Map(records.map((record) => [record.version, record]));
  const parents = new Set<string>();
  for (const record of records) {
    if (record.parentVersion === null) continue;
    if (!byVersion.has(record.parentVersion)) throw new AppVersionHistoryUnavailableError();
    parents.add(record.parentVersion);
  }
  const tips = records.filter((record) => !parents.has(record.version));
  if (tips.length !== 1) throw new AppVersionHistoryUnavailableError();
  const chain: AppVersionRecordV1[] = [];
  const seen = new Set<string>();
  let next: AppVersionRecordV1 | undefined = tips[0];
  while (next) {
    if (seen.has(next.version)) throw new AppVersionHistoryUnavailableError();
    seen.add(next.version);
    chain.push(next);
    next = next.parentVersion === null ? undefined : byVersion.get(next.parentVersion);
    if (chain.at(-1)?.parentVersion !== null && !next) {
      throw new AppVersionHistoryUnavailableError();
    }
  }
  if (chain.length !== records.length) throw new AppVersionHistoryUnavailableError();
  await git.writeRef({
    fs,
    dir: appDir,
    ref: currentRef(appId),
    value: chain[0].version,
    force: true,
  });
  await git.writeRef({
    fs,
    dir: appDir,
    ref: "refs/heads/main",
    value: chain[0].version,
    force: true,
  });
  await git.writeRef({
    fs,
    dir: appDir,
    ref: "HEAD",
    value: "refs/heads/main",
    symbolic: true,
    force: true,
  });
  return chain;
}

const ARCHIVE_REPAIR_MAX_DIRECTORIES = 64;
const ARCHIVE_REPAIR_MAX_OBJECTS = 20_000;
const ARCHIVE_REPAIR_MAX_BYTES = 256 * 1024 * 1024;
const ARCHIVE_REPAIR_MAX_MS = 5_000;

async function importMatchingArchiveObjects(
  appId: string,
  appDir: string,
  archiveRoot: string,
): Promise<void> {
  const retained = await listRefsOrEmpty(appDir, APP_VERSION_REF_ROOT);
  if (retained.length === 0) return;
  let candidates;
  try {
    candidates = await readdir(archiveRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  const budget = {
    startedAt: Date.now(),
    objects: 0,
    bytes: 0,
    copied: new Set<string>(),
  };
  for (const entry of candidates
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, ARCHIVE_REPAIR_MAX_DIRECTORIES)) {
    const donor = join(archiveRoot, entry.name);
    for (const version of retained) {
      if (await readableFinalVersion(appId, appDir, version)) continue;
      if (!await readableFinalVersion(appId, donor, version)) continue;
      const tagOid = await tryResolveRef(donor, `${APP_VERSION_REF_ROOT}/${version}`);
      if (!tagOid) continue;
      await copyReachableObject(donor, appDir, tagOid, budget);
    }
  }
}

async function readableFinalVersion(
  appId: string,
  dir: string,
  version: string,
): Promise<boolean> {
  try {
    const record = await readFinalVersionRecord(dir, version);
    if (!record || record.appId !== appId) return false;
    await verifyFinalVersionRef(dir, record);
    await readCommitPackage(dir, version);
    return true;
  } catch {
    return false;
  }
}

async function copyReachableObject(
  donor: string,
  target: string,
  oid: string,
  budget: {
    startedAt: number;
    objects: number;
    bytes: number;
    copied: Set<string>;
  },
): Promise<void> {
  if (budget.copied.has(oid)) return;
  if (
    budget.objects >= ARCHIVE_REPAIR_MAX_OBJECTS
    || Date.now() - budget.startedAt > ARCHIVE_REPAIR_MAX_MS
  ) throw new Error("App archive reconstruction limit exceeded");
  const parsed = await git.readObject({ fs, dir: donor, oid });
  const content = await git.readObject({ fs, dir: donor, oid, format: "content" });
  if (
    !(content.object instanceof Uint8Array)
    || (content.type !== "tag"
      && content.type !== "commit"
      && content.type !== "tree"
      && content.type !== "blob")
  ) throw new Error("Archived Git object has an unsupported representation");
  budget.objects += 1;
  budget.bytes += content.object.byteLength;
  if (budget.bytes > ARCHIVE_REPAIR_MAX_BYTES) {
    throw new Error("App archive reconstruction byte limit exceeded");
  }
  budget.copied.add(oid);
  const dependencies = parsed.type === "tag"
    ? [(parsed.object as { object: string }).object]
    : parsed.type === "commit"
      ? [
          (parsed.object as { tree: string }).tree,
          ...((parsed.object as { parent: string[] }).parent ?? []),
        ]
      : parsed.type === "tree"
        ? (parsed.object as TreeObject).map((entry) => entry.oid)
        : [];
  for (const dependency of dependencies) {
    await copyReachableObject(donor, target, dependency, budget);
  }
  await rm(join(target, ".git", "objects", oid.slice(0, 2), oid.slice(2)), { force: true });
  const written = await git.writeObject({
    fs,
    dir: target,
    type: content.type,
    object: content.object,
    format: "content",
  });
  if (written !== oid) throw new Error("Archived Git object identity mismatch");
}

async function initializeOrOpenRepository(dir: string): Promise<void> {
  let info;
  try {
    info = await lstat(join(dir, ".git"));
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw new AppVersionHistoryUnavailableError({ cause: error });
    try {
      await git.init({ fs, dir, defaultBranch: "main" });
      return;
    } catch (cause) {
      throw new AppVersionHistoryUnavailableError({ cause });
    }
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AppVersionHistoryUnavailableError();
  try {
    const head = await tryResolveHead(dir);
    if (head) await git.readCommit({ fs, dir, oid: head });
    await listRefsOrEmpty(dir, APP_VERSION_REF_ROOT);
  } catch (cause) {
    if (cause instanceof AppVersionHistoryUnavailableError) throw cause;
    throw new AppVersionHistoryUnavailableError({ cause });
  }
}

async function hasRepository(dir: string): Promise<boolean> {
  try {
    const info = await lstat(join(dir, ".git"));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AppVersionHistoryUnavailableError();
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function validateProjected(entries: readonly AppPackageEntry[], appId: string): ValidatedAppPackage {
  try {
    return validateAppPackageTree(entries, appId);
  } catch (error) {
    throw new AppLifecycleError(
      "APP_PACKAGE_INVALID",
      `App package is invalid: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function writeGitTree(dir: string, entries: readonly AppPackageEntry[]): Promise<string> {
  const root = node();
  for (const entry of entries) {
    if (entry.kind !== "file") throw new Error(`Package symlinks are not supported: ${entry.path}`);
    const parts = entry.path.split("/");
    const filename = parts.pop()!;
    let parent = root;
    for (const part of parts) {
      let child = parent.directories.get(part);
      if (!child) {
        child = node();
        parent.directories.set(part, child);
      }
      parent = child;
    }
    parent.files.set(filename, await git.writeBlob({ fs, dir, blob: entry.bytes }));
  }
  return writeNode(dir, root);
}

async function writeNode(dir: string, value: GitTreeNode): Promise<string> {
  const tree: TreeObject = [];
  for (const [name, child] of value.directories) {
    tree.push({ mode: "040000", path: name, oid: await writeNode(dir, child), type: "tree" });
  }
  for (const [name, oid] of value.files) {
    tree.push({ mode: "100755", path: name, oid, type: "blob" });
  }
  tree.sort(compareTreeEntries);
  return git.writeTree({ fs, dir, tree });
}

async function readCommitPackage(dir: string, version: string): Promise<CommitPackage> {
  try {
    const { commit } = await git.readCommit({ fs, dir, oid: version });
    const entries: AppPackageEntry[] = [];
    await readTreeEntries(dir, commit.tree, "", entries);
    entries.sort(comparePackageEntries);
    return {
      entries: Object.freeze(entries),
      digest: hashAppPackageTree(entries),
      tree: commit.tree,
    };
  } catch (cause) {
    if (cause instanceof AppVersionHistoryUnavailableError) throw cause;
    throw new AppVersionHistoryUnavailableError({ cause });
  }
}

async function readTreeEntries(
  dir: string,
  treeOid: string,
  prefix: string,
  entries: AppPackageEntry[],
  activeTrees = new Set<string>(),
): Promise<void> {
  if (activeTrees.has(treeOid)) throw new AppVersionHistoryUnavailableError();
  activeTrees.add(treeOid);
  try {
    for (const entry of await readRawTree(dir, treeOid)) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === "tree") {
        await readTreeEntries(dir, entry.oid, path, entries, activeTrees);
      } else if (entry.type === "blob" && entry.mode !== "120000") {
        const { blob } = await git.readBlob({ fs, dir, oid: entry.oid });
        entries.push(Object.freeze({ path, kind: "file", bytes: Uint8Array.from(blob) }));
      } else if (entry.type === "blob" && entry.mode === "120000") {
        const { blob } = await git.readBlob({ fs, dir, oid: entry.oid });
        entries.push(Object.freeze({
          path,
          kind: "symlink",
          target: new TextDecoder("utf-8", { fatal: true }).decode(blob),
        }));
      } else {
        throw new AppVersionHistoryUnavailableError({
          cause: new Error(`Unsupported Git tree entry: ${path}`),
        });
      }
    }
  } finally {
    activeTrees.delete(treeOid);
  }
}

async function readRawTree(
  dir: string,
  oid: string,
): Promise<Array<{ path: string; oid: string; mode: string; type: "tree" | "blob" }>> {
  const object = await git.readObject({ fs, dir, oid, format: "content" });
  if (object.type !== "tree" || !(object.object instanceof Uint8Array)) {
    throw new AppVersionHistoryUnavailableError();
  }
  const bytes = Buffer.from(object.object);
  const oidBytes = oid.length / 2;
  if (oidBytes !== 20 && oidBytes !== 32) throw new AppVersionHistoryUnavailableError();
  const result: Array<{ path: string; oid: string; mode: string; type: "tree" | "blob" }> = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const space = bytes.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : bytes.indexOf(0, space + 1);
    if (space <= offset || nul <= space + 1 || nul + 1 + oidBytes > bytes.byteLength) {
      throw new AppVersionHistoryUnavailableError();
    }
    const mode = bytes.toString("ascii", offset, space);
    let path: string;
    try {
      path = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(space + 1, nul));
    } catch (cause) {
      throw new AppVersionHistoryUnavailableError({ cause });
    }
    if (!path || path.includes("/") || path.includes("\0") || path === "." || path === "..") {
      throw new AppVersionHistoryUnavailableError();
    }
    const entryOid = bytes.subarray(nul + 1, nul + 1 + oidBytes).toString("hex");
    result.push({
      path,
      oid: entryOid,
      mode,
      type: mode === "40000" || mode === "040000" ? "tree" : "blob",
    });
    offset = nul + 1 + oidBytes;
  }
  return result;
}

async function writeCommitObject(options: {
  readonly dir: string;
  readonly tree: string;
  readonly parent: string | null;
  readonly createdAt: number;
  readonly message: string;
  readonly author?: string;
}): Promise<string> {
  const person = gitPerson(options.createdAt, options.author);
  return git.writeCommit({
    fs,
    dir: options.dir,
    commit: {
      tree: options.tree,
      parent: options.parent === null ? [] : [options.parent],
      author: person,
      committer: person,
      message: options.message,
    },
  });
}

async function writeNonCollidingCommit(options: {
  readonly dir: string;
  readonly tree: string;
  readonly parent: string | null;
  readonly createdAt: number;
  readonly message: string;
  readonly author?: string;
}): Promise<{ version: string; createdAt: number }> {
  const retained = options.parent === null
    ? await readRebuildKnownVersions(options.dir)
    : new Set<string>();
  let createdAt = options.createdAt;
  for (let attempt = 0; attempt <= retained.size; attempt += 1) {
    const version = await writeCommitObject({ ...options, createdAt });
    if (!retained.has(version)) return { version, createdAt };
    createdAt += 1_000;
  }
  throw new AppVersionHistoryUnavailableError({
    cause: new Error("Could not allocate a fresh App root version after history rebuild"),
  });
}

async function reconcileIndex(dir: string, entries: readonly AppPackageEntry[]): Promise<void> {
  const retained = new Set(entries.map((entry) => entry.path));
  let existing: string[] = [];
  try {
    existing = await git.listFiles({ fs, dir });
  } catch (error) {
    if (!isMissingRef(error)) throw error;
  }
  for (const path of existing) {
    if (retained.has(path)) continue;
    await git.updateIndex({ fs, dir, filepath: path, remove: true, force: true });
  }
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const oid = await git.writeBlob({ fs, dir, blob: entry.bytes });
    await git.updateIndex({
      fs,
      dir,
      filepath: entry.path,
      oid,
      mode: 0o100755,
      add: true,
    });
  }
}

function provisionalRecord(value: Omit<AppVersionRecordV1, "schemaVersion">): AppVersionRecordV1 {
  return validateAppVersionRecordV1({ schemaVersion: 1, ...value });
}

async function requireFinalRecord(
  dir: string,
  appId: string,
  version: string,
): Promise<AppVersionRecordV1> {
  const record = await readFinalVersionRecord(dir, version);
  if (!record || record.appId !== appId) throw new AppVersionHistoryUnavailableError();
  await verifyFinalVersionRef(dir, record);
  return record;
}

async function tryResolveHead(dir: string): Promise<string | undefined> {
  return tryResolveRef(dir, "HEAD");
}

async function tryResolveRef(dir: string, ref: string): Promise<string | undefined> {
  try {
    return await git.resolveRef({ fs, dir, ref });
  } catch (error) {
    if (isMissingRef(error)) return undefined;
    throw new AppVersionHistoryUnavailableError({ cause: error });
  }
}

async function listRefsOrEmpty(dir: string, filepath: string): Promise<string[]> {
  try {
    return await git.listRefs({ fs, dir, filepath });
  } catch (error) {
    if (isMissingRef(error)) return [];
    throw new AppVersionHistoryUnavailableError({ cause: error });
  }
}

async function isDescendant(dir: string, oid: string, ancestor: string): Promise<boolean> {
  if (oid === ancestor) return true;
  try {
    return await git.isDescendent({ fs, dir, oid, ancestor });
  } catch (cause) {
    throw new AppVersionHistoryUnavailableError({ cause });
  }
}

function resolveRecordedVersion(
  records: readonly AppVersionRecordV1[],
  value: string,
): AppVersionRecordV1 {
  if (!/^[0-9a-f]{4,64}$/.test(value)) {
    throw new AppLifecycleError("APP_VERSION_NOT_FOUND", `Unknown App version: ${value}`);
  }
  const matches = records.filter((record) => record.version.startsWith(value));
  if (matches.length === 0) {
    throw new AppLifecycleError("APP_VERSION_NOT_FOUND", `Unknown App version: ${value}`);
  }
  if (matches.length > 1) {
    throw new AppLifecycleError("APP_VERSION_AMBIGUOUS", `Ambiguous App version: ${value}`);
  }
  return matches[0];
}

function validateMetadata(message?: string, author?: string): void {
  for (const [field, value] of [["message", message], ["author", author]] as const) {
    if (value !== undefined && (value.length === 0 || value.trim() !== value)) {
      throw new AppLifecycleError(
        "APP_PACKAGE_INVALID",
        `App version ${field} must be non-empty trimmed text`,
      );
    }
  }
}

function validateAppId(appId: string): void {
  if (!PACKAGE_ID_PATTERN.test(appId)) throw new Error(`Invalid App ID: ${appId}`);
}

function currentRef(appId: string): string {
  return `refs/lamarck/current/${appId}`;
}

interface AppHistoryRebuildMarkerV1 {
  readonly schemaVersion: 1;
  readonly knownVersions: readonly string[];
}

function rebuildMarkerPath(dir: string): string {
  return join(dir, ".git", "lamarck", "history-rebuild-v1.json");
}

async function writeRebuildMarker(dir: string, versions: readonly string[]): Promise<void> {
  const marker: AppHistoryRebuildMarkerV1 = {
    schemaVersion: 1,
    knownVersions: Object.freeze([...new Set(versions)].sort()),
  };
  await mkdir(join(dir, ".git", "lamarck"), { recursive: true, mode: 0o700 });
  await writeFile(
    rebuildMarkerPath(dir),
    `${JSON.stringify(marker)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

async function readRebuildKnownVersions(dir: string): Promise<ReadonlySet<string>> {
  let raw: string;
  try {
    raw = await readFile(rebuildMarkerPath(dir), "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return new Set();
    throw new AppVersionHistoryUnavailableError({ cause: error });
  }
  try {
    const value = JSON.parse(raw) as Partial<AppHistoryRebuildMarkerV1>;
    if (
      value.schemaVersion !== 1
      || !Array.isArray(value.knownVersions)
      || value.knownVersions.some((version) => typeof version !== "string"
        || !/^[0-9a-f]{40}$/.test(version))
      || Object.keys(value).some((key) => key !== "schemaVersion" && key !== "knownVersions")
      || raw !== `${JSON.stringify(value)}\n`
    ) throw new Error("invalid App history rebuild marker");
    return new Set(value.knownVersions);
  } catch (cause) {
    throw new AppVersionHistoryUnavailableError({ cause });
  }
}

interface AppWritebackMarkerV1 {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly version: string;
  readonly packageDigest: `sha256:${string}`;
}

function writebackRoot(dir: string): string {
  return join(dir, ".git", "lamarck", "writebacks-v1");
}

function writebackPath(dir: string, version: string): string {
  return join(writebackRoot(dir), `${version}.json`);
}

async function writeWritebackMarker(
  dir: string,
  record: AppVersionRecordV1,
  packageDigest: `sha256:${string}`,
): Promise<void> {
  const marker: AppWritebackMarkerV1 = {
    schemaVersion: 1,
    appId: record.appId,
    version: record.version,
    packageDigest,
  };
  await mkdir(writebackRoot(dir), { recursive: true, mode: 0o700 });
  await writeFile(
    writebackPath(dir, record.version),
    `${JSON.stringify(marker)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

async function readWritebackMarker(
  dir: string,
  version: string,
): Promise<AppWritebackMarkerV1 | undefined> {
  let raw: string;
  try {
    raw = await readFile(writebackPath(dir, version), "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw new AppVersionHistoryUnavailableError({ cause: error });
  }
  try {
    const value = JSON.parse(raw) as Partial<AppWritebackMarkerV1>;
    if (
      value.schemaVersion !== 1
      || value.version !== version
      || typeof value.appId !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(value.packageDigest ?? "")
      || raw !== `${JSON.stringify(value)}\n`
    ) throw new Error("invalid App writeback marker");
    return value as AppWritebackMarkerV1;
  } catch (cause) {
    throw new AppVersionHistoryUnavailableError({ cause });
  }
}

async function deleteWritebackMarker(dir: string, version: string): Promise<void> {
  await rm(writebackPath(dir, version), { force: true });
}

async function recoverCompletedWritebacks(appId: string, appDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(writebackRoot(appDir));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw new AppVersionHistoryUnavailableError({ cause: error });
  }
  for (const name of names) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\.json$/.exec(name);
    if (!match) throw new AppVersionHistoryUnavailableError();
    const version = match[1];
    const marker = await readWritebackMarker(appDir, version);
    if (!marker || marker.appId !== appId) throw new AppVersionHistoryUnavailableError();
    const final = await readFinalVersionRecord(appDir, version);
    if (!final) {
      await deleteWritebackMarker(appDir, version);
      continue;
    }
    const current = await tryResolveRef(appDir, currentRef(appId));
    if (current !== version) throw new AppVersionHistoryUnavailableError();
    const packageValue = await readCommitPackage(appDir, version);
    if (packageValue.digest !== marker.packageDigest) {
      throw new AppVersionHistoryUnavailableError();
    }
    await replaceAppPackageTree(appDir, packageValue.entries);
    await reconcileIndex(appDir, packageValue.entries);
    await deleteWritebackMarker(appDir, version);
  }
}

function node(): GitTreeNode {
  return { files: new Map(), directories: new Map() };
}

function gitPerson(createdAt: number, author?: string) {
  return {
    name: author ?? "Lamarck",
    email: author === undefined ? "system@lamarck.local" : "author@lamarck.local",
    timestamp: Math.floor(createdAt / 1_000),
    timezoneOffset: new Date(createdAt).getTimezoneOffset(),
  };
}

function compareTreeEntries(left: TreeEntry, right: TreeEntry): number {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

function comparePackageEntries(left: AppPackageEntry, right: AppPackageEntry): number {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, offset }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, length: number): number {
  if (value === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
      || !Number.isSafeInteger((parsed as { offset?: unknown }).offset)
      || Number((parsed as { offset: number }).offset) < 0
      || Number((parsed as { offset: number }).offset) > length
      || Object.keys(parsed).some((key) => key !== "schemaVersion" && key !== "offset")
    ) throw new Error("invalid");
    return Number((parsed as { offset: number }).offset);
  } catch (cause) {
    throw new Error("App version cursor is invalid", { cause });
  }
}

function isMissingRef(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "NotFoundError";
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
