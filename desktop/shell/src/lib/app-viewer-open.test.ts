import { describe, expect, test } from "vitest";
import { viewerOpenRetryDelay } from "./app-viewer-open";

describe("App viewer open retry", () => {
  test("retries a structured busy response within the bounded attempt budget", () => {
    const failure = {
      code: "APP_VIEWER_BUSY",
      message: 'App "hello-world" already has an active viewer',
      restartRequired: false,
    };

    expect(viewerOpenRetryDelay(failure, 1)).toBe(140);
    expect(viewerOpenRetryDelay(failure, 3)).toBe(420);
    expect(viewerOpenRetryDelay(failure, 4)).toBeNull();
  });

  test("does not retry terminal or ordinary launch failures", () => {
    expect(viewerOpenRetryDelay({
      code: "CAPSULE_RESTART_REQUIRED",
      message: "Capsule boundary was lost",
      restartRequired: true,
    }, 1)).toBeNull();
    expect(viewerOpenRetryDelay({
      code: "APP_VIEWER_OPEN_FAILED",
      message: "UI workload failed",
      restartRequired: false,
    }, 1)).toBeNull();
  });

  test("keeps compatibility with a legacy rejected IPC request", () => {
    expect(viewerOpenRetryDelay({
      message: 'App "hello-world" already has an active viewer',
      restartRequired: false,
    }, 1)).toBe(140);
  });
});
