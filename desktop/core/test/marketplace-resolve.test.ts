import {
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  canonicalMarketplaceResolveBytes,
  parseMarketplaceTrustRoots,
  verifyMarketplaceResolvePayload,
} from "../src/marketplace/resolve";

const keyPair = generateKeyPairSync("ed25519");
const publicDer = keyPair.publicKey.export({ format: "der", type: "spki" });
const publicRaw = publicDer.subarray(publicDer.length - 32);

function signedResolve(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const unsigned = {
    protocolVersion: 1,
    kind: "app",
    packageId: "lamarck.notes",
    releaseId: "01JTESTRELEASE0000000000000",
    sequence: 7,
    artifactFormat: "marketplace-tar-gzip-v1",
    contentHash: `sha256:${"a".repeat(64)}`,
    artifactPath: `marketplace/v1/artifacts/app/sha256/aa/aa/${"a".repeat(64)}.tar.gz`,
    artifactBytes: 8192,
    publishedAt: "2026-08-04T03:02:01.000Z",
    origin: "Official",
    signatureKeyId: "marketplace-test-1",
    ...overrides,
  };
  return {
    ...unsigned,
    signature: sign(null, canonicalMarketplaceResolveBytes(unsigned), keyPair.privateKey)
      .toString("base64url"),
  };
}

const roots = [{ keyId: "marketplace-test-1", publicKey: publicRaw }];

describe("Marketplace resolve verification", () => {
  test("verifies the independent Backend production-shaped signing vector", () => {
    const backendPublicKey = createPublicKey(`-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----`);
    const backendDer = backendPublicKey.export({ format: "der", type: "spki" });
    const payload = {
      protocolVersion: 1,
      kind: "app",
      packageId: "lamarck.tools",
      releaseId: "rel_0123456789abcdefghijklmn",
      sequence: 7,
      artifactFormat: "marketplace-tar-gzip-v1",
      contentHash: "sha256:abababababababababababababababababababababababababababababababab",
      artifactPath: "marketplace/v1/artifacts/app/sha256/ab/ab/abababababababababababababababababababababababababababababababab.tar.gz",
      artifactBytes: 12345,
      publishedAt: "2026-08-04T01:02:03.000Z",
      origin: "Official",
      signatureKeyId: "marketplace-test-1",
      signature: "PDNxB8R6iSRYMD-hWnxt9pu4YwSdmQAg9SrDV0b7vy3bNUdPH4-ovB1rQj_bAPqgDCovmHj6dpdvkIAJ5QjRDg",
    };
    expect(canonicalMarketplaceResolveBytes(payload).toString("utf8")).toBe(
      '{"artifactBytes":12345,"artifactFormat":"marketplace-tar-gzip-v1","artifactPath":"marketplace/v1/artifacts/app/sha256/ab/ab/abababababababababababababababababababababababababababababababab.tar.gz","contentHash":"sha256:abababababababababababababababababababababababababababababababab","kind":"app","origin":"Official","packageId":"lamarck.tools","protocolVersion":1,"publishedAt":"2026-08-04T01:02:03.000Z","releaseId":"rel_0123456789abcdefghijklmn","sequence":7,"signatureKeyId":"marketplace-test-1"}',
    );
    expect(verifyMarketplaceResolvePayload(
      payload,
      { kind: "app", packageId: "lamarck.tools" },
      [{ keyId: "marketplace-test-1", publicKey: backendDer.subarray(backendDer.length - 32) }],
    )).toMatchObject({ releaseId: "rel_0123456789abcdefghijklmn", sequence: 7 });
  });

  test("verifies and binds a signed resolve response", () => {
    expect(verifyMarketplaceResolvePayload(
      signedResolve(),
      { kind: "app", packageId: "lamarck.notes" },
      roots,
    )).toMatchObject({
      kind: "app",
      packageId: "lamarck.notes",
      releaseId: "01JTESTRELEASE0000000000000",
      sequence: 7,
    });
  });

  test("pins scoped package identity to two ASCII segments of at most 64 bytes", () => {
    const namespace = "n".repeat(64);
    const name = "p".repeat(64);
    const boundary = `${namespace}.${name}`;
    expect(verifyMarketplaceResolvePayload(
      signedResolve({ packageId: boundary }),
      { kind: "app", packageId: boundary },
      roots,
    ).packageId).toBe(boundary);

    const overflow = `${namespace}x.${name}`;
    expect(() => verifyMarketplaceResolvePayload(
      signedResolve({ packageId: overflow }),
      { kind: "app", packageId: overflow },
      roots,
    )).toThrow("package ID");
  });

  test.each([
    ["packageId", "lamarck.changed"],
    ["kind", "connector"],
    ["artifactBytes", 8193],
    ["artifactPath", "https://evil.example/a.tar.gz"],
    ["contentHash", `sha256:${"b".repeat(64)}`],
    ["origin", "Community"],
    ["sequence", 8],
  ])("fails after changing the signed %s field", (field, changed) => {
    const payload = signedResolve();
    payload[field] = changed;
    expect(() => verifyMarketplaceResolvePayload(
      payload,
      { kind: "app", packageId: "lamarck.notes" },
      roots,
    )).toThrow();
  });

  test("rejects unknown keys and unexpected fields", () => {
    expect(() => verifyMarketplaceResolvePayload(
      signedResolve(),
      { kind: "app", packageId: "lamarck.notes" },
      [],
    )).toThrow("not trusted");
    expect(() => verifyMarketplaceResolvePayload(
      { ...signedResolve(), artifactUrl: "https://evil.example/a" },
      { kind: "app", packageId: "lamarck.notes" },
      roots,
    )).toThrow("unexpected");
  });

  test("parses only canonical raw Ed25519 build roots", () => {
    expect(parseMarketplaceTrustRoots({
      schemaVersion: 1,
      keys: [{
        keyId: "marketplace-test-1",
        algorithm: "Ed25519",
        publicKey: publicRaw.toString("base64"),
      }],
    })).toEqual([{ keyId: "marketplace-test-1", publicKey: publicRaw }]);
    expect(() => parseMarketplaceTrustRoots({
      schemaVersion: 1,
      keys: [{
        keyId: "marketplace-test-1",
        algorithm: "Ed25519",
        publicKey: publicRaw.toString("base64url"),
      }],
    })).toThrow("base64");
  });
});
