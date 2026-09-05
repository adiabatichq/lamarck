import { describe, expect, test } from "vitest";
import {
  HOST_CLI_OPERATIONS,
  MANAGED_CLI_OPERATIONS,
  encodeCliFrame,
  parseCliCapabilities,
  parseCliFrame,
  parseCliRequest,
  parseCliResponse,
} from "../src/index";

describe("typed CLI protocol V1", () => {
  test("negotiates the exact Host and managed operation vectors", () => {
    expect(parseCliCapabilities({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }, "host").supportedOperations)
      .toEqual(HOST_CLI_OPERATIONS);
    expect(parseCliCapabilities({ protocolVersion: 1, environment: "managed", supportedOperations: MANAGED_CLI_OPERATIONS }, "managed").supportedOperations)
      .toEqual(MANAGED_CLI_OPERATIONS);
    expect(() => parseCliCapabilities({ protocolVersion: 2, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }, "host"))
      .toThrowError(expect.objectContaining({ code: "CLI_HOST_INCOMPATIBLE" }));
  });

  test("rejects extra routing, identity, producer, and Host-path fields", () => {
    for (const extra of [
      { path: "/api/query" },
      { source: "system:forged" },
      { producerRef: `producer:v1:sha256:${"a".repeat(64)}` },
      { principal: { kind: "system" } },
      { hostPath: "/Users/private" },
    ]) {
      expect(() => parseCliRequest({ requestId: "request", operation: "query", input: { sql: "SELECT 1" }, ...extra }))
        .toThrow("unexpected or missing fields");
    }
  });

  test("allows Host-generated App uploads only at the trusted managed boundary", () => {
    const request = {
      requestId: "save-1",
      operation: "app.save",
      input: { appId: "focus" },
      upload: {
        kind: "app-package",
        archiveDigest: `sha256:${"a".repeat(64)}`,
        archiveBytes: 10,
        baseVersion: null,
        basePackageDigest: `sha256:${"b".repeat(64)}`,
      },
    };
    expect(() => parseCliRequest(request)).toThrow("upload is not allowed");
    expect(parseCliRequest(request, true)).toEqual(request);
  });

  test("frames strict JSON and pins response attribution", () => {
    const value = { requestId: "one", ok: true, result: [{ id: 1 }] };
    const frame = encodeCliFrame(value);
    expect(parseCliResponse(parseCliFrame(frame.subarray(4)), "one")).toEqual(value);
    expect(() => parseCliResponse(value, "two")).toThrow("attribution mismatch");
  });
});
