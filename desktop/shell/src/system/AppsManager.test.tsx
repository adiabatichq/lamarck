import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { AppHistoryView, AppRuntimeView } from "../hooks/useAppsManager";
import type { AppInfo, AppVersionRecordV1 } from "../lib/api";
import { AppsManagerView, deriveAppPrimaryStatus } from "./AppsManager";

const latest: AppVersionRecordV1 = {
  schemaVersion: 1,
  appId: "notes",
  version: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  parentVersion: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  trigger: "save",
  createdAt: 1_700_000_001_000,
  message: "Add search",
  author: "Ada",
};

const older: AppVersionRecordV1 = {
  schemaVersion: 1,
  appId: "notes",
  version: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  parentVersion: null,
  trigger: "activate",
  createdAt: 1_700_000_000_000,
};

const history: AppHistoryView = {
  versions: [latest, older],
  nextCursor: "next-page",
  loading: false,
  error: null,
};

describe("Apps Manager", () => {
  test("derives only Running, Ready, and Failed from runtime and health", () => {
    expect(deriveAppPrimaryStatus(app("ready"))).toEqual({ status: "Ready", detail: null });
    expect(deriveAppPrimaryStatus(app("running"), runtime("running", 2))).toEqual({
      status: "Running",
      detail: null,
    });
    expect(deriveAppPrimaryStatus(app("failed"), runtime("failed", 1, "build failed"))).toEqual({
      status: "Failed",
      detail: "build failed",
    });
    expect(deriveAppPrimaryStatus(app("invalid", { manifest: "invalid" }))).toMatchObject({
      status: "Failed",
      detail: "manifest invalid",
    });
    expect(deriveAppPrimaryStatus(app("history", { history: "unavailable" }))).toMatchObject({
      status: "Failed",
      detail: "App version history is unavailable",
    });

    const repaired = app("repaired");
    expect(deriveAppPrimaryStatus(repaired)).toEqual({ status: "Ready", detail: null });
    expect(deriveAppPrimaryStatus(repaired, runtime("repaired", 0, "launch failed"))).toEqual({
      status: "Failed",
      detail: "launch failed",
    });
  });

  test("renders actual grants, paginated history, and no editor or ordinary Save action", () => {
    const notes = app("notes");
    const markup = render(notes, history);

    expect(markup).toContain("Running");
    expect(markup).toContain("apps/notes/");
    expect(markup).toContain("shared/notes/");
    expect(markup).toContain("note_index");
    expect(markup).toContain("aaaaaaaaa");
    expect(markup).toContain("Latest");
    expect(markup).toContain("Restore version bbbbbbbbb");
    expect(markup).toContain("Load earlier versions");
    expect(markup).not.toContain(">Save<");
    expect(markup).not.toContain("source editor");
  });

  test("requires an explicit restore confirmation and states that restore does not launch", () => {
    const notes = app("notes");
    const markup = render(notes, history, { kind: "restore", app: notes, version: older });

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Restore bbbbbbbbb?");
    expect(markup).toContain("creates a new forward version");
    expect(markup).toContain("It does not launch the App");
    expect(markup).toContain("Restore version");
  });

  test("shows rebuild only for unavailable history with the data-loss warning", () => {
    const broken = app("broken", { history: "unavailable" });
    const markup = render(broken, { ...history, versions: [] }, { kind: "rebuild", app: broken });

    expect(markup).toContain("App version history is unavailable");
    expect(markup).toContain("Rebuild version history");
    expect(markup).toContain("Unrecoverable versions will disappear");
    expect(markup).toContain("historical D0 evidence is not changed");
  });
});

function render(
  selected: AppInfo,
  selectedHistory: AppHistoryView,
  pending: Parameters<typeof AppsManagerView>[0]["pending"] = null,
): string {
  const runtimeState = runtime(selected.id, selected.id === "notes" ? 1 : 0);
  return renderToStaticMarkup(<AppsManagerView
    apps={[selected]}
    selected={selected}
    runtimeByApp={new Map([[selected.id, runtimeState]])}
    selectedRuntime={runtimeState}
    history={selectedHistory}
    loading={false}
    error={null}
    busy={null}
    pending={pending}
    onSelect={vi.fn()}
    onOpenApp={vi.fn()}
    onLoadMore={vi.fn()}
    onRequestRestore={vi.fn()}
    onRequestRebuild={vi.fn()}
    onCancel={vi.fn()}
    onConfirm={vi.fn()}
  />);
}

function app(
  id: string,
  health: { manifest?: "invalid"; history?: "unavailable" } = {},
): AppInfo {
  return {
    schemaVersion: 1,
    id,
    path: `/workspace/apps/${id}`,
    version: latest.version,
    packageDirty: false,
    manifestHealth: health.manifest === "invalid"
      ? { status: "invalid", message: "manifest invalid" }
      : { status: "valid" },
    versionHealth: health.history === "unavailable"
      ? { status: "unavailable", message: "App version history is unavailable" }
      : { status: "healthy" },
    name: id === "notes" ? "Notes" : id,
    description: "Example App",
    runtime: { ui: { command: ["node", "server.mjs"], port: 3000 } },
    permissions: {
      writes: {
        files: ["shared/notes/"],
        tables: ["note_index"],
      },
    },
  };
}

function runtime(
  appId: string,
  runningWorkloads = 0,
  latestFailure: string | null = null,
): AppRuntimeView {
  return { appId, runningWorkloads, latestFailure };
}
