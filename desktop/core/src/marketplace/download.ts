import {
  mkdir,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { MARKETPLACE_MAX_ARTIFACT_BYTES } from "./resolve";

export const MARKETPLACE_RELEASE_ORIGIN = "https://releases.lamarck.ai";
export const MARKETPLACE_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface MarketplaceDownloadOptions {
  readonly artifactPath: string;
  readonly artifactBytes: number;
  readonly destinationPath: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Resolve only a canonical relative path beneath the immutable release origin. */
export function marketplaceArtifactUrl(artifactPath: unknown): URL {
  if (
    typeof artifactPath !== "string"
    || artifactPath.length === 0
    || Buffer.byteLength(artifactPath, "utf8") > 512
    || artifactPath.startsWith("/")
    || artifactPath.includes("\\")
    || artifactPath.includes("%")
    || artifactPath.includes("?")
    || artifactPath.includes("#")
    || /[\u0000-\u001f\u007f]/.test(artifactPath)
  ) {
    throw new Error("Marketplace artifact path must be a safe relative path");
  }
  const segments = artifactPath.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || !artifactPath.startsWith("marketplace/v1/artifacts/")
    || !artifactPath.endsWith(".tar.gz")
  ) {
    throw new Error("Marketplace artifact path is outside the release collection");
  }

  const url = new URL(artifactPath, `${MARKETPLACE_RELEASE_ORIGIN}/`);
  if (
    url.origin !== MARKETPLACE_RELEASE_ORIGIN
    || url.protocol !== "https:"
    || url.hostname !== "releases.lamarck.ai"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.pathname !== `/${artifactPath}`
  ) {
    throw new Error("Marketplace artifact URL escaped the pinned release origin");
  }
  return url;
}

/**
 * Download exact signed bytes to a newly-created Host-private file. The file is
 * removed on every network, timeout, length, or write failure.
 */
export async function downloadMarketplaceArtifact(
  options: MarketplaceDownloadOptions,
): Promise<{ readonly path: string; readonly bytes: number }> {
  if (
    !Number.isSafeInteger(options.artifactBytes)
    || options.artifactBytes < 1
    || options.artifactBytes > MARKETPLACE_MAX_ARTIFACT_BYTES
  ) {
    throw new Error("Marketplace artifact size is outside the Desktop limit");
  }
  const timeoutMs = options.timeoutMs ?? MARKETPLACE_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000) {
    throw new Error("Marketplace download timeout is invalid");
  }

  const artifactUrl = marketplaceArtifactUrl(options.artifactPath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Marketplace download timed out")), timeoutMs);
  timeout.unref?.();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();

  let file: FileHandle | undefined;
  try {
    await mkdir(dirname(options.destinationPath), { recursive: true, mode: 0o700 });
    file = await open(options.destinationPath, "wx", 0o600);
    const response = await (options.fetchImpl ?? fetch)(artifactUrl, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/gzip, application/octet-stream" },
    });
    if (!response.ok || response.status !== 200 || !response.body) {
      throw new Error(`Marketplace artifact download returned HTTP ${response.status}`);
    }
    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
      throw new Error("Marketplace artifact response used content encoding");
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null
      && (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) !== options.artifactBytes)
    ) {
      throw new Error("Marketplace artifact response length does not match the signature");
    }

    let written = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) continue;
        written += next.value.byteLength;
        if (written > options.artifactBytes || written > MARKETPLACE_MAX_ARTIFACT_BYTES) {
          await reader.cancel("Marketplace artifact exceeded its signed size").catch(() => {});
          throw new Error("Marketplace artifact exceeded its signed size");
        }
        await file.write(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (written !== options.artifactBytes) {
      throw new Error("Marketplace artifact ended before its signed size");
    }
    await file.sync();
    await file.close();
    file = undefined;
    return Object.freeze({ path: options.destinationPath, bytes: written });
  } catch (error) {
    try { await file?.close(); } catch {}
    await rm(options.destinationPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
