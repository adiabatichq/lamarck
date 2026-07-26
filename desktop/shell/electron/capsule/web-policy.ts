import { createHash } from "node:crypto";

export interface AppViewerOriginBinding {
  protocol: string;
  host: string;
}

export const APP_VIEWER_CSP = [
  "default-src 'self' data: blob:",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Every browser-authority generation receives an in-memory Electron session.
 * The lack of a `persist:` prefix is deliberate: App browser state is
 * disposable cache, never an authoritative or crash-durable state surface.
 */
export function appViewerPartition(
  workspaceId: string,
  appId: string,
  browserChannelId: string,
): string {
  return `lamarck-app-${appViewerIdentityDigest(workspaceId, appId, browserChannelId)}`;
}

/**
 * Browser authority generations receive distinct origins. A Service Worker or
 * CacheStorage entry from an earlier App version therefore cannot control the
 * WebContents that receives the replacement capability.
 */
export function appViewerOriginHost(
  workspaceId: string,
  appId: string,
  browserChannelId: string,
): string {
  return `${appViewerIdentityDigest(workspaceId, appId, browserChannelId)}.localhost`;
}

function appViewerIdentityDigest(
  workspaceId: string,
  appId: string,
  generation?: string,
): string {
  if (workspaceId.length < 1 || workspaceId.includes("\0")) {
    throw new Error("Viewer workspace identity is invalid");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(appId)) throw new Error("Viewer App identity is invalid");
  if (generation !== undefined && (generation.length < 1 || generation.length > 512)) {
    throw new Error("Browser channel generation must be bounded and nonempty");
  }
  const hash = createHash("sha256")
    .update(workspaceId, "utf8")
    .update("\0", "utf8")
    .update(appId, "utf8");
  if (generation !== undefined) hash.update("\0", "utf8").update(generation, "utf8");
  return hash.digest("hex").slice(0, 32);
}

export function isAllowedAppViewerUrl(
  rawUrl: string,
  binding: AppViewerOriginBinding,
): boolean {
  try {
    const candidate = new URL(rawUrl);
    if (candidate.protocol === "data:") return true;
    if (candidate.protocol === "blob:") {
      return candidate.origin === `${binding.protocol}//${binding.host}`;
    }
    const websocketProtocol = binding.protocol === "http:"
      ? "ws:"
      : binding.protocol === "https:"
        ? "wss:"
        : null;
    return candidate.host === binding.host
      && (candidate.protocol === binding.protocol || candidate.protocol === websocketProtocol);
  } catch {
    return false;
  }
}

/**
 * Top-level viewer documents must always come through the Host gateway so its
 * CSP and response hardening are present. `data:` and same-origin `blob:` stay
 * available as subresources, but cannot replace the privileged App document
 * with a headerless page.
 */
export function isAllowedAppViewerNavigationUrl(
  rawUrl: string,
  binding: AppViewerOriginBinding,
): boolean {
  try {
    const candidate = new URL(rawUrl);
    return candidate.protocol === binding.protocol && candidate.host === binding.host;
  } catch {
    return false;
  }
}

export function createShellNavigationPolicy(
  entryUrl: URL,
  allowSameOrigin: boolean,
): (rawUrl: string) => boolean {
  return (rawUrl: string): boolean => {
    try {
      const candidate = new URL(rawUrl);
      if (allowSameOrigin) {
        return candidate.protocol === entryUrl.protocol && candidate.host === entryUrl.host;
      }
      return candidate.protocol === "file:" && candidate.pathname === entryUrl.pathname;
    } catch {
      return false;
    }
  };
}

export function parseAllowedExternalUrl(rawUrl: unknown): URL {
  if (typeof rawUrl !== "string") throw new Error("External URL must be a string");
  const url = new URL(rawUrl);
  if (!new Set(["http:", "https:", "mailto:"]).has(url.protocol)) {
    throw new Error("External URL scheme is not allowed");
  }
  return url;
}
