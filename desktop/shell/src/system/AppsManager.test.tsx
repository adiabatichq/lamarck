import { renderToStaticMarkup } from "react-dom/server";
import { Children, isValidElement, type ReactNode, type ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";
import type { AppHistoryView, AppRuntimeView } from "../hooks/useAppsManager";
import type { AppInfo, AppVersionRecordV1, TriggerSummary } from "../lib/api";
import { AppActivityView, AppEnablementSwitch, AppServices } from "./AppWorkloadManagement";
import { AppVersions } from "./AppManagementDetails";
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
    ] }, onStopJob: vi.fn(), onManageTriggers: vi.fn(), ...overrides,
  });
  test("App and declared Service toggles show independent persisted choices without Stop App or restart controls", () => {
    const html = renderToStaticMarkup(<><AppEnablementSwitch enabled={false} label="App enabled" disabled={false} onChange={vi.fn()} /><AppServices appEnabled={false} pending={null} onChange={vi.fn()} services={[
      { serviceId: "indexer", enabled: true, state: "stopped", executionId: null, restartAt: null, failure: null },
      { serviceId: "sync", enabled: false, state: "disabled", executionId: null, restartAt: null, failure: null },
    ]} /></>);
    expect(html).toContain('aria-label="App enabled" aria-checked="false"');
    expect(html).toContain('aria-label="Service indexer enabled" aria-checked="true"');
    expect(html).toContain('aria-label="Service sync enabled" aria-checked="false"');
    expect(html).not.toMatch(/Stop App|Restart service|Resume service/);
  });
  test("shows starting and running invocations by declared job/run and available Trigger association", () => {
    const html = renderToStaticMarkup(execution());
    for (const text of ["Inbox", "run-a", "run-b", "Starting", "Running", "View trigger", "Run details"]) expect(html).toContain(text);
    expect(html).not.toContain("Launch job"); expect(html).not.toContain("Retry");
  });
  test("job and Trigger actions carry only the selected execution identity", () => {
    const onStopJob = vi.fn(), onManageTriggers = vi.fn();
    const buttons = elements(execution({ onStopJob, onManageTriggers })).filter(node => node.type === "button");
    buttons.find(node => node.props["aria-label"] === "Stop job inbox, run run-a")!.props.onClick();
    expect(onStopJob.mock.calls).toEqual([["notes", "run-a"]]);
    buttons.find(node => node.props.children === "View trigger")!.props.onClick(); expect(onManageTriggers.mock.calls).toEqual([["notes", "trigger-a"]]);
  });
  test("pending and failed cleanup remain visible with stop actions disabled instead of reporting completion", () => {
    const tree = execution({ pending: new Set(["job:run-a", "ui:notes"]), runtime: { ...runtime("notes", 2), ui: "running", jobs: [
      { jobId: "inbox", runId: "run-a", triggerId: null, state: "running", cleanupError: null },
      { jobId: "inbox", runId: "run-b", triggerId: "trigger-b", state: "cleanup-failed", cleanupError: "VM stop unconfirmed; restart required" },
    ] }, error: "App stop could not be confirmed" });
    const html = renderToStaticMarkup(tree);
    for (const text of ["waiting for cleanup", "Cleanup failed", "stop unconfirmed", "restart required"]) expect(html).toContain(text);
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
  test("failed authority cleanup stays visible and confirmed recovery clears the active row", () => {
    const failed: AppRuntimeView = { ...runtime("notes", 1, "Job authority cleanup failed"), ui: "closed", jobs: [
      { jobId: "inbox", runId: "run-a", triggerId: null, state: "cleanup-failed", cleanupError: "Job authority cleanup failed; stop was not confirmed" },
    ] };
    const tree = execution({ runtime: failed });
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
    expect(render(notes, history)).toContain("Manage triggers");
    expect(render(app("ui-only"), history)).not.toContain("Manage triggers");
  });
  test("derives runtime health and represents a disabled App without claiming it is Ready", () => {
    expect(deriveAppPrimaryStatus(app("disabled"), { ...runtime("disabled"), enabled: false })).toEqual({ status: "Disabled", detail: null });
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

  test("prioritizes management and keeps history, grants, and diagnostics out of the default view", () => {
    const notes = app("notes");
    const markup = render(notes, history);

    expect(markup).toContain('role="tablist"');
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Manage/);
    expect(markup).toContain("Open app");
    for (const text of ["apps/notes/", "shared/notes/", "note_index", latest.version, "Recent activity", "process output", "Restore this version"]) expect(markup).not.toContain(text);
    expect(markup).not.toContain(">Save<");
    expect(markup).not.toContain("source editor");
  });

  test("requires an explicit restore confirmation and states that restore does not launch", () => {
    const notes = app("notes");
    const markup = render(notes, history, { kind: "restore", app: notes, version: older });

    expect(markup).toContain('<dialog');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Restore Notes?");
    expect(markup).toContain("creates a new version");
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

  test("retains history pagination and restores with the exact selected version", () => {
    const notes = app("notes"), restore = vi.fn(), more = vi.fn();
    const tree = AppVersions({ app: notes, history, busy: null, onLoadMore: more, onRequestRestore: restore, onRequestRebuild: vi.fn() });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Current version");
    expect(html).toContain("Load earlier versions");
    const buttons = elements(tree).filter(node => node.type === "button");
    buttons.find(node => node.props.children === "Restore this version")!.props.onClick();
    expect(restore.mock.calls).toEqual([[notes, older]]);
    buttons.find(node => node.props.onClick === more)!.props.onClick();
    expect(more).toHaveBeenCalledOnce();
  });

  test("puts execution IDs and bounded output inside technical details in Activity", () => {
    const html = renderToStaticMarkup(<AppActivityView loading={false} error={null} diagnostics={[{
      appId: "notes", kind: "job", workloadId: "inbox", executionId: "run-a", version: latest.version,
      startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000, failure: null, output: "Private process output", droppedBytes: 64,
    }]} />);
    expect(html).toContain("Finished");
    expect(html).toMatch(/<summary>Technical details<\/summary>[\s\S]*run-a[\s\S]*Private process output/);
    expect(html).not.toMatch(/<details[^>]*\sopen[\s=>]/);
    expect(html).toContain("64 bytes");
    expect(renderToStaticMarkup(<AppActivityView diagnostics={[]} loading={false} error="Host unavailable" />)).toContain("could not be loaded");
  });

  test.each([
    ["job", "Job stopped by user", "Canceled"],
    ["service", "Service disabled", "Stopped"],
    ["service", "App stopped", "Stopped"],
    ["job", "Host stopped", "Canceled"],
    ["service", "Service activation replaced", "Stopped"],
    ["service", "Service declaration retired", "Stopped"],
    ["job", "App retired", "Canceled"],
  ] as const)("shows a normally stopped %s (%s) without a failure alert", (kind, failure, status) => {
    const html = renderToStaticMarkup(<AppActivityView loading={false} error={null} diagnostics={[{
      appId: "notes", kind, workloadId: "inbox", executionId: "run-a", version: latest.version,
      startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000, failure, output: "", droppedBytes: 0,
    }]} />);
    expect(html).toContain(status);
    expect(html).toContain(failure);
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain('role="alert"');
  });

  test.each(["Job authority cleanup failed", "Service exited unexpectedly", "Job stopped by user; cleanup failed", "Capsule boundary lost"])("retains the failure alert for %s", failure => {
    const html = renderToStaticMarkup(<AppActivityView loading={false} error={null} diagnostics={[{
      appId: "notes", kind: "job", workloadId: "inbox", executionId: "run-a", version: latest.version,
      startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000, failure, output: "", droppedBytes: 0,
    }]} />);
    expect(html).toContain("Needs attention");
    expect(html).toContain('role="alert"');
    expect(html).toContain(failure);
  });

  test("declared idle jobs retain their last result and hide Next for a disabled schedule or App", () => {
    const trigger: TriggerSummary = { id: "schedule-a", revision: 1, name: "Evening review", target: "app:notes:job:evening-review", kind: "schedule",
      enabled: false, available: true, unavailableReason: null, error: null, nextRunAt: 1_700_000_999_000,
      lastRun: { id: "finished", triggerId: "schedule-a", revision: 1, name: "Evening review", target: "app:notes:job:evening-review", status: "success",
        createdAt: 1_700_000_000_000, startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000, error: null, input: { kind: "schedule", scheduledAt: 1_700_000_000_000 } } };
    const view = (enabled: boolean, appEnabled: boolean) => renderToStaticMarkup(execution({ runtime: { ...runtime("notes"), enabled: appEnabled }, jobIds: ["evening-review"], triggers: [{ ...trigger, enabled }] }));
    expect(view(false, true)).toContain("Evening review");
    expect(view(false, true)).toContain("Last run: Completed");
    expect(view(false, true)).not.toContain("Next ");
    expect(view(true, false)).not.toContain("Next ");
    expect(view(true, true)).toContain("Next ");
    expect(view(false, true)).not.toContain("Launch job");
  });

  test("unknown enablement cannot be toggled and Service cleanup failures remain visible when App is disabled", () => {
    const unknown = renderToStaticMarkup(<AppEnablementSwitch enabled={undefined} label="App enabled" disabled={false} onChange={vi.fn()} />);
    expect(unknown).toContain("Checking");
    expect(unknown).toContain("disabled");
    const html = renderToStaticMarkup(<AppServices appEnabled={false} pending={null} onChange={vi.fn()} services={[
      { serviceId: "indexer", enabled: true, state: "cleanup-failed", executionId: "service-a", restartAt: null, failure: "Stop unconfirmed" },
    ]} />);
    expect(html).toContain("Cleanup failed · stop unconfirmed");
    expect(html).toContain("Stop unconfirmed");
    expect(html).toContain('aria-checked="true"');
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
  return { appId, enabled: true, runningWorkloads, latestFailure };
}
