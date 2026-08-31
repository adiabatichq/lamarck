import { describe, expect, test } from "vitest";
import {
  APP_PACKAGE_ID_PATTERN,
  encodeAppCliFrame,
  isCanonicalAppPackageId,
  parseAppCliRequest,
  type AppCliRequestV1,
} from "../src/app-edit/protocol";

describe("private App CLI V1 protocol", () => {
  test("matches the canonical V1 App id grammar", () => {
    for (const id of ["x", "7zip", "market.place", "a-b.c-1"]) {
      expect(isCanonicalAppPackageId(id)).toBe(true);
      expect(APP_PACKAGE_ID_PATTERN.test(id)).toBe(true);
    }
    for (const id of ["", "Upper", "-leading", ".leading", "two..dots", "slash/id"]) {
      expect(isCanonicalAppPackageId(id)).toBe(false);
    }
  });

  test("accepts only the fixed lifecycle operations and rejects arbitrary Core proxying", () => {
    const valid: AppCliRequestV1 = {
      version: 1,
      requestId: 1,
      operation: "app.list",
      input: {},
    };
    expect(parseAppCliRequest(encodeAppCliFrame(valid).subarray(4), false)).toEqual(valid);

    const arbitrary = Buffer.from(JSON.stringify({
      version: 1,
      requestId: 2,
      operation: "core.request",
      input: { method: "DELETE", path: "/api/apps/example" },
    }));
    expect(() => parseAppCliRequest(arbitrary, false)).toThrow("Malformed App CLI request");
  });

  test("rejects caller-supplied upload authority on local workload connections", () => {
    const forged = Buffer.from(JSON.stringify({
      version: 1,
      requestId: 3,
      operation: "app.save",
      input: { appId: "example" },
      upload: {
        archiveDigest: `sha256:${"a".repeat(64)}`,
        archiveBytes: 1,
        baseVersion: null,
        basePackageDigest: `sha256:${"b".repeat(64)}`,
      },
    }));
    expect(() => parseAppCliRequest(forged, false)).toThrow("Malformed App CLI request");
  });
});
