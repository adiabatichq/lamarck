export type AppLifecycleErrorCode =
  | "APP_NOT_FOUND"
  | "APP_PACKAGE_INVALID"
  | "APP_VERSION_AMBIGUOUS"
  | "APP_VERSION_CONFLICT"
  | "APP_VERSION_HISTORY_UNAVAILABLE"
  | "APP_COMMAND_UNSUPPORTED";

export class AppLifecycleError extends Error {
  constructor(
    readonly code: AppLifecycleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppLifecycleError";
  }
}

export class AppVersionHistoryUnavailableError extends AppLifecycleError {
  constructor(options?: ErrorOptions) {
    super(
      "APP_VERSION_HISTORY_UNAVAILABLE",
      "App version history is unavailable",
      options,
    );
    this.name = "AppVersionHistoryUnavailableError";
  }
}
