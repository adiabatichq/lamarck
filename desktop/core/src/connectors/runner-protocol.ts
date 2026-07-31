// runner-protocol — IPC message shapes between the host and the connector
// runner child process. All messages are JSON-serializable.
//
// The process boundary is a reliability boundary, not a sandbox: trust is
// verified by the host before any spawn, and all writes come back through the
// host-side capability broker where Guard injects source provenance.

import type {
  ConnectorHostContext,
  ConnectorConfigPatch,
  ConnectorRequirementContext,
  ConnectorRequirementStatus,
  ConnectorRuntimeAuthType,
} from "./types";

export type HostToRunnerMessage =
  | {
    type: "load";
    entryPath: string;
    contentHash: string;
    connectorId?: string;
    sourceIdentityKind?: "single" | "device" | "connector";
  }
  | { type: "check"; ids: string[]; ctx: ConnectorRequirementContext }
  | { type: "request"; id: string; ctx: ConnectorRequirementContext }
  | {
    type: "resolveSourceIdentity";
    config: unknown;
    configSet: boolean;
    authType: ConnectorRuntimeAuthType;
    providerOrigin?: string;
  }
  | {
    type: "run";
    config: unknown;
    // JSON cannot carry undefined; configSet=false means "config was absent"
    // so the child can preserve undefined semantics identical to in-process.
    configSet: boolean;
    host: ConnectorHostContext;
    authType: ConnectorRuntimeAuthType;
    providerOrigin?: string;
  }
  | {
    type: "configUi";
    panelId: string;
    config: unknown;
    configSet: boolean;
    host: ConnectorHostContext;
  }
  | { type: "abort" }
  | { type: "rpc-result"; id: number; ok: boolean; value?: unknown; error?: string };

export type RunnerToHostMessage =
  | { type: "hello" }
  | { type: "loaded"; requirementIds: string[] }
  | { type: "load-error"; message: string }
  | { type: "checked"; records: Record<string, ConnectorRequirementStatus | null> }
  | { type: "requested"; status: ConnectorRequirementStatus | null }
  | { type: "source-identity"; key: string; label?: string }
  | { type: "source-identity-error"; message: string }
  | { type: "config-ui-ready"; url: string }
  | { type: "config-ui-error"; message: string }
  | { type: "done" }
  | { type: "run-error"; message: string }
  | { type: "rpc"; id: number; method: RunnerRpcMethod; params?: unknown };

export type RunnerRpcMethod =
  | "writeEvent"
  | "writeEvents"
  | "writeTextBlob"
  | "stateGet"
  | "stateSet"
  | "authGetToken"
  | "warningSet"
  | "warningClear"
  | "configGet"
  | "configReplace"
  | "configPatch";

export type RunnerConfigPatch = ConnectorConfigPatch;
