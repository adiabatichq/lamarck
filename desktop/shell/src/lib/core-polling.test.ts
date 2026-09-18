import { afterEach, expect, test, vi } from "vitest";
import { clearCoreBaseUrlCache, CORE_READ_TIMEOUT_MS, listApps } from "./api";
import { createReadPoller } from "../hooks/useCorePolling";

afterEach(() => {
  clearCoreBaseUrlCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("bounds pending HTTP reads across polling, wake, timeout, and recovery", async () => {
  vi.useFakeTimers();
  let active = 0;
  let peak = 0;
  const requests: Array<{ signal: AbortSignal; respond: () => void }> = [];
  vi.stubGlobal("window", { lamarckHost: {
    getCoreBaseUrl: async () => "http://localhost:32100",
    getCoreToken: async () => "test-token",
  } });
  vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = options.signal!;
    active += 1;
    peak = Math.max(peak, active);
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      active -= 1;
      signal.removeEventListener("abort", cancel);
      return true;
    };
    const cancel = () => { if (settle()) reject(signal.reason); };
    signal.addEventListener("abort", cancel, { once: true });
    requests.push({ signal, respond: () => {
      if (settle()) resolve(Response.json({ apps: [] }));
    } });
  })));
  const published = vi.fn();
  const onError = vi.fn();
  const poller = createReadPoller(async (signal) => {
    const result = await listApps(signal);
    if (!signal.aborted) published(result);
  }, 5_000, onError);
  try {
    const first = poller.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toHaveLength(1);
    expect(poller.refresh()).toBe(first);

    clearCoreBaseUrlCache();
    poller.restart();
    poller.restart();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(true);
    requests[0].respond();
    expect(published).not.toHaveBeenCalled();
    requests[1].respond();
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000 + CORE_READ_TIMEOUT_MS);
    expect(requests).toHaveLength(3);
    expect(requests[2].signal.aborted).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(active).toBe(0);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(4);
    requests[3].respond();
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests).toHaveLength(5);
    expect(peak).toBe(1);
  } finally {
    poller.dispose();
  }
  expect(active).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(requests).toHaveLength(5);
  expect(published).toHaveBeenCalledTimes(2);
});
