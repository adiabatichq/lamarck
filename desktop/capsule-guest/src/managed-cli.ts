#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createConnection } from "node:net";
import {
  APP_CLI_SOCKET_PATH,
  encodeAppCliFrame,
  parseAppCliResponse,
  type AppCliOperation,
  type AppCliRequestV1,
  AppCliStreamReader,
  writeAppCliBytes,
} from "@lamarck/capsule";

const args = process.argv.slice(2);
const json = removeFlag(args, "--json");

class ManagedCliError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

try {
  if (args.shift() !== "app") usage();
  const command = args.shift();
  let operation: AppCliOperation;
  let input: Record<string, unknown>;
  switch (command) {
    case "list":
      if (args.length > 0) usage();
      operation = "app.list";
      input = {};
      break;
    case "save": {
      const appId = args.shift();
      if (!appId) usage();
      operation = "app.save";
      input = { appId, ...metadata(args) };
      break;
    }
    case "versions": {
      const appId = args.shift();
      if (!appId || args.length > 0) usage();
      operation = "app.versions";
      input = { appId };
      break;
    }
    case "restore": {
      const appId = args.shift();
      const version = args.shift();
      if (!appId || !version) usage();
      operation = "app.restore";
      input = { appId, version, ...metadata(args) };
      break;
    }
    case "refresh": {
      const appId = args.shift();
      const yes = removeFlag(args, "--yes");
      if (!appId || args.length > 0) usage();
      if (!yes) {
        if (!stdin.isTTY) throw cliError("APP_CONFIRMATION_REQUIRED", "app refresh requires interactive confirmation or --yes");
        const prompt = createInterface({ input: stdin, output: stdout });
        const answer = await prompt.question(`Discard unsaved changes to ${appId}? [y/N] `);
        prompt.close();
        if (!/^y(es)?$/i.test(answer.trim())) process.exit(1);
      }
      operation = "app.refresh";
      input = { appId };
      break;
    }
    default:
      usage();
  }

  const socket = createConnection(APP_CLI_SOCKET_PATH);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const request: AppCliRequestV1 = { version: 1, requestId: 1, operation, input };
  await writeAppCliBytes(socket, encodeAppCliFrame(request));
  const response = parseAppCliResponse(await new AppCliStreamReader(socket).readFrame());
  socket.end();
  if (!response.ok) throw cliError(response.error!.code, response.error!.message);
  if (json || command === "list" || command === "versions") {
    stdout.write(`${JSON.stringify(response.result)}\n`);
  } else if (response.result && typeof response.result === "object") {
    const version = (response.result as { version?: unknown }).version;
    stdout.write(`${typeof version === "string" ? version : "ok"}\n`);
  } else stdout.write("ok\n");
} catch (error) {
  const value = error instanceof ManagedCliError
    ? error
    : cliError("APP_INTERNAL_ERROR", error instanceof Error ? error.message : "App CLI failed");
  process.stderr.write(`${JSON.stringify({ error: { code: value.code, message: value.message } })}\n`);
  process.exitCode = 1;
}

function metadata(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  while (values.length > 0) {
    const flag = values.shift();
    if (flag === "-m" || flag === "--message") result.message = requireValue(values, flag);
    else if (flag === "--author") result.author = requireValue(values, flag);
    else usage();
  }
  return result;
}

function requireValue(values: string[], flag: string): string {
  const value = values.shift();
  if (!value) throw cliError("APP_COMMAND_UNSUPPORTED", `${flag} requires a value`);
  return value;
}

function removeFlag(values: string[], flag: string): boolean {
  const index = values.indexOf(flag);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}

function usage(): never {
  throw cliError(
    "APP_COMMAND_UNSUPPORTED",
    "Usage: lamarck app list [--json] | save <id> [-m message] [--author author] [--json] | versions <id> [--json] | restore <id> <version> [-m message] [--author author] [--json] | refresh <id> [--yes] [--json]",
  );
}

function cliError(code: string, message: string): ManagedCliError {
  return new ManagedCliError(code, message);
}
