import { afterEach, expect, test, vi } from "vitest";
import { createReadPoller } from "./read-poller";

afterEach(() => vi.useRealTimers());

test("does not begin a read after its component has already unmounted", async () => {
  const read = vi.fn().mockResolvedValue(undefined);
  const poller = createReadPoller(read, 5_000, vi.fn());
  const pending = poller.refresh();
  poller.dispose();
  await pending;
  expect(read).not.toHaveBeenCalled();
});

test("does not accumulate reads while one is stalled, including manual refreshes", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const read = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const poller = createReadPoller(read, 5_000, vi.fn());
  const first = poller.refresh();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(poller.refresh()).toBe(first);
  finish();
  await first;
  await vi.advanceTimersByTimeAsync(4_999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  poller.dispose();
  finish();
});

test("coalesces wake and runtime changes into one replacement after cancellation", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const read = vi.fn((signal: AbortSignal) => new Promise<void>((resolve) => {
    signals.push(signal);
    signal.addEventListener("abort", () => resolve(), { once: true });
  }));
  const poller = createReadPoller(read, 5_000, vi.fn());
  const first = poller.refresh();
  await vi.advanceTimersByTimeAsync(0);
  poller.restart();
  poller.restart();
  poller.restart();
  expect(signals[0].aborted).toBe(true);
  await first;
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(signals[1].aborted).toBe(false);
  poller.dispose();
  expect(signals[1].aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(2);
});

test("resumes polling after a failed read and clears scheduled work on disposal", async () => {
  vi.useFakeTimers();
  const failure = new Error("Core unavailable");
  const read = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  const onError = vi.fn();
  const poller = createReadPoller(read, 5_000, onError);
  poller.restart();
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledWith(failure);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(2);
  poller.dispose();
  poller.restart();
  await poller.refresh();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(2);
});

test("a recovery event during the idle interval reads immediately without a duplicate timer", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue(undefined);
  const poller = createReadPoller(read, 5_000, vi.fn());
  await poller.refresh();
  await vi.advanceTimersByTimeAsync(4_000);
  poller.restart();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledTimes(2);
  poller.dispose();
});

test("backs off repeated failures to 30 seconds and resets after a successful read", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockRejectedValue(new Error("Core unavailable"));
  const poller = createReadPoller(read, 5_000, vi.fn());
  poller.restart();
  await vi.advanceTimersByTimeAsync(0);
  for (const [index, delay] of [10_000, 20_000, 30_000, 30_000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(read).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(index + 2);
  }
  read.mockResolvedValue(undefined);
  // A manual refresh bypasses the backoff, without scheduling a duplicate.
  await poller.refresh();
  expect(read).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(read).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(7);
  poller.dispose();
});

test("a wake interrupts backoff and cancellation is not treated as a read failure", async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const read = vi.fn().mockRejectedValueOnce(new Error("Core unavailable"))
    .mockImplementationOnce((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }))
    .mockResolvedValue(undefined);
  const poller = createReadPoller(read, 5_000, onError);
  poller.restart();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1_000);
  poller.restart();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  poller.restart();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(3);
  expect(onError).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(read).toHaveBeenCalledTimes(4);
  poller.dispose();
});
