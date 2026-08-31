import type { Duplex } from "node:stream";
import type { AppManifestDigest } from "../../../capsule/src/app-manifest-authority";

export const CAPSULE_MAX_VIEWER_CONNECTIONS_PER_INSTANCE = 8;

export interface CapsuleUiSpec {
  appId: string;
  /** Exact Core activation authority which must match every launch input. */
  activationId: string;
  activationSequence: number;
  version: string;
  manifestDigest: AppManifestDigest;
  packageDigest: `sha256:${string}`;
  packageDir: string;
  command: string[];
  port: number;
  /** Host-private SystemBroker sender. It is never serialized into the Guest. */
  sdkSenderId: string;
}

export interface CapsuleUiInstance {
  instanceId: string;
}

/**
 * Host-private handle for a running candidate which has not changed the
 * last-known-good activation or retired a prior UI generation.
 */
export interface CapsuleUiPreparation extends CapsuleUiInstance {
  preparationId: string;
}

export interface CapsuleUiLostEvent {
  instanceId: string;
  appId: string;
  error: Error;
}

export interface CapsuleBackendStatus {
  available: boolean;
  backend: string;
  reason?: string;
  restartRequired?: boolean;
}

/**
 * A fail-closed Host state that cannot safely admit another Capsule until the
 * desktop process is restarted. This marker stays inside the trusted Host and
 * is serialized explicitly at the Shell IPC boundary.
 */
export class CapsuleRestartRequiredError extends Error {
  readonly code = "CAPSULE_RESTART_REQUIRED";
  readonly restartRequired = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CapsuleRestartRequiredError";
  }
}

/** The mutable package no longer matches the Core authority used for launch. */
export class CapsuleManifestAuthorityChangedError extends Error {
  readonly code = "CAPSULE_MANIFEST_AUTHORITY_CHANGED";

  constructor(message = "App manifest authority changed; refresh and retry") {
    super(message);
    this.name = "CapsuleManifestAuthorityChangedError";
  }
}

export function isCapsuleRestartRequiredError(value: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) return false;
    seen.add(candidate);
    if ((candidate as { restartRequired?: unknown }).restartRequired === true) return true;
    if (candidate instanceof AggregateError && candidate.errors.some(visit)) return true;
    return visit((candidate as { cause?: unknown }).cause);
  };
  return visit(value);
}

/** Platform backend beneath the backend-neutral App Capsule contract. */
export interface CapsuleBackend {
  /**
   * Registers the control-plane owner that must revoke every live App channel
   * when the backend loses its VM/Guest containment boundary asynchronously.
   */
  setBoundaryLostHandler?(handler: (error: unknown) => void): void;
  /** Reports an authenticated, unexpected terminal event for one active or prepared UI. */
  setUiLostHandler?(handler: (event: CapsuleUiLostEvent) => void): void;
  status(): Promise<CapsuleBackendStatus>;
  /**
   * Builds and starts a streamable candidate without changing activation.
   * When previousInstanceId is present, commit atomically replaces that exact
   * active generation; abort leaves it untouched.
   */
  prepareUi(
    spec: CapsuleUiSpec,
    previousInstanceId?: string,
  ): Promise<CapsuleUiPreparation>;
  /** Commits exactly one prepared candidate. Commit and abort are mutually exclusive. */
  commitPreparedUi(preparationId: string): Promise<CapsuleUiInstance>;
  /** Discards exactly one prepared candidate without changing activation. */
  abortPreparedUi(preparationId: string): Promise<void>;
  /** Compatibility wrapper which prepares and immediately commits a new UI. */
  startUi(spec: CapsuleUiSpec): Promise<CapsuleUiInstance>;
  /** Compatibility wrapper which prepares and immediately commits a replacement. */
  replaceUi(instanceId: string, spec: CapsuleUiSpec): Promise<CapsuleUiInstance>;
  /** Opens one active or prepared instance-bound stream to the declared Guest UI port. */
  openUiStream(instanceId: string): Promise<Duplex>;
  stopUi(instanceId: string): Promise<void>;
  stopApp(appId: string): Promise<void>;
  /**
   * Authoritatively stops an App and removes only its reconstructable Capsule
   * state. Workspace source and Personal System data are outside this API.
   */
  retireApp(appId: string): Promise<void>;
  stopAll(): Promise<void>;
}

/**
 * Honest bootstrap backend used until a verified Guest image is packaged.
 * App commands must never fall back to execution on the Host.
 */
export class UnavailableCapsuleBackend implements CapsuleBackend {
  constructor(
    private readonly reason = "The verified Linux Capsule Guest image is not installed.",
  ) {}

  async status(): Promise<CapsuleBackendStatus> {
    return { available: false, backend: "unavailable", reason: this.reason };
  }

  async prepareUi(
    _spec: CapsuleUiSpec,
    _previousInstanceId?: string,
  ): Promise<CapsuleUiPreparation> {
    throw new Error(`App Capsule unavailable: ${this.reason}`);
  }

  async commitPreparedUi(_preparationId: string): Promise<CapsuleUiInstance> {
    throw new Error(`App Capsule unavailable: ${this.reason}`);
  }

  async abortPreparedUi(_preparationId: string): Promise<void> {}

  async startUi(_spec: CapsuleUiSpec): Promise<CapsuleUiInstance> {
    throw new Error(`App Capsule unavailable: ${this.reason}`);
  }

  async replaceUi(_instanceId: string, _spec: CapsuleUiSpec): Promise<CapsuleUiInstance> {
    throw new Error(`App Capsule unavailable: ${this.reason}`);
  }

  async openUiStream(_instanceId: string): Promise<Duplex> {
    throw new Error(`App Capsule unavailable: ${this.reason}`);
  }

  async stopUi(_instanceId: string): Promise<void> {}

  async stopApp(_appId: string): Promise<void> {}

  async retireApp(_appId: string): Promise<void> {}

  async stopAll(): Promise<void> {}
}
