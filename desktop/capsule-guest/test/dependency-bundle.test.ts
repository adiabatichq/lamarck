import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  packageLockHasRegistryPackages,
  rewritePackageLockForBroker,
  type DependencyBundleManifest,
} from "../src/dependency-bundle";

describe("Guest dependency bundle", () => {
  test("counts and rewrites @lamarck/system through the ordinary registry path", () => {
    const integrity = `sha512-${createHash("sha512").update("system-sdk").digest("base64")}`;
    const digestHex = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
    const resolved = "https://registry.npmjs.org/@lamarck/system/-/system-0.1.0.tgz";
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "@lamarck/system": "^0.1.0" } },
        "node_modules/@lamarck/system": {
          version: "0.1.0",
          resolved,
          integrity,
        },
      },
    };
    const manifest: DependencyBundleManifest = {
      version: 1,
      entries: [{
        resolved,
        integrity,
        bytes: 10,
        file: `tarballs/${digestHex}.tgz`,
      }],
    };

    expect(packageLockHasRegistryPackages(lock)).toBe(true);
    const rewritten = rewritePackageLockForBroker(lock, manifest, "http://127.0.0.1:3000");
    expect(rewritten.usedEntries).toBe(1);
    expect(
      (rewritten.lock.packages as Record<string, Record<string, unknown>>)[
        "node_modules/@lamarck/system"
      ]?.resolved,
    ).toBe(`http://127.0.0.1:3000/tarballs/${digestHex}.tgz`);
    expect(lock.packages["node_modules/@lamarck/system"].resolved).toBe(resolved);
  });

  test("rejects the former SDK placeholder as a missing broker identity", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "@lamarck/system": "^0.1.0" } },
        "node_modules/@lamarck/system": { version: "0.1.0" },
      },
    };
    expect(() => rewritePackageLockForBroker(lock, { version: 1, entries: [] }, "http://127.0.0.1"))
      .toThrow("node_modules/@lamarck/system.resolved must be a bounded URL string");
  });
});
