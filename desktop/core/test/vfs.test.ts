import { createRequire } from "node:module";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { d1PathsConflict, parseVfsCommand, validateD1Path } from "@lamarck/system/internal/vfs";
import { ContentBlobStore } from "../src/blob-store";
import { D1Observer } from "../src/d1-observer";
import { D1ObserverState } from "../src/d1-observer-state";
import {
  compareFileSnapshots,
  externalizeFileChanges,
  INLINE_CHANGES_BYTES,
  INLINE_PATCH_BYTES,
  readStableD1File,
  scanD1Files,
} from "../src/filesystem-changes";
import { openSystemDatabase } from "../src/db";
import type { JsonValue } from "../src/json";
import { VfsService, type VfsCaller } from "../src/vfs";
import type { EventInput } from "../src/guard-types";
import type { RemoteGuard } from "../src/remote-guard";

const require = createRequire(import.meta.url);
const { applyPatch } = require("diff") as { applyPatch(source: string, patch: string): string | false };

class EventGuard {
  readonly events: Array<EventInput & { id: string }> = [];
  failNextWrite = false;

  async writeWorkspaceEvent(event: EventInput): Promise<string> {
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
  let closeDb: () => void;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-vfs-"));
    mkdirSync(join(workspace, ".lamarck"), { recursive: true });
    const db = openSystemDatabase(workspace);
    closeDb = () => db.close();
    state = new D1ObserverState(db);
    blobs = new ContentBlobStore(workspace);
    guard = new EventGuard();
    vfs = new VfsService(workspace, state, blobs);
    await vfs.initialize();
    filesRoot = join(workspace, "files");
  });

  afterEach(() => {
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
    const observer = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs);
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
    const observer = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs);
    await observer.observe();
    expect((guard.events.at(-1)!.payload as { changes: unknown[] }).changes).toEqual([
      expect.objectContaining({ kind: "added", path: "private/a.md" }),
    ]);
  });

  test("open URLs are workload-bound and invalidate on digest change", async () => {
    writeFileSync(join(filesRoot, "image.png"), Buffer.from([1, 2, 3]));
    const caller = { ...appCaller(guard, []), workloadId: "channel-1" };
    const url = await vfs.open(caller, "image.png", "http://core.test");
    const token = new URL(url).pathname.split("/").at(-1)!;
    expect(await vfs.resolveOpen(token, (id) => id === "channel-1")).toEqual({
      bytes: Buffer.from([1, 2, 3]),
      mediaType: "image/png",
    });
    writeFileSync(join(filesRoot, "image.png"), Buffer.from([4, 5, 6]));
    expect(await vfs.resolveOpen(token, () => true)).toBeNull();
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
    const observer = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs);
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
    const first = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs);
    await first.start();
    await first.stop();
    expect((guard.events[0]!.payload as { changes: unknown[] }).changes).toEqual([
      expect.objectContaining({ kind: "added", path: "journal.md" }),
    ]);

    writeFileSync(join(filesRoot, "journal.md"), "offline");
    const live = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs);
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

    const firstObserver = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs);
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

    const secondObserver = new D1Observer(filesRoot, guard as unknown as RemoteGuard, state, blobs);
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observer");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
