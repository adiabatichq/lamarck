// Source lifecycle is intentionally small: an existing Source is Active or
// Paused. Setup, runtime activity, health, trust, and platform support are
// independent observations/conditions.

import type {
  ConnectorSourceView,
  ConnectorSetupPendingReason,
  InstalledConnectorView,
} from "./api";

export type SourceLifecycle = "active" | "paused";

export function sourceIsPaused(c: ConnectorSourceView, now = Date.now()): boolean {
  if (c.pausedAt === undefined) return false;
  return c.resumeAt === undefined || c.resumeAt > now;
}

export function sourceLifecycle(c: ConnectorSourceView, now = Date.now()): SourceLifecycle {
  if (sourceIsPaused(c, now)) return "paused";
  return "active";
}

export function sourceHasAutomaticActivity(c: ConnectorSourceView): boolean {
  return c.mode === "watch" || (c.mode === "poll" && Boolean(c.scheduleCron));
}

export const SOURCE_LIFECYCLE_LABEL: Record<SourceLifecycle, string> = {
  active: "ACTIVE",
  paused: "PAUSED",
};

export function sourceShownName(
  c: Pick<
    ConnectorSourceView,
    "displayName" | "suggestedLabel" | "connectorName"
  >,
): string {
  return c.displayName ?? c.suggestedLabel ?? c.connectorName;
}

export function sourceRunsHere(c: Pick<ConnectorSourceView, "ownership">): boolean {
  return c.ownership === "here";
}

// Health is a secondary condition. A paused source can still need attention,
// and a failed run does not silently change its lifecycle.
export function sourceNeedsAttention(c: ConnectorSourceView): boolean {
  return Boolean(
    c.authAttention
      || c.status === "error"
      || c.warnings?.length
      || c.ownership === "device-unknown"
      || c.identityStatus === "conflict"
      || c.identityStatus === "changed"
      || c.identityStatus === "error",
  );
}

// Trust collapses to what a user must understand: official, approved custom,
// needs approval, or broken (package gone/invalid).
export type TrustView = "official" | "custom" | "needs-approval" | "broken";

export function trustView(c: Pick<ConnectorSourceView | InstalledConnectorView, "packageTrust">): TrustView {
  switch (c.packageTrust) {
    case "official":
      return "official";
    case "custom":
      return "custom";
    case "untrusted":
    case "modified":
      return "needs-approval";
    default:
      return "broken";
  }
}

export function sourceNeedsSetup(c: ConnectorSourceView): boolean {
  return c.setupPending.length > 0;
}

export function connectorNeedsAttention(
  c: Pick<ConnectorSourceView | InstalledConnectorView, "packageTrust" | "supported">,
): boolean {
  const trust = trustView(c);
  return !c.supported || trust === "needs-approval" || trust === "broken";
}

const SETUP_NEED_LABEL: Record<ConnectorSetupPendingReason, string> = {
  identity: "source identity",
  auth: "account connection",
  requirements: "permission grants",
  config: "settings",
};

export function setupNeeds(c: ConnectorSourceView): string[] {
  return c.setupPending.map((reason) => SETUP_NEED_LABEL[reason]);
}

export function relativeTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return "—";
  const delta = now - ts;
  const future = delta < 0;
  const abs = Math.abs(delta);
  const units: Array<[number, string]> = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [ms, suffix] of units) {
    if (abs >= ms) {
      const value = Math.floor(abs / ms);
      return future ? `in ${value}${suffix}` : `${value}${suffix} ago`;
    }
  }
  return "now";
}
