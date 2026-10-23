const STARTUP_MESSAGES = {
  DB_SCHEMA_MISMATCH: "This Workspace’s database structure is incompatible with this version of Lamarck.",
  DB_VERSION_TOO_NEW: "This Workspace’s database was opened by a newer, incompatible version of Lamarck.",
  DB_VERSION_INVALID: "This Workspace’s database version could not be read.",
  DB_MIGRATION_FAILED: "Lamarck could not initialize this Workspace’s database.",
  STARTUP_FAILED: "Lamarck could not start this Workspace. Try again or choose another Workspace.",
} as const;

type StartupFailureCode = keyof typeof STARTUP_MESSAGES;
export interface StartupFailureMessage {
  type: "startup-failed";
  code: StartupFailureCode;
  canResetSystemSettings?: true;
}

export function startupFailure(error: unknown, database?: "system.db"): StartupFailureMessage {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return {
    type: "startup-failed",
    code: typeof code === "string" && Object.hasOwn(STARTUP_MESSAGES, code)
      ? code as StartupFailureCode : "STARTUP_FAILED",
    ...(database === "system.db" && resettableDatabaseFailure(error) ? { canResetSystemSettings: true as const } : {}),
  };
}

function resettableDatabaseFailure(error: unknown): boolean {
  // Only structural failures or SQLite corruption qualify. Permission, lock,
  // disk, initialization bugs, and newer-version refusals must stay closed.
  for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
    const failure = error as { code?: unknown; errcode?: unknown; cause?: unknown };
    if (failure.code === "DB_VERSION_TOO_NEW") return false;
    if (failure.code === "DB_SCHEMA_MISMATCH" || failure.code === "DB_VERSION_INVALID") return true;
    if (failure.code === "ERR_SQLITE_ERROR" && typeof failure.errcode === "number"
      && [11, 26].includes(failure.errcode & 0xff)) return true; // SQLITE_CORRUPT / SQLITE_NOTADB
    error = failure.cause;
  }
  return false;
}

export function isStartupFailure(value: unknown): value is StartupFailureMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<StartupFailureMessage>;
  return message.type === "startup-failed" && typeof message.code === "string"
    && Object.hasOwn(STARTUP_MESSAGES, message.code);
}

export function startupFailureText(message: StartupFailureMessage): string {
  return STARTUP_MESSAGES[message.code];
}

/** Flush only an allowlisted code before the failed owner exits; never send stacks or credentials. */
export async function sendStartupFailure(error: unknown, database?: "system.db"): Promise<void> {
  if (!process.send || !process.connected) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    const finish = () => { clearTimeout(timer); resolve(); };
    try { process.send!(startupFailure(error, database), finish); } catch { finish(); }
  });
}
