import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HOST_CLI_OPERATIONS, HostCliTransport, readRuntimeDescriptor } from "../src/index";

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

  test("uses hello as the exact protocol compatibility authority", async () => {
    const { path } = await fixture();
    const incompatible = new HostCliTransport({
      descriptorPath: path,
      fetch: vi.fn<typeof fetch>(async () => Response.json({ protocolVersion: 2, environment: "host", supportedOperations: HOST_CLI_OPERATIONS })),
    });
    await expect(incompatible.hello()).rejects.toThrowError(expect.objectContaining({ code: "CLI_HOST_INCOMPATIBLE" }));

    const changed = new HostCliTransport({
      descriptorPath: path,
      fetch: vi.fn<typeof fetch>(async () => Response.json({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS.slice(1) })),
    });
    await expect(changed.hello()).rejects.toThrowError(expect.objectContaining({ code: "CLI_HOST_INCOMPATIBLE" }));
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
