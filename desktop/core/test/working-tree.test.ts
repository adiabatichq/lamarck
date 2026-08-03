import {
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveDocFilePath } from "../src/doc-id";
import {
  hashWorkingTreeContent,
  planWorkingTreeReconciliation,
  WorkingTree,
} from "../src/working-tree";
import { WorkingTreeStateStore } from "../src/working-tree-state";
import { openTestDatabases } from "./support/test-databases";
import { TEST_PRODUCER_REF, TestGuard } from "./support/test-guard";

const A = hashWorkingTreeContent("A");
const B = hashWorkingTreeContent("B");
const C = hashWorkingTreeContent("C");

describe("Working Tree reconciliation state machine", () => {
  test.each([
    ["both absent", null, null, null, false, "absent"],
    ["untracked equal sides", null, A, A, false, "converged"],
    ["untracked file only", null, null, A, false, "file-to-database"],
    ["untracked database only", null, A, null, false, "database-to-file"],
    ["untracked unequal sides", null, A, B, false, "conflict"],
    ["unchanged baseline", A, A, A, false, "converged"],
    ["same independently changed content", A, B, B, false, "converged"],
    ["file edit", A, A, B, false, "file-to-database"],
    ["file delete", A, A, null, false, "file-to-database"],
    ["database edit", A, B, A, false, "database-to-file"],
    ["database delete", A, null, A, false, "database-to-file"],
    ["concurrent edits", A, B, C, false, "conflict"],
    ["concurrent database edit and file delete", A, B, null, false, "conflict"],
    ["concurrent database delete and file edit", A, null, B, false, "conflict"],
    ["sticky unilateral change", A, A, B, true, "conflict"],
    ["sticky conflict naturally converged", A, B, B, true, "converged"],
    ["sticky conflict naturally absent", A, null, null, true, "absent"],
  ] as const)(
    "%s",
    (_name, baseline, database, file, sticky, expected) => {
      expect(planWorkingTreeReconciliation(baseline, database, file, sticky)).toBe(expected);
    },
  );

  test("metadata-only D1 changes converge alone but conflict with file divergence", () => {
    expect(planWorkingTreeReconciliation(A, A, A, false, true)).toBe("converged");
    expect(planWorkingTreeReconciliation(A, A, B, false, true)).toBe("conflict");
    expect(planWorkingTreeReconciliation(A, A, null, false, true)).toBe("conflict");
  });
});

describe("WorkingTree", () => {
  let workspace: string;
  let pagesDir: string;
  let dataDb: ReturnType<typeof openTestDatabases>["dataDb"];
  let systemDb: ReturnType<typeof openTestDatabases>["systemDb"];
  let closeDatabases: () => void;
  let guard: TestGuard;
  let state: WorkingTreeStateStore;
  let tree: WorkingTree;
  let runtimeOpen: boolean;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-working-tree-"));
    pagesDir = join(workspace, "pages");
    mkdirSync(pagesDir, { recursive: true });
    openRuntime();
  });

  afterEach(async () => {
    await closeRuntime();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("online Guard writes and deletes materialize through the shared subscriber", async () => {
    await tree.start();
    guard.writeDoc("journal/today", "# Today\n\nSome notes.");
    await tree.idle();

    expect(readLocal("journal/today")).toBe("# Today\n\nSome notes.");
    expect(state.getMirror("journal/today")?.contentHash)
      .toBe(hashWorkingTreeContent("# Today\n\nSome notes."));

    guard.deleteDoc("journal/today");
    await tree.idle();

    expect(existsSync(filePath("journal/today"))).toBe(false);
    expect(doc("journal/today")).toBeUndefined();
    expect(state.getMirror("journal/today")).toBeUndefined();
  });

  test("stop drains already queued database materialization", async () => {
    await tree.start();
    guard.writeDoc("queued/doc", "written before shutdown");

    await tree.stop();

    expect(readLocal("queued/doc")).toBe("written before shutdown");
    expect(state.getMirror("queued/doc")?.contentHash)
      .toBe(hashWorkingTreeContent("written before shutdown"));
  });

  test("startup removes only reserved stale atomic-publication files", async () => {
    const stale = join(pagesDir, ".123e4567-e89b-42d3-a456-426614174000.lamarck-tmp");
    const nestedDir = join(pagesDir, "nested");
    mkdirSync(nestedDir);
    const linked = join(nestedDir, ".123e4567-e89b-42d3-a456-426614174001.lamarck-tmp");
    const ordinary = join(pagesDir, ".keep.lamarck-tmp");
    writeLocal("nested/published", "private bytes");
    writeFileSync(stale, "stale private bytes", "utf8");
    linkSync(filePath("nested/published"), linked);
    writeFileSync(ordinary, "user file", "utf8");

    await tree.start();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(linked)).toBe(false);
    expect(readLocal("nested/published")).toBe("private bytes");
    expect(readFileSync(ordinary, "utf8")).toBe("user file");
  });

  test("online file creation, edit, and deletion use working-tree provenance", async () => {
    await tree.start();
    writeLocal("notes/edited", "old");
    await tree.reconcileNow("notes/edited");
    expect(doc("notes/edited")?.content).toBe("old");

    writeLocal("notes/edited", "new");
    await tree.reconcileNow("notes/edited");
    expect(doc("notes/edited")?.content).toBe("new");

    rmSync(filePath("notes/edited"));
    await tree.reconcileNow("notes/edited");
    expect(doc("notes/edited")).toBeUndefined();
    expect(workingTreeEvents("notes/edited").map((event) => event.type))
      .toEqual(["d1.write", "d1.write", "d1.delete"]);
  });

  test("startup imports, materializes, baselines, or conflicts every no-baseline shape", async () => {
    guard.writeDoc("database-only", "from database");
    writeLocal("file-only", "from file");
    guard.writeDoc("equal", "same");
    writeLocal("equal", "same");
    guard.writeDoc("different", "database value");
    writeLocal("different", "file value");

    await tree.start();

    expect(readLocal("database-only")).toBe("from database");
    expect(doc("file-only")?.content).toBe("from file");
    expect(doc("equal")?.content).toBe("same");
    expect(workingTreeEvents("equal")).toEqual([]);
    expect(doc("different")?.content).toBe("database value");
    expect(readLocal("different")).toBe("file value");
    expect((await tree.getConflict("different"))?.database.content).toBe("database value");
    expect((await tree.getConflict("different"))?.file.content).toBe("file value");
    for (const id of ["database-only", "file-only", "equal"]) {
      expect(state.getMirror(id)).toBeDefined();
      expect(state.getConflict(id)).toBeUndefined();
    }
  });

  test("portable path aliases fail closed before startup materializes either row", async () => {
    const now = Date.now();
    dataDb.prepare(
      `INSERT INTO docs (id, content, metadata, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?), (?, ?, NULL, ?, ?)`,
    ).run("Alias/CAFÉ", "first", now, now, "alias/cafe\u0301", "second", now, now);

    await expect(tree.start()).rejects.toThrow("incompatible portable Working Tree paths");
    expect(existsSync(filePath("Alias/CAFÉ"))).toBe(false);
    expect(existsSync(filePath("alias/cafe\u0301"))).toBe(false);
  });

  test("an offline case-only path rename becomes isolated conflicts instead of bricking Core", async () => {
    await seedConverged("case/note", "canonical");
    await closeRuntime();

    renameSync(join(pagesDir, "case"), join(pagesDir, "case-moving"));
    renameSync(join(pagesDir, "case-moving"), join(pagesDir, "Case"));
    openRuntime();
    await expect(tree.start()).resolves.toBeUndefined();

    expect(doc("case/note")?.content).toBe("canonical");
    const conflicts = await tree.listConflicts();
    expect(conflicts.map((conflict) => conflict.docId)).toEqual(["Case/note", "case/note"]);
    expect(conflicts.find((conflict) => conflict.docId === "Case/note")?.error)
      .toContain("collides with portable Working Tree id");
    expect(conflicts.find((conflict) => conflict.docId === "case/note")?.file.error)
      .toContain("where \"case\" is required");

    renameSync(join(pagesDir, "Case"), join(pagesDir, "case-moving"));
    renameSync(join(pagesDir, "case-moving"), join(pagesDir, "case"));
    await tree.reconcileNow("Case/note");
    await tree.reconcileNow("case/note");
    expect(await tree.listConflicts()).toEqual([]);
    expect(readLocal("case/note")).toBe("canonical");
  });

  test("startup paginates database ids and bounds concurrent reconciliation", async () => {
    const statement = dataDb.prepare(
      `INSERT INTO docs (id, content, metadata, created_at, updated_at)
       VALUES (?, '', NULL, ?, ?)`,
    );
    dataDb.exec("BEGIN");
    try {
      for (let index = 0; index < 511; index += 1) {
        const now = Date.now();
        statement.run(`many/doc-${String(index).padStart(4, "0")}`, now, now);
      }
      const unicodeNow = Date.now();
      statement.run("many/\uE000", unicodeNow, unicodeNow);
      statement.run("many/\u{10000}", unicodeNow, unicodeNow);
      dataDb.exec("COMMIT");
    } catch (error) {
      dataDb.exec("ROLLBACK");
      throw error;
    }

    await tree.start();

    expect(existsSync(filePath("many/doc-0000"))).toBe(true);
    expect(existsSync(filePath("many/\uE000"))).toBe(true);
    expect(existsSync(filePath("many/\u{10000}"))).toBe(true);
    expect(state.listMirrors()).toHaveLength(513);
  });

  test("Guard rejects creation of a second portable materialization identity", () => {
    guard.writeDoc("Alias/CAFÉ", "first");
    expect(() => guard.writeDoc("alias/cafe\u0301", "second"))
      .toThrow("collides with portable Working Tree id");
    expect(doc("Alias/CAFÉ")?.content).toBe("first");
    expect(doc("alias/cafe\u0301")).toBeUndefined();
  });

  test("offline file edit and deletion are replayed through Guard after restart", async () => {
    await seedConverged("offline/edit", "before", { label: "preserved" });
    await seedConverged("offline/delete", "delete me");
    await closeRuntime();

    writeLocal("offline/edit", "after");
    rmSync(filePath("offline/delete"));
    openRuntime();
    await tree.start();

    expect(doc("offline/edit")?.content).toBe("after");
    expect(parseMetadata(doc("offline/edit")?.metadata)).toEqual({ label: "preserved" });
    expect(doc("offline/delete")).toBeUndefined();
    expect(workingTreeEvents("offline/edit")).toHaveLength(1);
    expect(workingTreeEvents("offline/delete").at(-1)?.type).toBe("d1.delete");
  });

  test("offline database edit and deletion repair the materialized files after restart", async () => {
    await seedConverged("remote/edit", "before");
    await seedConverged("remote/delete", "delete me");
    await closeRuntime();

    openRuntime();
    guard.writeDoc("remote/edit", "after");
    guard.deleteDoc("remote/delete");
    await tree.start();

    expect(readLocal("remote/edit")).toBe("after");
    expect(existsSync(filePath("remote/delete"))).toBe(false);
    expect(workingTreeEvents("remote/edit")).toEqual([]);
    expect(workingTreeEvents("remote/delete")).toEqual([]);
  });

  test("offline metadata-only D1 changes conflict with local content edits or deletion", async () => {
    await seedConverged("metadata/edit", "base", { label: "old" });
    await seedConverged("metadata/delete", "base", { label: "old" });
    await closeRuntime();

    writeLocal("metadata/edit", "local edit");
    rmSync(filePath("metadata/delete"));
    openRuntime();
    guard.writeDoc("metadata/edit", "base", { label: "new" });
    guard.writeDoc("metadata/delete", "base", { locked: true, label: "new" });
    await tree.start();

    expect(doc("metadata/edit")?.content).toBe("base");
    expect(parseMetadata(doc("metadata/edit")?.metadata)).toEqual({ label: "new" });
    expect(doc("metadata/delete")?.content).toBe("base");
    expect(parseMetadata(doc("metadata/delete")?.metadata))
      .toEqual({ locked: true, label: "new" });
    expect(await tree.getConflict("metadata/edit")).not.toBeNull();
    expect(await tree.getConflict("metadata/delete")).not.toBeNull();
  });

  test("conflicts stay sticky until the two live sides naturally converge", async () => {
    await seedConverged("sticky", "base");
    guard.writeDoc("sticky", "database");
    writeLocal("sticky", "file");
    await tree.reconcileNow("sticky");
    const first = await tree.getConflict("sticky");
    expect(first).not.toBeNull();

    writeLocal("sticky", "base");
    await tree.reconcileNow("sticky");
    expect(doc("sticky")?.content).toBe("database");
    expect(readLocal("sticky")).toBe("base");
    expect(await tree.getConflict("sticky")).not.toBeNull();

    writeLocal("sticky", "database");
    await tree.reconcileNow("sticky");
    expect(await tree.getConflict("sticky")).toBeNull();
    expect(state.getMirror("sticky")?.contentHash).toBe(hashWorkingTreeContent("database"));
  });

  test("Use Database resolves a conflict without another D1 mutation", async () => {
    const conflict = await createConflict("resolve/database", "base", "database", "file");

    await expect(tree.resolveConflict("resolve/database", {
      resolution: "use-database",
      expectedVersion: conflict.expectedVersion,
    })).resolves.toEqual({ ok: true });

    expect(doc("resolve/database")?.content).toBe("database");
    expect(readLocal("resolve/database")).toBe("database");
    expect(workingTreeEvents("resolve/database")).toEqual([]);
    expect(await tree.getConflict("resolve/database")).toBeNull();
  });

  test("Use File resolves a conflict through a conditional Guard write", async () => {
    const conflict = await createConflict("resolve/file", "base", "database", "file");

    await expect(tree.resolveConflict("resolve/file", {
      resolution: "use-file",
      expectedVersion: conflict.expectedVersion,
    })).resolves.toEqual({ ok: true });

    expect(doc("resolve/file")?.content).toBe("file");
    expect(readLocal("resolve/file")).toBe("file");
    expect(workingTreeEvents("resolve/file").map((event) => event.type)).toEqual(["d1.write"]);
    expect(await tree.getConflict("resolve/file")).toBeNull();
  });

  test("Keep Both preserves the database version and creates an explicit local copy", async () => {
    await seedConverged("resolve/both", "base", { label: "inherited" });
    guard.writeDoc("resolve/both", "database");
    writeLocal("resolve/both", "file");
    await tree.reconcileNow("resolve/both");
    const conflict = await requiredConflict("resolve/both");

    await expect(tree.resolveConflict("resolve/both", {
      resolution: "keep-both",
      expectedVersion: conflict.expectedVersion,
      newId: "resolve/local-copy",
    })).resolves.toEqual({ ok: true, newDocId: "resolve/local-copy" });

    expect(doc("resolve/both")?.content).toBe("database");
    expect(readLocal("resolve/both")).toBe("database");
    expect(doc("resolve/local-copy")?.content).toBe("file");
    expect(readLocal("resolve/local-copy")).toBe("file");
    expect(parseMetadata(doc("resolve/local-copy")?.metadata)).toEqual({ label: "inherited" });
    expect(await tree.getConflict("resolve/both")).toBeNull();
  });

  test("Keep Both resumes idempotently after its copy committed before restoration", async () => {
    const conflict = await createConflict(
      "resolve/retry-both",
      "base",
      "database",
      "file",
    );
    guard.writeDoc("resolve/retry-copy", "file");
    await tree.idle();

    await expect(tree.resolveConflict("resolve/retry-both", {
      resolution: "keep-both",
      expectedVersion: conflict.expectedVersion,
      newId: "resolve/retry-copy",
    })).resolves.toEqual({ ok: true, newDocId: "resolve/retry-copy" });

    expect(readLocal("resolve/retry-both")).toBe("database");
    expect(doc("resolve/retry-copy")?.content).toBe("file");
    expect(await tree.getConflict("resolve/retry-both")).toBeNull();
  });

  test("Keep Both never mistakes matching content with different metadata for its retry", async () => {
    await seedConverged("resolve/metadata-source", "base", { label: "source" });
    guard.writeDoc("resolve/metadata-source", "database");
    writeLocal("resolve/metadata-source", "file");
    await tree.reconcileNow("resolve/metadata-source");
    const conflict = await requiredConflict("resolve/metadata-source");
    guard.writeDoc("resolve/metadata-target", "file", { label: "unrelated" });
    await tree.idle();

    await expect(tree.resolveConflict("resolve/metadata-source", {
      resolution: "keep-both",
      expectedVersion: conflict.expectedVersion,
      newId: "resolve/metadata-target",
    })).rejects.toThrow("Document already exists");

    expect(parseMetadata(doc("resolve/metadata-target")?.metadata))
      .toEqual({ label: "unrelated" });
    expect(await tree.getConflict("resolve/metadata-source")).not.toBeNull();
  });

  test("resolution rejects a stale conflict version and leaves both sides intact", async () => {
    const conflict = await createConflict("resolve/stale", "base", "database", "file");
    writeLocal("resolve/stale", "newer file");

    await expect(tree.resolveConflict("resolve/stale", {
      resolution: "use-file",
      expectedVersion: conflict.expectedVersion,
    })).rejects.toMatchObject({ code: "WORKING_TREE_CONFLICT_STALE" });

    expect(doc("resolve/stale")?.content).toBe("database");
    expect(readLocal("resolve/stale")).toBe("newer file");
    expect(await tree.getConflict("resolve/stale")).not.toBeNull();
  });

  test("locked offline edits and deletes preserve privacy and sticky metadata", async () => {
    await seedConverged("private/offline", "private", { locked: true, label: "journal" });
    expect(allEvents()).toEqual([]);
    await closeRuntime();

    writeLocal("private/offline", "edited privately");
    openRuntime();
    await tree.start();
    expect(doc("private/offline")?.content).toBe("edited privately");
    expect(parseMetadata(doc("private/offline")?.metadata))
      .toEqual({ locked: true, label: "journal" });
    expect(allEvents()).toEqual([]);
    await closeRuntime();

    rmSync(filePath("private/offline"));
    openRuntime();
    await tree.start();
    expect(doc("private/offline")).toBeUndefined();
    expect(allEvents()).toEqual([]);
  });

  test("an exact offline rename of locked bytes carries privacy to the new D1 id", async () => {
    await seedConverged("private/rename-a", "private bytes", {
      locked: true,
      label: "secret",
    });
    await closeRuntime();

    renameSync(filePath("private/rename-a"), filePath("private/rename-b"));
    openRuntime();
    await tree.start();

    expect(doc("private/rename-a")).toBeUndefined();
    expect(doc("private/rename-b")?.content).toBe("private bytes");
    expect(parseMetadata(doc("private/rename-b")?.metadata)).toEqual({ locked: true });
    expect(allEvents()).toEqual([]);
  });

  test("Use File on a locked conflict retains the lock and emits no D0 history", async () => {
    await seedConverged("private/conflict", "base", { locked: true, label: "secret" });
    guard.writeDoc("private/conflict", "database");
    writeLocal("private/conflict", "file");
    await tree.reconcileNow("private/conflict");
    const conflict = await requiredConflict("private/conflict");

    await tree.resolveConflict("private/conflict", {
      resolution: "use-file",
      expectedVersion: conflict.expectedVersion,
    });

    expect(doc("private/conflict")?.content).toBe("file");
    expect(parseMetadata(doc("private/conflict")?.metadata))
      .toEqual({ locked: true, label: "secret" });
    expect(allEvents()).toEqual([]);
  });

  test("a locked baseline stays locked when conflict resolution races a metadata unlock", async () => {
    await seedConverged("private/relock", "base", { locked: true, label: "secret" });
    guard.writeDoc("private/relock", "database", { locked: false, label: "secret" });
    writeLocal("private/relock", "local private version");
    await tree.reconcileNow("private/relock");
    const conflict = await requiredConflict("private/relock");

    await tree.resolveConflict("private/relock", {
      resolution: "use-file",
      expectedVersion: conflict.expectedVersion,
    });

    expect(parseMetadata(doc("private/relock")?.metadata))
      .toEqual({ locked: true, label: "secret" });
    expect(allEvents()).toEqual([]);
  });

  test("exact hashing catches equal-mtime equal-size offline byte changes", async () => {
    await seedConverged("same-stat", "aa");
    const fixed = new Date("2025-01-01T00:00:00.000Z");
    utimesSync(filePath("same-stat"), fixed, fixed);
    await tree.reconcileNow("same-stat");
    await closeRuntime();

    writeLocal("same-stat", "bb");
    utimesSync(filePath("same-stat"), fixed, fixed);
    expect(statSync(filePath("same-stat")).size).toBe(2);
    expect(statSync(filePath("same-stat")).mtimeMs).toBe(fixed.getTime());
    openRuntime();
    await tree.start();

    expect(doc("same-stat")?.content).toBe("bb");
    expect(state.getMirror("same-stat")?.contentHash).toBe(hashWorkingTreeContent("bb"));
  });

  test("symlinks fail closed and Use Database safely replaces only the link", async () => {
    const standaloneTarget = join(workspace, "standalone-target.md");
    writeFileSync(standaloneTarget, "outside", "utf8");
    symlinkSync(standaloneTarget, filePath("unsafe-standalone"));
    await tree.reconcileNow("unsafe-standalone");
    expect(doc("unsafe-standalone")).toBeUndefined();
    expect(state.getConflict("unsafe-standalone")).toBeUndefined();
    expect(readFileSync(standaloneTarget, "utf8")).toBe("outside");

    await seedConverged("unsafe-existing", "database");
    const target = join(workspace, "outside-target.md");
    writeFileSync(target, "outside remains", "utf8");
    rmSync(filePath("unsafe-existing"));
    symlinkSync(target, filePath("unsafe-existing"));
    await tree.reconcileNow("unsafe-existing");
    const conflict = await requiredConflict("unsafe-existing");
    expect(conflict.file.error).toContain("not a regular file");

    await tree.resolveConflict("unsafe-existing", {
      resolution: "use-database",
      expectedVersion: conflict.expectedVersion,
    });

    expect(lstatSync(filePath("unsafe-existing")).isSymbolicLink()).toBe(false);
    expect(readLocal("unsafe-existing")).toBe("database");
    expect(readFileSync(target, "utf8")).toBe("outside remains");
  });

  test("nested Unicode ids and empty content round-trip without confusing empty with absent", async () => {
    const id = "筆記/mañana-🌱";
    writeLocal(id, "");
    await tree.reconcileNow(id);

    expect(doc(id)?.content).toBe("");
    expect(state.getMirror(id)?.contentHash).toBe(hashWorkingTreeContent(""));
    expect(existsSync(filePath(id))).toBe(true);

    rmSync(filePath(id));
    await tree.reconcileNow(id);
    expect(doc(id)).toBeUndefined();
    expect(state.getMirror(id)).toBeUndefined();
  });

  test("a UTF-8 BOM is imported as U+FEFF and converges against the exact file bytes", async () => {
    const id = "encoding/bom";
    const content = "\uFEFF# BOM document";
    const path = filePath(id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(content, "utf8"));

    await tree.start();

    expect(doc(id)?.content).toBe(content);
    expect(readFileSync(path)).toEqual(Buffer.from(content, "utf8"));
    expect(state.getMirror(id)?.contentHash).toBe(hashWorkingTreeContent(content));
    expect(await tree.getConflict(id)).toBeNull();
  });

  test("one conflicted file does not block independent files from converging", async () => {
    await seedConverged("independent/conflict", "base");
    await seedConverged("independent/healthy", "base");
    guard.writeDoc("independent/conflict", "database");
    writeLocal("independent/conflict", "file");
    writeLocal("independent/healthy", "healthy edit");

    await tree.reconcileNow();

    expect(await tree.getConflict("independent/conflict")).not.toBeNull();
    expect(doc("independent/healthy")?.content).toBe("healthy edit");
    expect(state.getConflict("independent/healthy")).toBeUndefined();
  });

  test("one unreadable conflict does not hide other conflict summaries", async () => {
    await createConflict("summary/broken", "base", "database", "file");
    await createConflict("summary/healthy", "base", "database", "file");
    dataDb.prepare("UPDATE docs SET metadata = '[]' WHERE id = ?").run("summary/broken");

    const conflicts = await tree.listConflicts();

    expect(conflicts.map((conflict) => conflict.docId))
      .toEqual(["summary/broken", "summary/healthy"]);
    expect(conflicts[0].error).toContain("could not be fully inspected");
    expect(conflicts[1].error).toBeUndefined();
  });

  test("stale baselines heal every safe cross-resource crash window", async () => {
    await seedConverged("crash/equal", "old");
    guard.writeDoc("crash/equal", "new");
    writeLocal("crash/equal", "new");
    expect(state.getMirror("crash/equal")?.contentHash).toBe(hashWorkingTreeContent("old"));
    await tree.reconcileNow("crash/equal");
    expect(state.getMirror("crash/equal")?.contentHash).toBe(hashWorkingTreeContent("new"));

    await seedConverged("crash/database-first", "old");
    guard.writeDoc("crash/database-first", "new");
    await tree.reconcileNow("crash/database-first");
    expect(readLocal("crash/database-first")).toBe("new");

    await seedConverged("crash/file-first", "old");
    writeLocal("crash/file-first", "new");
    await tree.reconcileNow("crash/file-first");
    expect(doc("crash/file-first")?.content).toBe("new");

    await seedConverged("crash/absent", "old");
    guard.deleteDoc("crash/absent");
    rmSync(filePath("crash/absent"));
    expect(state.getMirror("crash/absent")).toBeDefined();
    await tree.reconcileNow("crash/absent");
    expect(state.getMirror("crash/absent")).toBeUndefined();
    expect(doc("crash/absent")).toBeUndefined();
  });

  function openRuntime(): void {
    const databases = openTestDatabases(workspace);
    dataDb = databases.dataDb;
    systemDb = databases.systemDb;
    closeDatabases = databases.close;
    guard = new TestGuard({ db: dataDb, source: "system:test" });
    state = new WorkingTreeStateStore(systemDb);
    tree = new WorkingTree({
      guard,
      producer: { producerRef: TEST_PRODUCER_REF },
      pagesDir,
      stateStore: state,
    });
    runtimeOpen = true;
  }

  async function closeRuntime(): Promise<void> {
    if (!runtimeOpen) return;
    await tree.stop();
    closeDatabases();
    runtimeOpen = false;
  }

  async function seedConverged(
    id: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    guard.writeDoc(id, content, metadata);
    await tree.reconcileNow(id);
    expect(readLocal(id)).toBe(content);
    expect(state.getMirror(id)?.contentHash).toBe(hashWorkingTreeContent(content));
  }

  async function createConflict(
    id: string,
    base: string,
    database: string,
    file: string,
  ) {
    await seedConverged(id, base);
    guard.writeDoc(id, database);
    writeLocal(id, file);
    await tree.reconcileNow(id);
    return requiredConflict(id);
  }

  async function requiredConflict(id: string) {
    const conflict = await tree.getConflict(id);
    expect(conflict).not.toBeNull();
    return conflict!;
  }

  function filePath(id: string): string {
    return resolveDocFilePath(pagesDir, id);
  }

  function writeLocal(id: string, content: string): void {
    const path = filePath(id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  function readLocal(id: string): string {
    return readFileSync(filePath(id), "utf8");
  }

  function doc(id: string): { content: string; metadata: string | null } | undefined {
    return dataDb.prepare(
      "SELECT content, metadata FROM docs WHERE id = ?",
    ).get(id) as { content: string; metadata: string | null } | undefined;
  }

  function allEvents(): Array<{ source: string; type: string; payload: string }> {
    return dataDb.prepare(
      "SELECT source, type, payload FROM events ORDER BY created_at, id",
    ).all() as unknown as Array<{ source: string; type: string; payload: string }>;
  }

  function workingTreeEvents(id: string): Array<{ source: string; type: string; payload: string }> {
    return allEvents().filter((event) => {
      if (event.source !== "working-tree:pages") return false;
      return (JSON.parse(event.payload) as { doc_id?: string }).doc_id === id;
    });
  }

  function parseMetadata(value: string | null | undefined): Record<string, unknown> | null {
    return value == null ? null : JSON.parse(value) as Record<string, unknown>;
  }
});
