#!/usr/bin/env node
import { readFile } from "fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.LAMARCK_CORE_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`;
const coreToken = process.env.LAMARCK_CORE_TOKEN;
const jsonMode = process.argv.slice(2).includes("--json");

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "query") {
    const sql = args.join(" ").trim();
    if (!sql) die("query requires SQL");
    const result = await post<{ rows: unknown[] }>("/api/query", { sql });
    console.log(JSON.stringify(result.rows, null, 2));
    return;
  }

  if (command === "schema") {
    if (args[0] !== "change") die("schema requires the change command");
    const change = await readSchemaChangeArgs(args.slice(1));
    if (!change.ddl.trim()) die("schema change requires DDL");
    const result = await post<{
      status: "pending";
      request: { id: string; status: string };
    }>("/api/schema/change/request", {
      ddl: change.ddl,
      ...(change.author === undefined ? {} : { author: change.author }),
      ...(change.context === undefined ? {} : { context: change.context }),
    });

    const id = result.request.id;
    if (!id) die("schema request returned without id");
    console.log(`schema change pending approval: ${id}`);
    await waitForSchemaRequest(id);
    return;
  }

  if (command === "vfs") {
    await runVfs(args);
    return;
  }

  if (command === "app") {
    await runApp(args);
    return;
  }

  die(`unknown command: ${command}`);
}

async function runApp(rawArgs: string[]): Promise<void> {
  const args = rawArgs.filter((arg) => arg !== "--json");
  const command = args.shift();
  if (!command) throw new CliError("APP_COMMAND_UNSUPPORTED", "app requires a command");

  if (command === "list") {
    if (args.length > 0) throw new CliError("APP_COMMAND_UNSUPPORTED", "app list accepts no arguments");
    const result = await get<{ apps: Array<{
      id: string;
      name: string;
      path: string;
      version: string | null;
    }> }>("/api/apps");
    const apps = result.apps.map(({ id, name, path, version }) => ({ id, name, path, version }));
    printResult(apps, apps.length === 0
      ? "No Apps installed"
      : apps.map((app) => `${app.id}\t${app.version?.slice(0, 12) ?? "unversioned"}\t${app.path}`).join("\n"));
    return;
  }

  if (command === "save") {
    const appId = args.shift();
    if (!appId) throw new CliError("APP_COMMAND_UNSUPPORTED", "app save requires an App id");
    const metadata = parseVersionMetadata(args);
    const result = await post<{ version: string; created: boolean }>(
      `/api/apps/${encodeURIComponent(appId)}/save`,
      metadata,
    );
    printResult(result, result.created
      ? `Saved ${appId} ${result.version.slice(0, 12)}`
      : `${appId} is unchanged at ${result.version.slice(0, 12)}`);
    return;
  }

  if (command === "versions") {
    const appId = args.shift();
    if (!appId || args.length > 0) {
      throw new CliError("APP_COMMAND_UNSUPPORTED", "app versions requires one App id");
    }
    const versions: unknown[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page = await get<{ versions: unknown[]; nextCursor: string | null }>(
        `/api/apps/${encodeURIComponent(appId)}/versions?${query}`,
      );
      versions.push(...page.versions);
      cursor = page.nextCursor;
    } while (cursor);
    printResult(versions, versions.length === 0
      ? `No versions recorded for ${appId}`
      : versions.map((value) => formatVersion(value)).join("\n"));
    return;
  }

  if (command === "restore") {
    const appId = args.shift();
    const version = args.shift();
    if (!appId || !version) {
      throw new CliError("APP_COMMAND_UNSUPPORTED", "app restore requires an App id and version");
    }
    const metadata = parseVersionMetadata(args);
    const result = await post<{ version: string; created: boolean }>(
      `/api/apps/${encodeURIComponent(appId)}/restore`,
      { version, ...metadata },
    );
    printResult(result, result.created
      ? `Restored ${appId} as ${result.version.slice(0, 12)}`
      : `${appId} already has that package at ${result.version.slice(0, 12)}`);
    return;
  }

  if (command === "refresh") {
    throw new CliError(
      "APP_COMMAND_UNSUPPORTED",
      "app refresh is available only inside a managed Capsule",
    );
  }
  throw new CliError("APP_COMMAND_UNSUPPORTED", `unknown app command: ${command}`);
}

function parseVersionMetadata(args: string[]): { message?: string; author?: string } {
  let message: string | undefined;
  let author: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "-m" || option === "--message") {
      if (message !== undefined) throw new CliError("APP_PACKAGE_INVALID", "message may be supplied once");
      message = args[++index];
      if (message === undefined) throw new CliError("APP_PACKAGE_INVALID", `${option} requires a value`);
      continue;
    }
    if (option === "--author") {
      if (author !== undefined) throw new CliError("APP_PACKAGE_INVALID", "author may be supplied once");
      author = args[++index];
      if (author === undefined) throw new CliError("APP_PACKAGE_INVALID", "--author requires a value");
      continue;
    }
    throw new CliError("APP_COMMAND_UNSUPPORTED", `unknown App option: ${option}`);
  }
  return {
    ...(message === undefined ? {} : { message }),
    ...(author === undefined ? {} : { author }),
  };
}

function printResult(value: unknown, human: string): void {
  console.log(jsonMode ? JSON.stringify(value, null, 2) : human);
}

function formatVersion(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const record = value as { version?: unknown; trigger?: unknown; createdAt?: unknown; message?: unknown };
  const version = typeof record.version === "string" ? record.version.slice(0, 12) : "unknown";
  const trigger = typeof record.trigger === "string" ? record.trigger : "unknown";
  const time = typeof record.createdAt === "number" ? new Date(record.createdAt).toISOString() : "unknown";
  return `${version}\t${trigger}\t${time}${typeof record.message === "string" ? `\t${record.message}` : ""}`;
}

async function runVfs(rawArgs: string[]): Promise<void> {
  let author: string | undefined;
  const args = [...rawArgs];
  if (args[0] === "--author") {
    author = args[1];
    if (author === undefined) die("vfs --author requires a value");
    args.splice(0, 2);
  }
  if (args.length === 0) die("vfs requires a command");
  const nativeCommand = args[0];
  const stdin = nativeCommand === "tee" ? await readStdin() : undefined;
  let response: {
    success: boolean;
    exitCode: number;
    stdoutBase64: string;
    stderrBase64: string;
  };
  try {
    response = await post("/api/vfs/command", {
      command: args.map(quoteVfsWord).join(" "),
      options: {
        ...(author === undefined ? {} : { author }),
        ...(stdin === undefined ? {} : { stdin: { encoding: "base64", data: stdin.toString("base64") } }),
      },
    }, { "x-lamarck-vfs-client": "cli" });
  } catch (error) {
    die(`Lamarck Core must be running for vfs commands: ${errorMessage(error)}`);
  }
  const stdout = Buffer.from(response.stdoutBase64, "base64");
  const stderr = Buffer.from(response.stderrBase64, "base64");
  if (stdout.length > 0) process.stdout.write(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);
  if (!response.success) process.exit(response.exitCode);
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function quoteVfsWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readSchemaChangeArgs(args: string[]): Promise<{
  ddl: string;
  author?: string;
  context?: string;
}> {
  let file: string | undefined;
  let author: string | undefined;
  let context: string | undefined;
  const ddlParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--file" || arg === "-f") {
      if (file !== undefined) die("schema change accepts only one --file");
      file = args[++index];
      if (file === undefined) die("--file requires a path");
      continue;
    }
    if (arg === "--author") {
      if (author !== undefined) die("schema change accepts only one --author");
      author = args[++index];
      if (author === undefined) die("--author requires a value");
      continue;
    }
    if (arg === "--context") {
      if (context !== undefined) die("schema change accepts only one --context");
      context = args[++index];
      if (context === undefined) die("--context requires a value");
      continue;
    }
    if (arg.startsWith("-")) die(`unknown schema change option: ${arg}`);
    ddlParts.push(arg);
  }
  if (file !== undefined && ddlParts.length > 0) {
    die("schema change accepts either inline DDL or --file, not both");
  }
  const ddl = file === undefined ? ddlParts.join(" ") : await readFile(file, "utf8");
  return { ddl, author, context };
}

async function waitForSchemaRequest(id: string): Promise<void> {
  for (;;) {
    await delay(1000);
    const result = await get<{ request: { status: string; error?: string } }>(`/api/schema/requests/${id}`);
    if (result.request.status === "pending") continue;
    if (result.request.status === "applied") {
      console.log(`schema request applied: ${id}`);
      return;
    }
    if (result.request.status === "failed") {
      die(`schema request failed: ${result.request.error ?? id}`);
    }
    if (result.request.status === "stale") {
      die(`schema request stale: ${result.request.error ?? id}`);
    }
    die(`schema request ${result.request.status}: ${id}`);
  }
}

async function post<T>(path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  });
  return readResponse<T>(res);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders() });
  return readResponse<T>(res);
}

function authHeaders(): Record<string, string> {
  if (!coreToken) {
    die("LAMARCK_CORE_TOKEN is required");
  }
  return {
    Authorization: `Bearer ${coreToken}`,
    "Content-Type": "application/json",
  };
}

async function readResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new CliError("APP_INTERNAL_ERROR", `Core returned invalid JSON (${res.status})`);
  }
  if (!res.ok) {
    const error = (body as { error?: unknown }).error;
    if (
      error !== null
      && typeof error === "object"
      && typeof (error as { code?: unknown }).code === "string"
      && typeof (error as { message?: unknown }).message === "string"
    ) {
      throw new CliError(
        (error as { code: string }).code,
        (error as { message: string }).message,
      );
    }
    throw new CliError(
      "APP_INTERNAL_ERROR",
      typeof error === "string" ? error : `${res.status} ${res.statusText}`,
    );
  }
  return body as T;
}

function usage(): void {
  console.log(`Usage:
  lamarck query "<sql>"
  lamarck schema change "<ddl>"
  lamarck schema change --file schema.sql [--author name] [--context text]
  lamarck app list [--json]
  lamarck app save <app-id> [-m message] [--author author] [--json]
  lamarck app versions <app-id> [--json]
  lamarck app restore <app-id> <version> [-m message] [--author author] [--json]
  lamarck app refresh <app-id>
  lamarck vfs [--author name] ls -R notes/
  lamarck vfs [--author name] tee -- notes/result.md
  lamarck vfs import <host-source> <d1-destination>
  lamarck vfs export <d1-source> <host-destination>`);
}

function die(error: unknown): never {
  const value = error instanceof CliError
    ? error
    : new CliError("APP_INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
  console.error(jsonMode
    ? JSON.stringify({ error: { code: value.code, message: value.message } })
    : value.message);
  process.exit(1);
}

main().catch(die);

class CliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CliError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
