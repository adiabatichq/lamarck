const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 500;
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);

interface ViewerReadinessResponse {
  readonly status: number;
  readonly statusText?: string;
  readonly body: {
    cancel(reason?: unknown): Promise<void>;
  } | null;
}

export interface ViewerReadinessOptions {
  request(signal: AbortSignal): Promise<ViewerReadinessResponse>;
  assertCurrent?(): void;
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

/**
 * Proves that the App's HTTP server is ready through the same Host-owned
 * viewer route Chromium will use. TCP acceptance alone is insufficient:
 * development servers can bind their port before the document is available.
 */
export async function waitForViewerHttpReady(
  options: ViewerReadinessOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Viewer readiness timeout must be positive");
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
    throw new Error("Viewer readiness retry delay must be positive");
  }

  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let attempt = 0;
  let lastResult = "no response";

  while (true) {
    options.assertCurrent?.();
    const remainingBeforeRequest = timeoutMs - (now() - startedAt);
    if (remainingBeforeRequest <= 0) {
      throw readinessTimeout(timeoutMs, lastResult);
    }

    const controller = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const attemptDeadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        controller.abort();
        reject(new ViewerReadinessDeadlineError());
      }, remainingBeforeRequest);
    });
    let response: ViewerReadinessResponse | null = null;
    try {
      response = await Promise.race([
        options.request(controller.signal),
        attemptDeadline,
      ]);
      const result = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      lastResult = result;
      if (response.body) {
        // Keep the same absolute attempt deadline through response cleanup.
        // A fetch that returns headers but never releases its body must not
        // leave the Shell's "Preparing" state hanging forever.
        await Promise.race([
          response.body.cancel().catch(() => {}),
          attemptDeadline,
        ]);
      }
    } catch (error) {
      if (error instanceof ViewerReadinessDeadlineError) {
        throw readinessTimeout(timeoutMs, lastResult);
      }
      lastResult = error instanceof Error ? error.message : String(error);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }

    options.assertCurrent?.();
    if (response) {
      const result = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      if (response.status >= 200 && response.status <= 299) return;
      if (!TRANSIENT_STATUS_CODES.has(response.status)) {
        throw new Error(`App viewer readiness failed: ${result}`);
      }
      lastResult = result;
    }

    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) throw readinessTimeout(timeoutMs, lastResult);
    attempt += 1;
    const backoff = Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * attempt);
    await sleep(Math.min(backoff, remaining));
  }
}

class ViewerReadinessDeadlineError extends Error {}

function readinessTimeout(timeoutMs: number, lastResult: string): Error {
  return new Error(
    `App viewer did not become ready within ${timeoutMs}ms (last result: ${lastResult})`,
  );
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
import { performance } from "node:perf_hooks";
