import { validateSourceKey } from "./manifest";
import type { ConnectorSourceIdentityResult } from "./types";

export const CONNECTOR_SOURCE_LABEL_MAX_LENGTH = 128;
const IDENTITY_ERROR_MAX_LENGTH = 512;

export interface ValidatedConnectorSourceIdentity {
  key: string;
  label: string | null;
}

export function validateConnectorSourceIdentityResult(
  connectorId: string,
  value: ConnectorSourceIdentityResult,
  warn: (message: string) => void = (message) => console.warn(message),
): ValidatedConnectorSourceIdentity {
  if (!value || typeof value !== "object" || typeof value.key !== "string" || !value.key) {
    throw new Error(`Connector ${connectorId} returned an invalid source identity key`);
  }
  try {
    validateSourceKey(value.key);
  } catch {
    throw new Error(`Connector ${connectorId} returned an invalid source identity key`);
  }

  let label: string | null = null;
  if (value.label !== undefined) {
    if (typeof value.label !== "string") {
      warn(`Connector ${connectorId} returned a non-string source label; ignoring it`);
    } else {
      const candidate = value.label.trim();
      if (!candidate || candidate.length > CONNECTOR_SOURCE_LABEL_MAX_LENGTH) {
        warn(`Connector ${connectorId} returned an invalid source label; ignoring it`);
      } else {
        label = candidate;
      }
    }
  }
  return { key: value.key, label };
}

export function sanitizeSourceIdentityError(connectorId: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(access[_ -]?token|refresh[_ -]?token|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, IDENTITY_ERROR_MAX_LENGTH);
  return message
    ? `Connector ${connectorId} could not resolve Source identity: ${message}`
    : `Connector ${connectorId} could not resolve Source identity`;
}
