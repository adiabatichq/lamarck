import { describe, expect, test } from "vitest";
import {
  encodeCliFrame,
  parseCliRequest,
  type CliRequest,
} from "@lamarck/cli";

describe("managed CLI V1 protocol", () => {
  test("accepts only typed operations and rejects arbitrary Core proxying", () => {
    const valid: CliRequest<"app.list"> = {
      requestId: "request-1",
      operation: "app.list",
      input: {},
    };
    expect(parseCliRequest(JSON.parse(encodeCliFrame(valid).subarray(4).toString("utf8")), false)).toEqual(valid);

    const arbitrary = {
      requestId: "request-2",
      operation: "core.request",
      input: { method: "DELETE", path: "/api/apps/example" },
    };
    expect(() => parseCliRequest(arbitrary, false)).toThrow("CLI operation is invalid");
  });

  test("rejects caller-supplied upload authority on local workload connections", () => {
    const forged = {
      requestId: "request-3",
      operation: "app.save",
      input: { appId: "example" },
      upload: {
        kind: "app-package",
        archiveDigest: `sha256:${"a".repeat(64)}`,
        archiveBytes: 1,
        baseVersion: null,
        basePackageDigest: `sha256:${"b".repeat(64)}`,
      },
    };
    expect(() => parseCliRequest(forged, false)).toThrow("CLI request upload is not allowed");
  });
});
