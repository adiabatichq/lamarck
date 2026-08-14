import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BROWSER_SYSTEM_HOST_GLOBAL,
  system,
  type BrowserSystemHost,
  type SystemOperation,
} from "../src/browser";

type BrowserGlobal = typeof globalThis & { __LAMARCK_SYSTEM_HOST__?: BrowserSystemHost };
const browserGlobal = globalThis as BrowserGlobal;

afterEach(() => {
  delete browserGlobal.__LAMARCK_SYSTEM_HOST__;
});

describe("browser System SDK", () => {
  test("uses only the Host-injected invoke seam and preserves the hard-cut API", async () => {
    const calls: Array<{ operation: SystemOperation; input: unknown }> = [];
    const invoke = vi.fn(async (operation: SystemOperation, input: unknown) => {
      calls.push({ operation, input });
      if (operation === "query") return { rows: [{ value: 1 }] };
      if (operation === "vfs.command") {
        return { success: true, exitCode: 0, stdoutBase64: "b2s=", stderrBase64: "" };
      }
      if (operation === "vfs.open") return { url: "http://core.test/api/vfs/open/token" };
      if (operation === "resolveContentRef") return { status: "missing", digest: "sha256:x" };
      return { ok: true, id: "result" };
    });
    browserGlobal.__LAMARCK_SYSTEM_HOST__ = { invoke: invoke as BrowserSystemHost["invoke"] };

    await expect(system.query("SELECT ?", [1])).resolves.toEqual({ rows: [{ value: 1 }] });
    await system.mutate("DELETE FROM x");
    await system.transaction([{ sql: "SELECT 1" }]);
    await expect(system.vfs.command("tee -- apps/a/result.bin", {
      stdin: new Blob([new Uint8Array([0, 255])]),
      stdout: "ignore",
      author: "codex",
    })).resolves.toMatchObject({ success: true, stdout: new Uint8Array([111, 107]) });
    await expect(system.vfs.open("apps/a/result.bin"))
      .resolves.toBe("http://core.test/api/vfs/open/token");
    await system.writeEvent({ type: "test", startedAt: 1, payload: {} });
    await system.resolveContentRef({
      kind: "content-blob",
      version: 1,
      digest: "sha256:x",
      mediaType: "text/plain; charset=utf-8",
      encoding: "gzip",
    });

    expect(BROWSER_SYSTEM_HOST_GLOBAL).toBe("__LAMARCK_SYSTEM_HOST__");
    expect(Object.isFrozen(system)).toBe(true);
    expect(Object.isFrozen(system.vfs)).toBe(true);
    expect(calls.map((call) => call.operation)).toEqual([
      "query",
      "mutate",
      "transaction",
      "vfs.command",
      "vfs.open",
      "writeEvent",
      "resolveContentRef",
    ]);
    expect(calls[3]?.input).toEqual({
      command: "tee -- apps/a/result.bin",
      options: {
        stdin: { encoding: "base64", data: "AP8=" },
        stdout: "ignore",
        author: "codex",
      },
    });
    expect(Object.keys(browserGlobal.__LAMARCK_SYSTEM_HOST__)).toEqual(["invoke"]);
  });

  test("fails closed when the Host did not inject a channel", async () => {
    await expect(system.query("SELECT 1")).rejects.toThrow(
      "Host did not inject the System SDK channel",
    );
  });

  test("omits optional fields and encodes text without inventing attribution", async () => {
    const invoke = vi.fn(async (operation: SystemOperation) => operation === "vfs.command"
      ? { success: true, exitCode: 0, stdoutBase64: "", stderrBase64: "" }
      : { rows: [] });
    browserGlobal.__LAMARCK_SYSTEM_HOST__ = { invoke: invoke as BrowserSystemHost["invoke"] };

    await system.query("SELECT 1");
    await system.mutate("DELETE FROM x");
    await system.vfs.command("tee -- apps/a/result.md", { stdin: "hello" });

    expect(invoke).toHaveBeenNthCalledWith(1, "query", { sql: "SELECT 1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "mutate", { sql: "DELETE FROM x" });
    expect(invoke).toHaveBeenNthCalledWith(3, "vfs.command", {
      command: "tee -- apps/a/result.md",
      options: { stdin: { encoding: "utf8", data: "hello" } },
    });
  });
});
