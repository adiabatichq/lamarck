import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useConnectors: vi.fn(),
}));

vi.mock("../hooks/useConnectors", () => ({
  useConnectors: mocks.useConnectors,
}));

import { ConnectorCatalogView } from "./ConnectorCatalogView";
import { ConnectorsView } from "./ConnectorsView";
import type { ConnectorIntegrationView } from "../lib/api";

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

const updateCandidate = {
  connectorId: "github",
  name: "GitHub",
  description: "GitHub activity.",
  mode: "poll" as const,
  identityKind: "connector" as const,
  authType: "managedProvider" as const,
  supported: true,
  installed: true,
  catalogHash: "sha256:catalog-package",
  installedHash: "sha256:installed-package",
  updateAvailable: true,
};

const installCandidate = {
  connectorId: "google-calendar",
  name: "Google Calendar",
  description: "Calendar activity.",
  mode: "poll" as const,
  identityKind: "connector" as const,
  authType: "oauth2-public" as const,
  supported: true,
  installed: false,
  catalogHash: "sha256:calendar-package",
  updateAvailable: false,
};

const identitySource: ConnectorIntegrationView = {
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
      available: [updateCandidate, installCandidate],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  test("keeps installed Connector lifecycle actions out of the Catalog", () => {
    const markup = renderToStaticMarkup(
      <ConnectorCatalogView onOpenConsole={() => {}} />,
    );

    expect(markup).toContain("UPDATE AVAILABLE");
    expect(markup).toContain("Install connector");
    expect(markup).toContain("Manage in Source Console");
    expect(markup).not.toContain("Update connector");
    expect(markup).not.toContain("Add source");
    expect(markup).not.toContain("Remove connector");
  });

  test("offers available package updates from the Source Console", () => {
    const markup = renderToStaticMarkup(<ConnectorsView />);

    expect(markup).toContain("UPDATE AVAILABLE");
    expect(markup).toContain("Update connector…");
  });

  test("shows Source identity, ownership, conflict, rename, and retry controls", () => {
    mocks.useConnectors.mockReturnValue({
      sources: [identitySource],
      packages: [installedConnector],
      available: [updateCandidate],
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
      available: [],
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
