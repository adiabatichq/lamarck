import { describe, expect, test } from "vitest";
import type { AppManifest } from "../src/app-loader";
import {
  isAppSystemRoute,
  isDeclaredWorkload,
  parseRequestedWorkload,
} from "../src/app-runtime-policy";

const manifest: AppManifest = {
  manifestVersion: 1,
  id: "app-a",
  name: "App A",
  description: "App runtime policy test fixture.",
  runtime: {
    ui: { command: ["npm", "run", "start"], port: 3000 },
    services: { indexer: { command: ["node", "indexer.mjs"] } },
    jobs: { "daily-etl": { command: ["node", "etl.mjs"] } },
  },
  permissions: { writes: { files: [], tables: [] } },
};

describe("App runtime policy", () => {
  test("accepts only normalized workload identities declared by the manifest", () => {
    for (const workload of ["ui", "service:indexer", "job:daily-etl"] as const) {
      const parsed = parseRequestedWorkload(workload);
      expect(parsed).toBe(workload);
      expect(isDeclaredWorkload(manifest, parsed!)).toBe(true);
    }

    expect(isDeclaredWorkload(manifest, "service:missing")).toBe(false);
    expect(isDeclaredWorkload(manifest, "job:missing")).toBe(false);
    // Entry ids are manifest data. Inherited Object.prototype names must not
    // become implicit workloads when the manifest does not own that key.
    expect(isDeclaredWorkload(manifest, "service:constructor")).toBe(false);
    const inherited = Object.create({ inherited: { command: ["false"] } }) as Record<
      string,
      { command: string[] }
    >;
    inherited.indexer = { command: ["node", "indexer.mjs"] };
    const prototypeManifest: AppManifest = {
      ...manifest,
      runtime: { ...manifest.runtime, services: inherited },
    };
    expect(isDeclaredWorkload(prototypeManifest, "service:inherited")).toBe(false);
    expect(isDeclaredWorkload(prototypeManifest, "service:indexer")).toBe(true);
    for (const invalid of ["", "agent:assistant", "service:", "service:Bad", "ui:other", 1, null]) {
      expect(parseRequestedWorkload(invalid)).toBeNull();
    }
  });

  test("allows App capabilities to call only the System SDK HTTP surface", () => {
    const allowed: Array<[string, string]> = [
      ["/api/query", "POST"],
      ["/api/content-ref/resolve", "POST"],
      ["/api/mutate", "POST"],
      ["/api/transaction", "POST"],
      ["/api/events", "POST"],
      ["/api/vfs/upload/begin", "POST"],
      ["/api/vfs/upload/chunk", "POST"],
      ["/api/vfs/upload/complete", "POST"],
      ["/api/vfs/upload/abort", "POST"],
      ["/api/vfs/command", "POST"],
      ["/api/vfs/open", "POST"],
    ];
    for (const [path, method] of allowed) expect(isAppSystemRoute(path, method)).toBe(true);
  });

  test("fails closed for Host, lifecycle, approval, terminal, and method variants", () => {
    const denied: Array<[string, string]> = [
      ["/api/health", "GET"],
      ["/api/workspace", "GET"],
      ["/api/apps", "GET"],
      ["/api/apps/app-a/source", "GET"],
      ["/api/apps/app-a/archive", "POST"],
      ["/api/app-runtime/channels", "POST"],
      ["/api/schema/inspect", "GET"],
      ["/api/schema/requests/x/approve", "POST"],
      ["/api/connectors", "GET"],
      ["/api/terminal", "GET"],
      ["/api/vfs/open/token", "GET"],
      ["/api/query", "GET"],
      ["/api/mutate", "GET"],
      ["/api/vfs/command", "GET"],
      ["/api/events", "GET"],
    ];
    for (const [path, method] of denied) expect(isAppSystemRoute(path, method)).toBe(false);
  });
});
