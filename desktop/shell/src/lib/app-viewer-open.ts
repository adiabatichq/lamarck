export interface ViewerOpenFailure {
  code?: string;
  message: string;
  restartRequired: boolean;
}

export const MAX_VIEWER_OPEN_ATTEMPTS = 4;

export function viewerOpenRetryDelay(
  failure: ViewerOpenFailure,
  attempt: number,
): number | null {
  if (failure.restartRequired || attempt >= MAX_VIEWER_OPEN_ATTEMPTS) return null;
  const busy = failure.code === "APP_VIEWER_BUSY"
    || (
      failure.code === undefined
      && /already has an active viewer|already has an active/i.test(failure.message)
    );
  return busy ? attempt * 140 : null;
}
