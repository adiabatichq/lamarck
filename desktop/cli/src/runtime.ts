import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { asCliError, CliError } from "./errors.js";
import { parseCliArgs } from "./parser.js";
import { renderHuman } from "./render-human.js";
import { renderJsonError, renderJsonSuccess } from "./render-json.js";
import {
  CLI_MAX_INLINE_BYTES,
  CLI_PROTOCOL_VERSION,
  type CliEnvironment,
  type CliOperation,
  type CliRequest,
  type CliResponse,
  type CliTransport,
  type CliUpload,
  type FileCommandResult,
  type SourceRunStatus,
} from "./operations.js";

export interface CliIo {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
}

export async function runCli(options: {
  readonly environment: CliEnvironment;
  readonly transport: CliTransport;
  readonly argv?: readonly string[];
  readonly io?: CliIo;
}): Promise<number> {
  const io = options.io ?? process;
  let json = options.argv?.includes("--json") ?? process.argv.slice(2).includes("--json");
  try {
    const parsed = parseCliArgs(options.argv ?? process.argv.slice(2), options.environment);
    if (parsed.kind === "help") { io.stdout.write(`${parsed.text}\n`); return 0; }
    json = parsed.json;
    let input = parsed.input as Record<string, unknown>;
    let uploadBytes: Buffer | undefined;
    let upload: CliUpload | undefined;
    if (parsed.schemaFile !== undefined) {
      input = { ...input, ddl: await readBoundedFile(parsed.schemaFile, 300 * 1024) };
    }
    if (parsed.readsStdin) {
      uploadBytes = await readBoundedStdin(io.stdin, CLI_MAX_INLINE_BYTES);
      upload = { kind: "file-stdin", bytes: uploadBytes.byteLength };
    }

    const hello = await options.transport.hello();
    if (hello.protocolVersion !== CLI_PROTOCOL_VERSION) {
      throw new CliError("CLI_HOST_INCOMPATIBLE", "Lamarck Desktop and this CLI are incompatible.");
    }
    if (!hello.supportedOperations.includes(parsed.operation)) {
      throw new CliError("CLI_UNSUPPORTED_COMMAND", `${parsed.operation} is not supported by this Lamarck environment.`);
    }
    if (needsConfirmation(parsed.operation) && !parsed.confirmed) {
      await confirm(parsed.operation, input, options.transport, io);
    }
    const result = await execute(options.transport, parsed.operation, input, upload, uploadBytes);
    if (isFileOperation(parsed.operation)) return renderFileResult(result as FileCommandResult, io);
    if (parsed.operation === "source.run" && parsed.wait) {
      const accepted = result as { sourceId: string; runId: string };
      const terminal = await waitForRun(options.transport, accepted.sourceId, accepted.runId);
      renderValue("source.run.status", terminal, json, io);
      return terminal.outcome === "success" ? 0 : 1;
    }
    renderValue(parsed.operation, result, json, io);
    return 0;
  } catch (error) {
    const value = asCliError(error);
    io.stderr.write(json ? renderJsonError(value.value()) : `${value.message}\n`);
    return 1;
  } finally {
    await options.transport.close?.();
  }
}

async function execute(
  transport: CliTransport,
  operation: CliOperation,
  input: Record<string, unknown>,
  upload?: CliUpload,
  uploadBytes?: Uint8Array,
): Promise<unknown> {
  const request = {
    requestId: randomUUID(),
    operation,
    input,
    ...(upload === undefined ? {} : { upload }),
  } as CliRequest;
  const response = await transport.execute(request, uploadBytes) as CliResponse;
  if (!response.ok) throw new CliError(response.error.code, response.error.message);
  return response.result;
}

async function waitForRun(transport: CliTransport, sourceId: string, runId: string): Promise<Extract<SourceRunStatus, { outcome: string }>> {
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.once("SIGINT", onSignal);
  try {
    for (;;) {
      if (interrupted) throw new CliError("SOURCE_RUN_ABORTED", "Detached from the Source run; the run was not cancelled.");
      const status = await execute(transport, "source.run.status", { sourceId, runId }) as SourceRunStatus;
      if (status.status !== "running") return status;
      await delay(250);
    }
  } finally { process.removeListener("SIGINT", onSignal); }
}

async function confirm(operation: CliOperation, input: Record<string, unknown>, transport: CliTransport, io: CliIo): Promise<void> {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw new CliError("CONFIRMATION_REQUIRED", `${operation.replaceAll(".", " ")} requires --yes in non-interactive use.`);
  }
  let promptText: string;
  if (operation === "connector.remove") {
    const connector = await execute(transport, "connector.inspect", { connectorId: input.connectorId }) as { id: string; sourceCount: number };
    promptText = `Remove ${connector.id} and retire ${connector.sourceCount} Source(s)? [y/N] `;
  } else if (operation === "app.archive") {
    const app = await execute(transport, "app.inspect", { appId: input.appId }) as { id: string; name?: string };
    promptText = `Archive ${app.name ?? app.id}? Its running Capsules will terminate immediately. [y/N] `;
  } else {
    promptText = `Discard this Capsule's unsaved edits to ${String(input.appId)}? [y/N] `;
  }
  const prompt = createInterface({ input: io.stdin, output: io.stdout });
  try {
    const answer = await prompt.question(promptText);
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new CliError("CONFIRMATION_REQUIRED", "Command cancelled.");
  } finally { prompt.close(); }
}

function renderValue(operation: CliOperation, result: unknown, json: boolean, io: CliIo): void {
  io.stdout.write(json ? renderJsonSuccess(result) : renderHuman(operation, result));
}
function renderFileResult(result: FileCommandResult, io: CliIo): number {
  if (!result || typeof result !== "object" || !Number.isInteger(result.exitCode)) throw new CliError("CLI_INTERNAL", "Lamarck returned an invalid file result.");
  const stdout = Buffer.from(result.stdoutBase64, "base64"); const stderr = Buffer.from(result.stderrBase64, "base64");
  if (stdout.length) io.stdout.write(stdout); if (stderr.length) io.stderr.write(stderr); return result.exitCode;
}
function isFileOperation(operation: CliOperation): boolean { return operation === "file.command" || operation === "file.import" || operation === "file.export"; }
function needsConfirmation(operation: CliOperation): boolean { return operation === "connector.remove" || operation === "app.archive" || operation === "app.refresh"; }
async function readBoundedFile(path: string, max: number): Promise<string> {
  try {
    const handle = await open(path, "r");
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size > max) throw new CliError("CLI_USAGE", `File exceeds the ${max}-byte limit.`);
      const bytes = await handle.readFile();
      if (bytes.byteLength > max) throw new CliError("CLI_USAGE", `File exceeds the ${max}-byte limit.`);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("CLI_USAGE", "The schema file could not be read as UTF-8.", {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
async function readBoundedStdin(stream: NodeJS.ReadStream, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const value of stream) { const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); total += chunk.length; if (total > max) throw new CliError("CLI_USAGE", "stdin exceeds the file command limit."); chunks.push(chunk); }
  return Buffer.concat(chunks, total);
}
