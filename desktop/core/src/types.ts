// Shared types for @lamarck/core

export type {
  ContentBlobRef,
  JsonValue,
  MutationResult,
  ResolveContentRefResult,
  SqlBlob,
  SqlParam,
  SqlParams,
  SqlScalar,
  SqlStatement,
  System,
  TransactionStatementResult,
  WriteEventInput,
} from "@lamarck/system";
export type { RemoteGuard as Guard } from "./remote-guard";
export type { EventInput } from "./guard-types";
export type { AppManifest, LoadedApp, AppRegistry } from "./app-loader";
export type {
  BoundConnectorGuard,
  ConnectorAuthHandle,
  ConnectorAuthSpec,
  ConnectorDefinition,
  ConnectorEventInput,
  ConnectorIdentityStatus,
  ConnectorSource,
  ConnectorManifest,
  ConnectorOwnership,
  ConnectorOfficialCatalogEntry,
  ConnectorPackageRecord,
  ConnectorPackageTrust,
  ConnectorPackageTrustStatus,
  ConnectorPlatform,
  ConnectorPlatformsSpec,
  ConnectorPlatformSpec,
  ConnectorRunContext,
  ConnectorRunHandle,
  ConnectorRuntimeMode,
  ConnectorSourceIdentityKind,
  ConnectorSourceSpec,
  ConnectorSetupStatus,
  ConnectorStateHandle,
  ConnectorTrustStatus,
  InstalledConnector,
  InstallConnectorOptions,
  RegisterWorkspaceConnectorsOptions,
  UpdateSourceInput,
} from "./connectors";
