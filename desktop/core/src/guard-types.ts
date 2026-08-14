import type { JsonValue } from "./json";

export interface EventInput {
  schemaVersion?: string;
  type: string;
  externalId?: string;
  startedAt: number;
  endedAt?: number;
  payload: JsonValue;
}

export type SchemaOp = "promote" | "demote";
