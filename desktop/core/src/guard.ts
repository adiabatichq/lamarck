// Public Guard facade.
//
// The authorization boundary lives in the Node 24 utility service under
// guard-service/. Core callers only receive this async RPC capability; no
// production module in Core owns or accepts a data.db handle.

export {
  GuardRpcClient,
  RemoteGuard,
  RemoteGuard as Guard,
} from "./remote-guard";

export type {
  GuardBinding,
  GuardStatement,
  GuardStatementResult,
  SchemaPlan,
  SchemaSnapshot,
} from "./remote-guard";
export type { EventInput } from "./guard-types";
