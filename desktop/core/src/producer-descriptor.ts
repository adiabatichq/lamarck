import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  validateFullGitCommit,
  validateSystemIdentity,
  type SystemIdentity,
} from "./system-identity";

export interface AppProducerV1 {
  readonly kind: "app";
  readonly appId: string;
  readonly commit: string;
}

export interface ConnectorProducerV1 {
  readonly kind: "connector";
  readonly connectorId: string;
  readonly packageDigest: string;
}

export interface SystemProducerV1 {
  readonly kind: "system";
}

export type ProducerIdentityV1 = AppProducerV1 | ConnectorProducerV1 | SystemProducerV1;

export interface ProducerDescriptorV1 {
  readonly schemaVersion: 1;
  readonly producer: ProducerIdentityV1;
  readonly system: SystemIdentity;
}

export type ProducerRef = `producer:v1:sha256:${string}`;

export interface DerivedProducerDescriptorV1 {
  descriptor: ProducerDescriptorV1;
  canonicalBytes: Buffer;
  digestHex: string;
  ref: ProducerRef;
}

export interface PublishProducerDescriptorResult extends DerivedProducerDescriptorV1 {
  compressedBytes: number;
}

export interface ProducerBinding {
  readonly producerRef: ProducerRef;
  readonly prepareProducer: () => void;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const PACKAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PRODUCER_REF_PATTERN = /^producer:v1:sha256:([0-9a-f]{64})$/;

export function createAppProducerDescriptor(
  appId: string,
  commit: string,
  system: SystemIdentity,
): ProducerDescriptorV1 {
  return validateProducerDescriptorV1({
    schemaVersion: 1,
    producer: { kind: "app", appId, commit },
    system,
  });
}

export function createConnectorProducerDescriptor(
  connectorId: string,
  packageDigest: string,
  system: SystemIdentity,
): ProducerDescriptorV1 {
  return validateProducerDescriptorV1({
    schemaVersion: 1,
    producer: { kind: "connector", connectorId, packageDigest },
    system,
  });
}

export function createSystemProducerDescriptor(system: SystemIdentity): ProducerDescriptorV1 {
  return validateProducerDescriptorV1({
    schemaVersion: 1,
    producer: { kind: "system" },
    system,
  });
}

export function validateProducerDescriptorV1(value: unknown): ProducerDescriptorV1 {
  const descriptor = requireExactObject(
    value,
    ["schemaVersion", "producer", "system"],
    "Producer descriptor",
  );
  if (descriptor.schemaVersion !== 1) {
    throw new Error("Producer descriptor schemaVersion must be 1");
  }

  return {
    schemaVersion: 1,
    producer: validateProducerIdentityV1(descriptor.producer),
    system: validateSystemIdentity(descriptor.system),
  };
}

export const parseProducerDescriptorV1 = validateProducerDescriptorV1;

export function canonicalizeProducerDescriptorV1(value: unknown): Buffer {
  const descriptor = validateProducerDescriptorV1(value);
  const producer = descriptor.producer.kind === "app"
    ? {
        kind: descriptor.producer.kind,
        appId: descriptor.producer.appId,
        commit: descriptor.producer.commit,
      }
    : descriptor.producer.kind === "connector"
      ? {
          kind: descriptor.producer.kind,
          connectorId: descriptor.producer.connectorId,
          packageDigest: descriptor.producer.packageDigest,
        }
      : { kind: descriptor.producer.kind };
  const canonical = {
    schemaVersion: descriptor.schemaVersion,
    producer,
    system: {
      version: descriptor.system.version,
      commit: descriptor.system.commit,
      platform: descriptor.system.platform,
    },
  };
  return Buffer.from(JSON.stringify(canonical), "utf8");
}

export function deriveProducerDescriptorV1(value: unknown): DerivedProducerDescriptorV1 {
  const descriptor = validateProducerDescriptorV1(value);
  const canonicalBytes = canonicalizeProducerDescriptorV1(descriptor);
  const digestHex = createHash("sha256").update(canonicalBytes).digest("hex");
  return {
    descriptor,
    canonicalBytes,
    digestHex,
    ref: formatProducerRef(digestHex),
  };
}

export function deriveProducerRef(value: unknown): ProducerRef {
  return deriveProducerDescriptorV1(value).ref;
}

export function parseProducerRef(value: unknown): ProducerRef {
  if (typeof value !== "string" || !PRODUCER_REF_PATTERN.test(value)) {
    throw new Error("Producer ref must match producer:v1:sha256:<64 lowercase hex characters>");
  }
  return value as ProducerRef;
}

export function formatProducerRef(digestHex: string): ProducerRef {
  if (!SHA256_HEX_PATTERN.test(digestHex)) {
    throw new Error("Producer descriptor digest must contain 64 lowercase hex characters");
  }
  return `producer:v1:sha256:${digestHex}`;
}

export function producerRefDigest(ref: unknown): string {
  return PRODUCER_REF_PATTERN.exec(parseProducerRef(ref))![1];
}

export function createProducerBinding(
  store: ProducerDescriptorStore,
  descriptorValue: unknown,
): ProducerBinding {
  const derived = deriveProducerDescriptorV1(descriptorValue);
  let published = false;
  return {
    producerRef: derived.ref,
    prepareProducer: () => {
      if (published) return;
      store.publish(derived.descriptor);
      published = true;
    },
  };
}

export class ProducerDescriptorStore {
  constructor(private readonly workspacePath: string) {}

  publish(value: unknown): PublishProducerDescriptorResult {
    const derived = deriveProducerDescriptorV1(value);
    const compressed = gzipSync(derived.canonicalBytes);
    const target = this.pathForDigest(derived.digestHex);
    mkdirSync(target.dir, { recursive: true });
    const tempPath = join(target.dir, `.publish-${randomUUID()}.tmp`);
    let tempFd: number | undefined;
    let ownsTemp = false;

    try {
      tempFd = openSync(tempPath, "wx");
      ownsTemp = true;
      writeFileSync(tempFd, compressed);
      fsyncSync(tempFd);
      closeSync(tempFd);
      tempFd = undefined;

      try {
        // The temporary inode contains the complete gzip before it becomes
        // reachable at the immutable digest path. A hard link on the same
        // filesystem publishes without ever replacing an existing object.
        linkSync(tempPath, target.path);
      } catch (error) {
        if (!isNodeErrorCode(error, "EEXIST")) throw error;
        this.resolve(derived.ref);
      }
    } finally {
      try {
        if (tempFd !== undefined) {
          closeSync(tempFd);
        }
      } finally {
        if (ownsTemp) {
          try {
            unlinkSync(tempPath);
          } catch (error) {
            if (!isNodeErrorCode(error, "ENOENT")) throw error;
          }
        }
      }
    }

    return {
      ...derived,
      compressedBytes: compressed.byteLength,
    };
  }

  resolve(refValue: unknown): ProducerDescriptorV1 {
    const ref = parseProducerRef(refValue);
    const digestHex = producerRefDigest(ref);
    const target = this.pathForDigest(digestHex);

    let compressed: Buffer;
    try {
      compressed = readFileSync(target.path);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        throw new Error(`Producer descriptor is missing for ${ref}`);
      }
      throw new Error(`Failed to read producer descriptor ${ref}: ${errorMessage(error)}`);
    }

    let bytes: Buffer;
    try {
      bytes = gunzipSync(compressed);
    } catch (error) {
      throw new Error(`Failed to decode producer descriptor ${ref}: ${errorMessage(error)}`);
    }

    const actualDigestHex = createHash("sha256").update(bytes).digest("hex");
    if (actualDigestHex !== digestHex) {
      throw new Error(
        `Producer descriptor digest mismatch: expected sha256:${digestHex}, actual sha256:${actualDigestHex}`,
      );
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`Producer descriptor is not valid UTF-8: ${errorMessage(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Producer descriptor is not valid JSON: ${errorMessage(error)}`);
    }
    const descriptor = validateProducerDescriptorV1(parsed);
    const canonicalBytes = canonicalizeProducerDescriptorV1(descriptor);
    if (!canonicalBytes.equals(bytes)) {
      throw new Error(`Producer descriptor ${ref} is not canonically serialized`);
    }
    return descriptor;
  }

  private pathForDigest(digestHex: string): { dir: string; path: string } {
    const dir = join(
      this.workspacePath,
      ".lamarck",
      "blobs",
      "producer",
      "v1",
      "sha256",
      digestHex.slice(0, 2),
      digestHex.slice(2, 4),
    );
    return { dir, path: join(dir, `${digestHex}.json.gz`) };
  }
}

function validateProducerIdentityV1(value: unknown): ProducerIdentityV1 {
  if (!isPlainObject(value)) {
    throw new Error("Producer descriptor producer must be an object");
  }
  if (value.kind === "app") {
    const producer = requireExactObject(value, ["kind", "appId", "commit"], "App producer");
    return {
      kind: "app",
      appId: requireNonEmptyIdentifier(producer.appId, "App producer appId"),
      commit: validateFullGitCommit(producer.commit, "App producer commit"),
    };
  }
  if (value.kind === "connector") {
    const producer = requireExactObject(
      value,
      ["kind", "connectorId", "packageDigest"],
      "Connector producer",
    );
    const packageDigest = producer.packageDigest;
    if (typeof packageDigest !== "string" || !PACKAGE_DIGEST_PATTERN.test(packageDigest)) {
      throw new Error("Connector producer packageDigest must match sha256:<64 lowercase hex characters>");
    }
    return {
      kind: "connector",
      connectorId: requireNonEmptyIdentifier(producer.connectorId, "Connector producer connectorId"),
      packageDigest,
    };
  }
  if (value.kind === "system") {
    requireExactObject(value, ["kind"], "System producer");
    return { kind: "system" };
  }
  throw new Error("Producer descriptor contains an unknown producer kind");
}

function requireNonEmptyIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function requireExactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }

  const expected = new Set(expectedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !expected.has(key)) {
      throw new Error(`${label} contains unknown field ${String(key)}`);
    }
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property) || !property.enumerable) {
      throw new Error(`${label} field ${key} must be an enumerable data property`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label} is missing field ${key}`);
    }
  }
  return value;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
