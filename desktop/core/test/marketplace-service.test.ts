import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MarketplaceService,
  type MarketplaceLifecycleAdapters,
} from "../src/marketplace/service";
import { canonicalMarketplaceResolveBytes } from "../src/marketplace/resolve";

const roots: string[] = [];
const signingKey = generateKeyPairSync("ed25519");
const publicDer = signingKey.publicKey.export({ format: "der", type: "spki" });
const trustRoots = [{ keyId: "marketplace-service-test", publicKey: publicDer.subarray(-32) }];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Marketplace lifecycle staging service", () => {
  test("cleans restart residue and bounds scoped IDs before network resolution", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "lamarck-marketplace-service-"));
    roots.push(workspacePath);
    const stagingRoot = join(workspacePath, ".lamarck", "marketplace", "staging");
    await mkdir(join(stagingRoot, "stale"), { recursive: true });
    await writeFile(join(stagingRoot, "stale", "partial.tar.gz"), "partial");
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network reached"));
    const service = await MarketplaceService.initialize({
      workspacePath,
      apiOrigin: "https://api.lamarck.ai",
      trustRoots: [],
      fetchImpl,
      lifecycle: {
        appExists: vi.fn().mockResolvedValue(false),
        instantiateApp: vi.fn(),
        connectorHash: vi.fn().mockResolvedValue(undefined),
        recordOfficialConnectorRelease: vi.fn(),
        installConnector: vi.fn(),
        updateConnector: vi.fn(),
      },
    });

    expect(await readdir(stagingRoot)).toEqual([]);
    expect((await stat(stagingRoot)).mode & 0o777).toBe(0o700);

    const namespace = "n".repeat(64);
    const name = "p".repeat(64);
    await expect(service.prepare("app", `${namespace}.${name}`)).rejects.toThrow("network reached");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(service.prepare("app", `${namespace}x.${name}`))
      .rejects.toThrow("identity is invalid");
    await expect(service.prepare("connector", `${namespace}.${name}x`))
      .rejects.toThrow("identity is invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  test("applies a verified App with release provenance and cleans apply/cancel stages", async () => {
    const release = appRelease("lamarck.notes");
    let extractedDuringApply = "";
    const instantiateApp = vi.fn(async (input: Parameters<MarketplaceLifecycleAdapters["instantiateApp"]>[0]) => {
      extractedDuringApply = input.verifiedSourceDir;
      expect(await readFile(join(input.verifiedSourceDir, "index.tsx"), "utf8"))
        .toBe("export default null;\n");
      return { id: input.localId ?? input.packageId };
    });
    const appExists = vi.fn().mockResolvedValue(true);
    const { service, stagingRoot } = await serviceForRelease(release, {
      ...baseLifecycle(),
      appExists,
      instantiateApp,
    });

    const prepared = await service.prepare("app", release.packageId);
    expect(prepared).toMatchObject({
      packageId: release.packageId,
      releaseId: release.releaseId,
      action: "create",
      localIdConflict: true,
    });
    const applied = await service.apply(prepared.stageId, "my-notes");
    expect(applied).toEqual({ ok: true, kind: "app", id: "my-notes", disposition: "create" });
    expect(instantiateApp).toHaveBeenCalledWith({
      verifiedSourceDir: extractedDuringApply,
      packageId: release.packageId,
      releaseId: release.releaseId,
      localId: "my-notes",
    });
    await expect(stat(extractedDuringApply)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(stagingRoot)).toEqual([]);

    const cancelled = await service.prepare("app", release.packageId);
    await service.cancel(cancelled.stageId);
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(instantiateApp).toHaveBeenCalledTimes(1);
  });

  test("selects Connector install, update, and same-hash lifecycles by exact hash", async () => {
    const release = connectorRelease("lamarck.calendar");

    const install = await connectorService(release, [undefined, undefined]);
    const installPrepared = await install.service.prepare("connector", release.packageId);
    expect(installPrepared.action).toBe("install");
    expect((await install.service.apply(installPrepared.stageId)).disposition).toBe("install");
    expect(install.recordOfficialConnectorRelease).toHaveBeenCalledWith(release.packageId, release.contentHash);
    expect(install.installConnector).toHaveBeenCalledWith(
      expect.stringContaining(installPrepared.stageId),
      release.packageId,
    );
    expect(install.recordOfficialConnectorRelease.mock.invocationCallOrder[0])
      .toBeLessThan(install.installConnector.mock.invocationCallOrder[0]);
    expect(install.updateConnector).not.toHaveBeenCalled();
    expect(await readdir(install.stagingRoot)).toEqual([]);

    const previousHash = `sha256:${"b".repeat(64)}`;
    const update = await connectorService(release, [previousHash, previousHash]);
    const updatePrepared = await update.service.prepare("connector", release.packageId);
    expect(updatePrepared.action).toBe("update");
    expect((await update.service.apply(updatePrepared.stageId)).disposition).toBe("update");
    expect(update.recordOfficialConnectorRelease).toHaveBeenCalledWith(release.packageId, release.contentHash);
    expect(update.updateConnector).toHaveBeenCalledWith(
      expect.stringContaining(updatePrepared.stageId),
      release.packageId,
    );
    expect(update.recordOfficialConnectorRelease.mock.invocationCallOrder[0])
      .toBeLessThan(update.updateConnector.mock.invocationCallOrder[0]);
    expect(update.installConnector).not.toHaveBeenCalled();
    expect(await readdir(update.stagingRoot)).toEqual([]);

    const same = await connectorService(release, [release.contentHash, release.contentHash]);
    const samePrepared = await same.service.prepare("connector", release.packageId);
    expect(samePrepared.action).toBe("already-installed");
    expect((await same.service.apply(samePrepared.stageId)).disposition).toBe("already-installed");
    expect(same.recordOfficialConnectorRelease).toHaveBeenCalledWith(release.packageId, release.contentHash);
    expect(same.installConnector).not.toHaveBeenCalled();
    expect(same.updateConnector).not.toHaveBeenCalled();
    expect(await readdir(same.stagingRoot)).toEqual([]);
  });

  test("checks signed Connector release metadata without downloading its artifact", async () => {
    const release = connectorRelease("lamarck.calendar");
    const { service, stagingRoot, requests } = await serviceForRelease(
      release,
      baseLifecycle(),
    );

    await expect(service.resolveConnectorRelease(release.packageId)).resolves.toMatchObject({
      kind: "connector",
      packageId: release.packageId,
      releaseId: release.releaseId,
      contentHash: release.contentHash,
    });
    expect(requests).toEqual([
      `https://api.lamarck.ai/marketplace/resolve/connector/${release.packageId}`,
    ]);
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  test("fails closed when Connector state changes after confirmation", async () => {
    const release = connectorRelease("lamarck.calendar");
    const changed = await connectorService(release, [
      `sha256:${"b".repeat(64)}`,
      `sha256:${"c".repeat(64)}`,
    ]);
    const prepared = await changed.service.prepare("connector", release.packageId);
    expect(prepared.action).toBe("update");
    await expect(changed.service.apply(prepared.stageId)).rejects.toThrow("state changed");
    expect(changed.recordOfficialConnectorRelease).not.toHaveBeenCalled();
    expect(changed.installConnector).not.toHaveBeenCalled();
    expect(changed.updateConnector).not.toHaveBeenCalled();
    expect(await readdir(changed.stagingRoot)).toEqual([]);
  });
});

interface TestRelease {
  kind: "app" | "connector";
  packageId: string;
  releaseId: string;
  contentHash: string;
  archive: Buffer;
}

function baseLifecycle(): MarketplaceLifecycleAdapters {
  return {
    appExists: async () => false,
    instantiateApp: async (input) => ({ id: input.localId ?? input.packageId }),
    connectorHash: async () => undefined,
    recordOfficialConnectorRelease: () => {},
    installConnector: async () => {},
    updateConnector: async () => ({ updated: true }),
  };
}

async function serviceForRelease(
  release: TestRelease,
  lifecycle: MarketplaceLifecycleAdapters,
): Promise<{ service: MarketplaceService; stagingRoot: string; requests: string[] }> {
  const workspacePath = await mkdtemp(join(tmpdir(), "lamarck-marketplace-flow-"));
  roots.push(workspacePath);
  const unsigned = {
    protocolVersion: 1,
    kind: release.kind,
    packageId: release.packageId,
    releaseId: release.releaseId,
    sequence: 1,
    artifactFormat: "marketplace-tar-gzip-v1",
    contentHash: release.contentHash,
    artifactPath: artifactPath(release),
    artifactBytes: release.archive.byteLength,
    publishedAt: "2026-08-04T01:02:03.000Z",
    origin: "Official",
    signatureKeyId: "marketplace-service-test",
  } as const;
  const resolution = {
    ...unsigned,
    signature: sign(null, canonicalMarketplaceResolveBytes(unsigned), signingKey.privateKey)
      .toString("base64url"),
  };
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url.startsWith("https://api.lamarck.ai/marketplace/resolve/")) {
      return new Response(JSON.stringify(resolution), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === `https://releases.lamarck.ai/${unsigned.artifactPath}`) {
      return new Response(Uint8Array.from(release.archive), {
        status: 200,
        headers: {
          "Content-Type": "application/gzip",
          "Content-Length": String(release.archive.byteLength),
        },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const service = await MarketplaceService.initialize({
    workspacePath,
    apiOrigin: "https://api.lamarck.ai",
    trustRoots,
    fetchImpl,
    lifecycle,
  });
  return {
    service,
    stagingRoot: join(workspacePath, ".lamarck", "marketplace", "staging"),
    requests,
  };
}

async function connectorService(release: TestRelease, hashes: Array<string | undefined>) {
  const connectorHash = vi.fn();
  for (const hash of hashes) connectorHash.mockResolvedValueOnce(hash);
  const recordOfficialConnectorRelease = vi.fn();
  const installConnector = vi.fn().mockResolvedValue(undefined);
  const updateConnector = vi.fn().mockResolvedValue({ updated: true });
  return {
    ...await serviceForRelease(release, {
      ...baseLifecycle(),
      connectorHash,
      recordOfficialConnectorRelease,
      installConnector,
      updateConnector,
    }),
    recordOfficialConnectorRelease,
    installConnector,
    updateConnector,
  };
}

function appRelease(packageId: string): TestRelease {
  const entries = [
    { path: "index.tsx", bytes: Buffer.from("export default null;\n") },
    { path: "manifest.json", bytes: Buffer.from(JSON.stringify({
      manifestVersion: 1,
      id: packageId,
      name: "Notes",
      description: "Editable notes.",
      runtime: { ui: { command: ["npm", "run", "start"], port: 3000 } },
      permissions: { writes: { files: [], tables: [] } },
    })) },
  ].sort((left, right) => left.path.localeCompare(right.path));
  return releaseForEntries("app", packageId, entries);
}

function connectorRelease(packageId: string): TestRelease {
  const entries = [
    { path: "connector.yaml", bytes: Buffer.from(`manifestVersion: 1
id: ${packageId}
name: Calendar
description: A managed calendar Connector.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
auth:
  type: none
`) },
    { path: "events.json", bytes: Buffer.from(JSON.stringify({
      catalogVersion: 1,
      eventTypes: {
        "calendar.event": {
          description: "A calendar event.",
          payloadSchema: { type: "object" },
        },
      },
    })) },
    { path: "index.mjs", bytes: Buffer.from("export default { async run() {} };\n") },
  ].sort((left, right) => left.path.localeCompare(right.path));
  return releaseForEntries("connector", packageId, entries);
}

function releaseForEntries(
  kind: TestRelease["kind"],
  packageId: string,
  entries: Array<{ path: string; bytes: Buffer }>,
): TestRelease {
  return {
    kind,
    packageId,
    releaseId: "rel_0123456789abcdefghijklmn",
    contentHash: logicalHash(entries),
    archive: canonicalArchive(entries),
  };
}

function artifactPath(release: TestRelease): string {
  const hex = release.contentHash.slice("sha256:".length);
  return `marketplace/v1/artifacts/${release.kind}/sha256/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}.tar.gz`;
}

function logicalHash(entries: readonly { path: string; bytes: Buffer }[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update("file\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function canonicalArchive(entries: readonly { path: string; bytes: Buffer }[]): Buffer {
  const tar: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    Buffer.from(entry.path).copy(header, 0);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    tar.push(header, entry.bytes);
    const remainder = entry.bytes.byteLength % 512;
    if (remainder) tar.push(Buffer.alloc(512 - remainder));
  }
  tar.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(tar), { level: 9 });
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}
