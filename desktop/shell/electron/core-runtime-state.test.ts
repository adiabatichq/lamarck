import { describe, expect, test, vi } from "vitest";
import { CoreRuntimeStateController } from "./core-runtime-state";

describe("Core runtime state generations", () => {
  test("publishes starting and accepts readiness only for the current generation", () => {
    const changed = vi.fn();
    const state = new CoreRuntimeStateController(changed);
    const first = state.begin();
    const second = state.begin();

    expect(state.ready(first)).toBe(false);
    expect(state.snapshot()).toEqual({
      generation: second,
      phase: "starting",
      error: null,
    });
    expect(state.ready(second)).toBe(true);
    expect(state.snapshot()).toEqual({
      generation: second,
      phase: "ready",
      error: null,
    });
  });

  test("does not let stale failure or readiness overwrite a newer failure", () => {
    const state = new CoreRuntimeStateController();
    const first = state.begin();
    const second = state.begin();

    expect(state.fail(first, "old Core exited")).toBe(false);
    expect(state.fail(second, "new Core exited")).toBe(true);
    expect(state.ready(second)).toBe(false);
    expect(state.snapshot()).toEqual({
      generation: second,
      phase: "failed",
      error: "new Core exited",
    });
  });
});
