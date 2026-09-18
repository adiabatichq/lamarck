import { describe, expect, test, vi } from "vitest";
import { DesktopRuntimeSupervisor } from "./runtime-supervisor";

function startReadyRuntime(
  supervisor: DesktopRuntimeSupervisor<object, object>,
): { generation: number; core: object; guard: object } {
  const generation = supervisor.begin();
  const guard = {};
  const core = {};
  supervisor.attachGuard(generation, guard);
  expect(supervisor.publishGuardOrigin(generation, guard, "http://127.0.0.1:1")).toBe(true);
  supervisor.attachCore(generation, core);
  expect(supervisor.ready(generation)).toBe(true);
  return { generation, core, guard };
}

describe("Desktop runtime supervisor", () => {
  test("serializes operations even after one rejects", async () => {
    const { supervisor, events } = harness();
    let release!: () => void;
    const first = supervisor.enqueue(async () => {
      events.push("first");
      await new Promise<void>(resolve => { release = resolve; });
      throw new Error("failed operation");
    });
    const failure = expect(first).rejects.toThrow("failed operation");
    const next = supervisor.enqueue(async () => { events.push("next"); });
    await Promise.resolve();
    expect(events).toEqual(["first"]);
    release();
    await failure;
    await next;
    expect(events).toEqual(["first", "next"]);
  });

  test("revokes Apps while Core is alive, then releases Core before Guard", async () => {
    const { supervisor, operations, events } = harness();
    await supervisor.start();
    operations.stopApps.mockImplementationOnce(async lost => {
      expect(lost).toBe(false);
      expect(supervisor.core).not.toBeNull();
      expect(supervisor.guard).not.toBeNull();
      events.push("apps");
    });
    await supervisor.stop();
    expect(events).toEqual(["start", "gateway", "apps", "core", "guard"]);
    await supervisor.start();
    expect(supervisor.snapshot()).toMatchObject({ generation: 2, phase: "ready" });
  });

  test("intentional replacement stops on failed revocation", async () => {
    const { supervisor, operations } = harness();
    await supervisor.start();
    operations.stopApps.mockRejectedValueOnce(new Error("cannot revoke"));
    await expect(supervisor.stop()).rejects.toThrow("cannot revoke");
    expect(operations.stopCore).not.toHaveBeenCalled();
    expect(operations.stopGuard).not.toHaveBeenCalled();
  });

  test("failure cleanup tries every service and retains unconfirmed processes", async () => {
    const { supervisor, operations } = harness();
    await supervisor.start();
    operations.stopGateway.mockRejectedValueOnce(new Error("gateway"));
    operations.stopApps.mockRejectedValueOnce(new Error("apps"));
    operations.stopCore.mockRejectedValueOnce(new Error("core still alive"));
    await expect(supervisor.stop("failure")).rejects.toBeInstanceOf(AggregateError);
    expect(operations.stopGuard).toHaveBeenCalledOnce();
    expect(supervisor.core).not.toBeNull();
    expect(supervisor.guard).toBeNull();
    await expect(supervisor.start()).rejects.toThrow("predecessor is still attached");
  });

  test("lost control plane cleanup does not wait for Capsule to stop processes", async () => {
    const { supervisor, operations, events } = harness();
    await supervisor.start();
    let release!: () => void;
    operations.stopApps.mockImplementationOnce(async lost => {
      expect(lost).toBe(true);
      events.push("apps");
      await new Promise<void>(resolve => { release = resolve; });
    });
    const stop = supervisor.stop("lost");
    await vi.waitFor(() => expect(events).toEqual(["start", "gateway", "apps", "core", "guard"]));
    release();
    await stop;
  });

  test("startup failure releases partially started processes even if gateway cleanup fails", async () => {
    const { supervisor, operations } = harness();
    operations.start.mockImplementationOnce(async generation => {
      supervisor.attachGuard(generation, {});
      throw new Error("startup failed");
    });
    operations.stopGateway.mockRejectedValueOnce(new Error("gateway failed"));
    await expect(supervisor.start()).rejects.toBeInstanceOf(AggregateError);
    expect(supervisor.snapshot()).toMatchObject({ phase: "failed", error: "startup failed" });
    expect(operations.stopGuard).toHaveBeenCalledOnce();
    expect(supervisor.guard).toBeNull();
  });

  test("late exits cannot detach a replacement generation", async () => {
    const { supervisor } = harness();
    await supervisor.start();
    const oldCore = supervisor.core!;
    const oldGuard = supervisor.guard!;
    await supervisor.stop();
    await supervisor.start();
    expect(supervisor.isExpectedCoreStop(oldCore)).toBe(true);
    expect(supervisor.isExpectedGuardStop(oldGuard)).toBe(true);
    expect(supervisor.detachCore(oldCore)).toBe(false);
    expect(supervisor.detachGuard(oldGuard)).toBe(false);
    expect(supervisor.fail(1, "late failure")).toBe(false);
    expect(supervisor.snapshot().phase).toBe("ready");
  });
  test("owns one Core and Guard pair per ready generation", () => {
    const changed = vi.fn();
    const supervisor = new DesktopRuntimeSupervisor<object, object>(changed);
    const { generation, core, guard } = startReadyRuntime(supervisor);

    expect(supervisor.core).toBe(core);
    expect(supervisor.guard).toBe(guard);
    expect(supervisor.snapshot()).toEqual({
      generation,
      phase: "ready",
      error: null,
    });
    expect(changed).toHaveBeenLastCalledWith(supervisor.snapshot());
  });

  test("publishes one whole-runtime restart", () => {
    const supervisor = new DesktopRuntimeSupervisor<object, object>();
    const { generation } = startReadyRuntime(supervisor);

    expect(supervisor.prepareRestart("Guard exited")).toBe(true);
    expect(supervisor.snapshot()).toEqual({
      generation,
      phase: "restarting",
      error: "Guard exited",
    });
    expect(supervisor.prepareRestart("Core followed")).toBe(false);
  });

  test("leaves startup failures to the existing startup operation", () => {
    const supervisor = new DesktopRuntimeSupervisor<object, object>();
    const generation = supervisor.begin();
    const guard = {};
    supervisor.attachGuard(generation, guard);

    expect(supervisor.snapshot().phase).toBe("starting");
    expect(supervisor.fail(generation, "startup exit")).toBe(true);
    expect(supervisor.snapshot()).toEqual({
      generation,
      phase: "failed",
      error: "startup exit",
    });
  });

  test("keeps an unconfirmed old process attached so replacement cannot overlap it", () => {
    const supervisor = new DesktopRuntimeSupervisor<object, object>();
    const { core } = startReadyRuntime(supervisor);

    supervisor.prepareRestart();
    expect(() => supervisor.begin()).toThrow("predecessor is still attached");
    expect(supervisor.detachCore(core)).toBe(true);
    expect(() => supervisor.begin()).toThrow("predecessor is still attached");
  });
});

function harness() {
  const events: string[] = [];
  const operations = {
    start: vi.fn(async (generation: number) => {
      events.push("start");
      const guard = {};
      supervisor.attachGuard(generation, guard);
      supervisor.publishGuardOrigin(generation, guard, "http://127.0.0.1:1");
      supervisor.attachCore(generation, {});
      supervisor.ready(generation);
    }),
    stopGateway: vi.fn(async () => { events.push("gateway"); }),
    stopApps: vi.fn(async (_lost: boolean) => { events.push("apps"); }),
    stopCore: vi.fn(async (child: object) => {
      events.push("core");
      supervisor.expectCoreStop(child);
      supervisor.detachCore(child);
    }),
    stopGuard: vi.fn(async (child: object) => {
      events.push("guard");
      supervisor.expectGuardStop(child);
      supervisor.detachGuard(child);
    }),
  };
  const supervisor = new DesktopRuntimeSupervisor<object, object>(() => {}, operations);
  return { supervisor, operations, events };
}
