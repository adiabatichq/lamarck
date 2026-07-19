import { Duplex, PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const netMock = vi.hoisted(() => ({ createConnection: vi.fn() }));

vi.mock("node:net", () => ({ createConnection: netMock.createConnection }));

const SDK_ENV = "LAMARCK_SDK_SOCKET";
const SDK_PATH = "/run/lamarck/system.sock";

beforeEach(() => {
  vi.resetModules();
  netMock.createConnection.mockReset();
  delete process.env[SDK_ENV];
});

afterEach(() => {
  delete process.env[SDK_ENV];
});

describe("Node System SDK workload binding", () => {
  test("connects lazily to the one fixed workload socket and preserves RPC", async () => {
    const streams = transportPair();
    const unref = vi.fn();
    netMock.createConnection.mockReturnValue(Object.assign(streams.client, { unref }));
    process.env[SDK_ENV] = SDK_PATH;
    const { system } = await import("../src/node");

    expect(netMock.createConnection).not.toHaveBeenCalled();
    const result = system.query("SELECT ?", [1]);
    expect(netMock.createConnection).toHaveBeenCalledExactlyOnceWith({ path: SDK_PATH });
    expect(unref).toHaveBeenCalledOnce();
    const request = await readFrame(streams.clientToHost);
    expect(request).toMatchObject({
      version: 1,
      requestId: 1,
      operation: "query",
      input: { sql: "SELECT ?", params: [1] },
    });
    streams.hostToClient.write(frame({
      version: 1,
      requestId: 1,
      ok: true,
      result: { rows: [{ value: 1 }] },
    }));
    await expect(result).resolves.toEqual({ rows: [{ value: 1 }] });
  });

  test.each([undefined, "relative.sock", "/run/app/forged.sock"])(
    "fails closed for an absent or caller-selected SDK path (%s)",
    async (path) => {
      if (path !== undefined) process.env[SDK_ENV] = path;
      const { system } = await import("../src/node");

      expect(() => system.query("SELECT 1")).toThrow(
        "must name the fixed workload System SDK socket",
      );
      expect(netMock.createConnection).not.toHaveBeenCalled();
    },
  );
});

function transportPair() {
  const hostToClient = new PassThrough();
  const clientToHost = new PassThrough();
  const client = Duplex.from({ readable: hostToClient, writable: clientToHost });
  return { client, hostToClient, clientToHost };
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const result = Buffer.allocUnsafe(payload.length + 4);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

async function readFrame(stream: PassThrough): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < length + 4) return;
      stream.off("data", onData);
      try {
        resolve(JSON.parse(buffer.subarray(4, length + 4).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    };
    stream.on("data", onData);
  });
}
