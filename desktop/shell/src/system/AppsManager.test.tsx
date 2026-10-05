import { renderToStaticMarkup } from "react-dom/server";
import { Children, isValidElement, type ReactNode, type ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";
import type { AppHistoryView, AppRuntimeView } from "../hooks/useAppsManager";
import type { AppInfo, AppVersionRecordV1 } from "../lib/api";
import { AppExecutionView, AppsManagerView, deriveAppPrimaryStatus } from "./AppsManager";

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
  const execution = (overrides: Partial<Parameters<typeof AppExecutionView>[0]> = {}) => AppExecutionView({
    appId: "notes", loading: false, pending: new Set(), error: null,
    runtime: { ...runtime("notes", 3), ui: "running", jobs: [
      { runId: "run-a", jobId: "inbox", triggerId: "trigger-a", state: "starting", cleanupError: null },
      { runId: "run-b", jobId: "inbox", triggerId: null, state: "running", cleanupError: null },
    ] }, onStopJob: vi.fn(), onCloseUi: vi.fn(), onStopApp: vi.fn(), onManageTriggers: vi.fn(), ...overrides,
  });
  test("shows starting and running invocations by declared job/run and available Trigger association", () => {
    const html = renderToStaticMarkup(execution());
    for (const text of ["inbox", "run-a", "run-b", "Starting", "Running", "Trigger trigger-a", "Close UI", "Stop App", "keeps jobs running"]) expect(html).toContain(text);
    expect(html).not.toContain("Launch job"); expect(html).not.toContain("Service"); expect(html).not.toContain("Retry");
  });
  test("job, UI, App and Trigger actions carry only the selected execution identity", () => {
    const onStopJob = vi.fn(), onCloseUi = vi.fn(), onStopApp = vi.fn(), onManageTriggers = vi.fn();
    const buttons = elements(execution({ onStopJob, onCloseUi, onStopApp, onManageTriggers })).filter(node => node.type === "button");
    buttons.find(node => node.props["aria-label"] === "Stop job inbox, run run-a")!.props.onClick();
    expect(onStopJob.mock.calls).toEqual([["notes", "run-a"]]);
    buttons.find(node => node.props.children === "Close UI")!.props.onClick(); expect(onCloseUi.mock.calls).toEqual([["notes"]]);
    buttons.find(node => node.props.children === "Stop App")!.props.onClick(); expect(onStopApp.mock.calls).toEqual([["notes"]]);
    buttons.find(node => renderToStaticMarkup(node).includes("Trigger trigger-a"))!.props.onClick(); expect(onManageTriggers.mock.calls).toEqual([["notes", "trigger-a"]]);
  });
  test("pending and failed cleanup remain visible with stop actions disabled instead of reporting completion", () => {
    const tree = execution({ pending: new Set(["job:run-a", "ui:notes"]), runtime: { ...runtime("notes", 2), ui: "running", jobs: [
      { jobId: "inbox", runId: "run-a", triggerId: null, state: "running", cleanupError: null },
      { jobId: "inbox", runId: "run-b", triggerId: "trigger-b", state: "cleanup-failed", cleanupError: "VM stop unconfirmed; restart required" },
    ] }, error: "App stop could not be confirmed" });
    const html = renderToStaticMarkup(tree);
    for (const text of ["waiting for cleanup", "Cleanup failed", "stop unconfirmed", "restart required", "App stop could not be confirmed", "Closing UI"]) expect(html).toContain(text);
    const stops = elements(tree).filter(node => node.type === "button" && node.props["aria-label"]?.startsWith("Stop job"));
    expect(stops.every(node => node.props.disabled)).toBe(true);
    expect(html).not.toContain("No active jobs");
    expect(renderToStaticMarkup(execution({ pending: new Set(["app:notes"]) }))).toContain("Stopping App · waiting for cleanup");
  });
  test("finished jobs disappear after authoritative refresh; unavailable state is never reported as confirmed empty", () => {
    expect(renderToStaticMarkup(execution({ runtime: runtime("notes") }))).toContain("No active jobs");
    expect(renderToStaticMarkup(execution({ runtime: undefined, error: "Host unavailable" }))).toContain("could not be confirmed");
    expect(renderToStaticMarkup(execution({ runtime: undefined, loading: true }))).toContain("Checking active jobs");
  });
  test("App stop stays available for failed authority cleanup and confirmed recovery clears the active row", () => {
    const onStopApp = vi.fn();
    const failed: AppRuntimeView = { ...runtime("notes", 1, "Job authority cleanup failed"), ui: "closed", jobs: [
      { jobId: "inbox", runId: "run-a", triggerId: null, state: "cleanup-failed", cleanupError: "Job authority cleanup failed; stop was not confirmed" },
    ] };
    const tree = execution({ runtime: failed, onStopApp });
    const stop = elements(tree).find(node => node.type === "button" && node.props.children === "Stop App")!;
    expect(stop.props.disabled).toBe(false);
    stop.props.onClick(); expect(onStopApp).toHaveBeenCalledWith("notes");
    const stopping = execution({ runtime: { ...failed, stopping: true, jobs: [{ ...failed.jobs![0], state: "stopping", cleanupError: null }] } });
    expect(renderToStaticMarkup(stopping)).toContain("waiting for cleanup");
    expect(renderToStaticMarkup(stopping)).not.toContain("No active jobs");
    const recovered: AppRuntimeView = { ...runtime("notes"), ui: "closed", jobs: [] };
    expect(renderToStaticMarkup(execution({ runtime: recovered }))).not.toContain("Cleanup failed");
    expect(renderToStaticMarkup(execution({ runtime: recovered }))).toContain("No active jobs");
    expect(deriveAppPrimaryStatus(app("notes"), recovered).status).toBe("Ready");
  });
  test("links declared job Apps to Trigger management", () => {
    const notes = app("notes"); notes.runtime!.jobs = { inbox: { command: ["node", "inbox.js"] } };
    expect(render(notes, history)).toContain("Manage Triggers");
    expect(render(app("ui-only"), history)).not.toContain("Manage Triggers");
  });
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

function elements(tree: ReactNode): ReactElement<Record<string, any>>[] {
  return Children.toArray(tree).flatMap(node => isValidElement<Record<string, any>>(node)
    ? [node, ...elements(node.props.children)] : []);
}

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
    onManageTriggers={vi.fn()}
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
