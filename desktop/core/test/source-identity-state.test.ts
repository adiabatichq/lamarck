import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  sanitizeSourceIdentityError,
  validateConnectorSourceIdentityResult,
} from "../src/connectors/source-identity";
import { ConnectorIntegrationStore } from "../src/connectors/state";
import { openTestDatabases } from "./support/test-databases";

describe("Connector source identity store", () => {
  let workspace: string;
  let store: ConnectorIntegrationStore;
  let close: () => void;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-source-identity-state-"));
    mkdirSync(join(workspace, ".lamarck"), { recursive: true });
    const databases = openTestDatabases(workspace);
    store = new ConnectorIntegrationStore(databases.systemDb);
    close = databases.close;
  });

  afterEach(() => {
    close();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("single identity creation converges on exactly one resolved row", () => {
    const first = store.createSingle({ connectorId: "single-feed" });
    const second = store.createSingle({ connectorId: "single-feed" });

    expect(second.id).toBe(first.id);
    expect(store.listForConnector("single-feed")).toEqual([
      expect.objectContaining({
        id: first.id,
        sourceKey: null,
        lastResolvedKey: null,
        identityStatus: "resolved",
      }),
    ]);
  });

  test("publishes resolved, conflict, and changed identity outcomes atomically", () => {
    const claimed = store.createConnector({ connectorId: "account-feed" });
    const duplicate = store.createConnector({ connectorId: "account-feed" });

    const first = store.publishSourceIdentity(claimed.id, "account-7", "Work account");
    expect(first.outcome).toBe("resolved");
    expect(first.integration).toMatchObject({
      sourceKey: "account-7",
      lastResolvedKey: "account-7",
      identityStatus: "resolved",
      suggestedLabel: "Work account",
      lastError: undefined,
    });

    const conflict = store.publishSourceIdentity(
      duplicate.id,
      "account-7",
      "Duplicate account",
    );
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.integration).toMatchObject({
      sourceKey: null,
      lastResolvedKey: "account-7",
      identityStatus: "conflict",
      suggestedLabel: "Duplicate account",
      lastError: undefined,
    });

    const changed = store.publishSourceIdentity(claimed.id, "account-8", "Personal account");
    expect(changed.outcome).toBe("changed");
    expect(changed.integration).toMatchObject({
      sourceKey: "account-7",
      lastResolvedKey: "account-8",
      identityStatus: "changed",
      suggestedLabel: "Personal account",
      lastError: undefined,
    });
  });

  test("records an identity error without discarding previously observed identity fields", () => {
    const source = store.createConnector({ connectorId: "error-feed" });
    store.publishSourceIdentity(source.id, "account-9", "Primary account");

    const failed = store.publishIdentityError(source.id, "identity endpoint unavailable");
    expect(failed).toMatchObject({
      sourceKey: "account-9",
      lastResolvedKey: "account-9",
      identityStatus: "error",
      suggestedLabel: "Primary account",
      lastError: "identity endpoint unavailable",
    });
  });

  test("rejects invalid source keys before any identity fields are written", () => {
    const source = store.createConnector({ connectorId: "invalid-key-feed" });

    expect(() => store.publishSourceIdentity(source.id, "contains spaces", null))
      .toThrow("Invalid connector source key");
    expect(store.get(source.id)).toMatchObject({
      sourceKey: null,
      lastResolvedKey: null,
      identityStatus: "unresolved",
    });
  });

  test("treats invalid resolver keys as fatal but invalid labels as warnings", () => {
    for (const key of ["", "contains spaces", "slash/key", `x${"y".repeat(128)}`]) {
      expect(() => validateConnectorSourceIdentityResult("resolver-feed", { key }))
        .toThrow("invalid source identity key");
    }

    const warnings: string[] = [];
    expect(validateConnectorSourceIdentityResult(
      "resolver-feed",
      { key: "account._~-7", label: "   " },
      (message) => warnings.push(message),
    )).toEqual({ key: "account._~-7", label: null });
    expect(warnings).toEqual([
      "Connector resolver-feed returned an invalid source label; ignoring it",
    ]);
  });

  test("sanitizes and bounds durable resolver errors", () => {
    const message = sanitizeSourceIdentityError(
      "resolver-feed",
      new Error(`Bearer secret-token api_key=secret-key ${"x".repeat(700)}`),
    );

    expect(message).toContain("Bearer [redacted]");
    expect(message).toContain("api_key=[redacted]");
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("secret-key");
    expect(message.length).toBeLessThanOrEqual(
      "Connector resolver-feed could not resolve Source identity: ".length + 512,
    );
  });
});
