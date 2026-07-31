import { describe, expect, test } from "vitest";
import type { ConnectorIntegrationView } from "./api";
import {
  setupNeeds,
  sourceLifecycle,
  sourceHasAutomaticActivity,
  sourceNeedsAttention,
  sourceNeedsSetup,
  sourceRunsHere,
  sourceShownName,
} from "./connector-state";

const NOW = 1_000_000;

function source(overrides: Partial<ConnectorIntegrationView> = {}): ConnectorIntegrationView {
  return {
    id: "source-1",
    connectorId: "example",
    connectorName: "Example",
    sourceKey: "singleton",
    displayName: null,
    suggestedLabel: null,
    identityKind: "single",
    identityStatus: "resolved",
    ownership: "here",
    name: "Example",
    description: "Example Source.",
    mode: "poll",
    status: "idle",
    setupStatus: "ready",
    packageTrust: "official",
    authType: "none",
    authReady: true,
    setupPending: [],
    source: "connector:example",
    running: false,
    supported: true,
    requirements: [],
    ...overrides,
  };
}

describe("source lifecycle", () => {
  test("has only active and paused states", () => {
    expect(sourceLifecycle(source({ setupStatus: "setup" }), NOW)).toBe("active");
    expect(sourceLifecycle(source(), NOW)).toBe("active");
    expect(sourceLifecycle(source({ pausedAt: NOW - 1 }), NOW)).toBe("paused");
  });

  test("automatically reads an expired timed pause as active", () => {
    expect(sourceLifecycle(source({ pausedAt: NOW - 100, resumeAt: NOW + 100 }), NOW)).toBe("paused");
    expect(sourceLifecycle(source({ pausedAt: NOW - 200, resumeAt: NOW - 100 }), NOW)).toBe("active");
  });

  test("keeps setup independent from pause policy", () => {
    expect(sourceLifecycle(source({ setupStatus: "setup" }), NOW)).toBe("active");
    expect(sourceLifecycle(source({ setupStatus: "setup", pausedAt: NOW - 1 }), NOW)).toBe("paused");
  });

  test("derives Needs setup from current run gates, not persisted setupStatus", () => {
    const credentialMissing = source({ setupStatus: "ready", setupPending: ["auth"] });
    expect(sourceLifecycle(credentialMissing, NOW)).toBe("active");
    expect(sourceNeedsSetup(credentialMissing)).toBe(true);
  });

  test("offers pause only to sources with automatic activity", () => {
    expect(sourceHasAutomaticActivity(source({ mode: "watch" }))).toBe(true);
    expect(sourceHasAutomaticActivity(source({ mode: "poll", scheduleCron: "0 * * * *" }))).toBe(true);
    expect(sourceHasAutomaticActivity(source({ mode: "poll", scheduleCron: undefined }))).toBe(false);
    expect(sourceHasAutomaticActivity(source({ mode: "manual" }))).toBe(false);
  });

  test("keeps runtime health and package trust out of lifecycle", () => {
    const failed = source({ status: "error", packageTrust: "untrusted" });
    expect(sourceLifecycle(failed, NOW)).toBe("active");
    expect(sourceNeedsAttention(failed)).toBe(true);
  });

  test("uses display, suggested, then Connector name for the shown name", () => {
    expect(sourceShownName(source({
      displayName: "Morning ring",
      suggestedLabel: "Scott's Oura",
      connectorName: "Oura",
    }))).toBe("Morning ring");
    expect(sourceShownName(source({
      displayName: null,
      suggestedLabel: "Scott's Oura",
      connectorName: "Oura",
    }))).toBe("Scott's Oura");
    expect(sourceShownName(source({
      displayName: null,
      suggestedLabel: null,
      connectorName: "Oura",
    }))).toBe("Oura");
  });

  test("keeps ownership separate from lifecycle and flags local identity failures", () => {
    const remote = source({ ownership: "other-device" });
    expect(sourceLifecycle(remote, NOW)).toBe("active");
    expect(sourceRunsHere(remote)).toBe(false);
    expect(sourceNeedsAttention(remote)).toBe(false);

    expect(sourceNeedsAttention(source({ identityStatus: "conflict" }))).toBe(true);
    expect(sourceNeedsAttention(source({ identityStatus: "changed" }))).toBe(true);
    expect(sourceNeedsAttention(source({ identityStatus: "error" }))).toBe(true);
    expect(sourceNeedsAttention(source({ ownership: "device-unknown" }))).toBe(true);
  });

  test("presents unresolved identity as a setup gate", () => {
    const unresolved = source({
      identityStatus: "unresolved",
      setupPending: ["identity"],
    });
    expect(sourceNeedsSetup(unresolved)).toBe(true);
    expect(setupNeeds(unresolved)).toEqual(["source identity"]);
  });
});
