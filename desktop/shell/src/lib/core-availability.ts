export type CoreStatus = "checking" | "connected" | "offline";

export interface CoreFailureState {
  status: "checking" | "offline";
  error: string | null;
}

export interface HostCoreRuntimeState {
  generation: number;
  phase: "starting" | "ready" | "failed";
  error: string | null;
}

export function coreResponseDisposition(
  before: HostCoreRuntimeState,
  after: HostCoreRuntimeState,
): "publish" | "retry" | "unavailable" {
  if (
    before.phase === "ready"
    && after.phase === "ready"
    && before.generation === after.generation
  ) return "publish";
  if (after.phase === "ready") return "retry";
  return "unavailable";
}

/**
 * A failed Core request is not itself proof that startup failed. The Shell is
 * created before Keychain access and Core startup, so the Host's explicit
 * runtime phase is authoritative. It also distinguishes startup from an HTTP
 * failure after Core was already ready.
 */
export async function resolveCoreRequestFailure(
  requestError: unknown,
  getRuntimeState?: () => Promise<HostCoreRuntimeState>,
): Promise<CoreFailureState> {
  if (getRuntimeState) {
    try {
      const runtime = await getRuntimeState();
      if (runtime.phase === "starting") {
        return { status: "checking", error: null };
      }
      if (runtime.phase === "failed" && runtime.error?.trim()) {
        return { status: "offline", error: runtime.error };
      }
    } catch {
      // If the Host cannot report its state, preserve the original request
      // failure instead of claiming startup is merely pending.
    }
  }

  return {
    status: "offline",
    error: errorMessage(requestError),
  };
}

export function emptyWorkspaceCopy(
  status: CoreStatus,
  hasApps: boolean,
): { eyebrow: string; title: string; detail: string } {
  if (status === "checking") {
    return {
      eyebrow: "System starting",
      title: "Preparing your workspace.",
      detail: "Unlocking local state and starting its services. Apps will appear when it is ready.",
    };
  }
  if (status === "offline") {
    return {
      eyebrow: "System unavailable",
      title: "The workspace is offline.",
      detail: "Use System to inspect the workspace and retry its runtime.",
    };
  }
  if (hasApps) {
    return {
      eyebrow: "Quiet canvas",
      title: "Open an app.",
      detail: "Choose an interface when you need it. The workspace stays out of the way otherwise.",
    };
  }
  return {
    eyebrow: "Quiet canvas",
    title: "Nothing needs to be here.",
    detail: "Apps with a UI will appear here when you build or install them.",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
