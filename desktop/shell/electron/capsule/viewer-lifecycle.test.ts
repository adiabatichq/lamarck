import { describe, expect, test, vi } from "vitest";
import {
  ViewerLifecycleCoordinator,
  assertViewerAuthorityCurrent,
} from "./viewer-lifecycle";

describe("ViewerLifecycleCoordinator", () => {
  test("keeps reload single-flight until the Electron cutover finishes", async () => {
    const lifecycle = new ViewerLifecycleCoordinator();
    const cutover = deferred<void>();
    const operation = vi.fn(async () => {
      await cutover.promise;
      return { active: true };
    });

    const first = lifecycle.reload("weather", operation);
    const second = lifecycle.reload("weather", operation);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);

    cutover.resolve();
    await expect(first).resolves.toEqual({ active: true });
    await expect(second).resolves.toEqual({ active: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test("serializes a later lifecycle operation behind reload cutover", async () => {
    const lifecycle = new ViewerLifecycleCoordinator();
    const cutover = deferred<void>();
    const order: string[] = [];
    const reload = lifecycle.reload("weather", async () => {
      order.push("reload-start");
      await cutover.promise;
      order.push("reload-end");
    });
    const close = lifecycle.runExclusive("weather", async () => {
      order.push("close");
    });

    await Promise.resolve();
    expect(order).toEqual(["reload-start"]);
    cutover.resolve();
    await Promise.all([reload, close]);
    expect(order).toEqual(["reload-start", "reload-end", "close"]);
  });

  test("invalidates an operation that was awaiting replacement I/O", async () => {
    const lifecycle = new ViewerLifecycleCoordinator();
    const generation = lifecycle.generation("weather");
    lifecycle.assertCurrent("weather", generation);

    lifecycle.invalidate("weather");
    expect(() => lifecycle.assertCurrent("weather", generation))
      .toThrow("generation changed");
  });

  test("makes close win over an in-flight cutover without interleaving publication", async () => {
    const lifecycle = new ViewerLifecycleCoordinator();
    const replacementReady = deferred<void>();
    const generation = lifecycle.generation("weather");
    const events: string[] = [];
    const reload = lifecycle.reload("weather", async () => {
      events.push("reload-await");
      await replacementReady.promise;
      lifecycle.assertCurrent("weather", generation);
      events.push("reload-publish");
    });
    await Promise.resolve();

    lifecycle.invalidate("weather");
    const close = lifecycle.runExclusive("weather", async () => {
      events.push("close-finalize");
    });
    replacementReady.resolve();

    await expect(reload).rejects.toThrow("generation changed");
    await close;
    expect(events).toEqual(["reload-await", "close-finalize"]);
  });

  test("rejects renderer publication when UI authority is lost during gateway setup", async () => {
    const configured = deferred<void>();
    const opened = {
      viewerId: "viewer-a",
      appId: "weather",
      instanceId: "instance-a",
      channelId: "channel-a",
      capability: "capability-a",
    };
    let current: typeof opened | null = opened;
    let rendererBound = false;
    const publication = (async () => {
      await configured.promise;
      assertViewerAuthorityCurrent(opened, current);
      rendererBound = true;
    })();

    // Models authenticated uiLost while createViewerGateway/session
    // configuration is awaiting: Manager removes the viewer synchronously.
    current = null;
    configured.resolve();

    await expect(publication).rejects.toThrow("authority changed");
    expect(rendererBound).toBe(false);
  });

  test("rejects a same-viewer replacement with mismatched instance or channel", () => {
    const opened = {
      viewerId: "viewer-a",
      appId: "weather",
      instanceId: "instance-a",
      channelId: "channel-a",
      capability: "capability-a",
    };
    expect(() => assertViewerAuthorityCurrent(opened, {
      ...opened,
      instanceId: "instance-b",
    })).toThrow("authority changed");
    expect(() => assertViewerAuthorityCurrent(opened, {
      ...opened,
      channelId: "channel-b",
    })).toThrow("authority changed");
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
} {
  let settle!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => { settle = resolveValue; });
  return { promise, resolve: (value) => settle(value as T) };
}
