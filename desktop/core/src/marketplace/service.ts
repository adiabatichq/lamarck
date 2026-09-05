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
import { MarketplaceUnavailableError, resolveMarketplacePackage } from "./client";
import { downloadMarketplaceArtifact } from "./download";
import type {
  MarketplacePackageKind,
  MarketplaceResolvePayload,
  MarketplaceTrustRoot,
} from "./resolve";
import type { ConnectorHostGuard } from "../connectors/guard";

export type MarketplaceLifecycleAction =
  | "create"
  | "install"
  | "update"
  | "already-installed";

export type ConnectorMarketplaceErrorCode =
  | "CONNECTOR_ALREADY_INSTALLED"
  | "CONNECTOR_NOT_INSTALLED"
  | "CONNECTOR_NOT_MARKETPLACE_MANAGED"
  | "CONNECTOR_MODIFIED"
  | "CONNECTOR_UPDATE_INCOMPATIBLE"
  | "CONNECTOR_MARKETPLACE_UNAVAILABLE"
  | "CONNECTOR_VERIFICATION_FAILED";

export class ConnectorMarketplaceError extends Error {
  constructor(
    readonly code: ConnectorMarketplaceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectorMarketplaceError";
  }
}

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

interface ConnectorLocalState {
  readonly hash: string;
  readonly trust: "official" | "custom" | "modified" | "untrusted";
  readonly marketplaceManaged: boolean;
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
  connectorState(packageId: string): Promise<ConnectorLocalState | undefined>;
  recordOfficialConnectorRelease(packageId: string, contentHash: string): void;
  recordConnectorInstallation(packageId: string, contentHash: string, releaseId: string): void;
  installConnector(verifiedSourceDir: string, packageId: string, guard?: ConnectorHostGuard): Promise<void>;
  updateConnector(verifiedSourceDir: string, packageId: string, guard?: ConnectorHostGuard): Promise<{ updated: boolean }>;
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
  readonly expectedAction?: "install" | "update";
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

  /** Resolve signed release metadata without downloading the package artifact. */
  async resolveConnectorRelease(packageId: string): Promise<MarketplaceResolvePayload> {
    if (!SCOPED_PACKAGE_ID_PATTERN.test(packageId)) {
      throw new Error("Marketplace package identity is invalid");
    }
    return resolveMarketplacePackage({
      apiOrigin: this.options.apiOrigin,
      kind: "connector",
      packageId,
      trustRoots: this.options.trustRoots,
      fetchImpl: this.options.fetchImpl,
    });
  }

  async prepare(
    kind: MarketplacePackageKind,
    packageId: string,
    expectedAction?: "install" | "update",
  ): Promise<MarketplacePreparedPackage> {
    if (
      (kind !== "app" && kind !== "connector")
      || !SCOPED_PACKAGE_ID_PATTERN.test(packageId)
    ) {
      throw new Error("Marketplace package identity is invalid");
    }
    if (kind === "app" && expectedAction !== undefined) {
      throw new Error("Marketplace App prepare does not accept a Connector action");
    }
    // Strict verbs are local preconditions. Do not contact Marketplace when
    // the installed state already determines that the command is invalid.
    if (kind === "connector" && expectedAction !== undefined) {
      await this.assertExpectedConnectorAction(packageId, expectedAction);
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
      let resolution: MarketplaceResolvePayload;
      try {
        resolution = await resolveMarketplacePackage({
          apiOrigin: this.options.apiOrigin,
          kind,
          packageId,
          trustRoots: this.options.trustRoots,
          fetchImpl: this.options.fetchImpl,
        });
      } catch (error) {
        if (kind !== "connector") throw error;
        throw error instanceof MarketplaceUnavailableError
          ? new ConnectorMarketplaceError(
              "CONNECTOR_MARKETPLACE_UNAVAILABLE",
              "Marketplace is unavailable; retry the Connector command when it is reachable.",
              { cause: error },
            )
          : new ConnectorMarketplaceError(
              "CONNECTOR_VERIFICATION_FAILED",
              "Marketplace release verification failed; retry the Connector command with a valid Official release.",
              { cause: error instanceof Error ? error : undefined },
            );
      }
      try {
        await downloadMarketplaceArtifact({
          artifactPath: resolution.artifactPath,
          artifactBytes: resolution.artifactBytes,
          destinationPath: archivePath,
          fetchImpl: this.options.fetchImpl,
        });
      } catch (error) {
        if (kind !== "connector") throw error;
        throw new ConnectorMarketplaceError(
          "CONNECTOR_MARKETPLACE_UNAVAILABLE",
          "Marketplace release download failed; retry the Connector command when Marketplace is reachable.",
          { cause: error instanceof Error ? error : undefined },
        );
      }
      let artifact;
      try {
        const archiveBytes = await readFile(archivePath);
        if (archiveBytes.byteLength !== resolution.artifactBytes) {
          throw new Error("Marketplace staged artifact size changed before verification");
        }
        artifact = verifyMarketplaceArtifact({
          kind,
          packageId,
          contentHash: resolution.contentHash,
          archiveBytes,
        });
        await extractVerifiedMarketplaceArtifact(artifact, extractedPath);
      } catch (error) {
        if (kind !== "connector") throw error;
        throw new ConnectorMarketplaceError(
          "CONNECTOR_VERIFICATION_FAILED",
          "Marketplace release verification failed; retry the Connector command with a valid Official release.",
          { cause: error instanceof Error ? error : undefined },
        );
      }
      await rm(archivePath, { force: true });

      const deriveDisposition = async () => {
        let disposition;
        if (kind === "connector" && expectedAction !== undefined) {
          const state = await this.assertExpectedConnectorAction(packageId, expectedAction);
          disposition = connectorDisposition(state?.hash, resolution.contentHash);
          if (expectedAction === "install" && disposition.action !== "install") {
            throw alreadyInstalled(packageId);
          }
          if (expectedAction === "update"
            && disposition.action !== "update"
            && disposition.action !== "already-installed") {
            throw notInstalled(packageId);
          }
        } else {
          disposition = await this.disposition(kind, packageId, resolution.contentHash);
        }
        return disposition;
      };
      const {
        action,
        localIdConflict,
        connectorHashAtPrepare,
      } = await deriveDisposition();
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
        ...(expectedAction === undefined ? {} : { expectedAction }),
        applying: false,
      });
      return prepared;
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async apply(
    stageId: string,
    localId?: string,
    guard?: ConnectorHostGuard,
  ): Promise<MarketplaceAppliedPackage> {
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

      {
        if (localId !== undefined) {
          throw new Error("Connector Marketplace apply does not accept a local App ID");
        }

        let expectedState: ConnectorLocalState | undefined;
        if (stage.expectedAction !== undefined) {
          expectedState = await this.assertExpectedConnectorAction(
            stage.prepared.packageId,
            stage.expectedAction,
          );
        }
        const current = stage.expectedAction === undefined
          ? await this.options.lifecycle.connectorHash(stage.prepared.packageId)
          : expectedState?.hash;
        if ((current ?? null) !== stage.connectorHashAtPrepare) {
          throw stateChanged(stage.prepared.packageId, stage.expectedAction);
        }
        const action: MarketplaceLifecycleAction = current === stage.prepared.contentHash
          ? "already-installed"
          : current === undefined
            ? "install"
            : "update";
        if (action !== stage.prepared.action) {
          throw stateChanged(stage.prepared.packageId, stage.expectedAction);
        }
        if (stage.expectedAction !== undefined) {
          if (stage.expectedAction === "install" && action !== "install") {
            throw alreadyInstalled(stage.prepared.packageId);
          }
          if (stage.expectedAction === "update" && action !== "update" && action !== "already-installed") {
            throw notInstalled(stage.prepared.packageId);
          }
        }
        if (action === "already-installed") {
          // The bytes may have arrived through a local/custom path and still be
          // untrusted. Confirmation of the signed Official release grants only
          // this exact logical hash; it does not rewrite or reinstall the tree.
          this.options.lifecycle.recordOfficialConnectorRelease(
            stage.prepared.packageId,
            stage.prepared.contentHash,
          );
          this.options.lifecycle.recordConnectorInstallation(
            stage.prepared.packageId,
            stage.prepared.contentHash,
            stage.prepared.releaseId,
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
          await this.options.lifecycle.installConnector(stage.extractedPath, stage.prepared.packageId, guard);
        } else {
          const result = await this.options.lifecycle.updateConnector(
            stage.extractedPath,
            stage.prepared.packageId,
            guard,
          );
          if (!result.updated) {
            throw new ConnectorMarketplaceError(
              "CONNECTOR_UPDATE_INCOMPATIBLE",
              `Connector ${stage.prepared.packageId} could not install the confirmed release; inspect it before retrying connector update.`,
            );
          }
        }
        this.options.lifecycle.recordConnectorInstallation(
          stage.prepared.packageId,
          stage.prepared.contentHash,
          stage.prepared.releaseId,
        );
        return Object.freeze({
          ok: true,
          kind: "connector",
          id: stage.prepared.packageId,
          disposition: action,
        });
      }
    } finally {
      this.stages.delete(stageId);
      await rm(stage.root, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async assertExpectedConnectorAction(
    packageId: string,
    expectedAction: "install" | "update",
  ): Promise<ConnectorLocalState | undefined> {
    const state = await this.options.lifecycle.connectorState(packageId);
    if (expectedAction === "install") {
      if (state) throw alreadyInstalled(packageId);
      return undefined;
    }
    if (!state) throw notInstalled(packageId);
    if (state.trust === "modified") {
      throw new ConnectorMarketplaceError(
        "CONNECTOR_MODIFIED",
        `Connector ${packageId} has local package modifications; restore the installed package before running connector update.`,
      );
    }
    if (state.trust !== "official" || !state.marketplaceManaged) {
      throw new ConnectorMarketplaceError(
        "CONNECTOR_NOT_MARKETPLACE_MANAGED",
        `Connector ${packageId} is not Marketplace-managed; install the Official Connector before running connector update.`,
      );
    }
    return state;
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
    return connectorDisposition(installedHash, contentHash);
  }
}

function connectorDisposition(
  installedHash: string | undefined,
  contentHash: string,
): {
  action: MarketplaceLifecycleAction;
  localIdConflict: false;
  connectorHashAtPrepare: string | null;
} {
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

function alreadyInstalled(packageId: string): ConnectorMarketplaceError {
  return new ConnectorMarketplaceError(
    "CONNECTOR_ALREADY_INSTALLED",
    `Connector ${packageId} is already installed; use lamarck connector update ${packageId}.`,
  );
}

function notInstalled(packageId: string): ConnectorMarketplaceError {
  return new ConnectorMarketplaceError(
    "CONNECTOR_NOT_INSTALLED",
    `Connector ${packageId} is not installed; use lamarck connector install ${packageId}.`,
  );
}

function stateChanged(
  packageId: string,
  expectedAction?: "install" | "update",
): ConnectorMarketplaceError {
  return new ConnectorMarketplaceError(
    "CONNECTOR_UPDATE_INCOMPATIBLE",
    `Connector ${packageId} changed after confirmation; inspect it and rerun connector ${expectedAction ?? "update"}.`,
  );
}
