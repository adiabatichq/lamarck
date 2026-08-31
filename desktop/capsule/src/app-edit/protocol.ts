export const APP_CLI_PROTOCOL_VERSION = 1 as const;
export const APP_CLI_SOCKET_PATH = "/run/lamarck/cli.sock" as const;
export const APP_EDIT_ROOT_PATH = "/mnt/lamarck-apps" as const;
export const APP_EDIT_LOWER_ROOT_PATH = "/mnt/lamarck-apps-lower" as const;
export const APP_CLI_MAX_CONTROL_BYTES = 64 * 1024;
export const APP_PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

export function isCanonicalAppPackageId(value: unknown): value is string {
  return typeof value === "string" && APP_PACKAGE_ID_PATTERN.test(value);
}

export type AppCliOperation =
  | "app.list"
  | "app.save"
  | "app.versions"
  | "app.restore"
  | "app.refresh";

export interface AppCliRequestV1 {
  readonly version: 1;
  readonly requestId: number;
  readonly operation: AppCliOperation;
  readonly input: Record<string, unknown>;
  /** Present only on the trusted Guest-to-Host save request. */
  readonly upload?: {
    readonly archiveDigest: `sha256:${string}`;
    readonly archiveBytes: number;
    readonly baseVersion: string | null;
    readonly basePackageDigest: `sha256:${string}`;
  };
}

export interface AppCliResponseV1 {
  readonly version: 1;
  readonly requestId: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface CapsuleAppInventoryItemV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly version: string | null;
  readonly editBase: AppEditBaseDescriptorV1;
}

export interface AppEditBaseDescriptorV1 {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly version: string | null;
  readonly packageDigest: `sha256:${string}`;
  readonly lowerPath: string;
}

export function encodeAppCliFrame(value: AppCliRequestV1 | AppCliResponseV1): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength < 1 || payload.byteLength > APP_CLI_MAX_CONTROL_BYTES) {
    throw new Error("App CLI control frame is outside the V1 bound");
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export function parseAppCliRequest(value: Buffer, allowUpload: boolean): AppCliRequestV1 {
  const parsed = parseObject(value) as Partial<AppCliRequestV1>;
  const keys = Object.keys(parsed).sort();
  const expected = allowUpload && parsed.upload !== undefined
    ? ["input", "operation", "requestId", "upload", "version"]
    : ["input", "operation", "requestId", "version"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error("Malformed App CLI request");
  if (
    parsed.version !== 1
    || !Number.isSafeInteger(parsed.requestId)
    || Number(parsed.requestId) < 1
    || !isOperation(parsed.operation)
    || !isPlainObject(parsed.input)
  ) throw new Error("Malformed App CLI request");
  if (parsed.upload !== undefined) {
    if (!allowUpload || parsed.operation !== "app.save") throw new Error("Unexpected App CLI upload");
    const upload = parsed.upload as Partial<AppCliRequestV1["upload"]>;
    if (
      !isPlainObject(upload)
      || Object.keys(upload).sort().join(",") !== "archiveBytes,archiveDigest,basePackageDigest,baseVersion"
      || !/^sha256:[0-9a-f]{64}$/.test(upload.archiveDigest ?? "")
      || !/^sha256:[0-9a-f]{64}$/.test(upload.basePackageDigest ?? "")
      || (upload.baseVersion !== null && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(upload.baseVersion ?? ""))
      || !Number.isSafeInteger(upload.archiveBytes)
      || Number(upload.archiveBytes) < 1
    ) throw new Error("Malformed App CLI upload metadata");
  }
  return parsed as AppCliRequestV1;
}

export function parseAppCliResponse(value: Buffer): AppCliResponseV1 {
  const parsed = parseObject(value) as Partial<AppCliResponseV1>;
  if (
    parsed.version !== 1
    || !Number.isSafeInteger(parsed.requestId)
    || Number(parsed.requestId) < 1
    || typeof parsed.ok !== "boolean"
    || (parsed.ok ? !("result" in parsed) || "error" in parsed : !isError(parsed.error) || "result" in parsed)
  ) throw new Error("Malformed App CLI response");
  return parsed as AppCliResponseV1;
}

function parseObject(value: Buffer): Record<string, unknown> {
  if (value.byteLength < 1 || value.byteLength > APP_CLI_MAX_CONTROL_BYTES) {
    throw new Error("App CLI control payload is outside the V1 bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch {
    throw new Error("App CLI control payload is not valid UTF-8 JSON");
  }
  if (!isPlainObject(parsed)) throw new Error("App CLI control payload must be an object");
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperation(value: unknown): value is AppCliOperation {
  return value === "app.list" || value === "app.save" || value === "app.versions"
    || value === "app.restore" || value === "app.refresh";
}

function isError(value: unknown): boolean {
  return isPlainObject(value)
    && Object.keys(value).sort().join(",") === "code,message"
    && typeof value.code === "string"
    && typeof value.message === "string";
}
