import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { HOST_CLI_OPERATIONS, HostCliTransport, type CliRequest, type CliResponse } from "@lamarck/cli";
import type { CliOperationDispatcher } from "./cli-dispatcher";
import { DesktopCliGateway } from "./cli-gateway";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("publishes an owner-only descriptor and dispatches only bound System operations", async () => {
  const root = await mkdtemp("/tmp/lamarck-cli-gateway-"); roots.push(root);
  const seen: unknown[] = [];
  const dispatcher = {
    capabilities: () => ({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }),
    dispatch: vi.fn(async (request: CliRequest, context: unknown) => {
      seen.push(context);
      return { response: { requestId: request.requestId, ok: true, result: [{ id: "focus" }] } as CliResponse };
    }),
  } as unknown as CliOperationDispatcher;
  const gateway = new DesktopCliGateway({ dispatcher, runtimeDirectory: root });
  await gateway.start();
  try {
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const descriptorPath = join(root, "runtime.json");
    expect((await stat(descriptorPath)).mode & 0o777).toBe(0o600);
    const transport = new HostCliTransport({ descriptorPath });
    expect((await transport.hello()).supportedOperations).toEqual(HOST_CLI_OPERATIONS);
    const response = await transport.execute({ requestId: "list-1", operation: "app.list", input: {} });
    expect(response).toEqual({ requestId: "list-1", ok: true, result: [{ id: "focus" }] });
    expect(seen).toEqual([{ environment: "host", principal: { kind: "system" } }]);

    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    expect(Object.keys(descriptor).sort()).toEqual(["port", "token"]);
    const second = await transport.execute({ requestId: "list-2", operation: "app.list", input: {} });
    expect(second.ok).toBe(true);
    expect(JSON.parse(await readFile(descriptorPath, "utf8"))).toEqual(descriptor);
    const denied = await fetch(`http://127.0.0.1:${descriptor.port}/cli/v1/hello`, {
      headers: { Authorization: `Bearer ${"x".repeat(43)}` },
    });
    expect(denied.status).toBe(401);
  } finally {
    await gateway.stop();
  }
  await expect(access(join(root, "runtime.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("turns dispatcher exceptions into stable protocol failures", async () => {
  const root = await mkdtemp("/tmp/lamarck-cli-gateway-error-"); roots.push(root);
  const dispatcher = {
    capabilities: () => ({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }),
    dispatch: async () => { throw new Error("private failure"); },
  } as unknown as CliOperationDispatcher;
  const gateway = new DesktopCliGateway({ dispatcher, runtimeDirectory: root });
  await gateway.start();
  try {
    const response = await new HostCliTransport({ descriptorPath: join(root, "runtime.json") })
      .execute({ requestId: "list-2", operation: "app.list", input: {} });
    expect(response).toEqual({
      requestId: "list-2",
      ok: false,
      error: { code: "CLI_INTERNAL", message: "Lamarck could not complete the command." },
    });
  } finally { await gateway.stop(); }
});

test("streams Host file bytes outside typed control frames", async () => {
  const root = await mkdtemp("/tmp/lamarck-cli-gateway-stream-"); roots.push(root);
  const stdin = Buffer.alloc(256 * 1024, 0xa5);
  const stdout = Buffer.from([0, 255, 1, 254]);
  let seen: CliRequest | undefined;
  const dispatcher = {
    capabilities: () => ({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }),
    dispatch: vi.fn(async (request: CliRequest) => {
      seen = request;
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result: { success: true, exitCode: 0, stdoutBase64: stdout.toString("base64"), stderrBase64: "" },
        } as CliResponse,
      };
    }),
  } as unknown as CliOperationDispatcher;
  const gateway = new DesktopCliGateway({ dispatcher, runtimeDirectory: root });
  await gateway.start();
  try {
    const response = await new HostCliTransport({ descriptorPath: join(root, "runtime.json") }).execute({
      requestId: "file-1",
      operation: "file.command",
      input: { argv: ["tee", "blob.bin"] },
      upload: { kind: "file-stdin", bytes: stdin.byteLength },
    }, stdin);
    expect(seen).toMatchObject({
      requestId: "file-1",
      operation: "file.command",
      input: { argv: ["tee", "blob.bin"], stdinBase64: stdin.toString("base64") },
    });
    expect(response).toEqual({
      requestId: "file-1",
      ok: true,
      result: { success: true, exitCode: 0, stdoutBase64: stdout.toString("base64"), stderrBase64: "" },
    });
  } finally { await gateway.stop(); }
});

test("uses one token for a Desktop lifetime and invalidates it on restart", async () => {
  const root = await mkdtemp("/tmp/lamarck-cli-lifetime-"); roots.push(root);
  const dispatcher = {
    capabilities: () => ({ protocolVersion: 1, environment: "host", supportedOperations: HOST_CLI_OPERATIONS }),
    dispatch: async (request: CliRequest) => ({
      response: { requestId: request.requestId, ok: true, result: [] } as CliResponse,
    }),
  } as unknown as CliOperationDispatcher;
  const gateway = new DesktopCliGateway({ dispatcher, runtimeDirectory: root });
  await gateway.start();
  const descriptorPath = join(root, "runtime.json");
  const firstDescriptor = await readFile(descriptorPath);
  const firstToken = JSON.parse(firstDescriptor.toString("utf8")).token as string;
  const oldDescriptorPath = join(root, "old-runtime.json");
  await writeFile(oldDescriptorPath, firstDescriptor, { mode: 0o600 });
  await expect(new HostCliTransport({ descriptorPath }).hello())
    .resolves.toMatchObject({ protocolVersion: 1 });
  await gateway.stop();
  await gateway.start();
  try {
    await expect(new HostCliTransport({ descriptorPath: oldDescriptorPath }).hello())
      .rejects.toThrowError(expect.objectContaining({ code: "LAMARCK_NOT_RUNNING" }));
    expect((await readFile(descriptorPath)).equals(firstDescriptor)).toBe(false);
    expect(JSON.parse(await readFile(descriptorPath, "utf8")).token).not.toBe(firstToken);
    await expect(new HostCliTransport({ descriptorPath }).hello())
      .resolves.toMatchObject({ protocolVersion: 1 });
  } finally {
    await gateway.stop();
  }
});
