import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, notRunning } from "./errors.js";
import { type CliHostCapabilities, type CliOperation, type CliRequest, type CliResponse, type CliTransport } from "./operations.js";
import { encodeCliFrame, parseCliCapabilities, parseCliRequest } from "./protocol.js";
import { decodeCliHttpResponse } from "./wire.js";

export interface CliRuntimeDescriptor {
  readonly port: number;
  readonly token: string;
}

export const CLI_RUNTIME_FILENAME = "runtime.json";

export function defaultCliRuntimeDirectory(platform = process.platform): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Lamarck", "cli");
  if (platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Lamarck", "cli");
  return join(process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".local", "run"), "lamarck", "cli");
}

export class HostCliTransport implements CliTransport {
  #descriptor: CliRuntimeDescriptor | null = null;
  #hello: CliHostCapabilities | null = null;
  constructor(private readonly options: { descriptorPath?: string; fetch?: typeof fetch } = {}) {}

  async hello(): Promise<CliHostCapabilities> {
    const descriptor = await readRuntimeDescriptor(
      this.options.descriptorPath ?? join(defaultCliRuntimeDirectory(), CLI_RUNTIME_FILENAME),
    );
    const response = await this.#request(descriptor, "/cli/v1/hello", { method: "GET" });
    const value = await response.json().catch(() => { throw notRunning(); });
    if (!response.ok) throw notRunning();
    const hello = parseCliCapabilities(value, "host");
    this.#descriptor = descriptor;
    this.#hello = hello;
    return hello;
  }

  async execute<T extends CliOperation>(request: CliRequest<T>, uploadBytes?: Uint8Array): Promise<CliResponse<T>> {
    parseCliRequest(request, true);
    assertUploadBytes(request, uploadBytes);
    const hello = this.#hello ?? await this.hello();
    if (!hello.supportedOperations.includes(request.operation)) {
      throw new CliError("CLI_UNSUPPORTED_COMMAND", `The running Lamarck Desktop does not support ${request.operation}.`);
    }
    const descriptor = this.#descriptor!;
    const body = Buffer.concat([
      encodeCliFrame(request),
      ...(uploadBytes === undefined ? [] : [Buffer.from(uploadBytes)]),
    ]);
    const response = await this.#request(descriptor, "/cli/v1/execute", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(body.byteLength) },
      body,
    });
    if (!response.ok && response.status === 401) throw notRunning();
    if (!response.ok) throw notRunning();
    return await decodeCliHttpResponse(new Uint8Array(await response.arrayBuffer()), request.operation, request.requestId) as CliResponse<T>;
  }

  async #request(descriptor: CliRuntimeDescriptor, path: string, init: RequestInit): Promise<Response> {
    try {
      return await (this.options.fetch ?? fetch)(`http://127.0.0.1:${descriptor.port}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          Authorization: `Bearer ${descriptor.token}`,
        },
      });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw notRunning();
    }
  }
}

function assertUploadBytes(request: CliRequest, uploadBytes?: Uint8Array): void {
  if (request.upload?.kind === "file-stdin") {
    if (uploadBytes === undefined || uploadBytes.byteLength !== request.upload.bytes) {
      throw new Error("CLI upload does not match its declared length");
    }
    return;
  }
  if (request.upload !== undefined) throw new Error("CLI transport does not accept App package authority");
  if (uploadBytes !== undefined) throw new Error("CLI request does not declare a file upload");
}

export async function readRuntimeDescriptor(path: string): Promise<CliRuntimeDescriptor> {
  try {
    const parent = await lstat(join(path, ".."));
    assertSecureMetadata(parent, 0o700, "CLI runtime directory");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const details = await handle.stat();
      assertSecureMetadata(details, 0o600, "CLI runtime descriptor");
      if (!details.isFile() || details.size < 1 || details.size > 8192) throw new Error("unsafe descriptor");
      const value = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
      const keys = Object.keys(value).sort().join(",");
      if (keys !== "port,token"
        || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535
        || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(value.token)) {
        throw new Error("invalid descriptor");
      }
      return {
        port: Number(value.port), token: value.token,
      };
    } finally { await handle.close(); }
  } catch { throw notRunning(); }
}

function assertSecureMetadata(details: { mode: number; uid: number; isDirectory(): boolean }, mode: number, _label: string): void {
  if (process.platform === "win32") return;
  if ((details.mode & 0o777) !== mode || !details.isDirectory() && mode === 0o700
    || process.getuid !== undefined && details.uid !== process.getuid()) throw new Error("unsafe CLI runtime metadata");
}
