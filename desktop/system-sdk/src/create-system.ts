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

const VFS_INLINE_STDIN_BYTES = 4 * 1024 * 1024;
const VFS_UPLOAD_CHUNK_BYTES = 512 * 1024;
const VFS_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

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
        const stdinBytes = options?.stdin === undefined
          ? undefined
          : vfsStdinByteLength(options.stdin);
        if (stdinBytes !== undefined && stdinBytes > VFS_UPLOAD_MAX_BYTES) {
          throw new Error("VFS stdin exceeds the 1 GiB upload limit");
        }
        const result = options?.stdin !== undefined
          && stdinBytes !== undefined
          && stdinBytes > VFS_INLINE_STDIN_BYTES
          ? await invokeUploadedVfsCommand(invoke, command, options, options.stdin)
          : await invokeInlineVfsCommand(invoke, command, options);
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

async function invokeInlineVfsCommand(
  invoke: SystemInvoke,
  command: string,
  options: VfsCommandOptions | undefined,
) {
  const wireOptions = await encodeVfsOptions(options);
  return invoke(
    "vfs.command",
    wireOptions === undefined ? { command } : { command, options: wireOptions },
  );
}

async function invokeUploadedVfsCommand(
  invoke: SystemInvoke,
  command: string,
  options: VfsCommandOptions,
  stdin: VfsStdin,
) {
  const { token } = await invoke("vfs.upload.begin", {});
  let abortRequired = true;
  try {
    let index = 0;
    for await (const chunk of vfsStdinChunks(stdin)) {
      await invoke("vfs.upload.chunk", {
        token,
        index,
        dataBase64: encodeBase64(chunk),
      });
      index += 1;
    }
    await invoke("vfs.upload.complete", { token });
    const wireOptions: VfsCommandWireOptions = { stdin: { uploadToken: token } };
    if (options.stdout !== undefined) wireOptions.stdout = options.stdout;
    if (options.author !== undefined) wireOptions.author = options.author;
    const result = await invoke("vfs.command", { command, options: wireOptions });
    abortRequired = false;
    return result;
  } finally {
    if (abortRequired) await invoke("vfs.upload.abort", { token }).catch(() => {});
  }
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

function vfsStdinByteLength(stdin: VfsStdin): number {
  if (typeof stdin === "string") return utf8ByteLength(stdin);
  if (stdin instanceof Blob) return stdin.size;
  return stdin.byteLength;
}

async function* vfsStdinChunks(stdin: VfsStdin): AsyncGenerator<Uint8Array> {
  if (typeof stdin === "string" || stdin instanceof Blob) {
    const blob = typeof stdin === "string" ? new Blob([stdin]) : stdin;
    const reader = blob.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (let offset = 0; offset < value.byteLength; offset += VFS_UPLOAD_CHUNK_BYTES) {
          yield value.subarray(offset, offset + VFS_UPLOAD_CHUNK_BYTES);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = stdin instanceof Uint8Array ? stdin : new Uint8Array(stdin);
  for (let offset = 0; offset < bytes.byteLength; offset += VFS_UPLOAD_CHUNK_BYTES) {
    yield bytes.subarray(offset, offset + VFS_UPLOAD_CHUNK_BYTES);
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
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
