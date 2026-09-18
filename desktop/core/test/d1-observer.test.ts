import { afterEach, expect, test, vi } from "vitest";
import { D1Observer } from "../src/d1-observer";
import { D1Sequencer } from "../src/d1-sequencer";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  watch: vi.fn(() => ({ on() { return this; }, close() {} })),
}));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  const observer = new D1Observer("/unused", {} as never, {} as never, {} as never, new D1Sequencer());
  const scan = vi.spyOn(observer as unknown as { observeExclusive(signal: AbortSignal): Promise<void> }, "observeExclusive")
    .mockResolvedValue(undefined);
  vi.spyOn(observer as unknown as { catchUpFromD0(): Promise<void> }, "catchUpFromD0").mockResolvedValue(undefined);
  return { observer, scan };
}

test("coalesces a minute of polling behind a stalled scan into one follow-up", async () => {
  vi.useFakeTimers();
  const { observer, scan } = fixture();
  let release!: () => void;
  await observer.start();
  scan.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  await vi.advanceTimersByTimeAsync(2_120);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(scan).toHaveBeenCalledTimes(2);
  release();
  await vi.advanceTimersByTimeAsync(120);
  expect(scan).toHaveBeenCalledTimes(3);
  await observer.stop();
  expect(vi.getTimerCount()).toBe(0);
});

test("stop aborts the current scan and drops every queued refresh", async () => {
  vi.useFakeTimers();
  const { observer, scan } = fixture();
  let release!: () => void;
  await observer.start();
  scan.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  await vi.advanceTimersByTimeAsync(2_120);
  await vi.advanceTimersByTimeAsync(60_000);
  const stopped = observer.stop();
  expect(scan.mock.calls[1][0].aborted).toBe(true);
  release();
  await stopped;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(scan).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("stop during initial observation cannot install a late watcher or timer", async () => {
  vi.useFakeTimers();
  const { observer, scan } = fixture();
  let release!: () => void;
  scan.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const started = observer.start();
  await vi.advanceTimersByTimeAsync(0);
  const stopped = observer.stop();
  release();
  await Promise.all([started, stopped]);
  expect(vi.getTimerCount()).toBe(0);
});
