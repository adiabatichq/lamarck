import type { AppManifest } from "./app-loader";
import type { AppWorkload } from "./auth";

const NAMED_WORKLOAD_PATTERN = /^(service|job):[a-z0-9][a-z0-9-]*$/;

export function parseRequestedWorkload(value: unknown): AppWorkload | null {
  if (value === "ui") return value;
  if (typeof value !== "string" || !NAMED_WORKLOAD_PATTERN.test(value)) return null;
  return value as AppWorkload;
}

export function isDeclaredWorkload(manifest: AppManifest, workload: AppWorkload): boolean {
  if (workload === "ui") return manifest.runtime.ui !== undefined;
  const separator = workload.indexOf(":");
  const kind = workload.slice(0, separator);
  const entryId = workload.slice(separator + 1);
  if (kind === "service") {
    return manifest.runtime.services !== undefined
      && Object.hasOwn(manifest.runtime.services, entryId);
  }
  if (kind === "job") {
    return manifest.runtime.jobs !== undefined
      && Object.hasOwn(manifest.runtime.jobs, entryId);
  }
  return false;
}

/**
 * Exact HTTP surface reachable through an App launch capability.
 *
 * Capability transport is an implementation seam for the Host broker, not a
 * general Core session. New Core routes remain Host-only until deliberately
 * added here and covered by policy tests.
 */
export function isAppSystemRoute(path: string, method: string): boolean {
  if (path === "/api/query" && method === "POST") return true;
  if (path === "/api/content-ref/resolve" && method === "POST") return true;
  if (path === "/api/mutate" && method === "POST") return true;
  if (path === "/api/transaction" && method === "POST") return true;
  if (path === "/api/events" && method === "POST") return true;
  if (path === "/api/vfs/upload/begin" && method === "POST") return true;
  if (path === "/api/vfs/upload/chunk" && method === "POST") return true;
  if (path === "/api/vfs/upload/complete" && method === "POST") return true;
  if (path === "/api/vfs/upload/abort" && method === "POST") return true;
  if (path === "/api/vfs/command" && method === "POST") return true;
  return path === "/api/vfs/open" && method === "POST";
}
