import { describe, expect, test } from "vitest";
import {
  APP_CAPABILITY_HEADER,
  AppCapabilityRegistry,
  admitRequest,
  type AppAuthorizationSnapshot,
} from "../src/auth";

const FORGED_APP_ID_HEADER = "x-lamarck-app-id";
const FORGED_BRIDGE_TOKEN_HEADER = "x-lamarck-bridge-token";
const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}` as const;
const APP_COMMIT = "b".repeat(40);

const secrets = {
  coreToken: "core-secret",
};

function appRequest(capability: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/query", {
    headers: {
      [APP_CAPABILITY_HEADER]: capability,
      ...extraHeaders,
    },
  });
}

function authorization(
  manifestGeneration = 1,
  writeTables: string[] = [],
  fileGrants: string[] = [],
): AppAuthorizationSnapshot {
  return {
    manifestGeneration,
    manifestDigest: MANIFEST_DIGEST,
    appCommit: APP_COMMIT,
    writeTables,
    fileGrants,
  };
}

describe("auth", () => {
  test("accepts the Host bearer token", () => {
    const req = new Request("http://localhost:3000/api/apps", {
      headers: { Authorization: "Bearer core-secret" },
    });

    const admission = admitRequest(req, secrets);
    expect(admission?.context).toEqual({ kind: "host" });
    expect(Object.isFrozen(admission?.context)).toBe(true);
    admission?.release();
  });

  test("binds an opaque capability to its server-held App and workload identity", () => {
    const registry = new AppCapabilityRegistry();
    const appA = registry.issue(
      "app-a",
      "service:indexer",
      authorization(1, ["notes"], ["apps/app-a/"]),
    );

    const admission = admitRequest(
      appRequest(appA.capability, {
        // A caller cannot use identity-shaped headers to borrow App B's identity.
        [FORGED_APP_ID_HEADER]: "app-b",
        [FORGED_BRIDGE_TOKEN_HEADER]: "bridge-secret",
      }),
      secrets,
      registry,
    );

    expect(admission?.context).toEqual({
      kind: "app",
      appId: "app-a",
      workload: "service:indexer",
      channelId: appA.channelId,
      authorization: {
        manifestGeneration: 1,
        manifestDigest: MANIFEST_DIGEST,
        appCommit: APP_COMMIT,
        writeTables: ["notes"],
        fileGrants: ["apps/app-a/"],
      },
    });
    expect(Object.isFrozen(admission?.context)).toBe(true);
    admission?.release();
  });

  test("does not authenticate caller-selected bridge headers or an unknown capability", () => {
    const registry = new AppCapabilityRegistry();
    expect(
      admitRequest(
        new Request("http://localhost:3000/api/query", {
          headers: {
            [FORGED_APP_ID_HEADER]: "app-a",
            [FORGED_BRIDGE_TOKEN_HEADER]: "bridge-secret",
          },
        }),
        secrets,
        registry,
      ),
    ).toBeNull();
    expect(
      admitRequest(
        appRequest("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        secrets,
        registry,
      ),
    ).toBeNull();
  });

  test("revocation closes admission immediately and drains active requests", async () => {
    const registry = new AppCapabilityRegistry();
    const appA = registry.issue("app-a", "ui", authorization());
    const appB = registry.issue("app-b", "job:daily-etl", authorization());
    const active = admitRequest(appRequest(appA.capability), secrets, registry);
    if (!active) throw new Error("Expected active App admission");

    let drained = false;
    const revocation = registry.revoke(appA.channelId).then((result) => {
      drained = true;
      return result;
    });

    expect(active.signal.aborted).toBe(true);
    expect(admitRequest(appRequest(appA.capability), secrets, registry)).toBeNull();
    await Promise.resolve();
    expect(drained).toBe(false);

    active.release();
    active.release();
    await expect(revocation).resolves.toBe(true);
    expect(await registry.revoke(appA.channelId)).toBe(false);
    const appBAdmission = admitRequest(appRequest(appB.capability), secrets, registry);
    expect(appBAdmission?.context).toMatchObject({
      appId: "app-b",
      workload: "job:daily-etl",
    });
    appBAdmission?.release();
  });

  test("revokes every live channel for one App only", async () => {
    const registry = new AppCapabilityRegistry();
    const appAUi = registry.issue("app-a", "ui", authorization());
    const appAJob = registry.issue("app-a", "job:refresh", authorization());
    const appB = registry.issue("app-b", "ui", authorization());

    expect(await registry.revokeApp("app-a")).toBe(2);
    expect(await registry.revokeApp("app-a")).toBe(0);
    expect(registry.size).toBe(1);
    expect(admitRequest(appRequest(appAUi.capability), secrets, registry)).toBeNull();
    expect(admitRequest(appRequest(appAJob.capability), secrets, registry)).toBeNull();
    const appBAdmission = admitRequest(appRequest(appB.capability), secrets, registry);
    expect(appBAdmission?.context).toMatchObject({
      appId: "app-b",
    });
    appBAdmission?.release();
  });

  test("returns immutable identity and never serializes the raw capability in registry state", () => {
    const registry = new AppCapabilityRegistry();
    const tables = ["notes"];
    const files = ["apps/app-a/"];
    const issued = registry.issue("app-a", "ui", authorization(1, tables, files));
    tables.push("secrets");
    files.push("private/");
    const admission = admitRequest(appRequest(issued.capability), secrets, registry);
    const auth = admission?.context;
    if (!auth || auth.kind !== "app") throw new Error("Expected App auth");

    expect(Object.isFrozen(issued)).toBe(true);
    expect(Object.isFrozen(auth)).toBe(true);
    expect(Reflect.set(auth, "appId", "app-b")).toBe(false);
    expect(auth.appId).toBe("app-a");
    expect(auth.authorization.writeTables).toEqual(["notes"]);
    expect(auth.authorization.fileGrants).toEqual(["apps/app-a/"]);
    expect(Object.isFrozen(auth.authorization)).toBe(true);
    expect(Object.isFrozen(auth.authorization.writeTables)).toBe(true);
    expect(Object.isFrozen(auth.authorization.fileGrants)).toBe(true);
    expect(JSON.stringify(registry)).not.toContain(issued.capability);
    admission.release();
  });

  test("invalidating a manifest generation cannot race with channel issuance", async () => {
    const registry = new AppCapabilityRegistry();
    const issued = registry.issue("app-a", "ui", authorization(1, ["notes"]));
    const active = admitRequest(appRequest(issued.capability), secrets, registry);
    if (!active) throw new Error("Expected active App admission");

    let drained = false;
    const invalidation = registry.invalidateManifestGeneration(1).then((count) => {
      drained = true;
      return count;
    });
    expect(active.signal.aborted).toBe(true);
    expect(admitRequest(appRequest(issued.capability), secrets, registry)).toBeNull();
    expect(() => registry.issue("app-a", "ui", authorization(1))).toThrow(
      "generation 1 is no longer active",
    );
    expect(drained).toBe(false);

    active.release();
    await expect(invalidation).resolves.toBe(1);
    expect(registry.issue("app-a", "ui", authorization(2))).toMatchObject({
      channelId: expect.stringMatching(/^appch_/),
    });
  });

  test("rejects malformed identities before issuing a capability", () => {
    const registry = new AppCapabilityRegistry();
    expect(() => registry.issue("App-A", "ui", authorization())).toThrow("Invalid app id");
    expect(() => registry.issue("app-a", "service:Bad" as never, authorization())).toThrow(
      "Invalid app workload",
    );
    expect(registry.size).toBe(0);
  });

  test("requires a Host-bound full App commit before issuing a capability", () => {
    const registry = new AppCapabilityRegistry();
    const invalidCommits: unknown[] = [
      undefined,
      "",
      "a".repeat(12),
      "A".repeat(40),
      `${"a".repeat(40)}-dirty`,
    ];

    for (const appCommit of invalidCommits) {
      expect(() => registry.issue("app-a", "ui", {
        ...authorization(),
        appCommit,
      } as AppAuthorizationSnapshot)).toThrow(
        "App authorization commit must be a full 40- or 64-character lowercase Git commit",
      );
    }
    expect(registry.size).toBe(0);
  });

  test("rejects missing or mismatched Host credentials", () => {
    expect(admitRequest(new Request("http://localhost:3000/api/apps"), secrets)).toBeNull();
    expect(
      admitRequest(
        new Request("http://localhost:3000/api/apps", {
          headers: { Authorization: "Bearer wrong" },
        }),
        secrets,
      ),
    ).toBeNull();
  });
});
