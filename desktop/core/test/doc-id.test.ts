import { describe, expect, test } from "vitest";
import { join } from "path";
import {
  docIdsHavePortableMaterializationConflict,
  portableDocIdKey,
  resolveDocFilePath,
  validateDocId,
} from "../src/doc-id";

describe("doc id validation", () => {
  test("allows normal page ids", () => {
    expect(() => validateDocId("journal/today")).not.toThrow();
    expect(() => validateDocId("stress-test")).not.toThrow();
    expect(() => validateDocId("folder/untitled")).not.toThrow();
    expect(() => validateDocId("..draft")).not.toThrow();
  });

  test("rejects traversal and ambiguous ids", () => {
    for (const id of [
      "",
      " ../x",
      "../x",
      "/tmp/x",
      "a/../x",
      "a//x",
      "a/./x",
      "a\\x",
      "a/\x00x",
      "a/question?",
      "a/trailing.",
      "con",
      "a".repeat(241),
      Array.from({ length: 390 }, () => "a").join("/"),
    ]) {
      expect(() => validateDocId(id)).toThrow("Invalid doc id");
    }
  });

  test("resolves doc files inside pages directory", () => {
    const pagesDir = "/tmp/workspace/pages";
    expect(resolveDocFilePath(pagesDir, "journal/today")).toBe(
      join(pagesDir, "journal/today.md"),
    );
    expect(resolveDocFilePath(pagesDir, "..draft")).toBe(
      join(pagesDir, "..draft.md"),
    );
    expect(() => resolveDocFilePath(pagesDir, "../outside")).toThrow("Invalid doc id");
  });

  test("derives one portable identity for case and Unicode normalization aliases", () => {
    expect(portableDocIdKey("Notes/CAFÉ")).toBe(portableDocIdKey("notes/cafe\u0301"));
    expect(portableDocIdKey("straße")).toBe(portableDocIdKey("STRASSE"));
    expect(portableDocIdKey("notes/cafe")).not.toBe(portableDocIdKey("notes/café"));
  });

  test("detects portable directory spelling and file-versus-directory conflicts", () => {
    expect(docIdsHavePortableMaterializationConflict("A/x", "a/y")).toBe(true);
    expect(docIdsHavePortableMaterializationConflict("a", "a.md/b")).toBe(true);
    expect(docIdsHavePortableMaterializationConflict("a/x", "a/y")).toBe(false);
    expect(docIdsHavePortableMaterializationConflict("a", "a/b")).toBe(false);
  });
});
