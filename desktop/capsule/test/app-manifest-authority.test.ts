import { describe, expect, test } from "vitest";
import { digestNormalizedAppManifest } from "../src/app-manifest-authority";

describe("normalized App manifest authority", () => {
  test("is stable across source key ordering but binds argv and grants", () => {
    const left = {
      manifestVersion: 1,
      id: "replay",
      runtime: { ui: { command: ["npm", "run", "start"], port: 3000 } },
      permissions: { writes: { docs: [], tables: ["reviews"] } },
    };
    const reordered = {
      permissions: { writes: { tables: ["reviews"], docs: [] } },
      runtime: { ui: { port: 3000, command: ["npm", "run", "start"] } },
      id: "replay",
      manifestVersion: 1,
    };
    expect(digestNormalizedAppManifest(left)).toBe(digestNormalizedAppManifest(reordered));
    expect(digestNormalizedAppManifest({
      ...left,
      runtime: { ui: { ...left.runtime.ui, command: ["npm", "run", "dev"] } },
    })).not.toBe(digestNormalizedAppManifest(left));
    expect(digestNormalizedAppManifest({
      ...left,
      permissions: { writes: { docs: [], tables: [] } },
    })).not.toBe(digestNormalizedAppManifest(left));
  });
});
