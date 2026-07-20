import { describe, expect, test } from "vitest";
import {
  APP_VIEWER_CSP,
  appViewerOriginHost,
  appViewerPartition,
  createShellNavigationPolicy,
  isAllowedAppViewerNavigationUrl,
  isAllowedAppViewerUrl,
  parseAllowedExternalUrl,
} from "./web-policy";

describe("Electron App/Shell web policy", () => {
  test("allows only the Host-bound App origin plus data and same-origin blob URLs", () => {
    const binding = { protocol: "http:", host: "0123456789abcdef.localhost" };
    expect(isAllowedAppViewerUrl("http://0123456789abcdef.localhost/assets/app.js", binding)).toBe(true);
    expect(isAllowedAppViewerUrl("data:text/plain,ok", binding)).toBe(true);
    expect(isAllowedAppViewerUrl("blob:http://0123456789abcdef.localhost/id", binding)).toBe(true);
    expect(isAllowedAppViewerUrl("blob:http://caller-selected.localhost/id", binding)).toBe(false);
    expect(isAllowedAppViewerUrl("http://caller-selected.localhost/", binding)).toBe(false);
    expect(isAllowedAppViewerUrl("https://example.com/", binding)).toBe(false);
    expect(isAllowedAppViewerUrl("http://127.0.0.1:32100/", binding)).toBe(false);
  });

  test("allows WebSocket only for the bound standard viewer origin", () => {
    const binding = { protocol: "http:", host: "0123456789abcdef.localhost" };
    expect(isAllowedAppViewerUrl("http://0123456789abcdef.localhost/", binding)).toBe(true);
    expect(isAllowedAppViewerUrl("ws://0123456789abcdef.localhost/hmr", binding)).toBe(true);
    expect(isAllowedAppViewerUrl("wss://0123456789abcdef.localhost/hmr", binding)).toBe(false);
    expect(isAllowedAppViewerUrl("ws://attacker.invalid/hmr", binding)).toBe(false);
  });

  test("requires top-level documents to retain the Host-hardened viewer origin", () => {
    const binding = { protocol: "http:", host: "0123456789abcdef.localhost" };
    expect(isAllowedAppViewerNavigationUrl(
      "http://0123456789abcdef.localhost/next?ok=1",
      binding,
    )).toBe(true);
    expect(isAllowedAppViewerNavigationUrl("data:text/html,<script>1</script>", binding)).toBe(false);
    expect(isAllowedAppViewerNavigationUrl(
      "blob:http://0123456789abcdef.localhost/headerless",
      binding,
    )).toBe(false);
    expect(isAllowedAppViewerNavigationUrl("http://another.localhost/", binding)).toBe(false);
  });

  test("keeps the viewer CSP origin-bound", () => {
    expect(APP_VIEWER_CSP).toContain("connect-src 'self'");
    expect(APP_VIEWER_CSP).toContain("frame-ancestors 'none'");
  });

  test("rotates the viewer origin with every Host-issued browser generation", () => {
    const first = appViewerOriginHost("/Users/person/Lamarck", "weather", "channel-one");
    const replacement = appViewerOriginHost(
      "/Users/person/Lamarck",
      "weather",
      "channel-two",
    );
    expect(first).toMatch(/^[a-f0-9]{32}\.localhost$/);
    expect(replacement).not.toBe(first);
    const firstPartition = appViewerPartition(
      "/Users/person/Lamarck",
      "weather",
      "channel-one",
    );
    const replacementPartition = appViewerPartition(
      "/Users/person/Lamarck",
      "weather",
      "channel-two",
    );
    expect(firstPartition).toMatch(/^lamarck-app-[a-f0-9]{32}$/);
    expect(firstPartition).not.toMatch(/^persist:/);
    expect(replacementPartition).not.toBe(firstPartition);
    expect(() => appViewerOriginHost("/Users/person/Lamarck", "weather", ""))
      .toThrow("generation");
  });

  test("locks trusted Shell navigation and external protocol dispatch", () => {
    const dev = createShellNavigationPolicy(new URL("http://127.0.0.1:5173/"), true);
    expect(dev("http://127.0.0.1:5173/settings")).toBe(true);
    expect(dev("http://localhost:5173/")).toBe(false);
    expect(dev("https://example.com/")).toBe(false);

    const production = createShellNavigationPolicy(new URL("file:///app/dist/index.html"), false);
    expect(production("file:///app/dist/index.html#settings")).toBe(true);
    expect(production("file:///etc/passwd")).toBe(false);
    expect(parseAllowedExternalUrl("https://example.com/").protocol).toBe("https:");
    expect(() => parseAllowedExternalUrl("file:///etc/passwd")).toThrow("not allowed");
  });
});
