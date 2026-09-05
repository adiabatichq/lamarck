import { describe, expect, test } from "vitest";
import {
  projectAppShape,
  projectAppSummary,
  projectConnectorInspect,
  projectConnectorSummary,
  projectSourceShape,
  projectSourceSummary,
  type SourceProjectionInput,
} from "../src/cli-projectors";

describe("public CLI shape projectors", () => {
  test("projects complete Source navigation fields without control-plane secrets", () => {
    const input = sourceInput();
    const summary = projectSourceSummary(input);
    const shape = projectSourceShape(input, {
      catalogVersion: 1,
      eventTypes: { "calendar.item": { description: "Calendar item", payloadSchema: { type: "object" } } },
    }, [{ type: "calendar.item", firstObservedAt: 2, lastObservedAt: 3 }]);

    expect(summary).toMatchObject({
      id: "source-1",
      name: "Work calendar",
      connector: { id: "lamarck.calendar", name: "Calendar", description: "Calendar events" },
      setup: { status: "ready", pending: [] },
      execution: { activity: "idle", lastRun: { outcome: "error", startedAt: 4, endedAt: 5 } },
    });
    expect(shape.outputs).toEqual({
      declared: [{ type: "calendar.item", description: "Calendar item", payloadSchema: { type: "object" } }],
      observed: [{ type: "calendar.item", firstObservedAt: 2, lastObservedAt: 3 }],
    });
    for (const forbidden of ["config", "syncState", "authRef", "lastError", "checkpoint", "secret-token"]) {
      expect(JSON.stringify(shape)).not.toContain(forbidden);
    }
  });

  test("projects Connector declarations and owned Sources without package paths", () => {
    const summary = projectConnectorSummary({
      connectorId: "lamarck.calendar",
      name: "Calendar",
      description: "Calendar events",
      mode: "poll",
      identityKind: "single",
      supported: true,
      packageTrust: "official",
      packageHash: `sha256:${"a".repeat(64)}`,
    }, { releaseId: "release-1", updateAvailable: false, sourceCount: 1 });
    const inspected = projectConnectorInspect(summary, {
      manifestVersion: 1,
      id: "lamarck.calendar",
      name: "Calendar",
      description: "Calendar events",
      entry: "./private-entry.mjs",
      eventCatalog: "./events.json",
      runtime: { mode: "poll", schedule: "0 * * * *" },
      source: { identity: "single" },
      auth: { type: "none" },
    } as any, {
      catalogVersion: 1,
      eventTypes: { "calendar.item": { description: "Calendar item", payloadSchema: true } },
    }, [projectSourceSummary(sourceInput())]);

    expect(inspected).toMatchObject({ id: "lamarck.calendar", releaseId: "release-1", sourceCount: 1 });
    expect(inspected.eventTypes).toEqual([{ type: "calendar.item", description: "Calendar item", payloadSchema: true }]);
    expect(JSON.stringify(inspected)).not.toContain("private-entry");
    expect(JSON.stringify(inspected)).not.toContain("events.json");
  });

  test("omits App manifest fields only when neither draft nor recorded manifest is usable", () => {
    const valid = projectAppShape(appInventory({
      manifestHealth: { status: "valid" },
      name: "Unavailable",
      description: "N/A",
    }), false, "/host/apps/example");
    expect(valid).toMatchObject({ name: "Unavailable", description: "N/A" });
    expect(projectAppSummary(valid)).toEqual({
      id: "example",
      name: "Unavailable",
      description: "N/A",
      lifecycle: valid.lifecycle,
      runtime: valid.runtime,
      path: "/host/apps/example",
    });

    const invalid = projectAppShape(appInventory({
      manifestHealth: { status: "invalid", message: "/host/private parse failure" },
      versionHealth: { status: "unversioned" },
      name: "Unavailable",
      description: "N/A",
    }), false, "/mnt/lamarck-apps/example");
    expect(invalid).not.toHaveProperty("name");
    expect(invalid).not.toHaveProperty("description");
    expect(JSON.stringify(invalid)).not.toContain("parse failure");
  });

  test("publishes releaseId only for the exact current Official package", () => {
    const base = {
      connectorId: "lamarck.calendar", name: "Calendar", description: "Calendar events",
      mode: "manual" as const, identityKind: "single" as const, supported: true,
      packageHash: `sha256:${"a".repeat(64)}`,
    };
    expect(projectConnectorSummary({ ...base, packageTrust: "official" }, { releaseId: "release-1", updateAvailable: false, sourceCount: 0 }).releaseId)
      .toBe("release-1");
    expect(projectConnectorSummary({ ...base, packageTrust: "modified" }, { releaseId: "release-1", updateAvailable: false, sourceCount: 0 }).releaseId)
      .toBeNull();
  });
});

function sourceInput(): SourceProjectionInput {
  return {
    id: "source-1",
    connectorId: "lamarck.calendar",
    sourceKey: "work",
    identityStatus: "resolved",
    displayName: "Work calendar",
    suggestedLabel: null,
    status: "idle",
    setupStatus: "ready",
    trustStatus: "official",
    config: { secret: "secret-token" },
    syncState: { checkpoint: "private" },
    authRef: "private-auth",
    createdAt: 1,
    updatedAt: 2,
    name: "Work calendar",
    connectorName: "Calendar",
    description: "Calendar events",
    mode: "poll",
    identityKind: "single",
    ownership: "here",
    source: "connector:lamarck.calendar:work",
    running: false,
    supported: true,
    packageTrust: "official",
    packageHash: `sha256:${"a".repeat(64)}`,
    setupPending: [],
    recentRuns: [{ id: "run-1", sourceId: "source-1", connectorId: "lamarck.calendar", trigger: "manual", status: "error", startedAt: 4, endedAt: 5, durationMs: 1, error: "private failure" }],
  } as unknown as SourceProjectionInput;
}

function appInventory(overrides: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    id: "example",
    path: "/host/private/example",
    version: null,
    packageDirty: true,
    manifestHealth: { status: "valid" },
    versionHealth: { status: "unversioned" },
    name: "Example",
    description: "Example App",
    runtime: { ui: { command: ["npm", "start"], port: 3000 } },
    permissions: { writes: { files: [], tables: [] } },
    ...overrides,
  } as any;
}
