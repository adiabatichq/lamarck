import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { d1PathsConflict, parseVfsCommand, validateD1Path } from "@lamarck/system/internal/vfs";
import { ContentBlobStore } from "../src/blob-store";
import { D1Observer } from "../src/d1-observer";
import { D1ObserverState } from "../src/d1-observer-state";
import { D1Sequencer } from "../src/d1-sequencer";
import {
  compareFileSnapshots,
  externalizeFileChanges,
  INLINE_CHANGES_BYTES,
  INLINE_PATCH_BYTES,
  observerFilesToSnapshots,
  readStableD1File,
  recordedChanges,
  scanD1Files,
} from "../src/filesystem-changes";
import { openSystemDatabase } from "../src/db";
import type { JsonValue } from "../src/json";
import {
  MAX_VFS_OPEN_HANDLES_PER_WORKLOAD,
  VfsService,
  type VfsCaller,
} from "../src/vfs";
import type { EventInput } from "../src/guard-types";
import type { RemoteGuard } from "../src/remote-guard";

const require = createRequire(import.meta.url);
const { applyPatch } = require("diff") as { applyPatch(source: string, patch: string): string | false };

class EventGuard {
  readonly events: Array<EventInput & { id: string }> = [];
  failNextWrite = false;
  writeAttempts = 0;
  private blockedWrite: { entered: () => void; released: Promise<void> } | null = null;

  blockNextWrite(): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.blockedWrite = { entered: markEntered, released };
    return { entered, release };
  }

  async writeWorkspaceEvent(event: EventInput): Promise<string> {
    this.writeAttempts += 1;
    const blockedWrite = this.blockedWrite;
    this.blockedWrite = null;
    if (blockedWrite) {
      blockedWrite.entered();
      await blockedWrite.released;
    }
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("injected D0 failure");
    }
    const id = `event-${String(this.events.length + 1).padStart(4, "0")}`;
    this.events.push({ ...event, id });
    return id;
  }

  async query(_sql: string, params?: unknown): Promise<unknown[]> {
    const cursor = Array.isArray(params) && typeof params[0] === "string" ? params[0] : "";
    return this.events
      .filter((event) => event.id > cursor)
      .map((event) => ({ id: event.id, payload: event.payload }));
  }
}

describe("D1 VFS", () => {
  let workspace: string;
  let filesRoot: string;
  let state: D1ObserverState;
  let blobs: ContentBlobStore;
  let guard: EventGuard;
  let vfs: VfsService;
  let sequencer: D1Sequencer;
  let systemDb: ReturnType<typeof openSystemDatabase>;
  let closeDb: () => void;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-vfs-"));
    mkdirSync(join(workspace, ".lamarck"), { recursive: true });
    systemDb = openSystemDatabase(workspace);
    closeDb = () => systemDb.close();
    state = new D1ObserverState(systemDb);
    blobs = new ContentBlobStore(workspace);
    guard = new EventGuard();
    sequencer = new D1Sequencer();
    vfs = new VfsService(workspace, state, blobs, sequencer);
    await vfs.initialize();
    filesRoot = join(workspace, "files");
  });

  afterEach(async () => {
    await vfs?.close();
    closeDb?.();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("parses the supported shell-like grammar into canonical argv", () => {
    expect(parseVfsCommand(`cp -fR -- "notes/a b.md" 'archive/a b.md'`).argv).toEqual([
      "cp",
      "-Rf",
      "--",
      "notes/a b.md",
      "archive/a b.md",
    ]);
    expect(parseVfsCommand("tee -- notes/--draft.md").operands).toEqual(["notes/--draft.md"]);
    for (const command of ["cat $HOME", "ls *.md", "cat x | tee y", "cat x > y", "ls; rm x", "ls && rm x"]) {
      expect(() => parseVfsCommand(command)).toThrow("Unsupported VFS command syntax");
    }
    expect(() => parseVfsCommand("chmod x")).toThrow("Unsupported VFS command");
    expect(() => parseVfsCommand("ls -z")).toThrow("Unsupported ls flag");
  });

  test("validates real portable paths and reserved paths", () => {
    expect(validateD1Path("health/records/xray.PNG")).toBe("health/records/xray.PNG");
    expect(d1PathsConflict("Notes/a.md", "notes/b.md")).toBe(true);
    expect(d1PathsConflict("notes/a.md", "notes/deep/b.md")).toBe(false);
    for (const path of ["/absolute.md", "../escape.md", "a\\b.md", "a//b.md", "CON.txt", "x. ", ".obsidian/x", "a/.DS_Store"]) {
      expect(() => validateD1Path(path)).toThrow();
    }
  });

  test("writes bytes through one command and records exact Markdown evidence", async () => {
    mkdirSync(join(filesRoot, "notes"));
    const caller = hostCaller(guard);
    const created = await vfs.command(caller, "tee -- notes/result.md", {
      stdin: { encoding: "utf8", data: "first\r\nline" },
      author: "codex",
    });
    expect(created.success).toBe(true);
    expect(Buffer.from(created.stdoutBase64, "base64").toString()).toBe("first\r\nline");

    const modified = await vfs.command(caller, "tee -- notes/result.md", {
      stdin: { encoding: "utf8", data: "first\r\nsecond\r\n" },
      stdout: "ignore",
    });
    expect(modified.stdoutBase64).toBe("");
    expect(readFileSync(join(filesRoot, "notes/result.md"), "utf8")).toBe("first\r\nsecond\r\n");
    expect(guard.events).toHaveLength(2);

    const payload = guard.events[1]!.payload as { changes: Array<{ patch: string; kind: string; prevDigest: string }> };
    expect(payload.changes[0]!.kind).toBe("modified");
    expect(payload.changes[0]!.prevDigest).toMatch(/^sha256:/);
    expect(applyPatch("first\r\nline", payload.changes[0]!.patch)).toBe("first\r\nsecond\r\n");
    expect((guard.events[0]!.payload as Record<string, JsonValue>).argv).toEqual([
      "tee", "--", "notes/result.md",
    ]);
    expect((guard.events[0]!.payload as Record<string, JsonValue>).author).toBe("codex");
  });

  test("streams stdin beyond the request limit and records only the consumed VFS effect", async () => {
    const caller = workloadCaller(guard, "channel-large", ["large.bin"]);
    const payload = Buffer.alloc(20 * 1024 * 1024 + 123, 0x5a);
    const token = await uploadBytes(vfs, caller, payload);

    expect(guard.events).toHaveLength(0);
    expect(readdirSync(uploadRoot(workspace))).toHaveLength(1);

    const written = await vfs.command(caller, "tee -- large.bin", {
      stdin: { uploadToken: token },
      stdout: "ignore",
      author: "codex",
    });

    expect(written).toMatchObject({ success: true, stdoutBase64: "" });
    expect(statSync(join(filesRoot, "large.bin")).size).toBe(payload.byteLength);
    expect(readFileSync(join(filesRoot, "large.bin")).equals(payload)).toBe(true);
    expect(guard.events).toHaveLength(1);
    expect(guard.events[0]!.payload).toMatchObject({
      argv: ["tee", "--", "large.bin"],
      author: "codex",
      changes: [expect.objectContaining({ kind: "added", path: "large.bin" })],
    });
    expect(readdirSync(uploadRoot(workspace))).toEqual([]);
  }, 20_000);

  test("gives uploaded stdin the same VFS and D0 semantics as inline stdin", async () => {
    const caller = workloadCaller(
      guard,
      "channel-semantics",
      ["inline.bin", "uploaded.bin", "reused.bin"],
    );
    const bytes = Buffer.from([0, 1, 2, 255]);
    const inline = await vfs.command(caller, "tee -- inline.bin", {
      stdin: { encoding: "base64", data: bytes.toString("base64") },
    });
    const token = await uploadBytes(vfs, caller, bytes);
    expect(guard.events).toHaveLength(1);

    const uploaded = await vfs.command(caller, "tee -- uploaded.bin", {
      stdin: { uploadToken: token },
    });

    expect(uploaded).toEqual(inline);
    const inlineChange = (guard.events[0]!.payload as {
      changes: Array<{ kind: string; digest: string }>;
    }).changes[0]!;
    const uploadedChange = (guard.events[1]!.payload as {
      changes: Array<{ kind: string; digest: string }>;
    }).changes[0]!;
    expect(uploadedChange).toMatchObject({
      kind: inlineChange.kind,
      digest: inlineChange.digest,
    });
    const reused = await vfs.command(caller, "tee -- reused.bin", {
      stdin: { uploadToken: token },
      stdout: "ignore",
    });
    expect(reused.success).toBe(false);
    expect(readFileMaybe(join(filesRoot, "reused.bin"))).toBeNull();
    expect(guard.events).toHaveLength(2);
    expect(readFileSync(join(filesRoot, "uploaded.bin"))).toEqual(bytes);
    expect(readdirSync(uploadRoot(workspace))).toEqual([]);
  });

  test("binds upload tokens to workloads and cleans every upload lifecycle", async () => {
    const callerA = workloadCaller(guard, "channel-a", []);
    const callerB = workloadCaller(guard, "channel-b", []);

    const crossWorkload = await uploadBytes(vfs, callerA, Buffer.from("owned"));
    const rejected = await vfs.command(callerB, "tee -- stolen.bin", {
      stdin: { uploadToken: crossWorkload },
      stdout: "ignore",
    });
    expect(rejected.success).toBe(false);
    expect(Buffer.from(rejected.stderrBase64, "base64").toString()).toContain("not available");
    vfs.abortUpload(callerA, crossWorkload);

    const aborted = await vfs.beginUpload(callerA);
    await vfs.appendUpload(callerA, aborted, 0, Buffer.from("abort").toString("base64"));
    vfs.abortUpload(callerA, aborted);

    const failed = await vfs.beginUpload(callerA);
    await expect(vfs.appendUpload(callerA, failed, 0, "not base64"))
      .rejects.toThrow("canonical base64");

    const expired = await uploadBytes(vfs, callerA, Buffer.from("expire"));
    expect(expired).toBeTruthy();
    expect(vfs.cleanupExpiredUploads(Number.MAX_SAFE_INTEGER)).toBe(1);

    const denied = await uploadBytes(vfs, callerA, Buffer.from("denied"));
    const deniedResult = await vfs.command(callerA, "tee -- denied.bin", {
      stdin: { uploadToken: denied },
      stdout: "ignore",
    });
    expect(deniedResult.success).toBe(false);
    expect(readFileMaybe(join(filesRoot, "denied.bin"))).toBeNull();

    for (let index = 0; index < 4; index += 1) await vfs.beginUpload(callerA);
    await expect(vfs.beginUpload(callerA)).rejects.toThrow("Too many concurrent");
    expect(vfs.closeWorkload("channel-a")).toBe(0);
    expect(readdirSync(uploadRoot(workspace))).toEqual([]);
    expect(guard.events).toHaveLength(0);
  });

  test("transfers a consumed upload exclusively to the running command", async () => {
    const caller = workloadCaller(guard, "channel-transfer", ["owned.bin"]);
    const bytes = Buffer.from("command-owned upload");
    const token = await uploadBytes(vfs, caller, bytes);
    const temporaryPath = join(uploadRoot(workspace), token);
    const gate = guard.blockNextWrite();
    const command = vfs.command(caller, "tee -- owned.bin", {
      stdin: { uploadToken: token },
      stdout: "ignore",
    });

    try {
      await gate.entered;
      expect(readFileSync(temporaryPath)).toEqual(bytes);
      expect(() => vfs.abortUpload(caller, token)).toThrow("not available");
      expect(vfs.cleanupExpiredUploads(Number.MAX_SAFE_INTEGER)).toBe(0);
      expect(vfs.closeWorkload("channel-transfer")).toBe(0);
      expect(readFileSync(temporaryPath)).toEqual(bytes);
    } finally {
      gate.release();
    }

    expect(await command).toMatchObject({ success: true, stdoutBase64: "" });
    expect(readFileMaybe(temporaryPath)).toBeNull();
    expect(readFileSync(join(filesRoot, "owned.bin"))).toEqual(bytes);
    expect(guard.events).toHaveLength(1);
    expect(guard.events[0]!.payload).toMatchObject({
      argv: ["tee", "--", "owned.bin"],
      changes: [expect.objectContaining({ kind: "added", path: "owned.bin" })],
    });
  });

  test("does not replace a successful command when final upload cleanup fails", async () => {
    const caller = workloadCaller(guard, "channel-cleanup", ["cleanup.bin"]);
    const bytes = Buffer.from("durable command result");
    const token = await uploadBytes(vfs, caller, bytes);
    const temporaryPath = join(uploadRoot(workspace), token);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gate = guard.blockNextWrite();
    const command = vfs.command(caller, "tee -- cleanup.bin", {
      stdin: { uploadToken: token },
      stdout: "ignore",
      author: "codex",
    });

    try {
      await gate.entered;
      rmSync(temporaryPath);
      mkdirSync(temporaryPath);
    } finally {
      gate.release();
    }

    try {
      expect(await command).toMatchObject({ success: true, stdoutBase64: "" });
      expect(readFileSync(join(filesRoot, "cleanup.bin"))).toEqual(bytes);
      expect(guard.events).toHaveLength(1);
      expect(guard.events[0]!.payload).toMatchObject({
        argv: ["tee", "--", "cleanup.bin"],
        author: "codex",
        changes: [expect.objectContaining({ kind: "added", path: "cleanup.bin" })],
      });
      expect(statSync(temporaryPath).isDirectory()).toBe(true);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(String(warning.mock.calls[0]![0])).toContain("consumed upload cleanup failed");
      expect(String(warning.mock.calls[0]![0]).length).toBeLessThan(600);
    } finally {
      warning.mockRestore();
    }

    await vfs.initialize();
    expect(readdirSync(uploadRoot(workspace))).toEqual([]);
  });

  test("rejects oversized captured tee stdout before filesystem mutation", async () => {
    const caller = workloadCaller(guard, "channel-capture", ["captured.bin"]);
    const token = await uploadBytes(vfs, caller, Buffer.alloc(16 * 1024 * 1024, 0x31));

    const rejected = await vfs.command(caller, "tee -- captured.bin", {
      stdin: { uploadToken: token },
    });

    expect(rejected.success).toBe(false);
    expect(Buffer.from(rejected.stderrBase64, "base64").toString()).toContain(
      "set stdout to ignore",
    );
    expect(readFileMaybe(join(filesRoot, "captured.bin"))).toBeNull();
    expect(guard.events).toHaveLength(0);
    expect(readdirSync(uploadRoot(workspace))).toEqual([]);
  }, 20_000);

  test("keeps unrelated external edits out of authored VFS evidence", async () => {
    mkdirSync(join(filesRoot, "notes"));
    mkdirSync(join(filesRoot, "external"));
    writeFileSync(join(filesRoot, "notes/managed.md"), "managed before");
    writeFileSync(join(filesRoot, "external/unrelated.md"), "external before");
    const observer = new D1Observer(
      filesRoot,
      guard as unknown as RemoteGuard,
      state,
      blobs,
      sequencer,
    );
    await observer.observe();

    writeFileSync(join(filesRoot, "external/unrelated.md"), "external changed later");
    const mutation = await vfs.command(hostCaller(guard), "tee -- notes/managed.md", {
      stdin: { encoding: "utf8", data: "managed changed" },
      author: "codex",
    });
    expect(mutation.success).toBe(true);
    expect(guard.events[1]!.payload).toMatchObject({
      argv: ["tee", "--", "notes/managed.md"],
      author: "codex",
      changes: [expect.objectContaining({ kind: "modified", path: "notes/managed.md" })],
    });

    await observer.observe();
    expect(guard.events).toHaveLength(3);
    expect(guard.events[2]!.payload).toEqual({
      changes: [expect.objectContaining({ kind: "modified", path: "external/unrelated.md" })],
    });
  });

  test("metadata-first scans do not reread unchanged files", async () => {
    writeFileSync(join(filesRoot, "unchanged.bin"), Buffer.from([1, 2, 3]));
    writeFileSync(join(filesRoot, "changed.md"), "before");
    const initial = await scanD1Files(filesRoot);
    state.apply(
      "event-cache",
      recordedChanges(compareFileSnapshots(new Map(), initial)),
      initial,
    );

    const cached = observerFilesToSnapshots(state.listFiles());
    const unchangedReads: string[] = [];
    const unchanged = await scanD1Files(filesRoot, {
      previous: cached,
      onRead: (path) => unchangedReads.push(path),
    });
    expect(unchangedReads).toEqual([]);

    writeFileSync(join(filesRoot, "changed.md"), "after with a different length");
    const changedReads: string[] = [];
    await scanD1Files(filesRoot, {
      previous: unchanged,
      onRead: (path) => changedReads.push(path),
    });
    expect(changedReads).toEqual(["changed.md"]);
  });

  test("does not write observer cache rows during an unchanged scan", async () => {
    writeFileSync(join(filesRoot, "one.md"), "one");
    writeFileSync(join(filesRoot, "two.bin"), Buffer.from([2]));
    const observer = new D1Observer(
      filesRoot,
      guard as unknown as RemoteGuard,
      state,
      blobs,
      sequencer,
    );
    await observer.observe();
    installCacheUpdateRecorder(systemDb);
    const changesBefore = sqliteTotalChanges(systemDb);

    await observer.observe();

    expect(guard.events).toHaveLength(1);
    expect(cacheUpdatePaths(systemDb)).toEqual([]);
    expect(sqliteTotalChanges(systemDb)).toBe(changesBefore);
  });

  test("refreshes only metadata-changed cache rows without emitting D0", async () => {
    writeFileSync(join(filesRoot, "affected.md"), "same content");
    writeFileSync(join(filesRoot, "unchanged.md"), "untouched");
    const observer = new D1Observer(
      filesRoot,
      guard as unknown as RemoteGuard,
      state,
      blobs,
      sequencer,
    );
    await observer.observe();
    const before = new Map(state.listFiles().map((file) => [file.path, file]));
    installCacheUpdateRecorder(systemDb);

    utimesSync(join(filesRoot, "affected.md"), new Date(1_000), new Date(2_000));
    await observer.observe();

    const after = new Map(state.listFiles().map((file) => [file.path, file]));
    expect(guard.events).toHaveLength(1);
    expect(cacheUpdatePaths(systemDb)).toEqual(["affected.md"]);
    expect(after.get("affected.md")?.digest).toBe(before.get("affected.md")?.digest);
    expect(after.get("affected.md")?.statFingerprint)
      .not.toBe(before.get("affected.md")?.statFingerprint);
    expect(after.get("unchanged.md")).toEqual(before.get("unchanged.md"));
  });

  test("keeps content-change evidence and checkpoint updates unchanged", async () => {
    writeFileSync(join(filesRoot, "content.md"), "before");
    const observer = new D1Observer(
      filesRoot,
      guard as unknown as RemoteGuard,
      state,
      blobs,
      sequencer,
    );
    await observer.observe();
    installCacheUpdateRecorder(systemDb);

    writeFileSync(join(filesRoot, "content.md"), "after with real content");
    await observer.observe();

    expect(guard.events).toHaveLength(2);
    const payload = guard.events[1]!.payload as {
      changes: Array<{ kind: string; path: string; digest: string; prevDigest: string; patch: string }>;
    };
    expect(payload).toEqual({
      changes: [expect.objectContaining({
        kind: "modified",
        path: "content.md",
        digest: expect.stringMatching(/^sha256:/),
        prevDigest: expect.stringMatching(/^sha256:/),
        patch: expect.any(String),
      })],
    });
    expect(applyPatch("before", payload.changes[0]!.patch)).toBe("after with real content");
    expect(cacheUpdatePaths(systemDb)).toEqual(["content.md"]);
    expect(state.listFiles()).toEqual([
      expect.objectContaining({
        path: "content.md",
        digest: payload.changes[0]!.digest,
        markdownBaseline: Buffer.from("after with real content"),
      }),
    ]);
    expect(state.cursor()).toBe("event-0002");
  });

  test("does not let the observer scan between a VFS filesystem effect and its checkpoint", async () => {
    mkdirSync(join(filesRoot, "notes"));
    const observer = new D1Observer(
      filesRoot,
      guard as unknown as RemoteGuard,
      state,
      blobs,
      sequencer,
    );
    const originalListFiles = state.listFiles.bind(state);
    let observerStateReads = 0;
    state.listFiles = (() => {
      observerStateReads += 1;
      return originalListFiles();
    }) as typeof state.listFiles;

    const gate = guard.blockNextWrite();
    const mutation = vfs.command(hostCaller(guard), "tee -- notes/result.md", {
      stdin: { encoding: "utf8", data: "complete" },
      author: "codex",
    });
    let observation: Promise<void> | undefined;
    try {
      await gate.entered;
      expect(readFileSync(join(filesRoot, "notes/result.md"), "utf8")).toBe("complete");

      observation = observer.observe();
      await Promise.resolve();
      expect(observerStateReads).toBe(0);
      expect(guard.writeAttempts).toBe(1);
    } finally {
      gate.release();
    }

    expect((await mutation).success).toBe(true);
    await observation;
    expect(guard.writeAttempts).toBe(1);
    expect(guard.events).toHaveLength(1);
    expect(guard.events[0]!.payload).toMatchObject({
      argv: ["tee", "--", "notes/result.md"],
      author: "codex",
      changes: [expect.objectContaining({ kind: "added", path: "notes/result.md" })],
    });
    expect(originalListFiles()).toEqual([
      expect.objectContaining({ path: "notes/result.md" }),
    ]);
  });

  test("does not let a VFS mutation enter an observer scan sequence", async () => {
    writeFileSync(join(filesRoot, "external.md"), "external");
    const observer = new D1Observer(
      filesRoot,
      guard as unknown as RemoteGuard,
      state,
      blobs,
      sequencer,
    );
    const gate = guard.blockNextWrite();
    const observation = observer.observe();
    let mutation: Promise<Awaited<ReturnType<VfsService["command"]>>> | undefined;
    try {
      await gate.entered;
      mutation = vfs.command(hostCaller(guard), "tee -- managed.md", {
        stdin: { encoding: "utf8", data: "managed" },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(readFileMaybe(join(filesRoot, "managed.md"))).toBeNull();
      expect(guard.writeAttempts).toBe(1);
    } finally {
      gate.release();
    }

    await observation;
    expect((await mutation)?.success).toBe(true);
    expect(guard.writeAttempts).toBe(2);
    expect(guard.events).toHaveLength(2);
    expect(guard.events[0]!.payload).toEqual({
      changes: [expect.objectContaining({ kind: "added", path: "external.md" })],
    });
    expect(guard.events[1]!.payload).toMatchObject({
      argv: ["tee", "--", "managed.md"],
      changes: [expect.objectContaining({ kind: "added", path: "managed.md" })],
    });
  });

  test("preflights every operand and rejects unsupported filesystem entries", async () => {
    mkdirSync(join(filesRoot, "ok"));
    mkdirSync(join(filesRoot, "blocked"));
    const app = appCaller(guard, ["ok/"]);
    const denied = await vfs.command(app, "tee -- ok/one.md blocked/two.md", {
      stdin: { encoding: "utf8", data: "must not write" },
    });
    expect(denied.success).toBe(false);
    expect(readFileMaybe(join(filesRoot, "ok/one.md"))).toBeNull();
    expect(guard.events).toHaveLength(0);

    writeFileSync(join(filesRoot, "target.md"), "original");
    linkSync(join(filesRoot, "target.md"), join(filesRoot, "hard.md"));
    expect((await vfs.command(hostCaller(guard), "tee -- hard.md", {
      stdin: { encoding: "utf8", data: "replacement" },
    })).success).toBe(false);
    expect(readFileSync(join(filesRoot, "target.md"), "utf8")).toBe("original");

    symlinkSync(join(filesRoot, "ok"), join(filesRoot, "alias"));
    expect((await vfs.command(hostCaller(guard), "cat -- alias/one.md")).success).toBe(false);
  });

  test("classifies explicit directory moves without guessing observer moves", async () => {
    mkdirSync(join(filesRoot, "from/sub"), { recursive: true });
    writeFileSync(join(filesRoot, "from/a.md"), "a");
    writeFileSync(join(filesRoot, "from/sub/b.bin"), Buffer.from([0, 1, 2]));
    const observer = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs, sequencer);
    await observer.observe();
    guard.events.length = 0;

    const moved = await vfs.command(hostCaller(guard), "mv -- from to");
    expect(moved.success).toBe(true);
    const changes = (guard.events[0]!.payload as { changes: Array<Record<string, unknown>> }).changes;
    expect(changes).toEqual([
      expect.objectContaining({ kind: "moved", from: "from/a.md", path: "to/a.md" }),
      expect.objectContaining({ kind: "moved", from: "from/sub/b.bin", path: "to/sub/b.bin" }),
    ]);

    guard.events.length = 0;
    writeFileSync(join(filesRoot, "to/a.md"), "changed externally");
    await observer.observe();
    expect((guard.events[0]!.payload as { changes: unknown[] }).changes).toEqual([
      expect.objectContaining({ kind: "modified", path: "to/a.md" }),
    ]);
  });

  test("supports trusted import/export and never emits for export", async () => {
    const hostSource = join(workspace, "incoming");
    mkdirSync(join(hostSource, "nested"), { recursive: true });
    writeFileSync(join(hostSource, "nested/data.bin"), Buffer.from([0, 255, 8]));
    const imported = await vfs.command(hostCaller(guard), `import -- ${hostSource} imported`);
    expect(imported.success).toBe(true);
    expect(readFileSync(join(filesRoot, "imported/nested/data.bin"))).toEqual(Buffer.from([0, 255, 8]));
    expect(guard.events).toHaveLength(1);

    const appImport = await vfs.command(appCaller(guard, ["apps/demo/"]), `import -- ${hostSource} apps/demo/data`);
    expect(appImport.success).toBe(false);

    const exported = join(workspace, "exported.bin");
    expect((await vfs.command(hostCaller(guard), `export -- imported/nested/data.bin ${exported}`)).success)
      .toBe(true);
    expect(readFileSync(exported)).toEqual(Buffer.from([0, 255, 8]));
    expect(guard.events).toHaveLength(1);
  });

  test("history exclusions omit mixed evidence and re-enter as added", async () => {
    mkdirSync(join(filesRoot, "private"));
    mkdirSync(join(filesRoot, "public"));
    state.addExclusion("private/");
    const result = await vfs.command(hostCaller(guard), "tee -- private/a.md public/a.md", {
      stdin: { encoding: "utf8", data: "same" },
    });
    expect(result.success).toBe(true);
    expect((guard.events[0]!.payload as { argv: string[]; changes: Array<{ path: string }> })).toMatchObject({
      argv: ["tee", "--", "private/a.md", "public/a.md"],
      changes: [{ path: "public/a.md" }],
    });
    expect(state.listFiles().map((file) => file.path)).toEqual(["public/a.md"]);

    state.removeExclusion("private/");
    const observer = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs, sequencer);
    await observer.observe();
    expect((guard.events.at(-1)!.payload as { changes: unknown[] }).changes).toEqual([
      expect.objectContaining({ kind: "added", path: "private/a.md" }),
    ]);
  });

  test("open URLs directly stream bounded exact bytes and support bodyless HEAD", async () => {
    const expected = Buffer.alloc(3 * 64 * 1024 + 17);
    for (let index = 0; index < expected.byteLength; index += 1) expected[index] = index % 251;
    writeFileSync(join(filesRoot, "image.png"), expected);
    const caller = { ...appCaller(guard, []), workloadId: "channel-1" };
    const url = await vfs.open(caller, "image.png", "http://core.test");
    const token = new URL(url).pathname.split("/").at(-1)!;
    const openTempRoot = join(workspace, ".lamarck", "tmp", "vfs-open");
    const recordedDigest = (vfs as unknown as {
      openHandles: Map<string, { digest: string }>;
    }).openHandles.get(token)!.digest;

    const head = await vfs.resolveOpen(token, (id) => id === "channel-1", false);
    expect(head).toMatchObject({ body: null, byteLength: expected.byteLength, mediaType: "image/png" });
    expect(existsSync(openTempRoot)).toBe(false);

    const resource = await vfs.resolveOpen(token, (id) => id === "channel-1");
    expect(resource).not.toBeNull();
    expect(resource).not.toHaveProperty("bytes");
    expect(resource).toMatchObject({ byteLength: expected.byteLength, mediaType: "image/png" });
    const chunks: Buffer[] = [];
    const reader = resource!.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(64 * 1024);
    const completed = Buffer.concat(chunks);
    expect(completed).toEqual(expected);
    expect(`sha256:${createHash("sha256").update(completed).digest("hex")}`).toBe(recordedDigest);
    expect(existsSync(openTempRoot)).toBe(false);
  });

  test("rejects a digest mismatch before creating an open response", async () => {
    writeFileSync(join(filesRoot, "image.png"), Buffer.from([1, 2, 3]));
    const caller = { ...appCaller(guard, []), workloadId: "channel-mismatch" };
    const url = await vfs.open(caller, "image.png", "http://core.test");
    const token = new URL(url).pathname.split("/").at(-1)!;
    writeFileSync(join(filesRoot, "image.png"), Buffer.from([4, 5, 6]));
    expect(await vfs.resolveOpen(token, () => true)).toBeNull();
    expect(existsSync(join(workspace, ".lamarck", "tmp", "vfs-open"))).toBe(false);
  });

  test("aborts and invalidates an open response when its source mutates during streaming", async () => {
    const original = Buffer.alloc(8 * 64 * 1024, 0x5a);
    const filePath = join(filesRoot, "changing.bin");
    writeFileSync(filePath, original);
    const caller = { ...appCaller(guard, []), workloadId: "channel-changing" };
    const url = await vfs.open(caller, "changing.bin", "http://core.test");
    const token = new URL(url).pathname.split("/").at(-1)!;
    const resource = await vfs.resolveOpen(token, () => true);
    const reader = resource!.body!.getReader();
    const first = await reader.read();
    expect(first).toMatchObject({ done: false });
    let emittedBytes = first.value!.byteLength;

    writeFileSync(filePath, Buffer.alloc(original.byteLength, 0xa5));
    await expect(drainReader(reader, (chunk) => { emittedBytes += chunk.byteLength; }))
      .rejects.toThrow("changed while streaming");
    expect(emittedBytes).toBeLessThan(resource!.byteLength);
    expect(await vfs.resolveOpen(token, () => true)).toBeNull();
  });

  test("closes direct open file handles on cancellation, workload closure, and service shutdown", async () => {
    const filePath = join(filesRoot, "active.bin");
    writeFileSync(filePath, Buffer.alloc(128 * 1024, 0x5a));
    const cancelledUrl = await vfs.open(
      { ...appCaller(guard, []), workloadId: "channel-cancelled" },
      "active.bin",
      "http://core.test",
    );
    const workloadUrl = await vfs.open(
      { ...appCaller(guard, []), workloadId: "channel-active" },
      "active.bin",
      "http://core.test",
    );
    const shutdownUrl = await vfs.open(
      { ...appCaller(guard, []), workloadId: "channel-shutdown" },
      "active.bin",
      "http://core.test",
    );
    const cancelledToken = tokenFromUrl(cancelledUrl);
    const cancelled = await vfs.resolveOpen(cancelledToken, () => true);
    const cancelledHandle = activeOpenFileHandle(vfs, cancelledToken);
    await cancelled!.body!.cancel();
    expect(cancelledHandle.fd).toBe(-1);

    const workloadToken = tokenFromUrl(workloadUrl);
    const active = await vfs.resolveOpen(workloadToken, () => true);
    const activeHandle = activeOpenFileHandle(vfs, workloadToken);
    const activeReader = active!.body!.getReader();
    expect(vfs.closeWorkload("channel-active")).toBe(1);
    await expect(activeReader.read()).rejects.toThrow("closed");
    expect(activeHandle.fd).toBe(-1);
    expect(await vfs.resolveOpen(workloadToken, () => true)).toBeNull();

    const shutdownToken = tokenFromUrl(shutdownUrl);
    const shutdown = await vfs.resolveOpen(shutdownToken, () => true);
    const shutdownHandle = activeOpenFileHandle(vfs, shutdownToken);
    const shutdownReader = shutdown!.body!.getReader();
    await vfs.close();
    await expect(shutdownReader.read()).rejects.toThrow("closed");
    expect(shutdownHandle.fd).toBe(-1);
    expect(await vfs.resolveOpen(shutdownToken, () => true)).toBeNull();
  });

  test("bounds open handles per workload and releases them when the workload closes", async () => {
    writeFileSync(join(filesRoot, "image.png"), Buffer.from([1, 2, 3]));
    const caller = { ...appCaller(guard, []), workloadId: "channel-1" };
    const tokens: string[] = [];
    for (let index = 0; index < MAX_VFS_OPEN_HANDLES_PER_WORKLOAD; index += 1) {
      const url = await vfs.open(caller, "image.png", "http://core.test");
      tokens.push(new URL(url).pathname.split("/").at(-1)!);
    }
    await expect(vfs.open(caller, "image.png", "http://core.test")).rejects.toThrow(
      "handle limit exceeded",
    );
    expect(vfs.closeWorkload("channel-1")).toBe(MAX_VFS_OPEN_HANDLES_PER_WORKLOAD);
    expect(await vfs.resolveOpen(tokens[0]!, () => true)).toBeNull();
    await expect(vfs.open(caller, "image.png", "http://core.test")).resolves.toMatch(
      /^http:\/\/core\.test\/api\/vfs\/open\//,
    );
  });

  test("externalizes patches and manifests at the specified byte limits", async () => {
    const inlinePatch = externalizeFileChanges([{
      kind: "added",
      path: "boundary.md",
      digest: `sha256:${"b".repeat(64)}`,
      patch: "x".repeat(INLINE_PATCH_BYTES),
    }], blobs);
    expect(inlinePatch.changes?.[0]).toMatchObject({ patch: "x".repeat(INLINE_PATCH_BYTES) });
    const externalPatch = externalizeFileChanges([{
      kind: "added",
      path: "boundary.md",
      digest: `sha256:${"b".repeat(64)}`,
      patch: "x".repeat(INLINE_PATCH_BYTES + 1),
    }], blobs);
    expect(externalPatch.changes?.[0]).toMatchObject({ patchRef: expect.any(Object) });

    const oldPath = join(filesRoot, "large.md");
    writeFileSync(oldPath, "a\n".repeat(INLINE_PATCH_BYTES));
    const before = new Map([["large.md", await readStableD1File(filesRoot, "large.md")]]);
    writeFileSync(oldPath, "b\n".repeat(INLINE_PATCH_BYTES));
    const after = new Map([["large.md", await readStableD1File(filesRoot, "large.md")]]);
    const externalized = externalizeFileChanges(compareFileSnapshots(before, after), blobs);
    expect(externalized.changes?.[0]).toMatchObject({
      patchPreview: expect.any(String),
      patchRef: expect.objectContaining({ kind: "content-blob" }),
    });
    const changed = externalized.changes![0]!;
    if (changed.kind === "moved") throw new Error("Expected a modified Markdown change");
    expect(Buffer.byteLength(changed.patchPreview!, "utf8")).toBeLessThanOrEqual(4096);

    const many = Array.from({ length: Math.ceil(INLINE_CHANGES_BYTES / 90) }, (_, index) => ({
      kind: "added" as const,
      path: `bulk/${String(index).padStart(8, "0")}-${"x".repeat(48)}.bin`,
      digest: `sha256:${"a".repeat(64)}`,
    }));
    const manifest = externalizeFileChanges(many, blobs);
    expect(manifest.changes).toBeUndefined();
    expect(manifest.changesRef).toMatchObject({ kind: "content-blob", mediaType: "application/json" });
    expect(manifest.changesSummary?.count).toBe(many.length);

    const manifestBase = { kind: "added" as const, path: "", digest: `sha256:${"c".repeat(64)}` };
    const baseBytes = Buffer.byteLength(JSON.stringify([manifestBase]), "utf8");
    const atLimit = [{ ...manifestBase, path: "x".repeat(INLINE_CHANGES_BYTES - baseBytes) }];
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(INLINE_CHANGES_BYTES);
    expect(externalizeFileChanges(atLimit, blobs).changes).toBeDefined();
    expect(externalizeFileChanges([
      { ...manifestBase, path: "x".repeat(INLINE_CHANGES_BYTES - baseBytes + 1) },
    ], blobs).changesRef).toBeDefined();
  }, 15_000);

  test("round-trips Markdown creation and deletion with Unicode and final-newline state", async () => {
    const path = "unicode.md";
    writeFileSync(join(filesRoot, path), "第一行\r\nsecond");
    const created = compareFileSnapshots(new Map(), new Map([
      [path, await readStableD1File(filesRoot, path)],
    ]))[0];
    if (!created || created.kind !== "added") throw new Error("Expected Markdown creation");
    expect(applyPatch("", created.patch!)).toBe("第一行\r\nsecond");

    const beforeDelete = new Map([[path, await readStableD1File(filesRoot, path)]]);
    rmSync(join(filesRoot, path));
    const deleted = compareFileSnapshots(beforeDelete, new Map())[0];
    if (!deleted || deleted.kind !== "deleted") throw new Error("Expected Markdown deletion");
    expect(applyPatch("第一行\r\nsecond", deleted.patch!)).toBe("");
  });

  test("records external renames as delete plus add and ignores no-op mutations", async () => {
    writeFileSync(join(filesRoot, "before.md"), "same bytes");
    const observer = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs, sequencer);
    await observer.observe();
    guard.events.length = 0;
    renameSync(join(filesRoot, "before.md"), join(filesRoot, "after.md"));
    await observer.observe();
    expect((guard.events[0]!.payload as { changes: Array<{ kind: string; path: string }> }).changes)
      .toEqual([
        expect.objectContaining({ kind: "added", path: "after.md" }),
        expect.objectContaining({ kind: "deleted", path: "before.md" }),
      ]);
    guard.events.length = 0;
    expect((await vfs.command(hostCaller(guard), "mkdir -p -- existing")).success).toBe(true);
    guard.events.length = 0;
    expect((await vfs.command(hostCaller(guard), "mkdir -p -- existing")).success).toBe(true);
    expect(guard.events).toHaveLength(0);
  });

  test("records first scan, offline edits, and a coalesced atomic-save result", async () => {
    writeFileSync(join(filesRoot, "journal.md"), "first");
    const first = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs, sequencer);
    await first.start();
    await first.stop();
    expect((guard.events[0]!.payload as { changes: unknown[] }).changes).toEqual([
      expect.objectContaining({ kind: "added", path: "journal.md" }),
    ]);

    writeFileSync(join(filesRoot, "journal.md"), "offline");
    const live = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs, sequencer);
    await live.start();
    expect((guard.events[1]!.payload as { changes: unknown[] }).changes).toEqual([
      expect.objectContaining({ kind: "modified", path: "journal.md" }),
    ]);

    writeFileSync(join(filesRoot, ".journal-save"), "atomic final");
    renameSync(join(filesRoot, ".journal-save"), join(filesRoot, "journal.md"));
    live.schedule();
    live.schedule();
    await waitFor(() => guard.events.length === 3);
    await live.stop();
    expect((guard.events[2]!.payload as { changes: unknown[] }).changes).toEqual([
      expect.objectContaining({ kind: "modified", path: "journal.md" }),
    ]);
  });

  test("observer ignores reserved and unsupported entries with warnings", async () => {
    mkdirSync(join(filesRoot, "Notes"));
    mkdirSync(join(filesRoot, ".obsidian"));
    writeFileSync(join(filesRoot, "Notes/a.md"), "first");
    writeFileSync(join(filesRoot, ".obsidian/config"), "hidden");
    writeFileSync(join(filesRoot, "base.bin"), "hard");
    linkSync(join(filesRoot, "base.bin"), join(filesRoot, "linked.bin"));
    const warnings: string[] = [];
    const snapshot = await scanD1Files(filesRoot, { onWarning: (warning) => warnings.push(warning) });
    expect([...snapshot.keys()]).toEqual(["Notes/a.md"]);
    expect(warnings.some((warning) => warning.includes("hard-linked"))).toBe(true);
  });

  test("recovers both filesystem/D0 and D0/checkpoint failure boundaries", async () => {
    mkdirSync(join(filesRoot, "recovery"));
    guard.failNextWrite = true;
    await expect(vfs.command(hostCaller(guard), "tee -- recovery/d0-failed.md", {
      stdin: { encoding: "utf8", data: "physical effect" },
    })).rejects.toThrow("injected D0 failure");
    expect(readFileSync(join(filesRoot, "recovery/d0-failed.md"), "utf8")).toBe("physical effect");
    expect(state.cursor()).toBeNull();

    const firstObserver = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs, sequencer);
    await firstObserver.start();
    await firstObserver.stop();
    expect(guard.events).toHaveLength(1);
    expect(state.listFiles()).toEqual([
      expect.objectContaining({ path: "recovery/d0-failed.md" }),
    ]);

    const originalApply = state.apply.bind(state);
    let failCheckpoint = true;
    state.apply = ((eventId, changes, snapshots) => {
      if (failCheckpoint) {
        failCheckpoint = false;
        throw new Error("injected checkpoint failure");
      }
      return originalApply(eventId, changes, snapshots);
    }) as typeof state.apply;
    await expect(vfs.command(hostCaller(guard), "tee -- recovery/checkpoint-failed.md", {
      stdin: { encoding: "utf8", data: "durable D0" },
    })).rejects.toThrow("injected checkpoint failure");
    expect(guard.events).toHaveLength(2);
    expect(state.listFiles().map((file) => file.path)).toEqual(["recovery/d0-failed.md"]);
    writeFileSync(join(filesRoot, "recovery/checkpoint-failed.md"), "offline edit after durable D0");

    const secondObserver = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs, sequencer);
    await secondObserver.start();
    await secondObserver.stop();
    expect(guard.events).toHaveLength(3);
    const recovered = (guard.events[2]!.payload as {
      changes: Array<{ kind: string; path: string; patch: string }>;
    }).changes[0]!;
    expect(recovered).toMatchObject({ kind: "modified", path: "recovery/checkpoint-failed.md" });
    expect(applyPatch("durable D0", recovered.patch)).toBe("offline edit after durable D0");
    expect(state.cursor()).toBe("event-0003");
    expect(state.listFiles().map((file) => file.path)).toEqual([
      "recovery/checkpoint-failed.md",
      "recovery/d0-failed.md",
    ]);
  });
});

function hostCaller(guard: EventGuard): VfsCaller {
  return { guard: guard as unknown as RemoteGuard, fileGrants: null, trustedHost: true };
}

function appCaller(guard: EventGuard, fileGrants: string[]): VfsCaller {
  return { guard: guard as unknown as RemoteGuard, fileGrants, trustedHost: false };
}

function workloadCaller(
  guard: EventGuard,
  workloadId: string,
  fileGrants: string[],
): VfsCaller {
  return { ...appCaller(guard, fileGrants), workloadId };
}

async function uploadBytes(
  vfs: VfsService,
  caller: VfsCaller,
  bytes: Uint8Array,
): Promise<string> {
  const token = await vfs.beginUpload(caller);
  let index = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 512 * 1024) {
    await vfs.appendUpload(
      caller,
      token,
      index,
      Buffer.from(bytes.subarray(offset, offset + 512 * 1024)).toString("base64"),
    );
    index += 1;
  }
  vfs.completeUpload(caller, token);
  return token;
}

function uploadRoot(workspace: string): string {
  return join(workspace, ".lamarck", "tmp", "vfs-uploads");
}

function readFileMaybe(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function installCacheUpdateRecorder(db: ReturnType<typeof openSystemDatabase>): void {
  db.exec(`
    CREATE TEMP TABLE d1_observer_file_update_log (path TEXT NOT NULL);
    CREATE TEMP TRIGGER record_d1_observer_file_update
    AFTER UPDATE ON d1_observer_files
    BEGIN
      INSERT INTO d1_observer_file_update_log (path) VALUES (NEW.path);
    END;
  `);
}

function cacheUpdatePaths(db: ReturnType<typeof openSystemDatabase>): string[] {
  return (db.prepare(
    "SELECT path FROM d1_observer_file_update_log ORDER BY rowid",
  ).all() as Array<{ path: string }>).map((row) => row.path);
}

function sqliteTotalChanges(db: ReturnType<typeof openSystemDatabase>): number {
  const row = db.prepare("SELECT total_changes() AS value").get() as { value: number };
  return row.value;
}

async function drainReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk?: (chunk: Uint8Array) => void,
): Promise<void> {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onChunk?.(value);
  }
}

function tokenFromUrl(url: string): string {
  return new URL(url).pathname.split("/").at(-1)!;
}

function activeOpenFileHandle(vfs: VfsService, token: string): { readonly fd: number } {
  const leases = (vfs as unknown as {
    openResourceLeasesByToken: Map<string, Set<{ fileHandle?: { readonly fd: number } }>>;
  }).openResourceLeasesByToken.get(token);
  const fileHandle = leases && [...leases][0]?.fileHandle;
  if (!fileHandle) throw new Error("Active VFS open file handle was not found");
  return fileHandle;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observer");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
