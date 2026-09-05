import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { SCOPED_PACKAGE_ID_PATTERN } from "../package-id";
import {
  parseMarketplaceTrustRoots,
  verifyMarketplaceResolvePayload,
  type MarketplacePackageKind,
  type MarketplaceResolvePayload,
  type MarketplaceTrustRoot,
} from "./resolve";

export const MARKETPLACE_RESOLVE_TIMEOUT_MS = 15_000;
const MARKETPLACE_RESOLVE_MAX_BYTES = 64 * 1024;

export class MarketplaceUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MarketplaceUnavailableError";
  }
}

export interface ResolveMarketplacePackageOptions {
  readonly apiOrigin: string;
  readonly kind: MarketplacePackageKind;
  readonly packageId: string;
  readonly trustRoots: readonly MarketplaceTrustRoot[];
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export async function loadMarketplaceTrustRootsFile(path: string): Promise<MarketplaceTrustRoot[]> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat({ bigint: true });
    if (!details.isFile() || details.size < 1n || details.size > 4096n) {
      throw new Error("Marketplace trust-root resource is not a bounded regular file");
    }
    const bytes = await handle.readFile();
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      throw new Error("Marketplace trust-root resource is malformed", { cause: error });
    }
    return parseMarketplaceTrustRoots(value);
  } finally {
    await handle.close();
  }
}

export async function resolveMarketplacePackage(
  options: ResolveMarketplacePackageOptions,
): Promise<MarketplaceResolvePayload> {
  const resolveUrl = marketplaceResolveUrl(options.apiOrigin, options.kind, options.packageId);
  const timeoutMs = options.timeoutMs ?? MARKETPLACE_RESOLVE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Marketplace resolve timeout is invalid");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Marketplace resolve timed out")), timeoutMs);
  timeout.unref?.();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();
  try {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(resolveUrl, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      const reason = error instanceof Error ? `: ${error.message}` : "";
      throw new MarketplaceUnavailableError(`Marketplace could not be reached${reason}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (!response.ok || response.status !== 200 || !response.body) {
      throw new MarketplaceUnavailableError(`Marketplace resolve returned HTTP ${response.status}`);
    }
    let bytes: Buffer;
    try {
      bytes = await readBoundedBody(response.body, MARKETPLACE_RESOLVE_MAX_BYTES);
    } catch (error) {
      const reason = error instanceof Error ? `: ${error.message}` : "";
      throw new MarketplaceUnavailableError(`Marketplace resolve response could not be read${reason}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      throw new MarketplaceUnavailableError("Marketplace resolve response is malformed", { cause: error });
    }
    return verifyMarketplaceResolvePayload(
      value,
      { kind: options.kind, packageId: options.packageId },
      options.trustRoots,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function marketplaceResolveUrl(
  apiOrigin: string,
  kind: MarketplacePackageKind,
  packageId: string,
): URL {
  if (
    (kind !== "app" && kind !== "connector")
    || !SCOPED_PACKAGE_ID_PATTERN.test(packageId)
  ) {
    throw new Error("Marketplace resolve identity is invalid");
  }
  let base: URL;
  try {
    base = new URL(apiOrigin);
  } catch {
    throw new Error("Marketplace API origin is invalid");
  }
  if (
    !["https:", "http:"].includes(base.protocol)
    || base.username !== ""
    || base.password !== ""
    || base.search !== ""
    || base.hash !== ""
    || (base.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  ) {
    throw new Error("Marketplace API origin is invalid");
  }
  return new URL(
    `/marketplace/resolve/${kind}/${encodeURIComponent(packageId)}`,
    base.origin,
  );
}

async function readBoundedBody(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel("Marketplace response exceeded its byte limit").catch(() => {});
        throw new Error("Marketplace resolve response exceeded its byte limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
