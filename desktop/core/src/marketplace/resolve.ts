import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

export const MARKETPLACE_RESOLVE_PROTOCOL_VERSION = 1;
export const MARKETPLACE_ARTIFACT_FORMAT = "marketplace-tar-gzip-v1";
export const MARKETPLACE_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export type MarketplacePackageKind = "app" | "connector";

export interface MarketplaceResolvePayload {
  readonly protocolVersion: 1;
  readonly kind: MarketplacePackageKind;
  readonly packageId: string;
  readonly releaseId: string;
  readonly sequence: number;
  readonly artifactFormat: typeof MARKETPLACE_ARTIFACT_FORMAT;
  readonly contentHash: string;
  readonly artifactPath: string;
  readonly artifactBytes: number;
  readonly publishedAt: string;
  readonly origin: "Official";
  readonly signatureKeyId: string;
  readonly signature: string;
}

export interface MarketplaceTrustRoot {
  readonly keyId: string;
  readonly publicKey: Buffer | string;
}

export interface MarketplaceResolveExpectation {
  readonly kind: MarketplacePackageKind;
  readonly packageId: string;
}

const RESOLVE_FIELDS = [
  "artifactBytes",
  "artifactFormat",
  "artifactPath",
  "contentHash",
  "kind",
  "origin",
  "packageId",
  "protocolVersion",
  "publishedAt",
  "releaseId",
  "sequence",
  "signature",
  "signatureKeyId",
] as const;
const SCOPED_PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/;
const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIGNATURE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Parse, bind, and authenticate the exact Marketplace resolve wire payload. */
export function verifyMarketplaceResolvePayload(
  value: unknown,
  expected: MarketplaceResolveExpectation,
  trustRoots: readonly MarketplaceTrustRoot[],
): MarketplaceResolvePayload {
  const record = requireRecord(value, "Marketplace resolve payload");
  assertExactKeys(record, RESOLVE_FIELDS, "Marketplace resolve payload");

  if (record.protocolVersion !== MARKETPLACE_RESOLVE_PROTOCOL_VERSION) {
    throw new Error("Marketplace resolve protocol version is not supported");
  }
  if (record.kind !== "app" && record.kind !== "connector") {
    throw new Error("Marketplace resolve kind is invalid");
  }
  if (record.kind !== expected.kind) {
    throw new Error("Marketplace resolve kind does not match the handoff");
  }
  if (
    typeof record.packageId !== "string"
    || !SCOPED_PACKAGE_ID_PATTERN.test(record.packageId)
    || record.packageId !== expected.packageId
  ) {
    throw new Error("Marketplace resolve package ID does not match the handoff");
  }
  if (typeof record.releaseId !== "string" || !OPAQUE_ID_PATTERN.test(record.releaseId)) {
    throw new Error("Marketplace resolve release ID is invalid");
  }
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1) {
    throw new Error("Marketplace resolve sequence is invalid");
  }
  if (record.artifactFormat !== MARKETPLACE_ARTIFACT_FORMAT) {
    throw new Error("Marketplace artifact format is not supported");
  }
  if (typeof record.contentHash !== "string" || !CONTENT_HASH_PATTERN.test(record.contentHash)) {
    throw new Error("Marketplace content hash is invalid");
  }
  if (
    typeof record.artifactPath !== "string"
    || record.artifactPath.length === 0
    || Buffer.byteLength(record.artifactPath, "utf8") > 512
  ) {
    throw new Error("Marketplace artifact path is invalid");
  }
  if (
    !Number.isSafeInteger(record.artifactBytes)
    || (record.artifactBytes as number) < 1
    || (record.artifactBytes as number) > MARKETPLACE_MAX_ARTIFACT_BYTES
  ) {
    throw new Error("Marketplace artifact size is invalid");
  }
  if (
    typeof record.publishedAt !== "string"
    || !RFC3339_PATTERN.test(record.publishedAt)
    || !Number.isFinite(Date.parse(record.publishedAt))
  ) {
    throw new Error("Marketplace publication time is invalid");
  }
  if (record.origin !== "Official") {
    throw new Error("Marketplace resolve origin is invalid");
  }
  if (
    typeof record.signatureKeyId !== "string"
    || !SIGNATURE_KEY_ID_PATTERN.test(record.signatureKeyId)
  ) {
    throw new Error("Marketplace signature key ID is invalid");
  }
  if (typeof record.signature !== "string") {
    throw new Error("Marketplace signature is invalid");
  }

  const signature = decodeCanonicalBase64Url(record.signature, 64, "Marketplace signature");
  const matchingRoots = trustRoots.filter((root) => root.keyId === record.signatureKeyId);
  if (matchingRoots.length !== 1) {
    throw new Error("Marketplace signature key is not trusted");
  }
  const signed = canonicalMarketplaceResolveBytes(record);
  if (!verifySignature(null, signed, marketplacePublicKey(matchingRoots[0]), signature)) {
    throw new Error("Marketplace resolve signature is invalid");
  }

  return Object.freeze({
    protocolVersion: 1,
    kind: record.kind,
    packageId: record.packageId,
    releaseId: record.releaseId,
    sequence: record.sequence as number,
    artifactFormat: MARKETPLACE_ARTIFACT_FORMAT,
    contentHash: record.contentHash,
    artifactPath: record.artifactPath,
    artifactBytes: record.artifactBytes as number,
    publishedAt: record.publishedAt,
    origin: "Official",
    signatureKeyId: record.signatureKeyId,
    signature: record.signature,
  });
}

/** Canonical JSON signed by Backend: recursively sorted keys, no whitespace. */
export function canonicalMarketplaceResolveBytes(value: Record<string, unknown>): Buffer {
  const unsigned: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key !== "signature") unsigned[key] = nested;
  }
  return Buffer.from(JSON.stringify(canonicalJson(unsigned)), "utf8");
}

export function parseMarketplaceTrustRoots(value: unknown): MarketplaceTrustRoot[] {
  const document = requireRecord(value, "Marketplace trust-root document");
  assertExactKeys(document, ["keys", "schemaVersion"], "Marketplace trust-root document");
  if (document.schemaVersion !== 1 || !Array.isArray(document.keys) || document.keys.length > 8) {
    throw new Error("Marketplace trust-root document is invalid");
  }
  const seen = new Set<string>();
  return document.keys.map((entry, index) => {
    const key = requireRecord(entry, `Marketplace trust root ${index}`);
    assertExactKeys(key, ["algorithm", "keyId", "publicKey"], `Marketplace trust root ${index}`);
    if (
      key.algorithm !== "Ed25519"
      || typeof key.keyId !== "string"
      || !SIGNATURE_KEY_ID_PATTERN.test(key.keyId)
      || seen.has(key.keyId)
      || typeof key.publicKey !== "string"
    ) {
      throw new Error(`Marketplace trust root ${index} is invalid`);
    }
    seen.add(key.keyId);
    return Object.freeze({
      keyId: key.keyId,
      publicKey: decodeCanonicalBase64(key.publicKey, 32, `Marketplace trust root ${index}`),
    });
  });
}

function marketplacePublicKey(root: MarketplaceTrustRoot): KeyObject {
  const raw = Buffer.isBuffer(root.publicKey)
    ? Buffer.from(root.publicKey)
    : decodeCanonicalBase64(root.publicKey, 32, "Marketplace public key");
  if (raw.length !== 32) throw new Error("Marketplace public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value;
}

function decodeCanonicalBase64Url(value: string, expectedBytes: number, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is not canonical base64url`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== value) {
    throw new Error(`${label} is not canonical base64url`);
  }
  return decoded;
}

function decodeCanonicalBase64(value: string, expectedBytes: number, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${label} is not canonical base64`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedBytes || decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}
