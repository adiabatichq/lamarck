import { Duplex, Readable } from "node:stream";
import { expect, test, vi } from "vitest";
import {
  APP_PACKAGE_ID_PATTERN,
  encodeAppCliFrame,
  parseAppCliResponse,
  type AppCliRequestV1,
} from "../../../capsule/src/app-edit/protocol";
import { PACKAGE_ID_PATTERN as CORE_PACKAGE_ID_PATTERN } from "../../../core/src/package-id";
import { AppCliStreamReader, writeAppCliBytes } from "../../../capsule/src/app-edit/stream";
import { AppCliStreamServer } from "./app-cli-broker";

const DIGEST = `sha256:${"a".repeat(64)}` as const;
const ARCHIVE = `sha256:${"b".repeat(64)}` as const;

test("maps inventory to private paths without exposing Host paths or its Core token", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/api/apps")) {
      return Response.json({ apps: [{ id: "example", name: "Example", path: "/host/secret/apps/example", version: null }] });
    }
    return Response.json({ editBase: base() });
  });
  const pair = duplexPair();
  const broker = new AppCliStreamServer({
    coreBaseUrl: "http://127.0.0.1:3000",
    coreToken: "host-secret",
    fetch: fetchImpl,
  });
  const detach = broker.attach(identity(), pair.server);
  const response = await invoke(pair.client, {
    version: 1,
    requestId: 1,
    operation: "app.list",
    input: {},
  });
  detach();

  expect(response.ok).toBe(true);
  expect(response.result).toEqual([{
    schemaVersion: 1,
    id: "example",
    name: "Example",
    path: "/mnt/lamarck-apps/example",
    version: null,
    editBase: base(),
  }]);
  expect(JSON.stringify(response)).not.toContain("/host/secret");
  expect(JSON.stringify(response)).not.toContain("host-secret");
  expect(requests.every((request) => request.authorization === "Bearer host-secret")).toBe(true);
});

test("accepts every canonical Core App id without failing the inventory", async () => {
  expect(APP_PACKAGE_ID_PATTERN.source).toBe(CORE_PACKAGE_ID_PATTERN.source);
  const ids = ["market.place", "7zip", "x"];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/api/apps")) {
      return Response.json({ apps: ids.map((id) => ({ id, name: id, version: null })) });
    }
    const match = /\/api\/apps\/([^/]+)\/edit-base$/.exec(url);
    const appId = decodeURIComponent(match?.[1] ?? "");
    return Response.json({ editBase: { ...base(), appId, lowerPath: `${appId}/draft-base` } });
  });
  const pair = duplexPair();
  const detach = new AppCliStreamServer({
    coreBaseUrl: "http://127.0.0.1:3000",
    coreToken: "host-secret",
    fetch: fetchImpl,
  }).attach(identity(), pair.server);
  const response = await invoke(pair.client, {
    version: 1,
    requestId: 2,
    operation: "app.list",
    input: {},
  });
  detach();

  expect(response.ok).toBe(true);
  expect((response.result as Array<{ id: string }>).map((item) => item.id)).toEqual(ids);
});

test("fetches all Core pages and returns the Host CLI version-record array shape", async () => {
  const records = [
    { schemaVersion: 1, appId: "example", version: "a".repeat(40), parentVersion: "b".repeat(40), trigger: "save", createdAt: 2 },
    { schemaVersion: 1, appId: "example", version: "b".repeat(40), parentVersion: null, trigger: "activate", createdAt: 1 },
  ];
  const requested: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("cursor=next")) {
      return Response.json({ versions: [records[1]], nextCursor: null });
    }
    return Response.json({ versions: [records[0]], nextCursor: "next" });
  });
  const pair = duplexPair();
  const detach = new AppCliStreamServer({
    coreBaseUrl: "http://127.0.0.1:3000",
    coreToken: "host-secret",
    fetch: fetchImpl,
  }).attach(identity(), pair.server);
  const response = await invoke(pair.client, {
    version: 1,
    requestId: 3,
    operation: "app.versions",
    input: { appId: "example" },
  });
  detach();

  expect(response).toMatchObject({ ok: true, result: records });
  expect(Array.isArray(response.result)).toBe(true);
  expect(JSON.stringify(response.result)).not.toContain("nextCursor");
  expect(requested).toHaveLength(2);
  expect(requested.every((url) => url.includes("limit=100"))).toBe(true);
});

test("streams a large complete save upload and returns the rematerialization base", async () => {
  const archive = Buffer.alloc(256 * 1024, 0x61);
  let received = Buffer.alloc(0);
  let metadata: unknown;
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    metadata = JSON.parse(Buffer.from(
      new Headers(init?.headers).get("x-lamarck-app-edit-v1")!,
      "base64url",
    ).toString("utf8"));
    const chunks: Buffer[] = [];
    for await (const chunk of init!.body as unknown as Readable) chunks.push(Buffer.from(chunk));
    received = Buffer.concat(chunks);
    return Response.json({ result: { version: "c".repeat(40), created: true }, editBase: { ...base(), version: "c".repeat(40) } });
  });
  const pair = duplexPair();
  const detach = new AppCliStreamServer({
    coreBaseUrl: "http://127.0.0.1:3000",
    coreToken: "host-secret",
    fetch: fetchImpl,
  }).attach(identity(), pair.server);
  const request: AppCliRequestV1 = {
    version: 1,
    requestId: 7,
    operation: "app.save",
    input: { appId: "example", message: "Save from Capsule" },
    upload: {
      archiveDigest: ARCHIVE,
      archiveBytes: archive.byteLength,
      baseVersion: null,
      basePackageDigest: DIGEST,
    },
  };
  const reader = new AppCliStreamReader(pair.client);
  await writeAppCliBytes(pair.client, encodeAppCliFrame(request));
  for (let offset = 0; offset < archive.byteLength; offset += 17 * 1024) {
    await writeAppCliBytes(pair.client, archive.subarray(offset, offset + 17 * 1024));
  }
  const response = parseAppCliResponse(await reader.readFrame());
  detach();

  expect(response).toMatchObject({ ok: true, requestId: 7 });
  expect(received.equals(archive)).toBe(true);
  expect(metadata).toMatchObject({
    schemaVersion: 1,
    baseVersion: null,
    basePackageDigest: DIGEST,
    archiveDigest: ARCHIVE,
    archiveBytes: archive.byteLength,
    message: "Save from Capsule",
  });
});

async function invoke(client: Duplex, request: AppCliRequestV1) {
  const reader = new AppCliStreamReader(client);
  await writeAppCliBytes(client, encodeAppCliFrame(request));
  return parseAppCliResponse(await reader.readFrame());
}

function identity() {
  return { schemaVersion: 1 as const, appId: "initiator", workloadHandle: "workload_123" };
}

function base() {
  return {
    schemaVersion: 1 as const,
    appId: "example",
    version: null,
    packageDigest: DIGEST,
    lowerPath: `example/draft-${"a".repeat(64)}`,
  };
}

function duplexPair(): { client: MemoryDuplex; server: MemoryDuplex } {
  const client = new MemoryDuplex();
  const server = new MemoryDuplex();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

class MemoryDuplex extends Duplex {
  peer!: MemoryDuplex;
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.peer.push(Buffer.from(chunk));
    callback();
  }
  _final(callback: (error?: Error | null) => void): void {
    this.peer.push(null);
    callback();
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.push(null);
    if (!this.peer.destroyed) this.peer.push(null);
    callback(error);
  }
}
