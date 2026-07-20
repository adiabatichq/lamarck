import { SYSTEM_OPERATIONS } from "@lamarck/system/protocol";
import { contextBridge, ipcRenderer } from "electron";

const MAX_SERIALIZED_BYTES = 20 * 1024 * 1024;
const MAX_JSON_DEPTH = 128;
const SYSTEM_OPERATION_SET: ReadonlySet<string> = new Set(SYSTEM_OPERATIONS);

// This is the complete App-viewer preload surface. Identity is bound to this
// WebContents in Electron main; App code supplies only a System operation and
// its arguments. No App id, Core URL, bearer, filesystem, or Host IPC is
// exposed to the page.
contextBridge.exposeInMainWorld("__LAMARCK_SYSTEM_HOST__", Object.freeze({
  invoke: async (operation: unknown, input: unknown): Promise<unknown> => {
    const request = serializeRequest(operation, input);
    const serializedResponse: unknown = await ipcRenderer.invoke("app-system:invoke", request);
    if (
      typeof serializedResponse !== "string"
      || utf8ByteLength(serializedResponse) > MAX_SERIALIZED_BYTES
    ) {
      throw new Error("Lamarck Host returned an invalid System SDK response");
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(serializedResponse) as unknown;
    } catch {
      throw new Error("Lamarck Host returned malformed System SDK JSON");
    }
    if (!isRecord(envelope)) {
      throw new Error("Lamarck Host returned a malformed System SDK envelope");
    }
    if (envelope.ok === true && Object.hasOwn(envelope, "result")) {
      return envelope.result;
    }
    const failure = envelope.error;
    if (
      envelope.ok === false
      && isRecord(failure)
      && typeof failure.message === "string"
    ) {
      const error = new Error(failure.message) as Error & { code?: string };
      if (typeof failure.code === "string") error.code = failure.code;
      throw error;
    }
    throw new Error("Lamarck Host returned a malformed System SDK envelope");
  },
}));

function serializeRequest(operation: unknown, input: unknown): string {
  if (typeof operation !== "string" || !SYSTEM_OPERATION_SET.has(operation)) {
    throw new Error("System SDK operation is not allowed");
  }
  assertJson(input);
  let serialized: string;
  try {
    serialized = JSON.stringify({ operation, input });
  } catch {
    throw new Error("System SDK request is not serializable");
  }
  if (utf8ByteLength(serialized) > MAX_SERIALIZED_BYTES) {
    throw new Error("System SDK request exceeds the size limit");
  }
  return serialized;
}

// Validate iteratively so a maliciously deep graph is rejected inside its
// isolated renderer instead of overflowing Electron main while it is cloned or
// traversed. This mirrors the Host's JSON-only System operation contract.
function assertJson(root: unknown): void {
  const ancestors = new Set<object>();
  const stack: Array<{ value: unknown; depth: number; exit: boolean }> = [
    { value: root, depth: 0, exit: false },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const value = frame.value;
    if (frame.exit) {
      ancestors.delete(value as object);
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("System SDK request numbers must be finite");
      continue;
    }
    if (typeof value !== "object") throw new Error("System SDK request must contain only JSON values");
    if (frame.depth > MAX_JSON_DEPTH) throw new Error("System SDK request is nested too deeply");
    if (ancestors.has(value)) throw new Error("System SDK request must not contain cycles");
    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value) as object | null;
      // contextBridge arguments originate in the page's JavaScript realm, so
      // their Object.prototype is not reference-equal to the preload realm's.
      // A plain-object prototype still terminates directly at null; class and
      // built-in prototypes do not.
      if (
        prototype !== Object.prototype
        && prototype !== null
        && Object.getPrototypeOf(prototype) !== null
      ) {
        throw new Error("System SDK request must contain only plain JSON objects");
      }
    }

    ancestors.add(value);
    stack.push({ value, depth: frame.depth, exit: true });
    const children = Array.isArray(value) ? value : Object.values(value);
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ value: children[index], depth: frame.depth + 1, exit: false });
    }
  }
}

// Counts UTF-8 bytes without allocating a second 20 MiB byte array.
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
