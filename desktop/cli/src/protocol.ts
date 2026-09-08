import { CliError } from "./errors.js";
import { CLI_OPERATIONS, type CliOperation, type CliRequest, type CliResponse, type CliUpload } from "./operations.js";
import { parseCliWireResponse, validateUpload } from "./transport.js";
export { encodeCliFrame, parseCliFrame, parseCliCapabilities, parseCliErrorValue } from "./transport.js";
const operationSet = new Set<string>(CLI_OPERATIONS);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function parseCliResponse(value: unknown, requestId?: string): CliResponse {
  return parseCliWireResponse(value, requestId) as CliResponse;
}

export function parseCliRequest(
  value: unknown,
  options: boolean | { readonly allowUpload?: boolean; readonly allowInlineFileBytes?: boolean } = false,
): CliRequest {
  const allowUpload = typeof options === "boolean" ? options : options.allowUpload === true;
  const allowInlineFileBytes = typeof options === "object" && options.allowInlineFileBytes === true;
  const raw = record(value, "CLI request");
  const expected = raw.upload === undefined ? ["input", "operation", "requestId"] : ["input", "operation", "requestId", "upload"];
  exactKeys(raw, expected, "CLI request");
  if (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId)) throw new Error("CLI request id is invalid");
  if (typeof raw.operation !== "string" || !operationSet.has(raw.operation)) throw new CliError("CLI_UNSUPPORTED_COMMAND", `CLI operation ${String(raw.operation)} is not supported by this Host/CLI.`);
  const operation = raw.operation as CliOperation;
  const input = validateInput(operation, raw.input, allowInlineFileBytes);
  let upload: CliUpload | undefined;
  if (raw.upload !== undefined) {
    if (!allowUpload) throw new Error("CLI request upload is not allowed");
    upload = validateUpload(raw.upload, operation, input);
  }
  return { requestId: raw.requestId, operation, input, ...(upload === undefined ? {} : { upload }) } as CliRequest;
}

function validateInput(
  operation: CliOperation,
  value: unknown,
  allowInlineFileBytes: boolean,
): Record<string, unknown> {
  const input = record(value, `CLI ${operation} input`);
  const empty = () => exactKeys(input, [], `CLI ${operation} input`);
  const id = (field: string) => {
    exactKeys(input, [field], `CLI ${operation} input`);
    text(input[field], field);
  };
  switch (operation) {
    case "source.list": case "connector.list": case "app.list": empty(); break;
    case "marketplace.list":
      exactOptionalKeys(input, [], ["kind"], `CLI ${operation} input`);
      if (input.kind !== undefined && input.kind !== "app" && input.kind !== "connector") throw new Error("CLI Marketplace kind is invalid");
      break;
    case "query": id("sql"); break;
    case "source.inspect": case "source.run": case "source.pause": case "source.resume": id("sourceId"); break;
    case "source.run.status":
      exactKeys(input, ["runId", "sourceId"], `CLI ${operation} input`); text(input.sourceId, "sourceId"); text(input.runId, "runId"); break;
    case "connector.install": id("packageId"); break;
    case "connector.inspect": case "connector.update": case "connector.remove": id("connectorId"); break;
    case "app.inspect": case "app.versions": case "app.refresh": case "app.archive": id("appId"); break;
    case "schema.change":
      exactOptionalKeys(input, ["ddl"], ["author", "context"], `CLI ${operation} input`);
      boundedUtf8Text(input.ddl, "ddl", 300 * 1024);
      optionalText(input.author, "author"); optionalText(input.context, "context"); break;
    case "file.command":
      exactOptionalKeys(input, ["argv"], ["author", "stdinBase64"], `CLI ${operation} input`); argv(input.argv); optionalText(input.author, "author"); optionalText(input.stdinBase64, "stdinBase64"); break;
    case "file.import":
      exactOptionalKeys(input, ["argv"], ["author"], `CLI ${operation} input`); argv(input.argv); optionalText(input.author, "author"); break;
    case "file.export": exactKeys(input, ["argv"], `CLI ${operation} input`); argv(input.argv); break;
    case "app.create":
      if ("fromPackageId" in input) {
        exactOptionalKeys(input, ["fromPackageId"], ["localId"], `CLI ${operation} input`);
        text(input.fromPackageId, "fromPackageId"); optionalText(input.localId, "localId"); break;
      }
      exactKeys(input, ["appId", "description", "name"], `CLI ${operation} input`); text(input.appId, "appId"); text(input.name, "name"); text(input.description, "description"); break;
    case "app.save":
      exactOptionalKeys(input, ["appId"], ["author", "message"], `CLI ${operation} input`); text(input.appId, "appId"); optionalText(input.author, "author"); optionalText(input.message, "message"); break;
    case "app.restore":
      exactOptionalKeys(input, ["appId", "version"], ["author", "message"], `CLI ${operation} input`); text(input.appId, "appId"); text(input.version, "version"); optionalText(input.author, "author"); optionalText(input.message, "message"); break;
  }
  if (operation === "file.command" && input.stdinBase64 !== undefined && !allowInlineFileBytes) {
    throw new Error("CLI inline file bytes are not allowed on this boundary");
  }
  return input;
}

function argv(value: unknown): void {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string")) throw new Error("CLI file argv is invalid");
}
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.length) throw new Error(`CLI ${field} is invalid`);
}
function boundedUtf8Text(value: unknown, field: string, maxBytes: number): asserts value is string {
  text(value, field);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`CLI ${field} is outside the V1 bound`);
}
function optionalText(value: unknown, field: string): void { if (value !== undefined) text(value, field); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const object = record(value, label); exactKeys(object, keys, label); return object;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} has unexpected or missing fields`);
}
function exactOptionalKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  for (const key of required) if (!(key in value)) throw new Error(`${label} is missing ${key}`);
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error(`${label} has an unexpected field`);
}
