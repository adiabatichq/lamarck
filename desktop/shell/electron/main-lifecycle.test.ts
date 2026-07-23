import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("Shell window lifecycle", () => {
  test("does not dereference a destroyed BrowserWindow from its closed handler", () => {
    const match = mainSource.match(/win\.on\("closed", \(\) => \{([\s\S]*?)\n  \}\);/);
    if (!match) throw new Error("Shell BrowserWindow closed handler is missing");

    const handler = match[1];
    expect(mainSource).toContain("const shellWebContentsId = shellContents.id;");
    expect(handler).toContain("shellWebContents.delete(shellWebContentsId)");
    expect(handler).toContain("disposeTerminalsForWebContents(shellWebContentsId)");
    expect(handler).toContain("closeAppViewersForOwner(shellWebContentsId)");
    expect(handler).not.toContain("win.");
    expect(handler).not.toContain("webContents");
  });
});

describe("Shell Host configuration", () => {
  test("selects the Alpha Capsule cache before checking packaged layout", () => {
    expect(mainSource).toContain(`const capsuleCacheNamespace = app.getVersion().includes("-alpha")
  ? "ai.lamarck.desktop.alpha"
  : app.isPackaged
    ? "ai.lamarck.desktop"
    : "ai.lamarck.desktop.dev";`);
  });
});
