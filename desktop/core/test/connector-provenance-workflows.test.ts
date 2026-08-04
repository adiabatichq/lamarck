import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EventInput } from "../src/guard-types";
import type { GuardSqlParams } from "../src/guard-service/protocol";
import {
  ConnectorPackageArchiveStore,
  ConnectorSupervisor,
  hashConnectorPackage,
  installConnectorFromSource,
  removeConnectorFromWorkspace,
  updateConnectorFromSource,
  type ConnectorHostGuard,
} from "../src/connectors";
import {
  extractVerifiedMarketplaceArtifact,
  verifyMarketplaceArtifact,
} from "../src/marketplace/artifact";
import { ProducerDescriptorStore } from "../src/producer-descriptor";
import { openTestDatabases } from "./support/test-databases";
import { TEST_PRODUCER_REF, TestGuard } from "./support/test-guard";

const TEST_SYSTEM_IDENTITY = Object.freeze({
  version: "0.0.0-test",
  commit: "a".repeat(40),
  platform: "darwin-arm64",
});

type ArchivePublication = Awaited<
  ReturnType<ConnectorPackageArchiveStore["publish"]>
>;

class InstrumentedArchiveStore {
  readonly real: ConnectorPackageArchiveStore;
  readonly failDigests = new Set<string>();
  readonly requiredDigests: string[] = [];
  readonly resolvedDigests: string[] = [];
  onPublish?: (connectorDir: string, digest: string) => void | Promise<void>;

  constructor(workspacePath: string) {
    this.real = new ConnectorPackageArchiveStore(workspacePath);
  }

  async publish(connectorDir: string, digest: string): Promise<ArchivePublication> {
    await this.onPublish?.(connectorDir, digest);
    if (this.failDigests.has(digest)) {
      throw new Error(`injected archive failure for ${digest}`);
    }
    return this.real.publish(connectorDir, digest);
  }

  resolve(digest: string) {
    this.resolvedDigests.push(digest);
    return this.real.resolve(digest);
  }

  requireExists(digest: string) {
    this.requiredDigests.push(digest);
    return this.real.requireExists(digest);
  }
}

/**
 * TestGuard stores the selected Producer ref. This adapter also runs the
 * Core-side publication callback so packaged-Connector tests exercise the
 * descriptor-before-D0 ordering used by RemoteGuard in production.
 */
class PreparingGuard implements ConnectorHostGuard {
  constructor(
    private readonly guard: TestGuard,
    private readonly prepareProducer?: () => void | Promise<void>,
  ) {}

  withSource(source: string, producer: {
    producerRef: string;
    prepareProducer?: () => void | Promise<void>;
  }): PreparingGuard {
    return new PreparingGuard(
      this.guard.withSource(source, { producerRef: producer.producerRef }),
      producer.prepareProducer,
    );
  }

  queryOne(sql: string, params?: GuardSqlParams): unknown | null {
    return this.guard.queryOne(sql, params);
  }

  async writeEvent(event: EventInput): Promise<string> {
    await this.prepareProducer?.();
    return this.guard.writeEvent(event);
  }
}

describe("Connector package provenance workflows", () => {
  let workspace: string;
  let dataDb: DatabaseSync;
  let systemDb: DatabaseSync;
  let closeDatabases: () => void;
  let archiveStore: InstrumentedArchiveStore;
  let descriptorStore: ProducerDescriptorStore;
  let guard: PreparingGuard;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-connector-provenance-"));
    mkdirSync(join(workspace, ".lamarck"), { recursive: true });
    const databases = openTestDatabases(workspace);
    dataDb = databases.dataDb;
    systemDb = databases.systemDb;
    closeDatabases = databases.close;
    archiveStore = new InstrumentedArchiveStore(workspace);
    descriptorStore = new ProducerDescriptorStore(workspace);
    guard = new PreparingGuard(new TestGuard({
      db: dataDb,
      source: "system:test",
      producerRef: TEST_PRODUCER_REF,
    }));
  });

  afterEach(() => {
    closeDatabases();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("custom approval publishes and verifies the archive before approval becomes effective", async () => {
    const connectorDir = writePackage(
      join(workspace, "connectors", "custom-provenance"),
      "custom-provenance",
      "custom-v1",
    );
    const supervisor = createSupervisor();
    await supervisor.registerDirectory(connectorDir);
    const digest = await hashConnectorPackage(connectorDir);

    archiveStore.onPublish = async (publishedDir, publishedDigest) => {
      expect(publishedDir).toBe(connectorDir);
      expect(publishedDigest).toBe(digest);
      expect(customApproval("custom-provenance")).toBeUndefined();
      expect(eventCount("connector.approved")).toBe(0);
    };

    await supervisor.approveCurrentPackage("custom-provenance");

    expect(customApproval("custom-provenance")?.approved_hash).toBe(digest);
    expect(supervisor.listInstalledConnectors()).toEqual([
      expect.objectContaining({
        connectorId: "custom-provenance",
        packageHash: digest,
        packageTrust: "custom",
      }),
    ]);
    await expect(archiveStore.resolve(digest)).resolves.toMatchObject({ digest });
    expect(eventCount("connector.approved")).toBe(1);
  });

  test("archive failure leaves a custom package unapproved", async () => {
    const connectorDir = writePackage(
      join(workspace, "connectors", "rejected-custom"),
      "rejected-custom",
      "custom-v1",
    );
    const digest = await hashConnectorPackage(connectorDir);
    archiveStore.failDigests.add(digest);
    const supervisor = createSupervisor();
    await supervisor.registerDirectory(connectorDir);

    await expect(supervisor.approveCurrentPackage("rejected-custom"))
      .rejects.toThrow("injected archive failure");

    expect(customApproval("rejected-custom")).toBeUndefined();
    expect(supervisor.listInstalledConnectors()).toEqual([
      expect.objectContaining({
        connectorId: "rejected-custom",
        packageHash: digest,
        packageTrust: "untrusted",
      }),
    ]);
    expect(eventCount("connector.approved")).toBe(0);
    await expect(archiveStore.resolve(digest)).rejects.toThrow("archive is missing");
  });

  test("trusted install archives the staged candidate before registration", async () => {
    const connectorId = "trusted-install";
    const sourceDir = writePackage(
      join(workspace, "package-sources", `${connectorId}-v1`),
      connectorId,
      "install-v1",
    );
    const digest = await hashConnectorPackage(sourceDir);
    const supervisor = createSupervisor([{ id: connectorId, hash: digest }]);
    const targetDir = join(workspace, "connectors", connectorId);

    archiveStore.onPublish = async (stagingDir, publishedDigest) => {
      expect(stagingDir).toContain(".install-staging-");
      expect(publishedDigest).toBe(digest);
      expect(existsSync(targetDir)).toBe(false);
      expect(supervisor.isRegistered(connectorId)).toBe(false);
      expect(eventCount("connector.installed")).toBe(0);
    };

    const installed = await installConnectorFromSource({
      sourceDir,
      workspacePath: workspace,
      guard,
      supervisor,
    });

    expect(installed.dir).toBe(targetDir);
    expect(existsSync(targetDir)).toBe(true);
    expect(supervisor.isRegistered(connectorId)).toBe(true);
    expect(eventCount("connector.installed")).toBe(1);
    await expect(archiveStore.resolve(digest)).resolves.toMatchObject({ digest });
  });

  test("materializes the verified macos-ax helper as executable without changing package identity", async () => {
    const connectorId = "lamarck.macos-ax";
    const officialSource = fileURLToPath(
      new URL("../../../connectors/macos-ax", import.meta.url),
    );
    const candidateSource = join(workspace, "marketplace-candidate", connectorId);
    cpSync(officialSource, candidateSource, { recursive: true });
    symlinkSync("privacy-lists", join(candidateSource, "privacy-alias"));
    const sourceModeDigest = await hashConnectorPackage(candidateSource);
    chmodSync(join(candidateSource, "bin", "ax-helper"), 0o644);
    expect(await hashConnectorPackage(candidateSource)).toBe(sourceModeDigest);

    // Produce canonical Connector bytes, then run the actual independent
    // Marketplace verifier/extractor to create the confirmation staging tree.
    const producerStore = new ConnectorPackageArchiveStore(
      join(workspace, "backend-shaped-artifact"),
    );
    const publication = await producerStore.publish(candidateSource, sourceModeDigest);
    const verifiedArtifact = verifyMarketplaceArtifact({
      kind: "connector",
      packageId: connectorId,
      contentHash: sourceModeDigest,
      archiveBytes: readFileSync(publication.path),
    });
    const verifiedSource = join(workspace, "marketplace-staging", connectorId);
    mkdirSync(join(workspace, "marketplace-staging"), { recursive: true });
    await extractVerifiedMarketplaceArtifact(verifiedArtifact, verifiedSource);
    expectTreeModes(verifiedSource, 0o644);
    expect(await hashConnectorPackage(verifiedSource)).toBe(sourceModeDigest);

    const targetDir = join(workspace, "connectors", connectorId);
    const supervisor = createSupervisor([{ id: connectorId, hash: sourceModeDigest }]);
    archiveStore.onPublish = async (stagingDir, publishedDigest) => {
      expect(publishedDigest).toBe(sourceModeDigest);
      expect(existsSync(targetDir)).toBe(false);
      // Download/verification staging remains non-executable through immutable
      // archive publication. Materialization happens after this boundary.
      expectTreeModes(stagingDir, 0o644);
    };

    const installed = await installConnectorFromSource({
      sourceDir: verifiedSource,
      workspacePath: workspace,
      connectorId,
      guard,
      supervisor,
    });

    expect(installed.dir).toBe(targetDir);
    expectTreeModes(verifiedSource, 0o644);
    expectTreeModes(targetDir, 0o700);
    expect(lstatSync(join(targetDir, "privacy-alias")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(targetDir, "privacy-alias"))).toBe("privacy-lists");
    expect(lstatSync(join(targetDir, "privacy-lists")).mode & 0o777).toBe(0o755);
    const installedHelper = join(targetDir, "bin", "ax-helper");
    expect(lstatSync(installedHelper).mode & 0o777).toBe(0o700);
    expect(() => accessSync(installedHelper, constants.X_OK)).not.toThrow();
    expect(await hashConnectorPackage(targetDir)).toBe(sourceModeDigest);
    await expect(archiveStore.resolve(sourceModeDigest)).resolves.toMatchObject({
      digest: sourceModeDigest,
    });
  });

  test("archive failure prevents trusted install completion", async () => {
    const connectorId = "failed-install";
    const sourceDir = writePackage(
      join(workspace, "package-sources", `${connectorId}-v1`),
      connectorId,
      "install-v1",
    );
    const digest = await hashConnectorPackage(sourceDir);
    archiveStore.failDigests.add(digest);
    const supervisor = createSupervisor([{ id: connectorId, hash: digest }]);
    const targetDir = join(workspace, "connectors", connectorId);

    await expect(installConnectorFromSource({
      sourceDir,
      workspacePath: workspace,
      guard,
      supervisor,
    })).rejects.toThrow("injected archive failure");

    expect(existsSync(targetDir)).toBe(false);
    expect(supervisor.isRegistered(connectorId)).toBe(false);
    expect(eventCount("connector.installed")).toBe(0);
    expect(connectorStagingEntries()).toEqual([]);
  });

  test("trusted update archives the candidate before swapping the active package", async () => {
    const connectorId = "trusted-update";
    const oldSource = writePackage(
      join(workspace, "package-sources", `${connectorId}-v1`),
      connectorId,
      "update-v1",
    );
    const newSource = writePackage(
      join(workspace, "package-sources", `${connectorId}-v2`),
      connectorId,
      "update-v2",
    );
    const oldDigest = await hashConnectorPackage(oldSource);
    const newDigest = await hashConnectorPackage(newSource);
    const supervisor = createSupervisor([
      { id: connectorId, hash: oldDigest },
      { id: connectorId, hash: newDigest },
    ]);
    const targetDir = join(workspace, "connectors", connectorId);
    await installConnectorFromSource({
      sourceDir: oldSource,
      workspacePath: workspace,
      guard,
      supervisor,
    });

    const originalWithConnectorUpdate = supervisor.withConnectorUpdate.bind(supervisor);
    const updateBoundary = vi.spyOn(supervisor, "withConnectorUpdate");
    updateBoundary.mockImplementation(async (id, nextManifest, update) => {
      const stagingName = readdirSync(join(workspace, "connectors")).find((name) =>
        name.startsWith(".update-staging-"));
      expect(stagingName).toBeDefined();
      // The candidate is mode-normalized while still hidden; the live package
      // remains the old tree until the guarded atomic swap begins.
      expectTreeModes(join(workspace, "connectors", stagingName!), 0o700);
      expectTreeModes(targetDir, 0o700);
      expect(await hashConnectorPackage(targetDir)).toBe(oldDigest);
      return originalWithConnectorUpdate(id, nextManifest, update);
    });

    archiveStore.onPublish = async (stagingDir, publishedDigest) => {
      if (publishedDigest !== newDigest) return;
      expect(stagingDir).toContain(".update-staging-");
      expectTreeModes(stagingDir, 0o644);
      expectTreeModes(targetDir, 0o700);
      expect(await hashConnectorPackage(targetDir)).toBe(oldDigest);
      expect(supervisor.listInstalledConnectors()).toEqual([
        expect.objectContaining({ packageHash: oldDigest }),
      ]);
      expect(eventCount("connector.updated")).toBe(0);
    };

    const result = await updateConnectorFromSource({
      sourceDir: newSource,
      workspacePath: workspace,
      guard,
      supervisor,
    });

    expect(result).toMatchObject({
      updated: true,
      fromHash: oldDigest,
      toHash: newDigest,
      dir: targetDir,
    });
    expect(updateBoundary).toHaveBeenCalledOnce();
    expectTreeModes(targetDir, 0o700);
    expect(await hashConnectorPackage(targetDir)).toBe(newDigest);
    expect(supervisor.listInstalledConnectors()).toEqual([
      expect.objectContaining({ packageHash: newDigest, packageTrust: "official" }),
    ]);
    expect(eventCount("connector.updated")).toBe(1);
    await expect(archiveStore.resolve(newDigest)).resolves.toMatchObject({ digest: newDigest });
  });

  test("archive failure prevents trusted update admission and preserves the active package", async () => {
    const connectorId = "failed-update";
    const oldSource = writePackage(
      join(workspace, "package-sources", `${connectorId}-v1`),
      connectorId,
      "update-v1",
    );
    const newSource = writePackage(
      join(workspace, "package-sources", `${connectorId}-v2`),
      connectorId,
      "update-v2",
    );
    const oldDigest = await hashConnectorPackage(oldSource);
    const newDigest = await hashConnectorPackage(newSource);
    const supervisor = createSupervisor([
      { id: connectorId, hash: oldDigest },
      { id: connectorId, hash: newDigest },
    ]);
    const targetDir = join(workspace, "connectors", connectorId);
    await installConnectorFromSource({
      sourceDir: oldSource,
      workspacePath: workspace,
      guard,
      supervisor,
    });
    expectTreeModes(targetDir, 0o700);
    archiveStore.failDigests.add(newDigest);
    archiveStore.onPublish = async (stagingDir, publishedDigest) => {
      if (publishedDigest !== newDigest) return;
      expectTreeModes(stagingDir, 0o644);
      expectTreeModes(targetDir, 0o700);
    };

    await expect(updateConnectorFromSource({
      sourceDir: newSource,
      workspacePath: workspace,
      guard,
      supervisor,
    })).rejects.toThrow("injected archive failure");

    expect(await hashConnectorPackage(targetDir)).toBe(oldDigest);
    expectTreeModes(targetDir, 0o700);
    expect(supervisor.listInstalledConnectors()).toEqual([
      expect.objectContaining({ packageHash: oldDigest, packageTrust: "official" }),
    ]);
    expect(eventCount("connector.updated")).toBe(0);
    expect(connectorStagingEntries()).toEqual([]);
  });

  test("rolls back a mode-normalized update when the post-swap audit fails", async () => {
    const connectorId = "mode-rollback";
    const oldSource = writePackage(
      join(workspace, "package-sources", `${connectorId}-v1`),
      connectorId,
      "rollback-v1",
    );
    const newSource = writePackage(
      join(workspace, "package-sources", `${connectorId}-v2`),
      connectorId,
      "rollback-v2",
    );
    const oldDigest = await hashConnectorPackage(oldSource);
    const newDigest = await hashConnectorPackage(newSource);
    const supervisor = createSupervisor([
      { id: connectorId, hash: oldDigest },
      { id: connectorId, hash: newDigest },
    ]);
    const targetDir = join(workspace, "connectors", connectorId);
    await installConnectorFromSource({
      sourceDir: oldSource,
      workspacePath: workspace,
      guard,
      supervisor,
    });
    expectTreeModes(targetDir, 0o700);

    const failingGuard: ConnectorHostGuard = {
      withSource: (source, producer) => guard.withSource(source, producer),
      queryOne: (sql, params) => guard.queryOne(sql, params),
      writeEvent: (event) => {
        if (event.type === "connector.updated") throw new Error("injected audit failure");
        return guard.writeEvent(event);
      },
    };
    await expect(updateConnectorFromSource({
      sourceDir: newSource,
      workspacePath: workspace,
      guard: failingGuard,
      supervisor,
    })).rejects.toThrow("injected audit failure");

    expect(await hashConnectorPackage(targetDir)).toBe(oldDigest);
    expectTreeModes(targetDir, 0o700);
    expect(supervisor.listInstalledConnectors()).toEqual([
      expect.objectContaining({ packageHash: oldDigest, packageTrust: "official" }),
    ]);
    expect(eventCount("connector.updated")).toBe(0);
    expect(connectorStagingEntries()).toEqual([]);
    expect(readdirSync(join(workspace, "connectors")).some((name) =>
      name.startsWith(".update-backup-"))).toBe(false);
  });

  test("trusted Source start fails before runner capability when its archive is missing", async () => {
    const connectorId = "missing-archive";
    const connectorDir = writePackage(
      join(workspace, "connectors", connectorId),
      connectorId,
      "missing-v1",
    );
    const digest = await hashConnectorPackage(connectorDir);
    const supervisor = createSupervisor([{ id: connectorId, hash: digest }]);
    await supervisor.registerDirectory(connectorDir);
    const source = supervisor.ensureSource({ connectorId });

    await expect(supervisor.run(source.id)).rejects.toThrow(
      `Connector package archive is missing: ${digest}`,
    );

    expect(archiveStore.requiredDigests).toEqual([digest]);
    expect(archiveStore.resolvedDigests).toEqual([]);
    expect(eventCount("provenance.observed")).toBe(0);
    expect(descriptorFiles()).toEqual([]);
  });

  test("Source runs from connectors/<id> and binds the freshly verified package digest", async () => {
    const connectorId = "fresh-package";
    const connectorDir = writePackage(
      join(workspace, "connectors", connectorId),
      connectorId,
      "registered-v1",
    );
    const registeredDigest = await hashConnectorPackage(connectorDir);

    // Register the first exact package, then change the active package before
    // opening the Source. Runtime admission must use a fresh package load.
    const futureDir = writePackage(
      join(workspace, "package-sources", `${connectorId}-v2`),
      connectorId,
      "runtime-v2",
    );
    const runtimeDigest = await hashConnectorPackage(futureDir);
    const supervisor = createSupervisor([
      { id: connectorId, hash: registeredDigest },
      { id: connectorId, hash: runtimeDigest },
    ]);
    await supervisor.registerDirectory(connectorDir);
    const source = supervisor.ensureSource({ connectorId });
    writePackage(connectorDir, connectorId, "runtime-v2");
    expect(await hashConnectorPackage(connectorDir)).toBe(runtimeDigest);
    await archiveStore.publish(connectorDir, runtimeDigest);

    await supervisor.run(source.id);

    expect(archiveStore.requiredDigests).toEqual([runtimeDigest]);
    expect(archiveStore.resolvedDigests).toEqual([]);

    const event = dataDb.prepare(
      "SELECT source, producer_ref, payload FROM events WHERE type = ?",
    ).get("provenance.observed") as {
      source: string;
      producer_ref: string;
      payload: string;
    };
    expect(event.source).toBe(`connector:${connectorId}`);
    expect(JSON.parse(event.payload)).toEqual({
      cwd: realpathSync(connectorDir),
      revision: "runtime-v2",
    });
    const descriptor = descriptorStore.resolve(event.producer_ref);
    expect(descriptor).toEqual({
      schemaVersion: 1,
      producer: {
        kind: "connector",
        connectorId,
        packageDigest: runtimeDigest,
      },
      system: TEST_SYSTEM_IDENTITY,
    });
    expect(runtimeDigest).not.toBe(registeredDigest);
    expect(supervisor.listInstalledConnectors()).toEqual([
      expect.objectContaining({ packageHash: runtimeDigest, packageTrust: "official" }),
    ]);
  });

  test("Connector removal preserves the immutable package archive", async () => {
    const connectorId = "remove-preserves-archive";
    const sourceDir = writePackage(
      join(workspace, "package-sources", `${connectorId}-v1`),
      connectorId,
      "remove-v1",
    );
    const digest = await hashConnectorPackage(sourceDir);
    const supervisor = createSupervisor([{ id: connectorId, hash: digest }]);
    const installed = await installConnectorFromSource({
      sourceDir,
      workspacePath: workspace,
      guard,
      supervisor,
    });
    const archivePath = archiveStore.real.archivePath(digest);
    expect(existsSync(archivePath)).toBe(true);

    await expect(removeConnectorFromWorkspace({
      workspacePath: workspace,
      connectorId,
      supervisor,
    })).resolves.toBe(true);

    expect(existsSync(installed.dir)).toBe(false);
    expect(existsSync(archivePath)).toBe(true);
    await expect(archiveStore.resolve(digest)).resolves.toMatchObject({ digest });
  });

  function createSupervisor(
    officialCatalog: Array<{ id: string; hash: string }> = [],
  ): ConnectorSupervisor {
    return new ConnectorSupervisor({
      systemDb,
      guard,
      workspacePath: workspace,
      systemIdentity: TEST_SYSTEM_IDENTITY,
      producerDescriptorStore: descriptorStore,
      packageArchiveStore: archiveStore,
      officialCatalog,
      platform: "darwin",
    });
  }

  function customApproval(connectorId: string): { approved_hash: string } | undefined {
    return systemDb.prepare(
      "SELECT approved_hash FROM connector_custom_approvals WHERE connector_id = ?",
    ).get(connectorId) as { approved_hash: string } | undefined;
  }

  function eventCount(type: string): number {
    const row = dataDb.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE type = ?",
    ).get(type) as { count: number };
    return row.count;
  }

  function connectorStagingEntries(): string[] {
    const connectorsDir = join(workspace, "connectors");
    if (!existsSync(connectorsDir)) return [];
    // Failed install/update cleanup is also observable through the absence of
    // hidden staging packages in the only activation directory.
    return readdirSync(connectorsDir).filter((name) =>
      /^\.(?:install|update)-staging-/.test(name));
  }

  function descriptorFiles(): string[] {
    const root = join(workspace, ".lamarck", "blobs", "producer");
    return existsSync(root) ? [root] : [];
  }
});

function writePackage(dir: string, connectorId: string, revision: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "connector.yaml"),
    `manifestVersion: 1
id: ${connectorId}
name: ${connectorId}
description: Connector provenance workflow fixture.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
  );
  writeFileSync(
    join(dir, "events.json"),
    `${JSON.stringify({
      catalogVersion: 1,
      eventTypes: {
        "provenance.observed": {
          description: "Records the active package directory for provenance tests.",
          payloadSchema: {
            type: "object",
            additionalProperties: false,
            required: ["cwd", "revision"],
            properties: {
              cwd: { type: "string" },
              revision: { type: "string" },
            },
          },
        },
      },
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "index.mjs"),
    `export default {
  async run({ guard }) {
    await guard.writeEvent({
      type: "provenance.observed",
      externalId: ${JSON.stringify(`observation-${revision}`)},
      startedAt: 1,
      payload: {
        cwd: process.cwd(),
        revision: ${JSON.stringify(revision)},
      },
    });
  },
};
`,
  );
  return dir;
}

function expectTreeModes(root: string, fileMode: number): void {
  expect(lstatSync(root).mode & 0o777).toBe(0o755);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      expectTreeModes(path, fileMode);
    } else if (entry.isFile()) {
      expect(lstatSync(path).mode & 0o777).toBe(fileMode);
    }
  }
}
