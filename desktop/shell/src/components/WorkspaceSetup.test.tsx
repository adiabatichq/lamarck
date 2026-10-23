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
  }} />);
  expect(markup).toMatch(/Try again<\/button><button[^>]*>Reset system settings…<\/button>/);
  const fresh = renderToStaticMarkup(<WorkspaceSetup {...props} state={{
    status: "setup", reason: "first-run", suggestedPath: "",
  }} />);
  expect(fresh).not.toContain("Reset system settings");
});
