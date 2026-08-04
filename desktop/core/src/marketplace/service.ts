import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { SCOPED_PACKAGE_ID_PATTERN } from "../package-id";
import {
  extractVerifiedMarketplaceArtifact,
  verifyMarketplaceArtifact,
} from "./artifact";
import { resolveMarketplacePackage } from "./client";
import { downloadMarketplaceArtifact } from "./download";
import type {
  MarketplacePackageKind,
  MarketplaceTrustRoot,
} from "./resolve";

export type MarketplaceLifecycleAction =
  | "create"
  | "install"
  | "update"
  | "already-installed";

export interface MarketplacePreparedPackage {
  readonly stageId: string;
  readonly kind: MarketplacePackageKind;
  readonly packageId: string;
  readonly releaseId: string;
  readonly contentHash: string;
  readonly origin: "Official";
  readonly name: string;
  readonly description: string;
  readonly action: MarketplaceLifecycleAction;
  readonly localIdConflict: boolean;
}

export interface MarketplaceAppliedPackage {
  readonly ok: true;
  readonly kind: MarketplacePackageKind;
  readonly id: string;
  readonly disposition: MarketplaceLifecycleAction;
}

export interface MarketplaceLifecycleAdapters {
  appExists(localId: string): Promise<boolean>;
  instantiateApp(input: {
    verifiedSourceDir: string;
    packageId: string;
    releaseId: string;
    localId?: string;
  }): Promise<{ id: string }>;
  connectorHash(packageId: string): Promise<string | undefined>;
  recordOfficialConnectorRelease(packageId: string, contentHash: string): void;
  installConnector(verifiedSourceDir: string, packageId: string): Promise<void>;
  updateConnector(verifiedSourceDir: string, packageId: string): Promise<{ updated: boolean }>;
}

export interface MarketplaceServiceOptions {
  readonly workspacePath: string;
  readonly apiOrigin: string;
  readonly trustRoots: readonly MarketplaceTrustRoot[];
  readonly lifecycle: MarketplaceLifecycleAdapters;
  readonly fetchImpl?: typeof fetch;
}

interface MarketplaceStage {
  readonly stageId: string;
  readonly root: string;
  readonly extractedPath: string;
  readonly prepared: MarketplacePreparedPackage;
  readonly connectorHashAtPrepare: string | null;
  applying: boolean;
}

const MAX_ACTIVE_MARKETPLACE_STAGES = 16;

/** One narrow, in-memory coordinator for verified release confirmation. */
export class MarketplaceService {
  readonly stagingRoot: string;
  private readonly stages = new Map<string, MarketplaceStage>();

  private constructor(private readonly options: MarketplaceServiceOptions) {
    this.stagingRoot = join(options.workspacePath, ".lamarck", "marketplace", "staging");
  }

  static async initialize(options: MarketplaceServiceOptions): Promise<MarketplaceService> {
    const service = new MarketplaceService(options);
    // Stages contain no durable authority. A restart always returns to a clean
    // state and an immutable release can simply be resolved again.
    await rm(service.stagingRoot, { recursive: true, force: true });
    await mkdir(service.stagingRoot, { recursive: true, mode: 0o700 });
    await chmod(service.stagingRoot, 0o700);
    return service;
  }

  async prepare(kind: MarketplacePackageKind, packageId: string): Promise<MarketplacePreparedPackage> {
    if (
      (kind !== "app" && kind !== "connector")
      || !SCOPED_PACKAGE_ID_PATTERN.test(packageId)
    ) {
      throw new Error("Marketplace package identity is invalid");
    }
    if (this.stages.size >= MAX_ACTIVE_MARKETPLACE_STAGES) {
      throw new Error("Too many Marketplace packages are awaiting confirmation");
    }
    const stageId = randomUUID();
    const root = join(this.stagingRoot, stageId);
    const archivePath = join(root, "artifact.tar.gz");
    const extractedPath = join(root, "package");
    await mkdir(root, { recursive: false, mode: 0o700 });
    await chmod(root, 0o700);
    try {
      const resolution = await resolveMarketplacePackage({
        apiOrigin: this.options.apiOrigin,
        kind,
        packageId,
        trustRoots: this.options.trustRoots,
        fetchImpl: this.options.fetchImpl,
      });
      await downloadMarketplaceArtifact({
        artifactPath: resolution.artifactPath,
        artifactBytes: resolution.artifactBytes,
        destinationPath: archivePath,
        fetchImpl: this.options.fetchImpl,
      });
      const archiveBytes = await readFile(archivePath);
      if (archiveBytes.byteLength !== resolution.artifactBytes) {
        throw new Error("Marketplace staged artifact size changed before verification");
      }
      const artifact = verifyMarketplaceArtifact({
        kind,
        packageId,
        contentHash: resolution.contentHash,
        archiveBytes,
      });
      await extractVerifiedMarketplaceArtifact(artifact, extractedPath);
      await rm(archivePath, { force: true });

      const {
        action,
        localIdConflict,
        connectorHashAtPrepare,
      } = await this.disposition(kind, packageId, resolution.contentHash);
      const prepared: MarketplacePreparedPackage = Object.freeze({
        stageId,
        kind,
        packageId,
        releaseId: resolution.releaseId,
        contentHash: resolution.contentHash,
        origin: "Official",
        name: artifact.manifest.name,
        description: artifact.manifest.description,
        action,
        localIdConflict,
      });
      this.stages.set(stageId, {
        stageId,
        root,
        extractedPath,
        prepared,
        connectorHashAtPrepare,
        applying: false,
      });
      return prepared;
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async apply(stageId: string, localId?: string): Promise<MarketplaceAppliedPackage> {
    const stage = this.requireStage(stageId);
    if (stage.applying) throw new Error("Marketplace package is already being applied");
    stage.applying = true;
    try {
      if (stage.prepared.kind === "app") {
        const created = await this.options.lifecycle.instantiateApp({
          verifiedSourceDir: stage.extractedPath,
          packageId: stage.prepared.packageId,
          releaseId: stage.prepared.releaseId,
          ...(localId === undefined ? {} : { localId }),
        });
        return Object.freeze({
          ok: true,
          kind: "app",
          id: created.id,
          disposition: "create",
        });
      }

      if (localId !== undefined) {
        throw new Error("Connector Marketplace apply does not accept a local App ID");
      }

      const current = await this.options.lifecycle.connectorHash(stage.prepared.packageId);
      if ((current ?? null) !== stage.connectorHashAtPrepare) {
        throw new Error("Connector installation state changed; confirm the Marketplace package again");
      }
      const action: MarketplaceLifecycleAction = current === stage.prepared.contentHash
        ? "already-installed"
        : current === undefined
          ? "install"
          : "update";
      if (action !== stage.prepared.action) {
        throw new Error("Connector installation state changed; confirm the Marketplace package again");
      }
      if (action === "already-installed") {
        // The bytes may have arrived through a local/custom path and still be
        // untrusted. Confirmation of the signed Official release grants only
        // this exact logical hash; it does not rewrite or reinstall the tree.
        this.options.lifecycle.recordOfficialConnectorRelease(
          stage.prepared.packageId,
          stage.prepared.contentHash,
        );
        return Object.freeze({
          ok: true,
          kind: "connector",
          id: stage.prepared.packageId,
          disposition: action,
        });
      }
      this.options.lifecycle.recordOfficialConnectorRelease(
        stage.prepared.packageId,
        stage.prepared.contentHash,
      );
      if (action === "install") {
        await this.options.lifecycle.installConnector(stage.extractedPath, stage.prepared.packageId);
      } else {
        const result = await this.options.lifecycle.updateConnector(
          stage.extractedPath,
          stage.prepared.packageId,
        );
        if (!result.updated) {
          throw new Error("Connector update did not install the confirmed release");
        }
      }
      return Object.freeze({
        ok: true,
        kind: "connector",
        id: stage.prepared.packageId,
        disposition: action,
      });
    } finally {
      this.stages.delete(stageId);
      await rm(stage.root, { recursive: true, force: true }).catch(() => {});
    }
  }

  async cancel(stageId: string): Promise<void> {
    const stage = this.requireStage(stageId);
    if (stage.applying) throw new Error("Marketplace package is being applied");
    this.stages.delete(stageId);
    await rm(stage.root, { recursive: true, force: true });
  }

  private requireStage(stageId: string): MarketplaceStage {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(stageId)) {
      throw new Error("Marketplace stage ID is invalid");
    }
    const stage = this.stages.get(stageId);
    if (!stage) throw new Error("Marketplace stage is missing or expired");
    return stage;
  }

  private async disposition(
    kind: MarketplacePackageKind,
    packageId: string,
    contentHash: string,
  ): Promise<{
    action: MarketplaceLifecycleAction;
    localIdConflict: boolean;
    connectorHashAtPrepare: string | null;
  }> {
    if (kind === "app") {
      return {
        action: "create",
        localIdConflict: await this.options.lifecycle.appExists(packageId),
        connectorHashAtPrepare: null,
      };
    }
    const installedHash = await this.options.lifecycle.connectorHash(packageId);
    return {
      action: installedHash === contentHash
        ? "already-installed"
        : installedHash === undefined
          ? "install"
          : "update",
      localIdConflict: false,
      connectorHashAtPrepare: installedHash ?? null,
    };
  }
}
