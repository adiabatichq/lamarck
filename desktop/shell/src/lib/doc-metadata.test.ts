import { describe, expect, test } from "vitest";
import { normalizeDocMetadata } from "./doc-metadata";

describe("normalizeDocMetadata", () => {
  test("normalizes SQLite JSON text to the declared object contract", () => {
    expect(normalizeDocMetadata('{"locked":true,"label":"private"}')).toEqual({
      locked: true,
      label: "private",
    });
    expect(normalizeDocMetadata({ locked: false })).toEqual({ locked: false });
    expect(normalizeDocMetadata(null)).toBeNull();
  });

  test("fails closed for malformed metadata", () => {
    expect(() => normalizeDocMetadata("not-json")).toThrow(/invalid document metadata JSON/i);
    expect(() => normalizeDocMetadata("[]")).toThrow(/not an object/i);
    expect(() => normalizeDocMetadata('{"locked":"yes"}')).toThrow(/non-boolean/i);
  });
});
