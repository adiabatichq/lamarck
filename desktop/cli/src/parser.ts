import { COMMAND_REGISTRY, helpText, operationAvailable } from "./command-registry.js";
import { CliError } from "./errors.js";
import type { CliEnvironment, CliOperation, CliOperationInput } from "./operations.js";

export type ParsedCliCommand =
  | { readonly kind: "help"; readonly text: string }
  | {
      readonly kind: "execute";
      readonly operation: CliOperation;
      readonly input: CliOperationInput<CliOperation>;
      readonly json: boolean;
      readonly wait: boolean;
      readonly confirmed: boolean;
      readonly schemaFile?: string;
      readonly readsStdin: boolean;
    };

export function parseCliArgs(argv: readonly string[], environment: CliEnvironment): ParsedCliCommand {
  const args = [...argv];
  const json = removeBooleanFlag(args, "--json");
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { kind: "help", text: scopedHelp(args, environment) };
  }
  const top = args.shift()!;

  let operation: CliOperation;
  let input: Record<string, unknown>;
  let wait = false;
  let confirmed = false;
  let schemaFile: string | undefined;
  let readsStdin = false;

  if (top === "query") {
    requireNoOptions(args, "query");
    const sql = args.join(" ").trim();
    if (!sql) usage("query requires read-only SQL");
    operation = "query"; input = { sql };
  } else if (top === "schema") {
    if (args.shift() !== "change") usage("schema requires `change`");
    const parsed = parseNamedValues(args, new Map([["--file", "file"], ["--author", "author"], ["--context", "context"]]));
    const ddl = parsed.positionals.join(" ").trim();
    schemaFile = parsed.values.file;
    if (schemaFile && ddl) usage("schema change accepts inline DDL or --file, not both");
    if (!schemaFile && !ddl) usage("schema change requires DDL or --file");
    operation = "schema.change";
    input = { ddl, ...optional(parsed.values, ["author", "context"]) };
  } else if (top === "file") {
    const author = removeValueFlag(args, "--author");
    const native = args[0];
    if (!native) usage("file requires a command");
    if (!new Set(["ls", "cat", "stat", "tee", "cp", "mv", "rm", "mkdir", "import", "export"]).has(native)) {
      usage(`unknown file command: ${native}`);
    }
    operation = native === "import" ? "file.import" : native === "export" ? "file.export" : "file.command";
    if (native === "export" && author !== undefined) usage("file export does not accept --author");
    input = { argv: args, ...(author === undefined ? {} : { author }) };
    readsStdin = native === "tee";
  } else if (top === "source") {
    const verb = args.shift();
    if (verb === "list") {
      noArgs(args, "source list"); operation = "source.list"; input = {};
    } else if (verb === "inspect" || verb === "pause" || verb === "resume" || verb === "run") {
      if (verb === "run") wait = removeBooleanFlag(args, "--wait");
      operation = `source.${verb}` as CliOperation; input = { sourceId: oneArg(args, `source ${verb}`) };
    } else usage("source requires list, inspect, run, pause, or resume");
  } else if (top === "connector") {
    const verb = args.shift();
    if (verb === "list") {
      noArgs(args, "connector list"); operation = "connector.list"; input = {};
    } else if (verb === "inspect" || verb === "install" || verb === "update" || verb === "remove") {
      if (verb === "remove") confirmed = removeBooleanFlag(args, "--yes");
      const id = oneArg(args, `connector ${verb}`);
      operation = `connector.${verb}` as CliOperation;
      input = verb === "install" ? { packageId: id } : { connectorId: id };
    } else usage("connector requires list, inspect, install, update, or remove");
  } else if (top === "app") {
    const verb = args.shift();
    if (verb === "list") {
      noArgs(args, "app list"); operation = "app.list"; input = {};
    } else if (verb === "inspect" || verb === "versions") {
      operation = `app.${verb}` as CliOperation; input = { appId: oneArg(args, `app ${verb}`) };
    } else if (verb === "create") {
      const appId = args.shift();
      if (!appId) usage("app create requires an App id");
      const parsed = parseNamedValues(args, new Map([["--name", "name"], ["--description", "description"]]));
      if (parsed.positionals.length) usage(`unknown app create argument: ${parsed.positionals[0]}`);
      const description = parsed.values.description;
      if (!description) usage("app create requires --description");
      operation = "app.create"; input = { appId, name: parsed.values.name ?? appId, description };
    } else if (verb === "save") {
      const appId = args.shift();
      if (!appId) usage("app save requires an App id");
      operation = "app.save"; input = { appId, ...versionMetadata(args) };
    } else if (verb === "restore") {
      const appId = args.shift(); const version = args.shift();
      if (!appId || !version) usage("app restore requires an App id and version");
      operation = "app.restore"; input = { appId, version, ...versionMetadata(args) };
    } else if (verb === "refresh" || verb === "archive") {
      confirmed = removeBooleanFlag(args, "--yes");
      operation = `app.${verb}` as CliOperation; input = { appId: oneArg(args, `app ${verb}`) };
    } else usage("app requires list, inspect, create, save, versions, restore, refresh, or archive");
  } else usage(`unknown command: ${top}`);

  if (!operationAvailable(operation, environment)) {
    throw new CliError("CLI_UNSUPPORTED_COMMAND", `lamarck ${operation.replaceAll(".", " ")} is not available in the ${environment} CLI.`);
  }
  return { kind: "execute", operation, input: input as CliOperationInput<CliOperation>, json, wait, confirmed,
    ...(schemaFile === undefined ? {} : { schemaFile }), readsStdin };
}

function scopedHelp(args: readonly string[], environment: CliEnvironment): string {
  const path = args.filter((value) => value !== "--help" && value !== "-h");
  if (!path.length) return helpText(environment);
  const entries = COMMAND_REGISTRY.filter((entry) => entry.environments.includes(environment)
    && path.every((part, index) => entry.path[index] === part));
  return entries.length ? `Usage:\n${entries.map((entry) => `  lamarck ${entry.usage}\n      ${entry.description}`).join("\n")}` : helpText(environment);
}

function versionMetadata(args: string[]): { message?: string; author?: string } {
  const parsed = parseNamedValues(args, new Map([["-m", "message"], ["--message", "message"], ["--author", "author"]]));
  if (parsed.positionals.length) usage(`unknown App option: ${parsed.positionals[0]}`);
  return optional(parsed.values, ["message", "author"]);
}

function parseNamedValues(args: string[], flags: ReadonlyMap<string, string>) {
  const values: Record<string, string> = {}; const positionals: string[] = [];
  while (args.length) {
    const arg = args.shift()!; const name = flags.get(arg);
    if (!name) { if (arg.startsWith("-")) usage(`unknown option: ${arg}`); positionals.push(arg); continue; }
    if (values[name] !== undefined) usage(`${arg} may be supplied once`);
    const value = args.shift(); if (value === undefined) usage(`${arg} requires a value`); values[name] = value;
  }
  return { values, positionals };
}

function optional(values: Record<string, string>, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.filter((name) => values[name] !== undefined).map((name) => [name, values[name]]));
}
function removeBooleanFlag(args: string[], flag: string): boolean {
  const indexes = args.flatMap((value, index) => value === flag ? [index] : []);
  if (indexes.length > 1) usage(`${flag} may be supplied once`);
  if (!indexes.length) return false; args.splice(indexes[0], 1); return true;
}
function removeValueFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag); if (index < 0) return undefined;
  if (args.indexOf(flag, index + 1) >= 0) usage(`${flag} may be supplied once`);
  const value = args[index + 1]; if (value === undefined) usage(`${flag} requires a value`); args.splice(index, 2); return value;
}
function requireNoOptions(args: readonly string[], label: string): void {
  const option = args.find((value) => value.startsWith("-")); if (option) usage(`${label} does not accept ${option}`);
}
function oneArg(args: string[], label: string): string { if (args.length !== 1 || !args[0]) usage(`${label} requires exactly one id`); return args[0]; }
function noArgs(args: string[], label: string): void { if (args.length) usage(`${label} accepts no arguments`); }
function usage(message: string): never { throw new CliError("CLI_USAGE", message); }
