import type {
  ConnectorDefinition,
  ConnectorEventInput,
  ConnectorRunContext,
} from "./types";
import { assertJsonValue } from "../json";

export interface ConnectorRuntimeOptions<TConfig, TState> {
  definition: ConnectorDefinition<TConfig, TState>;
  context: ConnectorRunContext<TConfig, TState>;
}

export class ConnectorRuntime<TConfig = unknown, TState = unknown> {
  constructor(private opts: ConnectorRuntimeOptions<TConfig, TState>) {}

  async run(): Promise<void> {
    await this.opts.definition.run(this.opts.context);
  }
}

export function validateConnectorDefinition(
  definition: ConnectorDefinition,
  identityKind?: "single" | "device" | "connector",
): void {
  if (!definition || typeof definition.run !== "function") {
    throw new Error("Connector module must export a run(context) function");
  }
  if (definition.configUi !== undefined && typeof definition.configUi !== "function") {
    throw new Error("Connector configUi export must be a function when provided");
  }
  if (
    definition.resolveSourceIdentity !== undefined
    && typeof definition.resolveSourceIdentity !== "function"
  ) {
    throw new Error("Connector resolveSourceIdentity export must be a function when provided");
  }
  if (identityKind === "connector" && !definition.resolveSourceIdentity) {
    throw new Error(
      "Connector source.identity=connector requires a resolveSourceIdentity(context) export",
    );
  }
  if (
    identityKind !== undefined
    && identityKind !== "connector"
    && definition.resolveSourceIdentity !== undefined
  ) {
    throw new Error(
      `Connector source.identity=${identityKind} forbids a resolveSourceIdentity export`,
    );
  }
  if (definition.requirements === undefined) return;
  if (
    definition.requirements === null
    || typeof definition.requirements !== "object"
    || Array.isArray(definition.requirements)
  ) {
    throw new Error("Connector requirements export must be an object keyed by requirement id");
  }
  for (const [id, handler] of Object.entries(definition.requirements)) {
    if (!handler || typeof handler.check !== "function") {
      throw new Error(`Connector requirement handler ${id} must provide a check(ctx) function`);
    }
    if (!handler.label || typeof handler.label !== "string") {
      throw new Error(`Connector requirement handler ${id} requires a label`);
    }
    if (handler.request !== undefined && typeof handler.request !== "function") {
      throw new Error(`Connector requirement handler ${id} request must be a function`);
    }
  }
}

export function validateConnectorEvent(event: ConnectorEventInput): void {
  if (!event.type || event.type.trim() !== event.type) {
    throw new Error("Connector event requires a type");
  }
  if (!event.externalId || event.externalId.trim() !== event.externalId) {
    throw new Error("Connector event requires an externalId");
  }
  if (!Number.isFinite(event.startedAt)) {
    throw new Error("Connector event requires a finite startedAt timestamp");
  }
  if (event.endedAt !== undefined && !Number.isFinite(event.endedAt)) {
    throw new Error("Connector event endedAt must be finite when provided");
  }
  assertJsonValue(event.payload, "Connector event payload");
}
