import fs from "node:fs";
import git from "isomorphic-git";
import type { EventInput } from "../guard-types";
import { AppVersionHistoryUnavailableError } from "./errors";
import {
  canonicalizeAppVersionRecordV1,
  parseCanonicalAppVersionRecordV1,
  validateAppVersionRecordV1,
  type AppVersionRecordV1,
} from "./version-record";

export const APP_VERSION_REF_ROOT = "refs/lamarck/versions";
export const APP_PENDING_REF_ROOT = "refs/lamarck/pending";
export const APP_EXTERNAL_REF_ROOT = "refs/lamarck/external";

export type AppVersionTransactionBoundary =
  | "after-commit-object"
  | "after-pending-ref"
  | "after-d0"
  | "after-final-ref"
  | "after-current-ref"
  | "after-head"
  | "after-publication"
  | "after-pending-delete";

export interface AppVersionEventWriter {
  writeEvent(event: EventInput): Promise<string> | string;
}

export interface AppVersionTransactionHooks {
  afterBoundary?(
    boundary: AppVersionTransactionBoundary,
    record: AppVersionRecordV1,
  ): Promise<void> | void;
}

export async function writePendingVersion(options: {
  readonly dir: string;
  readonly record: AppVersionRecordV1;
  readonly hooks?: AppVersionTransactionHooks;
}): Promise<void> {
  const record = validateAppVersionRecordV1(options.record);
  const existing = await tryReadVersionRef(options.dir, APP_PENDING_REF_ROOT, record.version);
  if (existing) {
    assertSameRecord(existing.record, record);
    return;
  }
  const tagOid = await git.writeTag({
    fs,
    dir: options.dir,
    tag: {
      object: record.version,
      type: "commit",
      tag: `lamarck-version-${record.version}`,
      tagger: gitPerson(record),
      message: canonicalizeAppVersionRecordV1(record),
    },
  });
  await git.writeRef({
    fs,
    dir: options.dir,
    ref: `${APP_PENDING_REF_ROOT}/${record.version}`,
    value: tagOid,
    force: true,
  });
  await options.hooks?.afterBoundary?.("after-pending-ref", record);
}

export async function finalizePendingVersion(options: {
  readonly dir: string;
  readonly record: AppVersionRecordV1;
  readonly writer: AppVersionEventWriter;
  readonly currentRef: string;
  readonly publish?: () => Promise<void>;
  readonly hooks?: AppVersionTransactionHooks;
}): Promise<void> {
  const record = validateAppVersionRecordV1(options.record);
  const pending = await tryReadVersionRef(options.dir, APP_PENDING_REF_ROOT, record.version);
  if (!pending) throw unavailable(new Error(`Pending App version is missing: ${record.version}`));
  assertSameRecord(pending.record, record);

  await options.writer.writeEvent(versionCreatedEvent(record));
  await options.hooks?.afterBoundary?.("after-d0", record);

  await writeRecordRef(options.dir, APP_VERSION_REF_ROOT, pending.tagOid, record);
  await options.hooks?.afterBoundary?.("after-final-ref", record);

  await git.writeRef({
    fs,
    dir: options.dir,
    ref: options.currentRef,
    value: record.version,
    force: true,
  });
  await options.hooks?.afterBoundary?.("after-current-ref", record);

  await git.writeRef({
    fs,
    dir: options.dir,
    ref: "refs/heads/main",
    value: record.version,
    force: true,
  });
  await git.writeRef({
    fs,
    dir: options.dir,
    ref: "HEAD",
    value: "refs/heads/main",
    symbolic: true,
    force: true,
  });
  await options.hooks?.afterBoundary?.("after-head", record);

  await options.publish?.();
  await options.hooks?.afterBoundary?.("after-publication", record);

  await deleteRefIfPresent(options.dir, `${APP_PENDING_REF_ROOT}/${record.version}`);
  await options.hooks?.afterBoundary?.("after-pending-delete", record);
}

export async function listPendingVersionRecords(dir: string): Promise<AppVersionRecordV1[]> {
  let names: string[];
  try {
    names = await git.listRefs({ fs, dir, filepath: APP_PENDING_REF_ROOT });
  } catch (error) {
    if (isMissingRef(error)) return [];
    throw unavailable(error);
  }
  const records = await Promise.all(names.map(async (name) => {
    const value = await tryReadVersionRef(dir, APP_PENDING_REF_ROOT, name);
    if (!value) throw unavailable(new Error(`Pending App version disappeared: ${name}`));
    if (value.record.version !== name) {
      throw unavailable(new Error(`Pending App version ref does not match its record: ${name}`));
    }
    return value.record;
  }));
  return records;
}

export async function readFinalVersionRecord(
  dir: string,
  version: string,
): Promise<AppVersionRecordV1 | undefined> {
  return (await tryReadVersionRef(dir, APP_VERSION_REF_ROOT, version))?.record;
}

export async function verifyFinalVersionRef(dir: string, record: AppVersionRecordV1): Promise<void> {
  const final = await tryReadVersionRef(dir, APP_VERSION_REF_ROOT, record.version);
  if (!final) throw unavailable(new Error(`Final App version ref is missing: ${record.version}`));
  assertSameRecord(final.record, record);
  try {
    await git.readCommit({ fs, dir, oid: record.version });
  } catch (error) {
    throw unavailable(error);
  }
}

function versionCreatedEvent(record: AppVersionRecordV1): EventInput {
  return {
    type: "app.version.created",
    externalId: `${record.appId}:${record.version}`,
    startedAt: record.createdAt,
    payload: {
      appId: record.appId,
      version: record.version,
      parentVersion: record.parentVersion,
      trigger: record.trigger,
      ...(record.restoredFrom === undefined ? {} : { restoredFrom: record.restoredFrom }),
      ...(record.message === undefined ? {} : { message: record.message }),
      ...(record.author === undefined ? {} : { author: record.author }),
    },
  };
}

async function writeRecordRef(
  dir: string,
  root: string,
  tagOid: string,
  record: AppVersionRecordV1,
): Promise<void> {
  const existing = await tryReadVersionRef(dir, root, record.version);
  if (existing) {
    assertSameRecord(existing.record, record);
    return;
  }
  await git.writeRef({
    fs,
    dir,
    ref: `${root}/${record.version}`,
    value: tagOid,
    force: false,
  });
}

async function tryReadVersionRef(
  dir: string,
  root: string,
  version: string,
): Promise<{ record: AppVersionRecordV1; tagOid: string } | undefined> {
  let tagOid: string;
  try {
    tagOid = await git.resolveRef({ fs, dir, ref: `${root}/${version}` });
  } catch (error) {
    if (isMissingRef(error)) return undefined;
    throw unavailable(error);
  }
  try {
    const { tag } = await git.readTag({ fs, dir, oid: tagOid });
    if (tag.type !== "commit" || tag.object !== version || tag.tag !== `lamarck-version-${version}`) {
      throw new Error(`App version tag is inconsistent: ${version}`);
    }
    const record = parseCanonicalAppVersionRecordV1(tag.message);
    if (record.version !== version) throw new Error(`App version record has the wrong commit: ${version}`);
    return { record, tagOid };
  } catch (error) {
    throw unavailable(error);
  }
}

function assertSameRecord(left: AppVersionRecordV1, right: AppVersionRecordV1): void {
  if (canonicalizeAppVersionRecordV1(left) !== canonicalizeAppVersionRecordV1(right)) {
    throw unavailable(new Error(`App version record changed: ${right.version}`));
  }
}

function gitPerson(record: AppVersionRecordV1) {
  return {
    name: record.author ?? "Lamarck",
    email: record.author === undefined ? "system@lamarck.local" : "author@lamarck.local",
    timestamp: Math.floor(record.createdAt / 1_000),
    timezoneOffset: new Date(record.createdAt).getTimezoneOffset(),
  };
}

async function deleteRefIfPresent(dir: string, ref: string): Promise<void> {
  try {
    await git.deleteRef({ fs, dir, ref });
  } catch (error) {
    if (!isMissingRef(error)) throw unavailable(error);
  }
}

function isMissingRef(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "NotFoundError";
}

function unavailable(cause: unknown): AppVersionHistoryUnavailableError {
  return new AppVersionHistoryUnavailableError({ cause });
}
