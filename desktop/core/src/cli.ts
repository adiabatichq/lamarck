#!/usr/bin/env node
import { readFile } from "fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.LAMARCK_CORE_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`;
const coreToken = process.env.LAMARCK_CORE_TOKEN;

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

  die(`unknown command: ${command}`);
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
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    die(body.error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

function usage(): void {
  console.log(`Usage:
  lamarck query "<sql>"
  lamarck schema change "<ddl>"
  lamarck schema change --file schema.sql [--author name] [--context text]
  lamarck vfs [--author name] ls -R notes/
  lamarck vfs [--author name] tee -- notes/result.md
  lamarck vfs import <host-source> <d1-destination>
  lamarck vfs export <d1-source> <host-destination>`);
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
