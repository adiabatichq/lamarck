import { createConnection, type Socket } from "node:net";
import { CliError, notRunning } from "./errors.js";
import { MANAGED_CLI_SOCKET_PATH, type CliHostCapabilities, type CliOperation, type CliRequest, type CliResponse, type CliTransport } from "./operations.js";
import { encodeCliFrame, parseCliCapabilities, parseCliFrame, parseCliRequest } from "./protocol.js";
import { CliStreamReader, writeCliBytes } from "./stream.js";
import { readCliResponse } from "./wire.js";

export class ManagedCliTransport implements CliTransport {
  #hello: CliHostCapabilities | null = null;
  #activeSockets = new Set<Socket>();
  constructor(private readonly socketPath: string = MANAGED_CLI_SOCKET_PATH) {}
  async hello(): Promise<CliHostCapabilities> {
    if (this.#hello) return this.#hello;
    let socket: Socket | undefined;
    try {
      const connection = await this.#connect();
      socket = connection.socket;
      const hello = connection.hello;
      this.#hello = hello;
      socket.end();
      return hello;
    } catch (error) {
      socket?.destroy();
      if (error instanceof CliError && error.code === "CLI_HOST_INCOMPATIBLE") throw error;
      throw notRunning();
    }
  }
  async execute<T extends CliOperation>(request: CliRequest<T>, uploadBytes?: Uint8Array): Promise<CliResponse<T>> {
    parseCliRequest(request, true);
    assertUploadBytes(request, uploadBytes);
    const hello = await this.hello();
    if (!hello.supportedOperations.includes(request.operation)) throw new CliError("CLI_UNSUPPORTED_COMMAND", `${request.operation} is not available here.`);
    let socket: Socket | undefined;
    try {
      const connection = await this.#connect();
      socket = connection.socket;
      if (!connection.hello.supportedOperations.includes(request.operation)) {
        throw new CliError("CLI_UNSUPPORTED_COMMAND", `${request.operation} is not available here.`);
      }
      await writeCliBytes(socket, encodeCliFrame(request));
      if (uploadBytes !== undefined && uploadBytes.byteLength > 0) await writeCliBytes(socket, uploadBytes);
      const response = await readCliResponse(
        connection.reader,
        request.operation,
        request.requestId,
      ) as CliResponse<T>;
      socket.end();
      return response;
    } catch (error) {
      socket?.destroy();
      if (error instanceof CliError) throw error;
      throw notRunning();
    }
  }
  close(): void {
    for (const socket of this.#activeSockets) socket.destroy();
    this.#activeSockets.clear();
    this.#hello = null;
  }

  async #connect(): Promise<{
    socket: Socket;
    reader: CliStreamReader;
    hello: CliHostCapabilities;
  }> {
    const socket = createConnection(this.socketPath);
    this.#activeSockets.add(socket);
    socket.once("close", () => this.#activeSockets.delete(socket));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const reader = new CliStreamReader(socket);
    const hello = parseCliCapabilities(parseCliFrame(await reader.readFrame()), "managed");
    return { socket, reader, hello };
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
