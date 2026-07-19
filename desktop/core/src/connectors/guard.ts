import type { EventInput } from "../guard-types";
import type { GuardSqlParams } from "../guard-service/protocol";
import type { BoundConnectorGuard, ConnectorEventInput } from "./types";
import { validateConnectorId, validateIntegrationKey } from "./manifest";
import { validateConnectorEvent } from "./runtime";

export function sourceForConnector(connectorId: string, integrationKey?: string): string {
  validateConnectorId(connectorId);
  if (integrationKey !== undefined) {
    validateIntegrationKey(integrationKey);
  }
  return `connector:${connectorId}${integrationKey ? `:${integrationKey}` : ""}`;
}

export function createBoundConnectorGuard(
  rootGuard: ConnectorHostGuard,
  connectorId: string,
  integrationKey?: string,
): BoundConnectorGuard {
  const source = sourceForConnector(connectorId, integrationKey);
  const guard = rootGuard.withSource(source);
  return {
    async writeEvent(event: ConnectorEventInput): Promise<{ id: string }> {
      validateConnectorEvent(event);
      return { id: await writeConnectorEvent(rootGuard, guard, source, event) };
    },
    async writeEvents(events: ConnectorEventInput[]): Promise<{ ids: string[] }> {
      const ids: string[] = [];
      for (const event of events) {
        validateConnectorEvent(event);
        ids.push(await writeConnectorEvent(rootGuard, guard, source, event));
      }
      return { ids };
    },
  };
}

async function writeConnectorEvent(
  rootGuard: ConnectorHostGuard,
  guard: ConnectorHostGuard,
  source: string,
  event: ConnectorEventInput,
): Promise<string> {
  const existing = await findExistingConnectorEvent(rootGuard, source, event.externalId);
  if (existing) return existing;

  try {
    return await guard.writeEvent(event);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const duplicate = await findExistingConnectorEvent(rootGuard, source, event.externalId);
      if (duplicate) return duplicate;
    }
    throw err;
  }
}

async function findExistingConnectorEvent(
  rootGuard: ConnectorHostGuard,
  source: string,
  externalId: string,
): Promise<string | undefined> {
  const row = await rootGuard.queryOne(
    "SELECT id FROM events WHERE source = ? AND external_id = ?",
    [source, externalId],
  ) as { id?: unknown } | null;
  return row && typeof row.id === "string" ? row.id : undefined;
}

export interface ConnectorHostGuard {
  withSource(source: string): ConnectorHostGuard;
  queryOne(sql: string, params?: GuardSqlParams): unknown | null | Promise<unknown | null>;
  writeEvent(event: EventInput): string | Promise<string>;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  return message.includes("UNIQUE constraint failed") && message.includes("events.source");
}
