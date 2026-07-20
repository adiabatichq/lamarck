import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { describe, expect, test, vi } from "vitest";

const MAX_SERIALIZED_BYTES = 20 * 1024 * 1024;
const PRELOAD_SOURCE = buildSync({
  entryPoints: [fileURLToPath(new URL("./app-preload.ts", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  logLevel: "silent",
}).outputFiles[0]!.text;

interface ExposedSystemHost {
  invoke(operation: string, input: unknown): Promise<unknown>;
}

function loadPreload(ipcInvoke: ReturnType<typeof vi.fn>): ExposedSystemHost {
  let exposed: unknown;
  runInNewContext(PRELOAD_SOURCE, {
    require(id: string) {
      if (id !== "electron") throw new Error(`Unexpected preload require: ${id}`);
      return {
        contextBridge: {
          exposeInMainWorld(name: string, value: unknown) {
            if (name !== "__LAMARCK_SYSTEM_HOST__") throw new Error(`Unexpected global: ${name}`);
            exposed = value;
          },
        },
        ipcRenderer: { invoke: ipcInvoke },
      };
    },
  }, { filename: "app-preload.cjs" });
  if (!exposed || typeof exposed !== "object") throw new Error("Preload did not expose the System Host");
  return exposed as ExposedSystemHost;
}

describe("isolated App System preload", () => {
  test("crosses IPC with bounded JSON strings in both directions", async () => {
    const ipcInvoke = vi.fn(async () => JSON.stringify({
      ok: true,
      result: { rows: [{ answer: 42 }] },
    }));
    const host = loadPreload(ipcInvoke);

    await expect(host.invoke("query", { sql: "SELECT ?", params: [42] })).resolves.toEqual({
      rows: [{ answer: 42 }],
    });
    expect(ipcInvoke).toHaveBeenCalledTimes(1);
    const [channel, serialized] = ipcInvoke.mock.calls[0] as unknown as [string, string];
    expect(channel).toBe("app-system:invoke");
    expect(typeof serialized).toBe("string");
    expect(JSON.parse(serialized)).toEqual({
      operation: "query",
      input: { sql: "SELECT ?", params: [42] },
    });
  });

  test("rejects an oversized malicious request before Electron IPC", async () => {
    const ipcInvoke = vi.fn();
    const host = loadPreload(ipcInvoke);

    await expect(host.invoke("writeDoc", {
      id: "apps/malicious/oversized",
      content: "x".repeat(MAX_SERIALIZED_BYTES),
    })).rejects.toMatchObject({ message: "System SDK request exceeds the size limit" });
    expect(ipcInvoke).not.toHaveBeenCalled();
  });

  test("rejects deeply nested and cyclic graphs inside the isolated renderer", async () => {
    const ipcInvoke = vi.fn();
    const host = loadPreload(ipcInvoke);
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 140; depth++) deep = { next: deep };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(host.invoke("writeEvent", {
      type: "malicious.deep",
      startedAt: 1,
      payload: deep,
    })).rejects.toMatchObject({ message: "System SDK request is nested too deeply" });
    await expect(host.invoke("writeEvent", {
      type: "malicious.cycle",
      startedAt: 1,
      payload: cyclic,
    })).rejects.toMatchObject({ message: "System SDK request must not contain cycles" });
    expect(ipcInvoke).not.toHaveBeenCalled();
  });

  test("rejects an oversized or malformed Host response before parsing it", async () => {
    const ipcInvoke = vi.fn()
      .mockResolvedValueOnce("x".repeat(MAX_SERIALIZED_BYTES + 1))
      .mockResolvedValueOnce(JSON.stringify({ ok: true }));
    const host = loadPreload(ipcInvoke);

    await expect(host.invoke("query", { sql: "SELECT 1" })).rejects.toMatchObject({
      message: "Lamarck Host returned an invalid System SDK response",
    });
    await expect(host.invoke("query", { sql: "SELECT 1" })).rejects.toMatchObject({
      message: "Lamarck Host returned a malformed System SDK envelope",
    });
  });

  test("turns the serialized Host failure envelope back into a rejected SDK call", async () => {
    const ipcInvoke = vi.fn(async () => JSON.stringify({
      ok: false,
      error: { message: "budget full", code: "resource_exhausted" },
    }));
    const host = loadPreload(ipcInvoke);

    const error = await host.invoke("query", { sql: "SELECT 1" }).catch((caught) => caught) as Error & {
      code?: string;
    };
    expect(error.message).toBe("budget full");
    expect(error.code).toBe("resource_exhausted");
  });
});
