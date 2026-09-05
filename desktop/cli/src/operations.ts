export const CLI_PROTOCOL_VERSION = 1 as const;
// A schema change may contain 300 KiB of UTF-8 text. JSON escaping can expand
// each input byte up to six bytes, so V1 reserves a bounded 2 MiB frame.
export const CLI_MAX_CONTROL_BYTES = 2 * 1024 * 1024;
export const CLI_MAX_INLINE_BYTES = 20 * 1024 * 1024;
export const MANAGED_CLI_SOCKET_PATH = "/run/lamarck/cli.sock" as const;
export const MANAGED_APP_EDIT_ROOT = "/mnt/lamarck-apps" as const;

export const CLI_OPERATIONS = [
  "query",
  "schema.change",
  "file.command",
  "file.import",
  "file.export",
  "source.list",
  "source.inspect",
  "source.run",
  "source.run.status",
  "source.pause",
  "source.resume",
  "connector.list",
  "connector.inspect",
  "connector.install",
  "connector.update",
  "connector.remove",
  "app.list",
  "app.inspect",
  "app.create",
  "app.save",
  "app.versions",
  "app.restore",
  "app.refresh",
  "app.archive",
] as const;

export type CliOperation = typeof CLI_OPERATIONS[number];
export type CliEnvironment = "host" | "managed";
export const HOST_CLI_OPERATIONS: readonly CliOperation[] = Object.freeze(
  CLI_OPERATIONS.filter((operation) => operation !== "app.refresh"),
);
export const MANAGED_CLI_OPERATIONS: readonly CliOperation[] = Object.freeze(
  CLI_OPERATIONS.filter((operation) => operation !== "file.import" && operation !== "file.export"),
);
export type JsonObject = { readonly [key: string]: unknown };

export interface SourceSummary {
  readonly id: string;
  readonly name: string;
  readonly source: string | null;
  readonly identity: {
    readonly kind: "single" | "device" | "connector";
    readonly status: "unresolved" | "resolved" | "conflict" | "changed" | "error";
    readonly ownership: "here" | "other-device" | "device-unknown";
  };
  readonly connector: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly packageHash: string;
    readonly packageTrust: "official" | "custom" | "modified" | "untrusted";
  };
  readonly lifecycle: {
    readonly state: "active" | "paused";
    readonly pausedAt: number | null;
    readonly resumeAt: number | null;
  };
  readonly setup: {
    readonly status: "setup" | "ready";
    readonly pending: readonly ("identity" | "auth" | "requirements" | "config")[];
  };
  readonly supported: boolean;
  readonly execution: {
    readonly mode: "watch" | "poll" | "manual";
    readonly scheduleCron: string | null;
    readonly nextRunAt: number | null;
    readonly activity: "idle" | "running";
    readonly lastRun: null | {
      readonly outcome: "success" | "error" | "aborted";
      readonly startedAt: number;
      readonly endedAt: number;
    };
  };
}

export interface SourceShape extends SourceSummary {
  readonly outputs: {
    readonly declared: readonly {
      readonly type: string;
      readonly description: string;
      readonly payloadSchema: object | boolean;
    }[];
    readonly observed: readonly {
      readonly type: string;
      readonly firstObservedAt: number;
      readonly lastObservedAt: number;
    }[];
  };
}

export interface ConnectorSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mode: "watch" | "poll" | "manual";
  readonly identityKind: "single" | "device" | "connector";
  readonly supported: boolean;
  readonly trust: "official" | "custom" | "modified" | "untrusted";
  readonly packageHash: string;
  readonly releaseId: string | null;
  readonly updateAvailable: boolean;
  readonly sourceCount: number;
}

export interface ConnectorInspect extends ConnectorSummary {
  readonly manifest: {
    readonly runtime: object;
    readonly source: object;
    readonly platforms?: object;
    readonly auth?: object;
    readonly config?: object;
    readonly configPanels?: object;
  };
  readonly eventTypes: readonly {
    readonly type: string;
    readonly description: string;
    readonly payloadSchema: object | boolean;
  }[];
  readonly sources: readonly SourceSummary[];
}

export interface AppShape {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly createdFrom?: { readonly packageId: string; readonly releaseId: string };
  readonly workloads?: JsonObject;
  readonly permissions?: {
    readonly writes: {
      readonly files: readonly string[];
      readonly tables: readonly string[];
    };
  };
  readonly lifecycle: {
    readonly version: string | null;
    readonly hasUnrecordedChanges: boolean;
    readonly manifestHealth: "valid" | "invalid";
    readonly versionHealth: "healthy" | "unversioned" | "unavailable";
  };
  readonly runtime: { readonly running: boolean };
  readonly path: string;
}

export type AppSummary = Pick<AppShape, "id" | "name" | "description" | "lifecycle" | "runtime" | "path">;

export interface AppVersionRecord {
  readonly appId: string;
  readonly version: string;
  readonly parentVersion: string | null;
  readonly trigger: "save" | "activate" | "restore";
  readonly createdAt: number;
  readonly message?: string;
  readonly author?: string;
  readonly restoredFrom?: string;
}

export interface CliOperationInputMap {
  query: { readonly sql: string };
  "schema.change": { readonly ddl: string; readonly author?: string; readonly context?: string };
  "file.command": { readonly argv: readonly string[]; readonly author?: string; readonly stdinBase64?: string };
  "file.import": { readonly argv: readonly string[]; readonly author?: string };
  "file.export": { readonly argv: readonly string[] };
  "source.list": Record<string, never>;
  "source.inspect": { readonly sourceId: string };
  "source.run": { readonly sourceId: string };
  "source.run.status": { readonly sourceId: string; readonly runId: string };
  "source.pause": { readonly sourceId: string };
  "source.resume": { readonly sourceId: string };
  "connector.list": Record<string, never>;
  "connector.inspect": { readonly connectorId: string };
  "connector.install": { readonly packageId: string };
  "connector.update": { readonly connectorId: string };
  "connector.remove": { readonly connectorId: string };
  "app.list": Record<string, never>;
  "app.inspect": { readonly appId: string };
  "app.create": { readonly appId: string; readonly name: string; readonly description: string };
  "app.save": { readonly appId: string; readonly message?: string; readonly author?: string };
  "app.versions": { readonly appId: string };
  "app.restore": { readonly appId: string; readonly version: string; readonly message?: string; readonly author?: string };
  "app.refresh": { readonly appId: string };
  "app.archive": { readonly appId: string };
}

export interface FileCommandResult {
  readonly success: boolean;
  readonly exitCode: number;
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
}

export type SourceRunStatus =
  | { readonly sourceId: string; readonly runId: string; readonly status: "running"; readonly startedAt: number }
  | {
      readonly sourceId: string;
      readonly runId: string;
      readonly status: "success" | "error" | "aborted";
      readonly outcome: "success" | "error" | "aborted";
      readonly startedAt: number;
      readonly endedAt: number;
    };

export interface ConnectorMutationResult {
  readonly id: string;
  readonly releaseId: string;
  readonly packageHash: string;
  readonly changed: boolean;
}

export interface CliOperationResultMap {
  query: readonly unknown[];
  "schema.change": { readonly id: string; readonly status: "pending" };
  "file.command": FileCommandResult;
  "file.import": FileCommandResult;
  "file.export": FileCommandResult;
  "source.list": readonly SourceSummary[];
  "source.inspect": SourceShape;
  "source.run": { readonly sourceId: string; readonly runId: string; readonly status: "accepted" };
  "source.run.status": SourceRunStatus;
  "source.pause": { readonly sourceId: string; readonly lifecycle: "paused" };
  "source.resume": { readonly sourceId: string; readonly lifecycle: "active" };
  "connector.list": readonly ConnectorSummary[];
  "connector.inspect": ConnectorInspect;
  "connector.install": ConnectorMutationResult;
  "connector.update": ConnectorMutationResult;
  "connector.remove": { readonly id: string; readonly removed: true };
  "app.list": readonly AppSummary[];
  "app.inspect": AppShape;
  "app.create": { readonly id: string; readonly created: true };
  "app.save": { readonly version: string; readonly created: boolean };
  "app.versions": readonly AppVersionRecord[];
  "app.restore": { readonly version: string; readonly created: boolean };
  "app.refresh": { readonly id: string; readonly refreshed: true };
  "app.archive": { readonly id: string; readonly archived: true };
}

export type CliOperationInput<T extends CliOperation> = CliOperationInputMap[T];
export type CliOperationResult<T extends CliOperation> = CliOperationResultMap[T];

export interface CliHostCapabilities {
  readonly protocolVersion: 1;
  readonly environment: CliEnvironment;
  readonly supportedOperations: readonly CliOperation[];
}

export interface CliRequest<T extends CliOperation = CliOperation> {
  readonly requestId: string;
  readonly operation: T;
  readonly input: CliOperationInput<T>;
  readonly upload?: CliUpload;
}

export type CliUpload = {
  readonly kind: "app-package";
  readonly archiveDigest: string;
  readonly archiveBytes: number;
  readonly baseVersion: string | null;
  readonly basePackageDigest: string;
} | {
  readonly kind: "file-stdin";
  readonly bytes: number;
};

export interface CliByteStreams {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export type CliResponse<T extends CliOperation = CliOperation> =
  | {
      readonly requestId: string;
      readonly ok: true;
      readonly result: CliOperationResult<T>;
      /** Transport-private lengths for raw byte streams following the control frame. */
      readonly byteStreams?: CliByteStreams;
    }
  | { readonly requestId: string; readonly ok: false; readonly error: CliErrorValue };

export interface CliErrorValue { readonly code: string; readonly message: string }

export interface CliTransport {
  hello(): Promise<CliHostCapabilities>;
  execute<T extends CliOperation>(request: CliRequest<T>, uploadBytes?: Uint8Array): Promise<CliResponse<T>>;
  close?(): Promise<void> | void;
}
