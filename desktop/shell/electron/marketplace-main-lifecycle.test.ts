import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");

describe("Marketplace Host handoff lifecycle", () => {
  test("registers all operating-system delivery paths before readiness", () => {
    expect(mainSource).toContain("app.requestSingleInstanceLock()");
    expect(mainSource).toContain('app.on("open-url"');
    expect(mainSource).toContain('app.on("second-instance"');
    expect(mainSource).toContain("marketplaceDeepLinksFromArgv(process.argv)");
    expect(mainSource).toContain('app.setAsDefaultProtocolClient("lamarck"');
  });

  test("waits for both Core and an explicitly ready renderer", () => {
    const flush = mainSource.match(
      /function flushMarketplaceHandoffs\(\): void \{[\s\S]*?\n\}/,
    )?.[0];
    if (!flush) throw new Error("Marketplace handoff flush is missing");
    expect(flush).toContain('coreRuntime.snapshot().phase !== "ready"');
    expect(flush).toContain("marketplaceRendererWebContentsId !== contents.id");
    expect(flush).toContain('contents.send("marketplace:handoff", handoff)');
    expect(mainSource).toContain('ipcMain.handle("marketplace:rendererReady"');
  });

  test("rejects queue overflow and removes a handoff only after sending it", () => {
    const enqueue = mainSource.match(
      /function queueMarketplaceHandoff[\s\S]*?\n\}/,
    )?.[0];
    const flush = mainSource.match(
      /function flushMarketplaceHandoffs\(\): void \{[\s\S]*?\n\}/,
    )?.[0];
    if (!enqueue || !flush) throw new Error("Marketplace queue functions are missing");
    expect(enqueue).toContain("marketplaceHandoffs.length >= MARKETPLACE_HANDOFF_QUEUE_LIMIT");
    expect(enqueue).toContain("return false");
    expect(enqueue).not.toContain("marketplaceHandoffs.shift()");
    expect(flush.indexOf('contents.send("marketplace:handoff", handoff)'))
      .toBeLessThan(flush.indexOf("marketplaceHandoffs.shift()"));
  });

  test("preload subscribes before the renderer readiness handshake", () => {
    expect(preloadSource).toContain('ipcRenderer.on("marketplace:handoff", listener)');
    expect(preloadSource).toContain('ipcRenderer.invoke("marketplace:rendererReady")');
    expect(preloadSource).not.toContain("artifactPath");
    expect(preloadSource).not.toContain("contentHash");
  });
});
