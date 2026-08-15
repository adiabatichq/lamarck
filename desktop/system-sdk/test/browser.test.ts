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
  test("keeps every supported small stdin type on the inline command path", async () => {
    const calls: Array<{ operation: SystemOperation; input: unknown }> = [];
    const invoke = vi.fn(async (operation: SystemOperation, input: unknown) => {
      calls.push({ operation, input });
      return { success: true, exitCode: 0, stdoutBase64: "", stderrBase64: "" };
    });
    browserGlobal.__LAMARCK_SYSTEM_HOST__ = { invoke: invoke as BrowserSystemHost["invoke"] };
    const arrayBuffer = new Uint8Array([4, 5]).buffer;

    await system.vfs.command("tee -- string.md", { stdin: "small" });
    await system.vfs.command("tee -- uint8.bin", { stdin: new Uint8Array([0, 255]) });
    await system.vfs.command("tee -- array-buffer.bin", { stdin: arrayBuffer });
    await system.vfs.command("tee -- blob.bin", { stdin: new Blob([new Uint8Array([6, 7])]) });

    expect(calls).toEqual([
      {
        operation: "vfs.command",
        input: { command: "tee -- string.md", options: { stdin: { encoding: "utf8", data: "small" } } },
      },
      {
        operation: "vfs.command",
        input: { command: "tee -- uint8.bin", options: { stdin: { encoding: "base64", data: "AP8=" } } },
      },
      {
        operation: "vfs.command",
        input: { command: "tee -- array-buffer.bin", options: { stdin: { encoding: "base64", data: "BAU=" } } },
      },
      {
        operation: "vfs.command",
        input: { command: "tee -- blob.bin", options: { stdin: { encoding: "base64", data: "Bgc=" } } },
      },
    ]);
  });

  test("chunks stdin larger than the transport limit without oversize requests", async () => {
    const requestBytes: number[] = [];
    const chunkLengths: number[] = [];
    let uploadedBytes = 0;
    const operations: SystemOperation[] = [];
    const invoke = vi.fn(async (operation: SystemOperation, input: unknown) => {
      operations.push(operation);
      requestBytes.push(Buffer.byteLength(JSON.stringify({ operation, input }), "utf8"));
      const value = input as Record<string, unknown>;
      if (operation === "vfs.upload.begin") return { token: "upload-token-opaque-123" };
      if (operation === "vfs.upload.chunk") {
        const bytes = Buffer.from(value.dataBase64 as string, "base64");
        chunkLengths.push(bytes.byteLength);
        uploadedBytes += bytes.byteLength;
        return { ok: true };
      }
      if (operation === "vfs.upload.complete" || operation === "vfs.upload.abort") {
        return { ok: true };
      }
      if (operation === "vfs.command") {
        expect(value).toEqual({
          command: "tee -- large.bin",
          options: {
            stdin: { uploadToken: "upload-token-opaque-123" },
            stdout: "ignore",
            author: "codex",
          },
        });
        return { success: true, exitCode: 0, stdoutBase64: "", stderrBase64: "" };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
    browserGlobal.__LAMARCK_SYSTEM_HOST__ = {
      invoke: invoke as unknown as BrowserSystemHost["invoke"],
    };
    const payload = new Uint8Array(20 * 1024 * 1024 + 123);
    payload.fill(0x5a);

    await expect(system.vfs.command("tee -- large.bin", {
      stdin: payload,
      stdout: "ignore",
      author: "codex",
    })).resolves.toMatchObject({ success: true, stdout: new Uint8Array() });

    expect(uploadedBytes).toBe(payload.byteLength);
    expect(chunkLengths.length).toBeGreaterThan(1);
    expect(Math.max(...chunkLengths)).toBeLessThanOrEqual(512 * 1024);
    expect(Math.max(...requestBytes)).toBeLessThan(20 * 1024 * 1024);
    expect(operations[0]).toBe("vfs.upload.begin");
    expect(operations.at(-2)).toBe("vfs.upload.complete");
    expect(operations.at(-1)).toBe("vfs.command");
  });

  test("explicitly aborts an upload when chunk transport fails", async () => {
    const operations: SystemOperation[] = [];
    const invoke = vi.fn(async (operation: SystemOperation) => {
      operations.push(operation);
      if (operation === "vfs.upload.begin") return { token: "upload-token-failure-123" };
      if (operation === "vfs.upload.chunk") throw new Error("injected chunk failure");
      if (operation === "vfs.upload.abort") return { ok: true };
      throw new Error(`Unexpected operation: ${operation}`);
    });
    browserGlobal.__LAMARCK_SYSTEM_HOST__ = {
      invoke: invoke as unknown as BrowserSystemHost["invoke"],
    };

    await expect(system.vfs.command("tee -- failed.bin", {
      stdin: new Uint8Array(5 * 1024 * 1024),
      stdout: "ignore",
    })).rejects.toThrow("injected chunk failure");
    expect(operations).toEqual([
      "vfs.upload.begin",
      "vfs.upload.chunk",
      "vfs.upload.abort",
    ]);
  });

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
