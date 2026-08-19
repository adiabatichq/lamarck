import { describe, expect, test, vi } from "vitest";
import {
  coreResponseDisposition,
  emptyWorkspaceCopy,
  resolveCoreRequestFailure,
} from "./core-availability";

describe("Core startup availability", () => {
  test("keeps a rejected request in the starting state while the Host is starting", async () => {
    const getRuntimeState = vi.fn(async () => ({
      generation: 1,
      phase: "starting" as const,
      error: null,
    }));

    await expect(resolveCoreRequestFailure(
      new Error("Node Core is not running"),
      getRuntimeState,
    )).resolves.toEqual({
      status: "checking",
      error: null,
    });
    expect(getRuntimeState).toHaveBeenCalledOnce();
  });

  test("uses the Host's confirmed startup failure for the unavailable state", async () => {
    await expect(resolveCoreRequestFailure(
      new Error("Node Core is not running"),
      async () => ({
        generation: 1,
        phase: "failed",
        error: "Workspace vault is locked on this device.",
      }),
    )).resolves.toEqual({
      status: "offline",
      error: "Workspace vault is locked on this device.",
    });
  });

  test("keeps automatic recovery out of the unavailable UI", async () => {
    await expect(resolveCoreRequestFailure(
      new Error("Node Core is restarting"),
      async () => ({
        generation: 2,
        phase: "restarting",
        error: "Guard exited",
      }),
    )).resolves.toEqual({
      status: "checking",
      error: null,
    });
  });

  test("fails unavailable with the request error when Host state cannot be inspected", async () => {
    await expect(resolveCoreRequestFailure(
      new Error("Core connection was lost"),
      async () => { throw new Error("IPC closed"); },
    )).resolves.toEqual({
      status: "offline",
      error: "Core connection was lost",
    });
  });

  test("preserves the request failure while the runtime still reports ready", async () => {
    await expect(resolveCoreRequestFailure(
      new Error("HTTP 500"),
      async () => ({ generation: 1, phase: "ready", error: null }),
    )).resolves.toEqual({
      status: "offline",
      error: "HTTP 500",
    });
  });

  test("never publishes a response from an older ready generation", () => {
    expect(coreResponseDisposition(
      { generation: 4, phase: "ready", error: null },
      { generation: 5, phase: "ready", error: null },
    )).toBe("retry");
    expect(coreResponseDisposition(
      { generation: 4, phase: "ready", error: null },
      { generation: 5, phase: "starting", error: null },
    )).toBe("unavailable");
    expect(coreResponseDisposition(
      { generation: 5, phase: "ready", error: null },
      { generation: 5, phase: "ready", error: null },
    )).toBe("publish");
  });

  test("presents pending startup as preparation rather than unavailability", () => {
    expect(emptyWorkspaceCopy("checking", false)).toEqual({
      eyebrow: "System starting",
      title: "Preparing your workspace.",
      detail: "Unlocking local state and starting its services. Apps will appear when it is ready.",
    });
    expect(emptyWorkspaceCopy("offline", false).eyebrow).toBe("System unavailable");
  });
});
