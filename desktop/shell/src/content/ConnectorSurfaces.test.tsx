import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useConnectors: vi.fn(),
}));

vi.mock("../hooks/useConnectors", () => ({
  useConnectors: mocks.useConnectors,
}));

import { ConnectorsView } from "./ConnectorsView";
import type { ConnectorSourceView } from "../lib/api";

const installedConnector = {
  connectorId: "github",
  name: "GitHub",
  description: "GitHub activity.",
  mode: "poll" as const,
  identityKind: "connector" as const,
  supported: true,
  packageTrust: "official" as const,
  packageHash: "sha256:installed-package",
};

const identitySource: ConnectorSourceView = {
  id: "source-new",
  connectorId: "github",
  connectorName: "GitHub",
  sourceKey: null,
  displayName: "Personal GitHub",
  suggestedLabel: "octocat",
  identityKind: "connector",
  identityStatus: "conflict",
  ownership: "here",
  conflictSourceId: "source-existing",
  name: "Personal GitHub",
  description: "GitHub activity.",
  mode: "poll",
  status: "idle",
  setupStatus: "setup",
  packageTrust: "official",
  authType: "managedProvider",
  authReady: true,
  setupPending: ["identity"],
  source: null,
  running: false,
  supported: true,
  requirements: [],
};

describe("Connector surface responsibilities", () => {
  beforeEach(() => {
    mocks.useConnectors.mockReset();
    mocks.useConnectors.mockReturnValue({
      sources: [],
      packages: [installedConnector],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  test("keeps installed management and delegates discovery to Marketplace", () => {
    const markup = renderToStaticMarkup(<ConnectorsView />);

    expect(markup).toContain("Open Marketplace");
    expect(markup).toContain("INSTALLED");
    expect(markup).toContain("Add source");
    expect(markup).toContain("Remove connector");
    expect(markup).not.toContain("UPDATE AVAILABLE");
    expect(markup).not.toContain("Connector Catalog");
  });

  test("shows a package-level update action when Core reports a newer content hash", () => {
    mocks.useConnectors.mockReturnValue({
      sources: [],
      packages: [{ ...installedConnector, updateAvailable: true }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<ConnectorsView />);

    expect(markup).toContain("UPDATE AVAILABLE");
    expect(markup).toContain(">Update</button>");
    expect(markup).toContain("Remove connector…");
  });

  test("shows Source identity, ownership, conflict, rename, and retry controls", () => {
    mocks.useConnectors.mockReturnValue({
      sources: [identitySource],
      packages: [installedConnector],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<ConnectorsView />);

    expect(markup).toContain("Personal GitHub");
    expect(markup).toContain("identity conflict");
    expect(markup).toContain("connector identity");
    expect(markup).toContain("runs on this device");
    expect(markup).toContain("Open existing Source");
    expect(markup).toContain("Retry identity");
    expect(markup).toContain("Rename…");
  });

  test("waits for account connection before enabling identity retry", () => {
    mocks.useConnectors.mockReturnValue({
      sources: [{
        ...identitySource,
        identityStatus: "unresolved" as const,
        conflictSourceId: undefined,
        authReady: false,
        setupPending: ["auth", "identity"],
      }],
      packages: [installedConnector],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<ConnectorsView />);

    expect(markup).toContain("Connect an account before resolving identity");
    expect(markup).toContain("Connect Account");
  });

  test("presents another-device ownership without local run controls", () => {
    mocks.useConnectors.mockReturnValue({
      sources: [{
        ...identitySource,
        sourceKey: "github:octocat",
        identityStatus: "resolved" as const,
        ownership: "other-device" as const,
        status: "error" as const,
        setupStatus: "ready" as const,
        setupPending: [],
      }],
      packages: [installedConnector],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<ConnectorsView />);

    expect(markup).toContain("runs on another device");
    expect(markup).toContain("does not run here");
    expect(markup).not.toContain("Run now");
    expect(markup).not.toContain("Retry now");
  });
});
