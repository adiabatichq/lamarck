import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import {
  downloadMarketplaceArtifact,
  marketplaceArtifactUrl,
} from "../src/marketplace/download";

const validPath = `marketplace/v1/artifacts/app/sha256/aa/bb/${"a".repeat(64)}.tar.gz`;

describe("Marketplace artifact URL", () => {
  test("resolves a signed relative path against only the pinned origin", () => {
    expect(marketplaceArtifactUrl(validPath).toString()).toBe(
      `https://releases.lamarck.ai/${validPath}`,
    );
  });

  test.each([
    "https://evil.example/a.tar.gz",
    "//evil.example/a.tar.gz",
    "/marketplace/v1/artifacts/a.tar.gz",
    "marketplace/v1/artifacts/../evil/a.tar.gz",
    "marketplace/v1/artifacts/%2e%2e/evil/a.tar.gz",
    "marketplace/v1/artifacts/a.tar.gz?redirect=https://evil.example",
    "marketplace/v1/artifacts/a.tar.gz#fragment",
    "marketplace/v1/artifacts/a.zip",
    "other/a.tar.gz",
  ])("rejects unsafe artifact path %s", (path) => {
    expect(() => marketplaceArtifactUrl(path)).toThrow();
  });
});

describe("Marketplace bounded download", () => {
  test("writes exactly the signed bytes to a private new file", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-marketplace-download-"));
    const destinationPath = join(root, "stage", "artifact.tar.gz");
    const bytes = Buffer.from("bounded artifact bytes");
    const fetchImpl = async () => new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
    await expect(downloadMarketplaceArtifact({
      artifactPath: validPath,
      artifactBytes: bytes.length,
      destinationPath,
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual({ path: destinationPath, bytes: bytes.length });
    expect(await readFile(destinationPath)).toEqual(bytes);
  });

  test.each([
    ["short", Buffer.from("short"), 10],
    ["oversized", Buffer.from("too many bytes"), 3],
  ])("removes a %s partial download", async (_name, bytes, expectedBytes) => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-marketplace-download-"));
    const destinationPath = join(root, "artifact.tar.gz");
    const fetchImpl = async () => new Response(bytes, { status: 200 });
    await expect(downloadMarketplaceArtifact({
      artifactPath: validPath,
      artifactBytes: expectedBytes,
      destinationPath,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow();
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects redirects without following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "lamarck-marketplace-download-"));
    const destinationPath = join(root, "artifact.tar.gz");
    let redirectMode: RequestRedirect | undefined;
    const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit) => {
      redirectMode = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://evil.example/a" } });
    };
    await expect(downloadMarketplaceArtifact({
      artifactPath: validPath,
      artifactBytes: 1,
      destinationPath,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow("HTTP 302");
    expect(redirectMode).toBe("error");
  });
});
