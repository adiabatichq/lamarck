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
}

export function startupFailure(error: unknown): StartupFailureMessage {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return {
    type: "startup-failed",
    code: typeof code === "string" && Object.hasOwn(STARTUP_MESSAGES, code)
      ? code as StartupFailureCode : "STARTUP_FAILED",
  };
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
export async function sendStartupFailure(error: unknown): Promise<void> {
  if (!process.send || !process.connected) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    const finish = () => { clearTimeout(timer); resolve(); };
    try { process.send!(startupFailure(error), finish); } catch { finish(); }
  });
}
