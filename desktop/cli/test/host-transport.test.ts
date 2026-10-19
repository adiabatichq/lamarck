import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HOST_CLI_OPERATIONS, HostCliTransport, readRuntimeDescriptor, encodeCliHttpResponse } from "../src/index";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Host runtime discovery", () => {
  test("accepts only a current owner-only descriptor", async () => {
    const { path, descriptor } = await fixture();
    expect(await readRuntimeDescriptor(path)).toEqual(descriptor);
  });

  test.each([
    ["invalid token", async (path: string) => writeFile(path, JSON.stringify(value({ token: "short" })))],
    ["invalid port", async (path: string) => writeFile(path, JSON.stringify(value({ port: 0 })))],
    ["unsafe file mode", async (path: string) => chmod(path, 0o644)],
    ["unsafe directory mode", async (path: string) => chmod(join(path, ".."), 0o755)],
  ])("maps %s to stopped Desktop", async (_label, mutate) => {
    const { path } = await fixture();
    await mutate(path);
    await expect(readRuntimeDescriptor(path)).rejects.toThrowError(expect.objectContaining({ code: "LAMARCK_NOT_RUNNING" }));
  });

  test("uses protocol compatibility and checks individual capabilities", async () => {
    const { path } = await fixture();
    const incompatible = new HostCliTransport({
      descriptorPath: path,
      fetch: vi.fn<typeof fetch>(async () => Response.json({ protocolVersion: 2, environment: "host", supportedOperations: HOST_CLI_OPERATIONS })),
    });
    await expect(incompatible.hello()).rejects.toThrowError(expect.objectContaining({ code: "CLI_HOST_INCOMPATIBLE" }));

    const changed = new HostCliTransport({
      descriptorPath: path,
      fetch: vi.fn<typeof fetch>(async () => Response.json({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS.filter(operation => operation !== "query") })),
    });
    await expect(changed.hello()).resolves.toMatchObject({ supportedOperations: HOST_CLI_OPERATIONS.filter(operation => operation !== "query") });
    await expect(changed.execute({ requestId: "missing", operation: "query", input: { sql: "SELECT 1" } })).rejects.toMatchObject({ code: "CLI_UNSUPPORTED_COMMAND" });
  });

  test("rejects a symlinked runtime directory", async () => {
    const { path } = await fixture();
    const parent = await mkdtemp("/tmp/lamarck-cli-link-"); roots.push(parent);
    const link = join(parent, "runtime-link");
    await symlink(join(path, ".."), link, "dir");
    await expect(readRuntimeDescriptor(join(link, "runtime.json")))
      .rejects.toThrowError(expect.objectContaining({ code: "LAMARCK_NOT_RUNNING" }));
  });

  test("maps an unreachable stale descriptor to stopped Desktop", async () => {
    const { path } = await fixture();
    await expect(new HostCliTransport({
      descriptorPath: path,
      fetch: vi.fn<typeof fetch>(async () => { throw new Error("connection refused"); }),
    }).hello()).rejects.toThrowError(expect.objectContaining({ code: "LAMARCK_NOT_RUNNING" }));
  });
});

async function fixture() {
  const root = await mkdtemp("/tmp/lamarck-cli-descriptor-"); roots.push(root);
  await chmod(root, 0o700);
  const path = join(root, "runtime.json");
  const descriptor = value();
  await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
  await chmod(path, 0o600);
  return { path, descriptor };
}

function value(overrides: Record<string, unknown> = {}) {
  return {
    port: 32_123,
    token: "t".repeat(43),
    ...overrides,
  };
}


test("App disable waits beyond the short read deadline for confirmed cleanup", async () => {
  const { path } = await fixture();
  const client = new HostCliTransport({ descriptorPath: path, fetch: async (url, init) => {
    if (String(url).endsWith("/hello")) return Response.json({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5_100);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    });
    return new Response(new Uint8Array(encodeCliHttpResponse("app.disable", { requestId: "cleanup", ok: true, result: { appId: "notes", enabled: false } })));
  } });
  await expect(client.execute({ requestId: "cleanup", operation: "app.disable", input: { appId: "notes" } }))
    .resolves.toMatchObject({ ok: true, result: { enabled: false } });
}, 10_000);


test("runtime timeout reports an unconfirmed operation rather than a stopped Desktop", async () => {
  const { path } = await fixture();
  const timeout = vi.spyOn(AbortSignal, "timeout")
    .mockReturnValueOnce(new AbortController().signal)
    .mockReturnValueOnce(AbortSignal.abort(new Error("Timed out")));
  try {
    const client = new HostCliTransport({ descriptorPath: path, fetch: async (url, init) => {
      if (String(url).endsWith("/hello")) return Response.json({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS });
      throw init?.signal?.reason;
    } });
    await expect(client.execute({ requestId: "timeout", operation: "app.disable", input: { appId: "notes" } }))
      .rejects.toMatchObject({ code: "APP_RUNTIME_FAILED", message: expect.stringContaining("may still complete") });
  } finally { timeout.mockRestore(); }
});
