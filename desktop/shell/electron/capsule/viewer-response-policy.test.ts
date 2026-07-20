import { describe, expect, test } from "vitest";
import { hardenViewerResponseHeaders } from "./viewer-gateway";

describe("App viewer response policy", () => {
  test("overrides upstream cache policy with disposable no-store headers", () => {
    const headers = hardenViewerResponseHeaders({
      "cache-control": "public, max-age=31536000",
      expires: "Wed, 01 Jan 2031 00:00:00 GMT",
      pragma: "cache",
      "content-type": "text/html",
    });

    expect(headers["cache-control"]).toBe("no-store, max-age=0");
    expect(headers.pragma).toBe("no-cache");
    expect(headers.expires).toBe("0");
    expect(headers["content-security-policy"]).toContain("connect-src 'self'");
  });
});
