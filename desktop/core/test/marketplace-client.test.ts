import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  marketplaceResolveUrl,
  resolveMarketplacePackage,
} from "../src/marketplace/client";
import { canonicalMarketplaceResolveBytes } from "../src/marketplace/resolve";

const pair = generateKeyPairSync("ed25519");
const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
const roots = [{ keyId: "test", publicKey: publicDer.subarray(publicDer.length - 32) }];

function responsePayload() {
  const unsigned = {
    protocolVersion: 1,
    kind: "connector",
    packageId: "lamarck.rss",
    releaseId: "release-1",
    sequence: 1,
    artifactFormat: "marketplace-tar-gzip-v1",
    contentHash: `sha256:${"1".repeat(64)}`,
    artifactPath: `marketplace/v1/artifacts/connector/sha256/11/11/${"1".repeat(64)}.tar.gz`,
    artifactBytes: 42,
    publishedAt: "2026-08-04T00:00:00Z",
    origin: "Official",
    signatureKeyId: "test",
  };
  return {
    ...unsigned,
    signature: sign(null, canonicalMarketplaceResolveBytes(unsigned), pair.privateKey)
      .toString("base64url"),
  };
}

describe("Marketplace resolve client", () => {
  test("uses only the configured API origin and encoded identity path", () => {
    expect(marketplaceResolveUrl(
      "https://api.lamarck.ai/ignored/path",
      "connector",
      "lamarck.rss",
    ).toString()).toBe("https://api.lamarck.ai/marketplace/resolve/connector/lamarck.rss");
    expect(() => marketplaceResolveUrl("http://evil.example", "app", "lamarck.notes"))
      .toThrow("invalid");
    expect(() => marketplaceResolveUrl("https://user@api.lamarck.ai", "app", "lamarck.notes"))
      .toThrow("invalid");
    const namespace = "n".repeat(64);
    const name = "p".repeat(64);
    expect(marketplaceResolveUrl(
      "https://api.lamarck.ai",
      "app",
      `${namespace}.${name}`,
    ).pathname).toBe(`/marketplace/resolve/app/${namespace}.${name}`);
    expect(() => marketplaceResolveUrl(
      "https://api.lamarck.ai",
      "app",
      `${namespace}x.${name}`,
    )).toThrow("identity is invalid");
  });

  test("authenticates the bounded JSON response", async () => {
    let requestedUrl = "";
    let redirect: RequestRedirect | undefined;
    const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
      requestedUrl = String(url);
      redirect = init?.redirect;
      return new Response(JSON.stringify(responsePayload()), { status: 200 });
    };
    await expect(resolveMarketplacePackage({
      apiOrigin: "https://api.lamarck.ai",
      kind: "connector",
      packageId: "lamarck.rss",
      trustRoots: roots,
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ packageId: "lamarck.rss", origin: "Official" });
    expect(requestedUrl).toBe("https://api.lamarck.ai/marketplace/resolve/connector/lamarck.rss");
    expect(redirect).toBe("error");
  });

  test("rejects an oversized response before JSON parsing", async () => {
    const fetchImpl = async () => new Response("x".repeat(65 * 1024), { status: 200 });
    await expect(resolveMarketplacePackage({
      apiOrigin: "https://api.lamarck.ai",
      kind: "connector",
      packageId: "lamarck.rss",
      trustRoots: roots,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow("byte limit");
  });
});
