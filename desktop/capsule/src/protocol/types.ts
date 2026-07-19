export const CAPSULE_PROTOCOL_VERSION = 1 as const;

export type GuestArchitecture = "arm64" | "x64";
export type WorkloadKind = "ui" | "service" | "job";
export type StreamKind =
  | "sdk"
  | "viewer"
  | "package-in"
  | "dependency-in"
  | "artifact-in"
  | "artifact-out"
  | "logs";
export type ImportedBlobKind = "package" | "dependency" | "artifact";
export type ImportedBlobFormat =
  | "capsule-tree-v1"
  | "npm-dependency-bundle-v1"
  | "erofs-v1";

export interface GuestHello {
  type: "guest.hello";
  protocolVersion: typeof CAPSULE_PROTOCOL_VERSION;
  bootId: string;
  imageDigest: string;
  supervisorVersion: string;
  architecture: GuestArchitecture;
  features: string[];
}

export interface HostInitialize {
  type: "host.initialize";
  protocolVersion: typeof CAPSULE_PROTOCOL_VERSION;
  sessionId: string;
  expectedImageDigest: string;
  maxControlFrameBytes: number;
}

export interface GuestReady {
  type: "guest.ready";
  protocolVersion: typeof CAPSULE_PROTOCOL_VERSION;
  bootId: string;
  sessionId: string;
}

export interface DataStreamPrelude {
  protocolVersion: typeof CAPSULE_PROTOCOL_VERSION;
  sessionId: string;
  ticket: string;
  kind: StreamKind;
}

export interface PingBody {
  nonce: number;
}

export interface AppPrepareBody {
  /** Stable, Host-derived SHA-256 App owner key; never selected by Guest code. */
  ownerKey: string;
  appHandle: string;
  artifactDigest: string;
  artifactBytes: number;
  artifactBlobHandle: string;
  mappedHostUid: number;
  mappedHostGid: number;
  scratchBytes?: number;
}

export interface AppStopBody {
  appHandle: string;
}

export interface WorkloadPrepareBody {
  appHandle: string;
  workloadHandle: string;
  workloadKind: WorkloadKind;
  argv: string[];
  cwd: string;
  environment: Record<string, string>;
  sdkTicket: string;
  logsTicket?: string;
  uiPort?: number;
}

export interface BlobImportPrepareBody {
  /** Stable owner used only for Guest storage attribution and retention. */
  ownerKey: string;
  blobHandle: string;
  blobKind: ImportedBlobKind;
  format: ImportedBlobFormat;
  digest: string;
  bytes: number;
  streamTicket: string;
}

export interface BlobImportReleaseBody {
  ownerKey: string;
  blobHandle: string;
  blobKind: ImportedBlobKind;
  digest: string;
  bytes: number;
}

export interface BlobExportPrepareBody {
  /** Stable owner of the Build output reference being exported. */
  ownerKey: string;
  buildHandle: string;
  blobHandle: string;
  digest: string;
  bytes: number;
  streamTicket: string;
}

export interface BuildPrepareBody {
  /** Stable owner shared with the imported package/dependency references. */
  ownerKey: string;
  appHandle: string;
  buildHandle: string;
  packageDigest: string;
  packageBytes: number;
  packageBlobHandle: string;
  /** Shared Host/Guest digest of the exact pre-network npm install inputs. */
  installDigest: string;
  dependencyDigest?: string;
  dependencyBytes?: number;
  dependencyBlobHandle?: string;
  /** Optional same-App sealed artifact whose node_modules may be reused. */
  baseArtifactDigest?: string;
  baseArtifactBytes?: number;
  baseArtifactBlobHandle?: string;
  /** Dependency-bundle provenance of the sealed base artifact. */
  baseDependencyDigest?: string;
  mappedHostUid: number;
  mappedHostGid: number;
  timeoutMs: number;
  resources: {
    memoryBytes: number;
    pids: number;
    cpuQuotaMicros: number;
  };
}

export interface BuildStartBody {
  appHandle: string;
  buildHandle: string;
}

export interface BuildCancelBody {
  appHandle: string;
  buildHandle: string;
  graceMs: number;
}

export interface BuildOutputReleaseBody {
  ownerKey: string;
  buildHandle: string;
  digest: string;
  bytes: number;
}

export interface ViewerAttachBody {
  appHandle: string;
  workloadHandle: string;
  viewerTicket: string;
}

export interface ViewerDetachBody {
  appHandle: string;
  workloadHandle: string;
}

export interface WorkloadStartBody {
  appHandle: string;
  workloadHandle: string;
}

export interface WorkloadStopBody {
  appHandle: string;
  workloadHandle: string;
  graceMs: number;
}

export type HostOperation =
  | "ping"
  | "blob.import.prepare"
  | "blob.import.release"
  | "blob.export.prepare"
  | "build.prepare"
  | "build.start"
  | "build.cancel"
  | "build.output.release"
  | "app.prepare"
  | "app.stop"
  | "workload.prepare"
  | "workload.start"
  | "workload.stop"
  | "viewer.attach"
  | "viewer.detach"
  | "vm.drain";

export type RequestFor<TOperation extends HostOperation, TBody> = {
  v: typeof CAPSULE_PROTOCOL_VERSION;
  sessionId: string;
  kind: "request";
  requestId: string;
  op: TOperation;
  body: TBody;
};

export type HostRequest =
  | RequestFor<"ping", PingBody>
  | RequestFor<"blob.import.prepare", BlobImportPrepareBody>
  | RequestFor<"blob.import.release", BlobImportReleaseBody>
  | RequestFor<"blob.export.prepare", BlobExportPrepareBody>
  | RequestFor<"build.prepare", BuildPrepareBody>
  | RequestFor<"build.start", BuildStartBody>
  | RequestFor<"build.cancel", BuildCancelBody>
  | RequestFor<"build.output.release", BuildOutputReleaseBody>
  | RequestFor<"app.prepare", AppPrepareBody>
  | RequestFor<"app.stop", AppStopBody>
  | RequestFor<"workload.prepare", WorkloadPrepareBody>
  | RequestFor<"workload.start", WorkloadStartBody>
  | RequestFor<"workload.stop", WorkloadStopBody>
  | RequestFor<"viewer.attach", ViewerAttachBody>
  | RequestFor<"viewer.detach", ViewerDetachBody>
  | RequestFor<"vm.drain", Record<string, never>>;

export type GuestEventType =
  | "blob.imported"
  | "blob.exported"
  | "blob.failed"
  | "build.progress"
  | "build.completed"
  | "build.failed"
  | "workload.started"
  | "workload.ready"
  | "workload.exited"
  | "workload.faulted"
  | "app.faulted"
  | "vm.faulted";

export interface GuestEvent {
  v: typeof CAPSULE_PROTOCOL_VERSION;
  sessionId: string;
  kind: "event";
  eventSeq: number;
  type: GuestEventType;
  body: JsonValue;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ControlResponse =
  | {
    v: typeof CAPSULE_PROTOCOL_VERSION;
    sessionId: string;
    kind: "response";
    requestId: string;
    ok: true;
    result: JsonValue;
  }
  | {
    v: typeof CAPSULE_PROTOCOL_VERSION;
    sessionId: string;
    kind: "response";
    requestId: string;
    ok: false;
    error: { code: string; message: string };
  };
