import { describe, expect, test } from "vitest";
import { evaluateNpmInstallInput } from "../src/build/install-input";

function input(overrides: Partial<Parameters<typeof evaluateNpmInstallInput>[0]> = {}) {
  return {
    packageJson: Buffer.from(JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      dependencies: { vite: "^6.0.0" },
    })),
    packageLock: Buffer.from(JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "1.0.0", dependencies: { vite: "^6.0.0" } },
        "node_modules/vite": { version: "6.0.0" },
      },
    })),
    hasBindingGyp: false,
    hasShrinkwrap: false,
    ...overrides,
  };
}

describe("npm install input fingerprint", () => {
  test("is stable, domain-framed, and sensitive to every captured install input", () => {
    const baseline = evaluateNpmInstallInput(input());
    expect(baseline).toMatchObject({ warmEligible: true });
    expect(baseline.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evaluateNpmInstallInput(input()).digest).toBe(baseline.digest);

    const variants = [
      input({ packageJson: Buffer.from('{"name":"changed"}') }),
      input({ packageLock: Buffer.from('{"lockfileVersion":3,"packages":{}}') }),
      input({ npmrc: Buffer.alloc(0) }),
      input({ npmrc: Buffer.from("install-links=false\n") }),
      input({ hasBindingGyp: true }),
      input({ hasShrinkwrap: true }),
    ];
    for (const variant of variants) {
      expect(evaluateNpmInstallInput(variant).digest).not.toBe(baseline.digest);
    }
  });

  test("conservatively rejects source-dependent npm install conventions", () => {
    for (const lifecycle of [
      "preinstall",
      "install",
      "postinstall",
      "prepublish",
      "preprepare",
      "prepare",
      "postprepare",
    ]) {
      expect(evaluateNpmInstallInput(input({
        packageJson: Buffer.from(JSON.stringify({ scripts: { [lifecycle]: "node build.js" } })),
      }))).toMatchObject({
        warmEligible: false,
        reason: expect.stringContaining(lifecycle),
      });
    }

    const workspace = input({
      packageJson: Buffer.from(JSON.stringify({ workspaces: ["packages/*"] })),
    });
    expect(evaluateNpmInstallInput(workspace)).toMatchObject({ warmEligible: false });

    for (const [field, specification] of [
      ["dependencies", "file:../local"],
      ["devDependencies", "link:../local"],
      ["optionalDependencies", "workspace:*"],
      ["peerDependencies", "file:./peer"],
    ]) {
      expect(evaluateNpmInstallInput(input({
        packageJson: Buffer.from(JSON.stringify({ [field]: { local: specification } })),
      }))).toMatchObject({ warmEligible: false });
    }

    const linked = input({
      packageLock: Buffer.from(JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/local": { link: true, resolved: "packages/local" } },
      })),
    });
    expect(evaluateNpmInstallInput(linked)).toMatchObject({ warmEligible: false });
    expect(evaluateNpmInstallInput(input({
      packageLock: Buffer.from(JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/local": { resolved: "file:../local" } },
      })),
    }))).toMatchObject({ warmEligible: false });
    expect(evaluateNpmInstallInput(input({ hasBindingGyp: true }))).toMatchObject({
      warmEligible: false,
    });
    expect(evaluateNpmInstallInput(input({ hasShrinkwrap: true }))).toMatchObject({
      warmEligible: false,
    });
  });
});
