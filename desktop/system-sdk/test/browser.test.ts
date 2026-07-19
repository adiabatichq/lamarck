import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BROWSER_SYSTEM_HOST_GLOBAL,
  system,
  type BrowserSystemHost,
  type SystemOperation,
} from "../src/browser";

type BrowserGlobal = typeof globalThis & {
  __LAMARCK_SYSTEM_HOST__?: BrowserSystemHost;
};

const browserGlobal = globalThis as BrowserGlobal;

afterEach(() => {
  delete browserGlobal.__LAMARCK_SYSTEM_HOST__;
});

describe("browser System SDK", () => {
  test("uses only the Host-injected invoke seam and preserves the public API", async () => {
    const calls: Array<{ operation: SystemOperation; input: unknown }> = [];
    const invoke = vi.fn(async (operation: SystemOperation, input: unknown) => {
      calls.push({ operation, input });
      return operation === "query" ? { rows: [{ value: 1 }] } : { ok: true, id: "result" };
    });
    browserGlobal.__LAMARCK_SYSTEM_HOST__ = { invoke: invoke as BrowserSystemHost["invoke"] };

    await expect(system.query("SELECT ?", [1])).resolves.toEqual({ rows: [{ value: 1 }] });
    await system.mutate("DELETE FROM x");
    await system.transaction([{ sql: "SELECT 1" }]);
    await system.writeDoc("apps/a/doc", "hello", { pinned: true });
    await system.deleteDoc("apps/a/doc");
    await system.writeEvent({ type: "test", startedAt: 1, payload: {} });
    await system.resolveContentRef({
      kind: "content-blob",
      version: 1,
      digest: "sha256:x",
      variant: "redacted-text",
      mediaType: "text/plain; charset=utf-8",
      encoding: "gzip",
    });

    expect(BROWSER_SYSTEM_HOST_GLOBAL).toBe("__LAMARCK_SYSTEM_HOST__");
    expect(Object.isFrozen(system)).toBe(true);
    expect(calls.map((call) => call.operation)).toEqual([
      "query",
      "mutate",
      "transaction",
      "writeDoc",
      "deleteDoc",
      "writeEvent",
      "resolveContentRef",
    ]);
    expect(calls[0]?.input).toEqual({ sql: "SELECT ?", params: [1] });
    expect(Object.keys(browserGlobal.__LAMARCK_SYSTEM_HOST__)).toEqual(["invoke"]);
  });

  test("fails closed when the Host did not inject a channel", async () => {
    await expect(system.query("SELECT 1")).rejects.toThrow(
      "Host did not inject the System SDK channel",
    );
  });

  test("omits optional fields instead of serializing undefined values", async () => {
    const invoke = vi.fn(async () => ({ rows: [] }));
    browserGlobal.__LAMARCK_SYSTEM_HOST__ = {
      invoke: invoke as BrowserSystemHost["invoke"],
    };

    await system.query("SELECT 1");
    await system.mutate("DELETE FROM x");
    await system.writeDoc("apps/a/doc", "hello");

    expect(invoke).toHaveBeenNthCalledWith(1, "query", { sql: "SELECT 1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "mutate", { sql: "DELETE FROM x" });
    expect(invoke).toHaveBeenNthCalledWith(3, "writeDoc", {
      id: "apps/a/doc",
      content: "hello",
    });
  });
});
