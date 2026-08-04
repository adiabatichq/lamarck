import { describe, expect, test } from "vitest";
import {
  MARKETPLACE_DEEP_LINK_MAX_BYTES,
  marketplaceDeepLinksFromArgv,
  parseMarketplaceDeepLink,
} from "./marketplace-deep-link";

describe("Marketplace deep-link parser", () => {
  test.each([
    ["lamarck://marketplace/app/lamarck.notes", "app", "lamarck.notes"],
    ["lamarck://marketplace/connector/acme.read-later", "connector", "acme.read-later"],
  ])("accepts the identity-only protocol URL %s", (url, kind, packageId) => {
    expect(parseMarketplaceDeepLink(url)).toEqual({ kind, packageId });
  });

  test.each([
    "https://marketplace/app/lamarck.notes",
    "lamarck:/marketplace/app/lamarck.notes",
    "lamarck://evil.example/app/lamarck.notes",
    "lamarck://user@marketplace/app/lamarck.notes",
    "lamarck://marketplace:80/app/lamarck.notes",
    "lamarck://marketplace/app/lamarck.notes?artifact=https://evil.example/a",
    "lamarck://marketplace/app/lamarck.notes#fragment",
    "lamarck://marketplace/app/lamarck.notes/extra",
    "lamarck://marketplace/app/lamarck",
    "lamarck://marketplace/app/lamarck.notes.extra",
    "lamarck://marketplace/app/Lamarck.notes",
    "lamarck://marketplace/app/lamarck.%6eotes",
    "lamarck://marketplace/package/lamarck.notes",
    "lamarck://marketplace/app/../connector/lamarck.notes",
  ])("rejects malformed or authority-bearing URL %s", (url) => {
    expect(() => parseMarketplaceDeepLink(url)).toThrow();
  });

  test("rejects oversized URLs before parsing", () => {
    const url = `lamarck://marketplace/app/lamarck.${"a".repeat(MARKETPLACE_DEEP_LINK_MAX_BYTES)}`;
    expect(() => parseMarketplaceDeepLink(url)).toThrow("oversized");
  });

  test("accepts two 64-byte ID segments and rejects either segment at 65 bytes", () => {
    const namespace = "n".repeat(64);
    const name = "p".repeat(64);
    expect(parseMarketplaceDeepLink(
      `lamarck://marketplace/app/${namespace}.${name}`,
    )).toEqual({ kind: "app", packageId: `${namespace}.${name}` });
    expect(() => parseMarketplaceDeepLink(
      `lamarck://marketplace/app/${namespace}x.${name}`,
    )).toThrow("valid scoped package ID");
    expect(() => parseMarketplaceDeepLink(
      `lamarck://marketplace/app/${namespace}.${name}x`,
    )).toThrow("valid scoped package ID");
  });

  test("extracts only valid protocol arguments in order", () => {
    expect(marketplaceDeepLinksFromArgv([
      "/Applications/Lamarck.app/Contents/MacOS/Lamarck",
      "--flag",
      "lamarck://marketplace/app/lamarck.notes",
      "lamarck://marketplace/app/lamarck.%6eotes",
      "lamarck://marketplace/connector/lamarck.rss",
    ])).toEqual([
      { kind: "app", packageId: "lamarck.notes" },
      { kind: "connector", packageId: "lamarck.rss" },
    ]);
  });
});
