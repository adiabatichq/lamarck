import type { CliErrorCode, CliResponse } from "@lamarck/cli";
import { AppLifecycleError } from "./apps/errors";

class CoreCliError extends Error {
  constructor(readonly code: CliErrorCode, message: string) { super(message); }
}

export function cliCoded(code: CliErrorCode, message: string): CoreCliError {
  return new CoreCliError(code, message);
}

export function cliFailure(requestId: string, error: unknown): CliResponse {
  if (error instanceof CoreCliError) {
    return { requestId, ok: false, error: { code: error.code, message: error.message } } as CliResponse;
  }
  if (error instanceof AppLifecycleError) {
    const code = error.code === "APP_PACKAGE_INVALID"
      ? "APP_INVALID"
      : error.code === "APP_COMMAND_UNSUPPORTED"
        ? "CLI_UNSUPPORTED_COMMAND"
        : error.code;
    return { requestId, ok: false, error: { code, message: error.message } } as CliResponse;
  }
  if (error instanceof Error && "code" in error) {
    const code = error.code === "GUARD_QUERY_REJECTED" ? "QUERY_REJECTED"
      : error.code === "GUARD_QUERY_INVALID" ? "QUERY_INVALID" : undefined;
    if (code) return { requestId, ok: false, error: { code, message: error.message } } as CliResponse;
  }
  return {
    requestId,
    ok: false,
    error: { code: "CLI_INTERNAL", message: "Lamarck could not complete the command." },
  } as CliResponse;
}
