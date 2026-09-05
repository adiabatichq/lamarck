import type {
  AppShape,
  AppSummary,
  ConnectorInspect,
  ConnectorSummary,
  SourceShape,
  SourceSummary,
} from "@lamarck/cli";
import type { AppInventoryItemV1 } from "./apps/lifecycle";
import type {
  ConnectorEventCatalog,
  ConnectorManifest,
  ConnectorOwnership,
  ConnectorPackageTrustStatus,
  ConnectorRunRecord,
  ConnectorSource,
  ConnectorSourceIdentityKind,
} from "./connectors";

export interface SourceProjectionInput extends ConnectorSource {
  readonly name: string;
  readonly connectorName: string;
  readonly description?: string;
  readonly mode: string;
  readonly identityKind: ConnectorSourceIdentityKind;
  readonly ownership: ConnectorOwnership;
  readonly source: string | null;
  readonly running: boolean;
  readonly supported: boolean;
  readonly packageTrust: ConnectorPackageTrustStatus;
  readonly setupPending: readonly ("identity" | "auth" | "requirements" | "config")[];
  readonly recentRuns: readonly ConnectorRunRecord[];
}

export interface ObservedOutput {
  readonly type: string;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
}

export function projectSourceSummary(value: SourceProjectionInput): SourceSummary {
  if (!value.packageHash || !isPublicTrust(value.packageTrust) || !isMode(value.mode)) {
    throw new Error(`Source ${value.id} has no admitted Connector package`);
  }
  const last = value.recentRuns.find((run) => run.status !== "running");
  return Object.freeze({
    id: value.id,
    name: value.name,
    source: value.source,
    identity: Object.freeze({
      kind: value.identityKind,
      status: value.identityStatus,
      ownership: value.ownership,
    }),
    connector: Object.freeze({
      id: value.connectorId,
      name: value.connectorName,
      description: value.description ?? "",
      packageHash: value.packageHash,
      packageTrust: value.packageTrust,
    }),
    lifecycle: Object.freeze({
      state: value.pausedAt === undefined ? "active" as const : "paused" as const,
      pausedAt: value.pausedAt ?? null,
      resumeAt: value.pausedAt === undefined ? null : value.resumeAt ?? null,
    }),
    setup: Object.freeze({ status: value.setupStatus, pending: Object.freeze([...value.setupPending]) }),
    supported: value.supported,
    execution: Object.freeze({
      mode: value.mode,
      scheduleCron: value.scheduleCron ?? null,
      nextRunAt: value.nextRunAt ?? null,
      activity: value.running ? "running" as const : "idle" as const,
      lastRun: last?.endedAt === undefined ? null : Object.freeze({
        outcome: last.status as "success" | "error" | "aborted",
        startedAt: last.startedAt,
        endedAt: last.endedAt,
      }),
    }),
  });
}

export function projectSourceShape(
  value: SourceProjectionInput,
  catalog: ConnectorEventCatalog,
  observed: readonly ObservedOutput[],
): SourceShape {
  return Object.freeze({
    ...projectSourceSummary(value),
    outputs: Object.freeze({
      declared: Object.freeze(Object.entries(catalog.eventTypes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, definition]) => Object.freeze({
          type,
          description: definition.description,
          payloadSchema: definition.payloadSchema,
        }))),
      observed: Object.freeze([...observed]
        .sort((left, right) => left.type.localeCompare(right.type))
        .map((output) => Object.freeze({ ...output }))),
    }),
  });
}

export function projectConnectorSummary(value: {
  readonly connectorId: string;
  readonly name: string;
  readonly description: string;
  readonly mode: "watch" | "poll" | "manual";
  readonly identityKind: ConnectorSourceIdentityKind;
  readonly supported: boolean;
  readonly packageTrust: ConnectorPackageTrustStatus;
  readonly packageHash?: string;
}, context: {
  readonly releaseId: string | null;
  readonly updateAvailable: boolean;
  readonly sourceCount: number;
}): ConnectorSummary {
  if (!value.packageHash || !isPublicTrust(value.packageTrust)) {
    throw new Error(`Connector ${value.connectorId} has no admitted package`);
  }
  return Object.freeze({
    id: value.connectorId,
    name: value.name,
    description: value.description,
    mode: value.mode,
    identityKind: value.identityKind,
    supported: value.supported,
    trust: value.packageTrust,
    packageHash: value.packageHash,
    releaseId: value.packageTrust === "official" ? context.releaseId : null,
    updateAvailable: context.updateAvailable,
    sourceCount: context.sourceCount,
  });
}

export function projectConnectorInspect(
  summary: ConnectorSummary,
  manifest: ConnectorManifest,
  eventCatalog: ConnectorEventCatalog,
  sources: readonly SourceSummary[],
): ConnectorInspect {
  return Object.freeze({
    ...summary,
    manifest: Object.freeze({
      runtime: manifest.runtime,
      source: manifest.source,
      ...(manifest.platforms === undefined ? {} : { platforms: manifest.platforms }),
      ...(manifest.auth === undefined ? {} : { auth: manifest.auth }),
      ...(manifest.config === undefined ? {} : { config: manifest.config }),
      ...(manifest.configPanels === undefined ? {} : { configPanels: manifest.configPanels }),
    }),
    eventTypes: Object.freeze(Object.entries(eventCatalog.eventTypes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, definition]) => Object.freeze({ type, ...definition }))),
    sources: Object.freeze([...sources]),
  });
}

export function projectAppShape(
  value: AppInventoryItemV1,
  running: boolean,
  path: string,
): AppShape {
  const manifestUsable = value.manifestHealth.status === "valid"
    || (value.version !== null && value.versionHealth.status === "healthy");
  return Object.freeze({
    id: value.id,
    ...(manifestUsable ? {
      name: value.name,
      description: value.description,
      ...(value.createdFrom === undefined ? {} : { createdFrom: value.createdFrom }),
      ...(value.runtime === undefined ? {} : { workloads: value.runtime }),
      ...(value.permissions === undefined ? {} : {
        permissions: {
          writes: {
            files: Object.freeze([...new Set([`apps/${value.id}/`, ...value.permissions.writes.files])]),
            tables: Object.freeze([...value.permissions.writes.tables]),
          },
        },
      }),
    } : {}),
    lifecycle: Object.freeze({
      version: value.version,
      hasUnrecordedChanges: value.packageDirty,
      manifestHealth: value.manifestHealth.status,
      versionHealth: value.versionHealth.status,
    }),
    runtime: Object.freeze({ running }),
    path,
  });
}

export function projectAppSummary(shape: AppShape): AppSummary {
  return Object.freeze({
    id: shape.id,
    ...(shape.name === undefined ? {} : { name: shape.name }),
    ...(shape.description === undefined ? {} : { description: shape.description }),
    lifecycle: shape.lifecycle,
    runtime: shape.runtime,
    path: shape.path,
  });
}

function isMode(value: string): value is "watch" | "poll" | "manual" {
  return value === "watch" || value === "poll" || value === "manual";
}

function isPublicTrust(value: ConnectorPackageTrustStatus): value is "official" | "custom" | "modified" | "untrusted" {
  return value === "official" || value === "custom" || value === "modified" || value === "untrusted";
}
