import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { AppInfo } from "../lib/api";
import { UseWorkspace } from "./UseWorkspace";

function app(id: string, name: string): AppInfo {
  return {
    manifestVersion: 1,
    id,
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
        docs: [],
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
});
