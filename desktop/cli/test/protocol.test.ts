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
  test("validates protocol identity and advertised operation names", () => {
    expect(parseCliCapabilities({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }, "host").supportedOperations)
      .toEqual(HOST_CLI_OPERATIONS);
    expect(parseCliCapabilities({ protocolVersion: 1, environment: "managed", supportedOperations: MANAGED_CLI_OPERATIONS }, "managed").supportedOperations)
      .toEqual(MANAGED_CLI_OPERATIONS);
    expect(() => parseCliCapabilities({ protocolVersion: 2, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }, "host"))
      .toThrowError(expect.objectContaining({ code: "CLI_HOST_INCOMPATIBLE" }));
  });

  test("accepts reordered, smaller and newer operation sets, while rejecting malformed capabilities", () => {
    for (const supportedOperations of [[], ["query"], ["future.command", "query"], [...MANAGED_CLI_OPERATIONS].reverse()]) {
      expect(parseCliCapabilities({ protocolVersion: 1, environment: "managed", supportedOperations }).supportedOperations).toEqual(supportedOperations);
    }
    for (const supportedOperations of [["query", "query"], ["../escape"], [""], [42], ["a".repeat(129)]]) {
      expect(() => parseCliCapabilities({ protocolVersion: 1, environment: "managed", supportedOperations })).toThrow();
    }
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

  test.each(["", "Cg=="])("accepts stdin bytes %j only at the trusted inline boundary", (stdinBase64) => {
    const request = {
      requestId: "tee-1", operation: "file.command",
      input: { argv: ["tee", "empty.md"], stdinBase64 },
    };
    expect(parseCliRequest(request, { allowInlineFileBytes: true })).toEqual(request);
    for (const options of [false, true, { allowUpload: true }]) {
      expect(() => parseCliRequest(request, options)).toThrow("inline file bytes are not allowed");
    }
    const withoutStdin = { ...request, input: { argv: request.input.argv } };
    expect(parseCliRequest(withoutStdin)).toEqual(withoutStdin);
  });

  test("rejects non-string stdin and still requires non-empty identity and text fields", () => {
    for (const stdinBase64 of [null, 0, false, {}, []]) {
      expect(() => parseCliRequest({
        requestId: "tee-1", operation: "file.command",
        input: { argv: ["tee", "empty.md"], stdinBase64 },
      }, { allowInlineFileBytes: true })).toThrow("stdinBase64 is invalid");
    }
    for (const [operation, input] of [
      ["file.command", { argv: ["tee", "empty.md"], author: "", stdinBase64: "" }],
      ["app.inspect", { appId: "" }],
      ["query", { sql: "" }],
    ]) {
      expect(() => parseCliRequest({ requestId: "invalid", operation, input }, { allowInlineFileBytes: true })).toThrow();
    }
  });

  test("frames strict JSON and pins response attribution", () => {
    const value = { requestId: "one", ok: true, result: [{ id: 1 }] };
    const frame = encodeCliFrame(value);
    expect(parseCliResponse(parseCliFrame(frame.subarray(4)), "one")).toEqual(value);
    expect(() => parseCliResponse(value, "two")).toThrow("attribution mismatch");
  });
});
