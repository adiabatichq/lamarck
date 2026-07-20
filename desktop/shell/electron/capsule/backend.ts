import type { Duplex } from "node:stream";

export const CAPSULE_MAX_VIEWER_CONNECTIONS_PER_INSTANCE = 8;

export interface CapsuleUiSpec {
  appId: string;
  packageDir: string;
  command: string[];
  port: number;
  /** Host-private SystemBroker sender. It is never serialized into the Guest. */
  sdkSenderId: string;
}

export interface CapsuleUiInstance {
  instanceId: string;
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
}

/** Platform backend beneath the backend-neutral App Capsule contract. */
export interface CapsuleBackend {
  /**
   * Registers the control-plane owner that must revoke every live App channel
   * when the backend loses its VM/Guest containment boundary asynchronously.
   */
  setBoundaryLostHandler?(handler: (error: unknown) => void): void;
  /** Reports an authenticated, unexpected terminal event for one live UI. */
  setUiLostHandler?(handler: (event: CapsuleUiLostEvent) => void): void;
  status(): Promise<CapsuleBackendStatus>;
  startUi(spec: CapsuleUiSpec): Promise<CapsuleUiInstance>;
  /** Builds and starts a replacement before retiring the current UI. */
  replaceUi(instanceId: string, spec: CapsuleUiSpec): Promise<CapsuleUiInstance>;
  /** Opens one instance-bound raw TCP stream to the declared Guest UI port. */
  openUiStream(instanceId: string): Promise<Duplex>;
  stopUi(instanceId: string): Promise<void>;
  stopApp(appId: string): Promise<void>;
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

  async stopAll(): Promise<void> {}
}
