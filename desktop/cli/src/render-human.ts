import type { CliOperation } from "./operations.js";

export function renderHuman(operation: CliOperation, value: unknown): string {
  if (Array.isArray(value)) {
    if (!value.length) return emptyMessage(operation);
    return `${value.map((item) => summaryLine(operation, item)).join("\n")}\n`;
  }
  const result = value as Record<string, unknown>;
  switch (operation) {
    case "schema.change": return `Schema change pending approval: ${result.id}\n`;
    case "source.run": return `Source run accepted: ${result.runId}\n`;
    case "source.run.status": return `Source run ${result.runId}: ${result.outcome ?? result.status}\n`;
    case "source.pause": return `Paused Source ${result.sourceId}.\n`;
    case "source.resume": return `Resumed Source ${result.sourceId}.\n`;
    case "connector.install": case "connector.update":
      return `${result.changed ? (operation === "connector.update" ? "Updated" : "Installed") : "Already current"} ${result.id} (${result.releaseId}).\n`;
    case "connector.remove": return `Removed Connector ${result.id}.\n`;
    case "app.create": return `Created App ${result.id}.\n`;
    case "app.save": return `${result.created ? "Saved" : "Unchanged at"} ${short(result.version)}.\n`;
    case "app.restore": return `${result.created ? "Restored as" : "Unchanged at"} ${short(result.version)}.\n`;
    case "app.refresh": return `Refreshed App ${result.id}.\n`;
    case "app.archive": return `Archived App ${result.id}.\n`;
    default: return `${JSON.stringify(value, null, 2)}\n`;
  }
}

function summaryLine(operation: CliOperation, value: unknown): string {
  const item = value as Record<string, unknown>;
  if (operation === "source.list") return `${item.id}\t${item.name}\t${(item.lifecycle as Record<string, unknown>)?.state ?? ""}`;
  if (operation === "connector.list") return `${item.id}\t${item.name}\t${item.trust}\t${item.sourceCount} source(s)`;
  if (operation === "app.list") return `${item.id}\t${item.name ?? ""}\t${short((item.lifecycle as Record<string, unknown>)?.version)}`;
  if (operation === "app.versions") return `${short(item.version)}\t${item.trigger}\t${new Date(Number(item.createdAt)).toISOString()}${item.message ? `\t${item.message}` : ""}`;
  return JSON.stringify(value);
}
function emptyMessage(operation: CliOperation): string {
  if (operation === "source.list") return "No Sources.\n";
  if (operation === "connector.list") return "No Connectors installed.\n";
  if (operation === "app.list") return "No Apps.\n";
  if (operation === "app.versions") return "No App versions.\n";
  return "[]\n";
}
function short(value: unknown): string { return typeof value === "string" ? value.slice(0, 12) : "unversioned"; }
