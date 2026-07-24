import { describe, expect, test, vi } from "vitest";
import { waitForViewerHttpReady } from "./viewer-readiness";

describe("App viewer HTTP readiness", () => {
  test("holds publication across transient gateway responses", async () => {
    const statuses = [503, 502, 200];
    let now = 0;
    const request = vi.fn(async () => new Response("", {
      status: statuses.shift() ?? 200,
    }));

    await waitForViewerHttpReady({
      request,
      timeoutMs: 1_000,
      retryDelayMs: 10,
      now: () => now,
      sleep: async (delayMs) => { now += delayMs; },
    });

    expect(request).toHaveBeenCalledTimes(3);
  });

  test("rejects a non-success response without retrying it", async () => {
    const request = vi.fn(async () => new Response("", { status: 404 }));

    await expect(waitForViewerHttpReady({ request }))
      .rejects.toThrow("App viewer readiness failed: HTTP 404");
    expect(request).toHaveBeenCalledOnce();
  });

  test("does not adopt an unverified redirect response", async () => {
    const request = vi.fn(async () => new Response("", {
      status: 302,
      statusText: "Found",
    }));

    await expect(waitForViewerHttpReady({ request }))
      .rejects.toThrow("App viewer readiness failed: HTTP 302 Found");
    expect(request).toHaveBeenCalledOnce();
  });

  test("fails with the last transient status after the bounded deadline", async () => {
    let now = 0;
    const request = vi.fn(async () => new Response("warming", {
      status: 503,
      statusText: "Service Unavailable",
    }));

    await expect(waitForViewerHttpReady({
      request,
      timeoutMs: 25,
      retryDelayMs: 10,
      now: () => now,
      sleep: async (delayMs) => { now += delayMs; },
    })).rejects.toThrow(
      "App viewer did not become ready within 25ms (last result: HTTP 503 Service Unavailable)",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("does not retry a stale viewer authority", async () => {
    let current = true;
    const request = vi.fn(async () => {
      current = false;
      return new Response("", { status: 503 });
    });

    await expect(waitForViewerHttpReady({
      request,
      assertCurrent: () => {
        if (!current) throw new Error("viewer authority changed");
      },
    })).rejects.toThrow("viewer authority changed");
    expect(request).toHaveBeenCalledOnce();
  });

  test("keeps the deadline active while cancelling the probe body", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async () => ({
        status: 200,
        statusText: "OK",
        body: {
          cancel: async () => await new Promise<void>(() => {}),
        },
      }));
      const readiness = waitForViewerHttpReady({
        request,
        timeoutMs: 25,
      });
      const rejected = expect(readiness).rejects.toThrow(
        "App viewer did not become ready within 25ms (last result: HTTP 200 OK)",
      );

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
