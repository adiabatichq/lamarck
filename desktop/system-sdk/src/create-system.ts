import type {
  ContentBlobRef,
  MutationResult,
  ResolveContentRefResult,
  SqlParams,
  SqlStatement,
  SystemInvoke,
  TransactionStatementResult,
  WriteEventInput,
  VfsCommandWireOptions,
} from "./protocol.js";

export type VfsStdin = string | Uint8Array | ArrayBuffer | Blob;

export interface VfsCommandOptions {
  stdin?: VfsStdin;
  stdout?: "capture" | "ignore";
  author?: string;
}

export interface VfsCommandResult {
  success: boolean;
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface System {
  query(sql: string, params?: SqlParams): Promise<{ rows: unknown[] }>;
  resolveContentRef(ref: ContentBlobRef): Promise<ResolveContentRefResult>;
  mutate(sql: string, params?: SqlParams): Promise<MutationResult>;
  transaction(statements: SqlStatement[]): Promise<TransactionStatementResult[]>;
  vfs: Readonly<{
    command(command: string, options?: VfsCommandOptions): Promise<VfsCommandResult>;
    open(path: string): Promise<string>;
  }>;
  writeEvent(event: WriteEventInput): Promise<{ ok: true; id: string }>;
}

export function createSystem(invoke: SystemInvoke): System {
  return Object.freeze({
    query: (sql: string, params?: SqlParams) => invoke(
      "query",
      params === undefined ? { sql } : { sql, params },
    ),
    resolveContentRef: (ref: ContentBlobRef) => invoke("resolveContentRef", { ref }),
    mutate: (sql: string, params?: SqlParams) => invoke(
      "mutate",
      params === undefined ? { sql } : { sql, params },
    ),
    transaction: (statements: SqlStatement[]) => invoke("transaction", { statements }),
    vfs: Object.freeze({
      command: async (command: string, options?: VfsCommandOptions) => {
        const wireOptions = await encodeVfsOptions(options);
        const result = await invoke(
          "vfs.command",
          wireOptions === undefined ? { command } : { command, options: wireOptions },
        );
        return {
          success: result.success,
          exitCode: result.exitCode,
          stdout: decodeBase64(result.stdoutBase64),
          stderr: decodeBase64(result.stderrBase64),
        };
      },
      open: async (path: string) => (await invoke("vfs.open", { path })).url,
    }),
    writeEvent: (event: WriteEventInput) => invoke("writeEvent", event),
  });
}

async function encodeVfsOptions(options: VfsCommandOptions | undefined): Promise<VfsCommandWireOptions | undefined> {
  if (!options) return undefined;
  const wire: VfsCommandWireOptions = {};
  if (options.stdout !== undefined) wire.stdout = options.stdout;
  if (options.author !== undefined) wire.author = options.author;
  if (options.stdin !== undefined) {
    if (typeof options.stdin === "string") {
      wire.stdin = { encoding: "utf8", data: options.stdin };
    } else {
      const bytes = options.stdin instanceof Blob
        ? await readBlobStream(options.stdin)
        : options.stdin instanceof Uint8Array
          ? options.stdin
          : new Uint8Array(options.stdin);
      wire.stdin = { encoding: "base64", data: encodeBase64(bytes) };
    }
  }
  return wire;
}

async function readBlobStream(blob: Blob): Promise<Uint8Array> {
  const reader = blob.stream().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
