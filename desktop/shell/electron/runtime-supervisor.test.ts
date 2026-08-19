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
