import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceSetup } from "./WorkspaceSetup";

afterEach(() => vi.unstubAllGlobals());

test("offers Reset system settings beside Try again only on the startup failure screen", () => {
  vi.stubGlobal("window", {});
  const props = {
    onReady: () => {}, onRetry: async () => {}, onResetSystemSettings: async () => {},
  };
  const markup = renderToStaticMarkup(<WorkspaceSetup {...props} state={{
    status: "setup", reason: "startup-failed", suggestedPath: "",
    previousWorkspace: { lastKnownPath: "/workspace", vaultId: "vault-a" },
    detail: "This Workspace’s database structure is incompatible with this version of Lamarck.",
    canResetSystemSettings: true,
  }} />);
  expect(markup).toMatch(/Try again<\/button><button[^>]*>Reset system settings…<\/button>/);
  const fresh = renderToStaticMarkup(<WorkspaceSetup {...props} state={{
    status: "setup", reason: "first-run", suggestedPath: "",
  }} />);
  expect(fresh).not.toContain("Reset system settings");
});

test.each(["Core port is in use", "Permission denied", "Core startup timed out", "The Lamarck Host is unavailable"])(
  "hides reset without a positive Host diagnosis: %s", detail => {
    vi.stubGlobal("window", {});
    const markup = renderToStaticMarkup(<WorkspaceSetup state={{
      status: "setup", reason: "startup-failed", suggestedPath: "", detail,
    }} onReady={() => {}} onRetry={async () => {}} onResetSystemSettings={async () => {}} />);
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("Reset system settings");
  },
);
