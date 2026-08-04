import { describe, expect, test, vi } from "vitest";
import type { MarketplacePreparedPackage } from "../lib/api";
import {
  MarketplaceHandoffQueue,
  commitMarketplaceStage,
  openAppliedAppBestEffort,
  suggestedMarketplaceAppLocalId,
  validateMarketplaceAppLocalId,
} from "./MarketplaceHandoffController";

const preparedApp: MarketplacePreparedPackage = {
  stageId: "68f28433-b777-45b5-9b26-952f99632374",
  kind: "app",
  packageId: "lamarck.notes",
  releaseId: "release-1",
  contentHash: `sha256:${"a".repeat(64)}`,
  origin: "Official",
  name: "Notes",
  description: "Editable notes.",
  action: "create",
  localIdConflict: false,
};

describe("Marketplace handoff controller coordination", () => {
  test("requires a valid non-conflicting local App ID", () => {
    expect(validateMarketplaceAppLocalId("", "lamarck.notes"))
      .toBe("Enter a local App ID.");
    expect(validateMarketplaceAppLocalId("Lamarck Notes", "lamarck.notes"))
      .toContain("lowercase letters");
    expect(validateMarketplaceAppLocalId("lamarck.notes", "lamarck.notes"))
      .toContain("already in use");
    expect(validateMarketplaceAppLocalId("local.notes-copy", "lamarck.notes"))
      .toBeNull();
    const suggestion = suggestedMarketplaceAppLocalId("lamarck.notes");
    expect(suggestion).toBe("lamarck.notes-copy");
    expect(validateMarketplaceAppLocalId(suggestion, "lamarck.notes")).toBeNull();
  });

  test("serializes two rapid handoffs without dropping either", () => {
    const queue = new MarketplaceHandoffQueue();
    const first = { kind: "app" as const, packageId: "lamarck.notes" };
    const second = { kind: "connector" as const, packageId: "lamarck.calendar" };

    queue.enqueue(first);
    queue.enqueue(second);

    expect(queue.take()).toEqual(first);
    expect(queue.take()).toEqual(second);
    expect(queue.length).toBe(0);
  });

  test("best-effort cancels an ambiguous failed apply before allowing retry", async () => {
    const apply = vi.fn().mockRejectedValue(new Error("connection lost"));
    const cancel = vi.fn().mockResolvedValue({ ok: true as const });

    await expect(commitMarketplaceStage(preparedApp, "lamarck.notes", {
      apply,
      cancel,
    })).rejects.toThrow("connection lost");
    expect(cancel).toHaveBeenCalledWith(preparedApp.stageId);
  });

  test("does not turn post-commit App navigation failure into an install retry", async () => {
    const navigationError = new Error("viewer did not open");
    const report = vi.fn();
    openAppliedAppBestEffort("lamarck.notes", () => {
      throw navigationError;
    }, report);

    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith(navigationError);
  });
});
