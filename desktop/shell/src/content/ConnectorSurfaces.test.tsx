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

const installedConnector = {
  connectorId: "github",
  name: "GitHub",
  mode: "poll" as const,
  integrationsMode: "multiple" as const,
  supported: true,
  packageTrust: "official" as const,
  packageHash: "sha256:installed-package",
};

const updateCandidate = {
  connectorId: "github",
  name: "GitHub",
  mode: "poll" as const,
  integrationsMode: "multiple" as const,
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
  mode: "poll" as const,
  integrationsMode: "multiple" as const,
  authType: "oauth2-public" as const,
  supported: true,
  installed: false,
  catalogHash: "sha256:calendar-package",
  updateAvailable: false,
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
});
