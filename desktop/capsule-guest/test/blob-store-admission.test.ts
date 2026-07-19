import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GuestBlobStore, GuestBlobStorageUncertainError } from "../src/blob-store";
import { GuestResourceAdmission } from "../src/resource-admission";

const roots: string[] = [];
const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("CAS disk admission", () => {
  test("retains durable CAS bytes and does not double-charge a cache hit", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-cas-admission-"));
    roots.push(root);
    const admission = new GuestResourceAdmission({ diskBudgetBytes: 100, memoryBudgetBytes: 1 });
    const blobs = new GuestBlobStore(root, { admission });
    const bytes = Buffer.from("abc");
    const digest = sha256(bytes);

    expect(await blobs.receive("package", digest, bytes.byteLength, chunks(bytes), {
      ownerKey: OWNER_A,
      referenceId: "import:first",
    })).toMatchObject({
      reused: false,
    });
    expect(admission.snapshot()).toMatchObject({ reservedDiskBytes: 3, reservations: 1 });
    expect(await blobs.receive("package", digest, bytes.byteLength, chunks(bytes), {
      ownerKey: OWNER_A,
      referenceId: "import:second",
    })).toMatchObject({
      reused: true,
    });
    expect(admission.snapshot()).toMatchObject({ reservedDiskBytes: 3, reservations: 1 });
    expect(blobs.snapshot()).toMatchObject({
      blobs: 1,
      references: 2,
      ownerBytes: { [OWNER_A]: 3 },
    });
    await blobs.release("import:first");
    expect(admission.snapshot().reservedDiskBytes).toBe(3);
    await blobs.release("import:second");
    expect(admission.snapshot()).toMatchObject({ reservedDiskBytes: 0, reservations: 0 });
  });

  test("releases a failed pre-publish import", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-cas-admission-"));
    roots.push(root);
    const admission = new GuestResourceAdmission({ diskBudgetBytes: 100, memoryBudgetBytes: 1 });
    const blobs = new GuestBlobStore(root, { admission });
    const expected = Buffer.from("abc");

    await expect(blobs.receive(
      "package",
      sha256(expected),
      expected.byteLength,
      chunks(Buffer.from("abd")),
      { ownerKey: OWNER_A, referenceId: "import:failed" },
    )).rejects.toThrow(/digest mismatch/);
    expect(admission.snapshot()).toMatchObject({ reservedDiskBytes: 0, reservations: 0 });
    expect(blobs.snapshot()).toMatchObject({ blobs: 0, references: 0 });
  });

  test("enforces stable per-owner bytes while shared content stays physically deduplicated", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-cas-owner-"));
    roots.push(root);
    const admission = new GuestResourceAdmission({ diskBudgetBytes: 100, memoryBudgetBytes: 1 });
    const blobs = new GuestBlobStore(root, { admission, ownerQuotaBytes: 5 });
    const first = Buffer.from("abc");
    const second = Buffer.from("def");
    await blobs.receive("artifact", sha256(first), first.byteLength, chunks(first), {
      ownerKey: OWNER_A,
      referenceId: "app:first",
    });
    await blobs.acquireReference({
      ownerKey: OWNER_B,
      referenceId: "app:shared",
      kind: "artifact",
      digest: sha256(first),
      bytes: first.byteLength,
    });
    await expect(blobs.receive("artifact", sha256(second), second.byteLength, chunks(second), {
      ownerKey: OWNER_A,
      referenceId: "app:second",
    })).rejects.toMatchObject({ code: "CAPSULE_RESOURCE_EXHAUSTED" });
    expect(admission.snapshot().reservedDiskBytes).toBe(3);
    expect(blobs.snapshot().ownerBytes).toEqual({ [OWNER_A]: 3, [OWNER_B]: 3 });
  });

  test("serializes same-digest imports without double storage or pending-byte leakage", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-cas-race-"));
    roots.push(root);
    const admission = new GuestResourceAdmission({ diskBudgetBytes: 100, memoryBudgetBytes: 1 });
    const blobs = new GuestBlobStore(root, { admission });
    const bytes = Buffer.from("abc");
    const digest = sha256(bytes);

    await Promise.all([
      blobs.receive("package", digest, bytes.byteLength, chunks(bytes), {
        ownerKey: OWNER_A,
        referenceId: "import:same",
      }),
      blobs.receive("package", digest, bytes.byteLength, chunks(bytes), {
        ownerKey: OWNER_A,
        referenceId: "import:same",
      }),
    ]);

    expect(blobs.snapshot()).toEqual({
      blobs: 1,
      references: 1,
      ownerBytes: { [OWNER_A]: 3 },
      ownerPendingBytes: {},
    });
    expect(admission.snapshot()).toMatchObject({ reservedDiskBytes: 3, reservations: 1 });
    await blobs.release("import:same");
    expect(admission.snapshot()).toMatchObject({ reservedDiskBytes: 0, reservations: 0 });
  });

  test("rolls back a winning publication when reference acquisition fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-cas-publish-rollback-"));
    roots.push(root);
    const admission = new GuestResourceAdmission({ diskBudgetBytes: 100, memoryBudgetBytes: 1 });
    let fail = true;
    const blobs = new GuestBlobStore(root, {
      admission,
      beforePublishedReferenceAcquire: () => {
        if (!fail) return;
        fail = false;
        throw new Error("injected reference-ledger failure");
      },
    });
    const bytes = Buffer.from("abc");
    const digest = sha256(bytes);

    await expect(blobs.receive("artifact", digest, bytes.byteLength, chunks(bytes), {
      ownerKey: OWNER_A,
      referenceId: "import:failed-publish",
    })).rejects.toThrow("injected reference-ledger failure");
    await expect(access(blobs.path("artifact", digest))).rejects.toMatchObject({ code: "ENOENT" });
    expect(blobs.snapshot()).toEqual({
      blobs: 0,
      references: 0,
      ownerBytes: {},
      ownerPendingBytes: {},
    });
    expect(admission.snapshot()).toMatchObject({ reservedDiskBytes: 0, reservations: 0 });
  });

  test("keeps a failed durable release retryable and rejects use after unlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-cas-release-retry-"));
    roots.push(root);
    const admission = new GuestResourceAdmission({ diskBudgetBytes: 100, memoryBudgetBytes: 1 });
    let syncAttempts = 0;
    const blobs = new GuestBlobStore(root, {
      admission,
      syncReleasedBlobDirectory: async () => {
        syncAttempts += 1;
        if (syncAttempts === 1) throw new Error("injected fsync failure");
      },
    });
    const bytes = Buffer.from("abc");
    const digest = sha256(bytes);
    await blobs.receive("artifact", digest, bytes.byteLength, chunks(bytes), {
      ownerKey: OWNER_A,
      referenceId: "import:durability",
    });

    await expect(blobs.release("import:durability"))
      .rejects.toBeInstanceOf(GuestBlobStorageUncertainError);
    expect(blobs.snapshot()).toMatchObject({ blobs: 1, references: 1 });
    await expect(blobs.acquireReference({
      ownerKey: OWNER_A,
      referenceId: "app:forbidden",
      kind: "artifact",
      digest,
      bytes: bytes.byteLength,
    })).rejects.toBeInstanceOf(GuestBlobStorageUncertainError);

    await expect(blobs.release("import:durability")).resolves.toBe(true);
    expect(blobs.snapshot()).toEqual({
      blobs: 0,
      references: 0,
      ownerBytes: {},
      ownerPendingBytes: {},
    });
    expect(admission.snapshot()).toMatchObject({ reservedDiskBytes: 0, reservations: 0 });
  });

  test("escalates a post-publication fsync failure when rollback is also not durable", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-cas-publish-fsync-"));
    roots.push(root);
    const admission = new GuestResourceAdmission({ diskBudgetBytes: 100, memoryBudgetBytes: 1 });
    let releaseSyncAttempts = 0;
    const blobs = new GuestBlobStore(root, {
      admission,
      syncPublishedBlobDirectory: async () => {
        throw new Error("injected publication fsync failure");
      },
      syncReleasedBlobDirectory: async () => {
        releaseSyncAttempts += 1;
        if (releaseSyncAttempts === 1) throw new Error("injected rollback fsync failure");
      },
    });
    const bytes = Buffer.from("abc");
    const digest = sha256(bytes);

    await expect(blobs.receive("artifact", digest, bytes.byteLength, chunks(bytes), {
      ownerKey: OWNER_A,
      referenceId: "import:publish-fsync",
    })).rejects.toBeInstanceOf(GuestBlobStorageUncertainError);
    expect(blobs.snapshot()).toMatchObject({
      blobs: 1,
      references: 1,
      ownerBytes: { [OWNER_A]: 3 },
      ownerPendingBytes: {},
    });
    await expect(blobs.release("import:publish-fsync")).resolves.toBe(true);
    expect(blobs.snapshot()).toMatchObject({ blobs: 0, references: 0, ownerBytes: {} });
    expect(admission.snapshot()).toMatchObject({ reservedDiskBytes: 0, reservations: 0 });
  });
});

async function* chunks(value: Buffer): AsyncGenerator<Buffer> {
  yield value;
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
