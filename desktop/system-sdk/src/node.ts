import { createConnection } from "node:net";
import { createSystem } from "./create-system.js";
import { FramedRpcClient } from "./node-transport.js";

export * from "./create-system.js";
export * from "./protocol.js";

export const LAMARCK_SDK_SOCKET_ENV = "LAMARCK_SDK_SOCKET" as const;
export const LAMARCK_SDK_SOCKET_PATH = "/run/lamarck/system.sock" as const;

let client: FramedRpcClient | undefined;

function workloadClient(): FramedRpcClient {
  if (client) return client;
  const path = process.env[LAMARCK_SDK_SOCKET_ENV];
  if (path !== LAMARCK_SDK_SOCKET_PATH) {
    throw new Error(
      `${LAMARCK_SDK_SOCKET_ENV} must name the fixed workload System SDK socket`,
    );
  }

  const socket = createConnection({ path });
  // A Host channel alone must not turn a completed Job into a permanent process.
  socket.unref();
  client = new FramedRpcClient(socket);
  return client;
}

export const system = createSystem((operation, input) => workloadClient().invoke(operation, input));
