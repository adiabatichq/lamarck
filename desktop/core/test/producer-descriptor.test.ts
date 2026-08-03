import { createHash } from "node:crypto";
import { buildSync } from "esbuild";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ProducerDescriptorStore,
  canonicalizeProducerDescriptorV1,
  createAppProducerDescriptor,
  createConnectorProducerDescriptor,
  createProducerBinding,
  createSystemProducerDescriptor,
  deriveProducerRef,
  formatProducerRef,
  parseProducerRef,
  producerRefDigest,
  validateProducerDescriptorV1,
  type ProducerDescriptorV1,
} from "../src/producer-descriptor";
import {
  createSystemIdentity,
  systemIdentityFromBuild,
  validateSystemIdentity,
  type SystemIdentity,
} from "../src/system-identity";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const PACKAGE_DIGEST = `sha256:${"ab".repeat(32)}`;
const SYSTEM: SystemIdentity = {
  version: "0.1.0",
  commit: COMMIT,
  platform: "darwin-arm64",
};

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("SystemIdentity", () => {
  test("constructs a deterministic injected platform identity", () => {
    expect(createSystemIdentity(
      { version: "0.1.0", commit: COMMIT },
      { platform: "darwin", arch: "arm64" },
    )).toEqual(SYSTEM);
    expect(validateSystemIdentity(SYSTEM)).toEqual(SYSTEM);
  });

  test("rejects missing, unknown, abbreviated, and volatile identity fields", () => {
    expect(() => validateSystemIdentity({ commit: COMMIT, platform: "darwin-arm64" }))
      .toThrow("missing field version");
    expect(() => validateSystemIdentity({ ...SYSTEM, version: "unknown" }))
      .toThrow("must not be unknown");
    expect(() => validateSystemIdentity({ ...SYSTEM, commit: COMMIT.slice(0, 12) }))
      .toThrow("full 40- or 64-character lowercase Git commit");
    expect(validateSystemIdentity({ ...SYSTEM, commit: "a".repeat(64) }).commit)
      .toBe("a".repeat(64));
    expect(() => validateSystemIdentity({ ...SYSTEM, createdAt: 1 }))
      .toThrow("unknown field createdAt");
  });

  test("fails closed when build identity globals are not embedded", () => {
    expect(() => systemIdentityFromBuild()).toThrow(
      "Lamarck product version was not embedded in the Core build",
    );
  });
});

describe("Producer Descriptor V1", () => {
  test("serializes each exact descriptor shape in fixed canonical order", () => {
    const app = createAppProducerDescriptor("focus", APP_COMMIT, SYSTEM);
    expect(canonicalizeProducerDescriptorV1(app).toString("utf8")).toBe(
      `{"schemaVersion":1,"producer":{"kind":"app","appId":"focus","commit":"${APP_COMMIT}"},`
      + `"system":{"version":"0.1.0","commit":"${COMMIT}","platform":"darwin-arm64"}}`,
    );

    const connector = createConnectorProducerDescriptor("oura", PACKAGE_DIGEST, SYSTEM);
    expect(canonicalizeProducerDescriptorV1(connector).toString("utf8")).toBe(
      `{"schemaVersion":1,"producer":{"kind":"connector","connectorId":"oura",`
      + `"packageDigest":"${PACKAGE_DIGEST}"},`
      + `"system":{"version":"0.1.0","commit":"${COMMIT}","platform":"darwin-arm64"}}`,
    );

    const system = createSystemProducerDescriptor(SYSTEM);
    const canonical = canonicalizeProducerDescriptorV1(system);
    const expectedDigest = createHash("sha256").update(canonical).digest("hex");
    expect(deriveProducerRef(system)).toBe(`producer:v1:sha256:${expectedDigest}`);
    expect(canonical.toString("utf8")).not.toMatch(/\s/);
  });

  test("rejects unknown kinds, missing or unknown fields, empty ids, and malformed code identities", () => {
    const base = createAppProducerDescriptor("focus", APP_COMMIT, SYSTEM);
    expect(() => validateProducerDescriptorV1({
      ...base,
      producer: { kind: "official" },
    })).toThrow("unknown producer kind");
    expect(() => validateProducerDescriptorV1({
      schemaVersion: 1,
      producer: { kind: "app", appId: "focus" },
      system: SYSTEM,
    })).toThrow("missing field commit");
    expect(() => validateProducerDescriptorV1({ ...base, createdAt: 1 }))
      .toThrow("unknown field createdAt");
    expect(() => createAppProducerDescriptor("", APP_COMMIT, SYSTEM))
      .toThrow("non-empty string");
    expect(() => createAppProducerDescriptor("focus", APP_COMMIT.slice(0, 12), SYSTEM))
      .toThrow("full 40- or 64-character lowercase Git commit");
    expect(() => createConnectorProducerDescriptor("oura", `sha256:${"a".repeat(63)}`, SYSTEM))
      .toThrow("packageDigest must match");
    expect(() => validateProducerDescriptorV1({
      ...base,
      producer: { ...base.producer, runId: "volatile" },
    })).toThrow("unknown field runId");
  });

  test("strictly parses and formats logical refs", () => {
    const digest = "cd".repeat(32);
    const ref = formatProducerRef(digest);
    expect(parseProducerRef(ref)).toBe(ref);
    expect(producerRefDigest(ref)).toBe(digest);
    for (const malformed of [
      undefined,
      "",
      `producer:v1:sha256:${digest.toUpperCase()}`,
      `producer:v2:sha256:${digest}`,
      `producer:v1:sha512:${digest}`,
      `producer:v1:sha256:${digest.slice(1)}`,
    ]) {
      expect(() => parseProducerRef(malformed)).toThrow("Producer ref must match");
    }
  });
});

describe("ProducerDescriptorStore", () => {
  test("derives a binding eagerly and memoizes only successful lazy publication", () => {
    const workspace = createWorkspace();
    const store = new ProducerDescriptorStore(workspace);
    const descriptor = createSystemProducerDescriptor(SYSTEM);
    const publish = vi.spyOn(store, "publish");
    publish.mockImplementationOnce(() => {
      throw new Error("injected publication failure");
    });

    const binding = createProducerBinding(store, descriptor);
    expect(binding.producerRef).toBe(deriveProducerRef(descriptor));
    expect(publish).not.toHaveBeenCalled();
    expect(() => binding.prepareProducer()).toThrow("injected publication failure");
    expect(publish).toHaveBeenCalledTimes(1);

    binding.prepareProducer();
    binding.prepareProducer();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(store.resolve(binding.producerRef)).toEqual(descriptor);
  });

  test("same-object publishers converge on one complete descriptor without temporary files", () => {
    const workspace = createWorkspace();
    const firstStore = new ProducerDescriptorStore(workspace);
    const secondStore = new ProducerDescriptorStore(workspace);
    const descriptor = createConnectorProducerDescriptor("oura", PACKAGE_DIGEST, SYSTEM);

    const first = firstStore.publish(descriptor);
    const second = secondStore.publish(descriptor);

    expect(second.ref).toBe(first.ref);
    expect(firstStore.resolve(first.ref)).toEqual(descriptor);
    const storedPath = pathFor(workspace, first.ref);
    expect(readFileSync(storedPath).byteLength).toBe(first.compressedBytes);
    expect(readdirSync(dirname(storedPath))).toEqual([
      `${producerRefDigest(first.ref)}.json.gz`,
    ]);
    expect(() => firstStore.resolve(formatProducerRef("f".repeat(64))))
      .toThrow("Producer descriptor is missing");
  });

  test("concurrent publishers atomically converge on one complete descriptor", async () => {
    const workspace = createWorkspace();
    const descriptor = createSystemProducerDescriptor(SYSTEM);
    const store = new ProducerDescriptorStore(workspace);
    const ref = deriveProducerRef(descriptor);
    const modulePath = join(workspace, "producer-descriptor-worker.mjs");
    const workerPath = join(workspace, "publish-worker.mjs");
    buildSync({
      entryPoints: [fileURLToPath(new URL("../src/producer-descriptor.ts", import.meta.url))],
      outfile: modulePath,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
    });
    writeFileSync(workerPath, `
      import { parentPort, workerData } from "node:worker_threads";
      import { ProducerDescriptorStore } from "./producer-descriptor-worker.mjs";

      const gate = new Int32Array(workerData.gate);
      Atomics.add(gate, 0, 1);
      Atomics.notify(gate, 0);
      while (Atomics.load(gate, 0) !== 3) Atomics.wait(gate, 0, 2, 1000);
      new ProducerDescriptorStore(workerData.workspace).publish(workerData.descriptor);
      parentPort.postMessage("published");
    `);

    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const workerData = { descriptor, gate: gate.buffer, workspace };
    const workers = [
      new Worker(workerPath, { workerData }),
      new Worker(workerPath, { workerData }),
    ];
    while (Atomics.load(gate, 0) !== workers.length) {
      await new Promise((resolveReady) => setTimeout(resolveReady, 1));
    }
    Atomics.store(gate, 0, 3);
    Atomics.notify(gate, 0, workers.length);
    await Promise.all(workers.map(waitForWorker));

    expect(store.resolve(ref)).toEqual(descriptor);
    const storedPath = pathFor(workspace, ref);
    expect(readdirSync(dirname(storedPath))).toEqual([
      `${producerRefDigest(ref)}.json.gz`,
    ]);
  });

  test("never overwrites a corrupt existing object during put-if-absent", () => {
    const workspace = createWorkspace();
    const store = new ProducerDescriptorStore(workspace);
    const descriptor = createSystemProducerDescriptor(SYSTEM);
    const published = store.publish(descriptor);
    const storedPath = pathFor(workspace, published.ref);
    writeFileSync(storedPath, Buffer.from("not gzip"));

    expect(() => store.publish(descriptor)).toThrow("Failed to decode producer descriptor");
    expect(readFileSync(storedPath).toString("utf8")).toBe("not gzip");
    expect(readdirSync(dirname(storedPath))).toEqual([
      `${producerRefDigest(published.ref)}.json.gz`,
    ]);
  });

  test("rejects descriptor corruption and digest mismatch", () => {
    const workspace = createWorkspace();
    const store = new ProducerDescriptorStore(workspace);
    const descriptor = createSystemProducerDescriptor(SYSTEM);
    const ref = deriveProducerRef(descriptor);
    const storedPath = pathFor(workspace, ref);
    mkdirSync(dirname(storedPath), { recursive: true });
    const different = canonicalizeProducerDescriptorV1({
      ...descriptor,
      system: { ...SYSTEM, version: "0.2.0" },
    });
    writeFileSync(storedPath, gzipSync(different));

    expect(() => store.resolve(ref)).toThrow("Producer descriptor digest mismatch");

    writeFileSync(storedPath, gzipSync(Buffer.from([0xff, 0xfe])));
    expect(() => store.resolve(ref)).toThrow("Producer descriptor digest mismatch");
  });

  test("rejects a digest-addressed but non-canonical descriptor encoding", () => {
    const workspace = createWorkspace();
    const store = new ProducerDescriptorStore(workspace);
    const descriptor: ProducerDescriptorV1 = createSystemProducerDescriptor(SYSTEM);
    const nonCanonical = Buffer.from(JSON.stringify(descriptor, null, 2), "utf8");
    const digest = createHash("sha256").update(nonCanonical).digest("hex");
    const ref = formatProducerRef(digest);
    const storedPath = pathFor(workspace, ref);
    mkdirSync(dirname(storedPath), { recursive: true });
    writeFileSync(storedPath, gzipSync(nonCanonical));

    expect(() => store.resolve(ref)).toThrow("not canonically serialized");
  });
});

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "lamarck-producer-descriptor-"));
  workspaces.push(workspace);
  return workspace;
}

function pathFor(workspace: string, ref: string): string {
  const digest = producerRefDigest(ref);
  return join(
    workspace,
    ".lamarck",
    "blobs",
    "producer",
    "v1",
    "sha256",
    digest.slice(0, 2),
    digest.slice(2, 4),
    `${digest}.json.gz`,
  );
}

function waitForWorker(worker: Worker): Promise<void> {
  return new Promise((resolveWorker, rejectWorker) => {
    worker.once("error", rejectWorker);
    worker.once("message", () => resolveWorker());
    worker.once("exit", (code) => {
      if (code !== 0) rejectWorker(new Error(`Producer publication worker exited with ${code}`));
    });
  });
}
