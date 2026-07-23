import { once } from "node:events";
import { connect } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { LvrmDuplex } from "../src/lvrm-duplex";
import {
  createGuestControlServer,
  createGuestDataServer,
} from "../src/main";

describe("Guest relay servers", () => {
  test.each([
    ["control", () => createGuestControlServer({ attachControl: vi.fn() })],
    ["DATA", () => createGuestDataServer({ attachData: vi.fn() })],
  ] as const)("preserves independent %s read and write directions", (_name, create) => {
    const server = create();
    // `allowHalfOpen` is a documented net.Server runtime option but is not
    // exposed on the current @types/node Server surface.
    expect((server as unknown as { allowHalfOpen: boolean }).allowHalfOpen).toBe(true);
    server.close();
  });

  test.each([
    ["control", () => {
      const attach = vi.fn();
      return {
        attach,
        server: createGuestControlServer({ attachControl: attach }),
      };
    }],
    ["DATA", () => {
      const attach = vi.fn();
      return {
        attach,
        server: createGuestDataServer({ attachData: attach }),
      };
    }],
  ] as const)("wraps every accepted %s socket in the LVRM adapter", async (
    _name,
    create,
  ) => {
    const { attach, server } = create();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP address");
    }

    const client = connect(address.port, "127.0.0.1");
    await once(client, "connect");
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    const relay = attach.mock.calls[0]![0];
    expect(relay).toBeInstanceOf(LvrmDuplex);
    if (!(relay instanceof LvrmDuplex)) throw new Error("accepted stream was not adapted");
    relay.on("error", () => undefined);
    relay.resume();
    const guestRecords: Buffer[] = [];
    client.on("data", (chunk) => guestRecords.push(Buffer.from(chunk)));
    client.resume();

    const hostEnd = once(relay, "end");
    client.write(terminalRecord(2));
    relay.end();
    await once(relay, "finish");
    await vi.waitFor(() => expect(recordKinds(Buffer.concat(guestRecords))).toEqual([2, 4]));
    client.write(terminalRecord(4));
    await hostEnd;
    const guestEnd = once(client, "end");
    await guestEnd;
    await once(client, "close");
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
});

function terminalRecord(kind: 2 | 4): Buffer {
  const value = Buffer.alloc(12);
  value.write("LVRM", 0, "ascii");
  value.writeUInt16BE(2, 4);
  value.writeUInt16BE(kind, 6);
  return value;
}

function recordKinds(bytes: Buffer): number[] {
  const kinds: number[] = [];
  let offset = 0;
  while (bytes.byteLength - offset >= 12) {
    const payloadBytes = bytes.readUInt32BE(offset + 8);
    const end = offset + 12 + payloadBytes;
    if (end > bytes.byteLength) break;
    kinds.push(bytes.readUInt16BE(offset + 6));
    offset = end;
  }
  return kinds;
}
