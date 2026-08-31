import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { AppInfo } from "../lib/api";
import { UseWorkspace } from "./UseWorkspace";

function app(id: string, name: string): AppInfo {
  return {
    schemaVersion: 1,
    id,
    path: `/workspace/apps/${id}`,
    version: null,
    packageDirty: true,
    manifestHealth: { status: "valid" },
    versionHealth: { status: "unversioned" },
    name,
    description: `${name} App`,
    runtime: {
      ui: {
        command: ["node", "index.mjs"],
        port: 3000,
      },
    },
    permissions: {
      writes: {
        files: [],
        tables: [],
      },
    },
  };
}

describe("Use workspace App rail", () => {
  const mail = app("mail", "Mail");
  const notes = app("notes", "Notes");

  test("places pinned Apps above open-only Apps and exposes the active close action", () => {
    const markup = renderToStaticMarkup(
      <UseWorkspace
        apps={[notes, mail]}
        activeApp={notes}
        pinnedIds={["mail"]}
        openIds={["notes", "mail"]}
        launcherOpen={false}
        launcher={null}
        appSurface={<div>Notes surface</div>}
        coreStatus="connected"
        systemNeedsAttention={false}
        onToggleLauncher={() => {}}
        onOpenApp={() => {}}
        onCloseApp={() => {}}
        onTogglePin={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    expect(markup.indexOf("Switch to Mail")).toBeLessThan(markup.indexOf("Switch to Notes"));
    expect(markup).toContain('aria-label="Close Notes"');
    expect(markup).toContain("Notes surface");
  });

  test("keeps a closed pinned App in the rail", () => {
    const markup = renderToStaticMarkup(
      <UseWorkspace
        apps={[notes, mail]}
        activeApp={notes}
        pinnedIds={["mail"]}
        openIds={["notes"]}
        launcherOpen={false}
        launcher={null}
        appSurface={<div>Notes surface</div>}
        coreStatus="connected"
        systemNeedsAttention={false}
        onToggleLauncher={() => {}}
        onOpenApp={() => {}}
        onCloseApp={() => {}}
        onTogglePin={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Open Mail"');
    expect(markup).toContain("appPinDormant");
  });

  test("offers blank App creation and Marketplace discovery in an empty Workspace", () => {
    const markup = renderToStaticMarkup(
      <UseWorkspace
        apps={[]}
        activeApp={null}
        pinnedIds={[]}
        openIds={[]}
        launcherOpen={false}
        launcher={null}
        appSurface={null}
        coreStatus="connected"
        systemNeedsAttention={false}
        onToggleLauncher={() => {}}
        onOpenApp={() => {}}
        onCloseApp={() => {}}
        onTogglePin={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    expect(markup).toContain("Create Blank App");
    expect(markup).toContain("Explore Marketplace");
    expect(markup).not.toContain("Include starter apps");
  });
});
