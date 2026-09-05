import type { CliErrorValue } from "./operations.js";

export type CliErrorCode =
  | "LAMARCK_NOT_RUNNING" | "CLI_HOST_INCOMPATIBLE" | "CLI_UNSUPPORTED_COMMAND" | "CLI_USAGE"
  | "SOURCE_NOT_FOUND" | "SOURCE_RUN_REJECTED" | "SOURCE_RUN_ERROR" | "SOURCE_RUN_ABORTED"
  | "CONNECTOR_NOT_FOUND" | "CONNECTOR_ALREADY_INSTALLED" | "CONNECTOR_NOT_INSTALLED"
  | "CONNECTOR_NOT_MARKETPLACE_MANAGED" | "CONNECTOR_MODIFIED" | "CONNECTOR_UPDATE_INCOMPATIBLE"
  | "CONNECTOR_MARKETPLACE_UNAVAILABLE" | "CONNECTOR_VERIFICATION_FAILED" | "CONFIRMATION_REQUIRED"
  | "APP_NOT_FOUND" | "APP_INVALID" | "APP_VERSION_CONFLICT" | "APP_VERSION_NOT_FOUND"
  | "APP_VERSION_AMBIGUOUS" | "APP_VERSION_HISTORY_UNAVAILABLE" | "SCHEMA_REQUEST_REJECTED"
  | "CLI_INTERNAL";

export class CliError extends Error {
  constructor(readonly code: CliErrorCode | string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
  }
  value(): CliErrorValue { return { code: this.code, message: this.message }; }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError("CLI_INTERNAL", "Lamarck could not complete the command.", {
    cause: error instanceof Error ? error : undefined,
  });
}

export function notRunning(): CliError {
  return new CliError("LAMARCK_NOT_RUNNING", "Lamarck is not running.");
}
