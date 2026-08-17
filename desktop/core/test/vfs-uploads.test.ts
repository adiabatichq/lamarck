import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  MAX_VFS_UPLOAD_BYTES,
  VfsUploadStore,
} from "../src/vfs-uploads";

describe("VFS upload size boundary", () => {
  let workspace: string | undefined;

  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  test("allows the exact limit and terminates an upload that exceeds it", async () => {
    expect(MAX_VFS_UPLOAD_BYTES).toBe(1024 * 1024 * 1024);
    workspace = await mkdtemp(join(tmpdir(), "lamarck-vfs-upload-limit-"));
    const store = new VfsUploadStore(workspace, 4);
    await store.initialize();

    const exact = await store.begin("workload");
    await store.append("workload", exact, 0, Buffer.from("1234").toString("base64"));
    store.complete("workload", exact);
    const consumed = store.consume("workload", exact);
    expect(consumed.byteLength).toBe(4);
    store.cleanupConsumed(consumed);

    const overflow = await store.begin("workload");
    await store.append("workload", overflow, 0, Buffer.from("1234").toString("base64"));
    await expect(store.append(
      "workload",
      overflow,
      1,
      Buffer.from("5").toString("base64"),
    )).rejects.toThrow("1 GiB size limit");

    expect(await readdir(store.root)).toEqual([]);
    expect(() => store.abort("workload", overflow)).toThrow("not available");
    expect(existsSync(join(workspace, "files"))).toBe(false);
  });

  test("reserves workload and global upload slots before concurrent file creation yields", async () => {
    workspace = await mkdtemp(join(tmpdir(), "lamarck-vfs-upload-quota-"));
    const store = new VfsUploadStore(workspace);
    await store.initialize();

    const workloadBegins = await Promise.allSettled(
      Array.from({ length: 5 }, () => store.begin("same-workload")),
    );
    expect(workloadBegins.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(workloadBegins.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(store.closeWorkload("same-workload")).toBe(4);
    expect(await readdir(store.root)).toEqual([]);

    const globalBegins = await Promise.allSettled(
      Array.from({ length: 33 }, (_, index) => store.begin(`workload-${index}`)),
    );
    expect(globalBegins.filter((result) => result.status === "fulfilled")).toHaveLength(32);
    expect(globalBegins.filter((result) => result.status === "rejected")).toHaveLength(1);
    for (let index = 0; index < 33; index += 1) store.closeWorkload(`workload-${index}`);
    expect(await readdir(store.root)).toEqual([]);
  });

  test("rolls back a reserved slot when temporary file creation fails", async () => {
    workspace = await mkdtemp(join(tmpdir(), "lamarck-vfs-upload-rollback-"));
    const store = new VfsUploadStore(workspace);

    await expect(store.begin("workload")).rejects.toThrow();
    await store.initialize();
    const tokens = await Promise.all(
      Array.from({ length: 4 }, () => store.begin("workload")),
    );
    expect(tokens).toHaveLength(4);
    expect(store.closeWorkload("workload")).toBe(4);
    expect(await readdir(store.root)).toEqual([]);
  });
});
