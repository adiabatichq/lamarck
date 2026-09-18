import { afterEach, expect, test, vi } from "vitest";
import { loadApps, type AppRegistry } from "../src/app-loader";
import { AppLifecycleService, type AppInventoryItemV1 } from "../src/apps/lifecycle";

vi.mock("../src/app-loader", async (original) => ({
  ...await original<typeof import("../src/app-loader")>(), loadApps: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

function fixture() {
  const lifecycle = new AppLifecycleService("/unused", "/unused", {} as never, {} as never, {} as never);
  const registry = { apps: new Map() } as AppRegistry;
  vi.mocked(loadApps).mockResolvedValue(registry);
  const scan = vi.spyOn(lifecycle as unknown as {
    scanInventory(signal: AbortSignal): Promise<readonly AppInventoryItemV1[]>;
  }, "scanInventory").mockResolvedValue([]);
  return { lifecycle, scan };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("removes cancelled readers without restarting or adding callbacks to a stalled scan", async () => {
  const { lifecycle, scan } = fixture();
  const held = deferred<readonly AppInventoryItemV1[]>();
  scan.mockReturnValueOnce(held.promise);
  const initial = new AbortController();
  const first = expect(lifecycle.inventory(initial.signal)).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
  initial.abort();
  await first;
  for (let index = 0; index < 100; index++) {
    const caller = new AbortController();
    const cancelled = expect(lifecycle.inventory(caller.signal)).rejects.toMatchObject({ name: "AbortError" });
    caller.abort();
    await cancelled;
  }
  const state = lifecycle as unknown as { waitingReads: Set<unknown>; activeReads: Set<unknown> };
  expect(state.waitingReads.size).toBe(0);
  expect(state.activeReads.size).toBe(0);
  expect(loadApps).toHaveBeenCalledTimes(1);
  held.resolve([]);
  await lifecycle.close();
  expect(scan).toHaveBeenCalledTimes(1);
});

test("one reader disconnecting cannot cancel a scan still owned by another reader", async () => {
  const { lifecycle, scan } = fixture();
  const held = deferred<readonly AppInventoryItemV1[]>();
  scan.mockReturnValueOnce(held.promise);
  const caller = new AbortController();
  const cancelled = expect(lifecycle.inventory(caller.signal)).rejects.toMatchObject({ name: "AbortError" });
  const remaining = lifecycle.inventory();
  await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
  caller.abort();
  await cancelled;
  expect(scan.mock.calls[0][0].aborted).toBe(false);
  held.resolve([]);
  await expect(remaining).resolves.toEqual([]);
  expect(loadApps).toHaveBeenCalledTimes(1);
  await lifecycle.close();
});

test("readers arriving during a scan share one subsequent fresh scan", async () => {
  const { lifecycle, scan } = fixture();
  const held = deferred<readonly AppInventoryItemV1[]>();
  const old = [{ name: "before save" }] as AppInventoryItemV1[];
  const fresh = [{ name: "after save" }] as AppInventoryItemV1[];
  scan.mockReturnValueOnce(held.promise).mockResolvedValue(fresh);
  const first = lifecycle.inventory();
  await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
  const readers = Array.from({ length: 20 }, () => lifecycle.inventory());
  held.resolve(old);
  await expect(first).resolves.toEqual(old);
  for (const result of await Promise.all(readers)) expect(result).toEqual(fresh);
  expect(scan).toHaveBeenCalledTimes(2);
  await lifecycle.close();
});

test("closing stops admission and rejects readers while retaining the real I/O slot", async () => {
  const { lifecycle, scan } = fixture();
  const held = deferred<readonly AppInventoryItemV1[]>();
  scan.mockReturnValueOnce(held.promise);
  const first = expect(lifecycle.inventory()).rejects.toThrow("shutting down");
  await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
  const queued = expect(lifecycle.refreshRegistry()).rejects.toThrow("shutting down");
  let closed = false;
  const closing = lifecycle.close().then(() => { closed = true; });
  await Promise.all([first, queued]);
  expect(scan.mock.calls[0][0].aborted).toBe(true);
  expect(closed).toBe(false);
  await expect(lifecycle.inventory()).rejects.toThrow("shutting down");
  held.resolve([]);
  await closing;
  expect(loadApps).toHaveBeenCalledTimes(1);
});
