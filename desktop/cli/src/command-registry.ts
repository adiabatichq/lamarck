import type { CliEnvironment, CliOperation } from "./operations.js";

export interface CommandDefinition {
  readonly path: readonly string[];
  readonly operation: CliOperation;
  readonly usage: string;
  readonly description: string;
  readonly environments: readonly CliEnvironment[];
}

const both = ["host", "managed"] as const;
export const COMMAND_REGISTRY: readonly CommandDefinition[] = Object.freeze([
  command(["query"], "query", 'query "<read-only-sql>" [--json]', "Run a read-only D0 or D2 query.", both),
  command(["schema", "change"], "schema.change", 'schema change <ddl>|--file <schema.sql> [--author <author>] [--context <text>] [--json]', "Submit a schema change for human approval.", both),
  command(["file"], "file.command", "file [--author <author>] <ls|cat|stat|tee|cp|mv|rm|mkdir> ...", "Use the Workspace file authority.", both),
  command(["file", "import"], "file.import", "file import <host-source> <file-destination> [--author <author>]", "Import a Host path into Workspace Files.", ["host"]),
  command(["file", "export"], "file.export", "file export <file-source> <host-destination>", "Export Workspace Files to a Host path.", ["host"]),
  command(["source", "list"], "source.list", "source list [--json]", "List current Sources.", both),
  command(["source", "inspect"], "source.inspect", "source inspect <source-id> [--json]", "Inspect one Source.", both),
  command(["source", "run"], "source.run", "source run <source-id> [--wait] [--json]", "Start one manual Source run.", both),
  command(["source", "pause"], "source.pause", "source pause <source-id> [--json]", "Pause automatic Source execution.", both),
  command(["source", "resume"], "source.resume", "source resume <source-id> [--json]", "Resume automatic Source execution.", both),
  command(["connector", "list"], "connector.list", "connector list [--json]", "List installed Connector packages.", both),
  command(["connector", "inspect"], "connector.inspect", "connector inspect <connector-id> [--json]", "Inspect one installed Connector package.", both),
  command(["connector", "install"], "connector.install", "connector install <package-id> [--json]", "Install the latest signed Marketplace release.", both),
  command(["connector", "update"], "connector.update", "connector update <connector-id> [--json]", "Update from the latest signed Marketplace release.", both),
  command(["connector", "remove"], "connector.remove", "connector remove <connector-id> [--yes] [--json]", "Retire an installed Connector package.", both),
  command(["app", "list"], "app.list", "app list [--json]", "List current Apps.", both),
  command(["app", "inspect"], "app.inspect", "app inspect <app-id> [--json]", "Inspect one App.", both),
  command(["app", "create"], "app.create", "app create <app-id> --description <text> [--name <name>] [--json]", "Create a blank App package.", both),
  command(["app", "save"], "app.save", "app save <app-id> [-m <message>] [--author <author>] [--json]", "Record the current App package.", both),
  command(["app", "versions"], "app.versions", "app versions <app-id> [--json]", "List recorded App versions.", both),
  command(["app", "restore"], "app.restore", "app restore <app-id> <version> [-m <message>] [--author <author>] [--json]", "Restore as a new forward App version.", both),
  command(["app", "refresh"], "app.refresh", "app refresh <app-id> [--yes] [--json]", "Discard this Capsule's unsaved App edits.", ["managed"]),
  command(["app", "archive"], "app.archive", "app archive <app-id> [--yes] [--json]", "Archive an App.", both),
]);

function command(path: readonly string[], operation: CliOperation, usage: string, description: string, environments: readonly CliEnvironment[]): CommandDefinition {
  return Object.freeze({ path, operation, usage, description, environments });
}

export function helpText(environment: CliEnvironment): string {
  const lines = COMMAND_REGISTRY.filter((entry) => entry.environments.includes(environment))
    .map((entry) => `  lamarck ${entry.usage}\n      ${entry.description}`);
  return `Usage:\n${lines.join("\n")}`;
}

export function operationAvailable(operation: CliOperation, environment: CliEnvironment): boolean {
  if (operation === "source.run.status") return true;
  return COMMAND_REGISTRY.some((entry) => entry.operation === operation && entry.environments.includes(environment));
}
