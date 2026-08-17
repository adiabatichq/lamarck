import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type VfsCommandName =
  | "ls"
  | "cat"
  | "stat"
  | "tee"
  | "cp"
  | "mv"
  | "rm"
  | "mkdir"
  | "import"
  | "export";

export interface ParsedVfsCommand {
  name: VfsCommandName;
  flags: ReadonlySet<string>;
  operands: string[];
  argv: string[];
}

const FLAGS: Record<VfsCommandName, ReadonlySet<string>> = {
  ls: new Set(["a", "l", "1", "R"]),
  cat: new Set(),
  stat: new Set(),
  tee: new Set(["a"]),
  cp: new Set(["R", "r", "f"]),
  mv: new Set(["f"]),
  rm: new Set(["R", "r", "f"]),
  mkdir: new Set(["p"]),
  import: new Set(["f"]),
  export: new Set(["f"]),
};

const FLAG_ORDER: Record<VfsCommandName, readonly string[]> = {
  ls: ["a", "l", "1", "R"],
  cat: [],
  stat: [],
  tee: ["a"],
  cp: ["R", "r", "f"],
  mv: ["f"],
  rm: ["R", "r", "f"],
  mkdir: ["p"],
  import: ["f"],
  export: ["f"],
};

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const PORTABLE_PATH_CHARS = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MAX_PATH_BYTES = 768;
const MAX_SEGMENT_BYTES = 240;
const VFS_READ_CHUNK_BYTES = 64 * 1024;

export function parseVfsCommand(command: string): ParsedVfsCommand {
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    throw new Error("VFS command must be a non-empty string");
  }
  const words = splitWords(command);
  const name = words.shift() as VfsCommandName | undefined;
  if (!name || !Object.hasOwn(FLAGS, name)) {
    throw new Error(`Unsupported VFS command: ${name ?? ""}`);
  }

  const flags = new Set<string>();
  const operands: string[] = [];
  let options = true;
  for (const word of words) {
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && word.startsWith("-") && word !== "-") {
      for (const flag of word.slice(1)) {
        if (!FLAGS[name].has(flag)) throw new Error(`Unsupported ${name} flag: -${flag}`);
        flags.add(flag);
      }
      continue;
    }
    options = false;
    operands.push(word);
  }

  if ((name === "cp" || name === "mv") && operands.length < 2) {
    throw new Error(`${name} requires a source and destination`);
  }
  if ((name === "rm" || name === "mkdir" || name === "stat") && operands.length < 1) {
    throw new Error(`${name} requires at least one path`);
  }
  if ((name === "import" || name === "export") && operands.length !== 2) {
    throw new Error(`${name} requires exactly two paths`);
  }

  const canonicalFlags = FLAG_ORDER[name].filter((flag) => flags.has(flag));
  return {
    name,
    flags,
    operands,
    argv: [
      name,
      ...(canonicalFlags.length > 0 ? [`-${canonicalFlags.join("")}`] : []),
      ...(operands.length > 0 ? ["--", ...operands] : []),
    ],
  };
}

export function isReadVfsCommand(command: ParsedVfsCommand): boolean {
  return command.name === "ls" || command.name === "cat" || command.name === "stat";
}

export function validateVfsMetadata(options: unknown): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("VFS options must be an object");
  }
  const value = options as { stdout?: unknown; author?: unknown };
  if (value.stdout !== undefined && value.stdout !== "capture" && value.stdout !== "ignore") {
    throw new Error("VFS stdout must be capture or ignore");
  }
  if (value.author !== undefined && (
    typeof value.author !== "string"
    || value.author.length > 200
    || /[\x00-\x1f\x7f]/.test(value.author)
  )) {
    throw new Error("VFS author must be at most 200 characters and contain no control characters");
  }
}

export async function executeReadVfsCommand(
  filesRoot: string,
  parsed: ParsedVfsCommand,
  options: {
    captureOutput?: boolean;
    maxCapturedBytes?: number;
  } = {},
): Promise<Buffer> {
  if (parsed.name === "cat") {
    const captureOutput = options.captureOutput !== false;
    const maxCapturedBytes = options.maxCapturedBytes ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maxCapturedBytes) || maxCapturedBytes < 0) {
      throw new Error("cat captured-output limit is invalid");
    }
    if (captureOutput) {
      await assertCatCaptureWithinLimit(filesRoot, parsed.operands, maxCapturedBytes);
    }
    const chunks: Buffer[] = [];
    let remainingBytes = maxCapturedBytes;
    for (const path of parsed.operands) {
      const bytes = await readStableFile(filesRoot, path, {
        retainBytes: captureOutput,
        maxBytes: remainingBytes,
      });
      if (captureOutput) {
        chunks.push(bytes);
        remainingBytes -= bytes.byteLength;
      }
    }
    return captureOutput ? Buffer.concat(chunks) : Buffer.alloc(0);
  }
  if (parsed.name === "stat") {
    const lines: string[] = [];
    for (const path of parsed.operands) {
      validateD1Path(path);
      await assertSafeD1Parents(filesRoot, path);
      const entry = await lstat(resolveD1Path(filesRoot, path));
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error(`stat: ${path}: unsupported filesystem entry`);
      }
      if (entry.isFile() && entry.nlink !== 1) throw new Error(`stat: ${path}: hard links are unsupported`);
      lines.push(`${path}\t${entry.isDirectory() ? "directory" : "file"}\t${entry.size}`);
    }
    return Buffer.from(lines.length ? `${lines.join("\n")}\n` : "");
  }
  if (parsed.name === "ls") return Buffer.from(await formatListing(filesRoot, parsed));
  throw new Error(`${parsed.name} is not a read command`);
}

export function validateD1Path(path: string): string {
  if (
    typeof path !== "string"
    || path.length === 0
    || isAbsolute(path)
    || path.startsWith("/")
    || path.includes("\\")
    || CONTROL_CHARS.test(path)
    || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES
  ) {
    throw new Error(`Invalid D1 path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) =>
    segment === ""
    || segment === "."
    || segment === ".."
    || segment.endsWith(" ")
    || segment.endsWith(".")
    || PORTABLE_PATH_CHARS.test(segment)
    || WINDOWS_RESERVED_NAME.test(segment)
    || Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES
  )) {
    throw new Error(`Invalid D1 path: ${JSON.stringify(path)}`);
  }
  if (isReservedD1Path(path)) throw new Error(`Reserved D1 path: ${JSON.stringify(path)}`);
  return path;
}

export function validateD1Grant(grant: string): string {
  if (typeof grant !== "string" || grant.length === 0) throw new Error("Invalid D1 file grant");
  const body = grant.endsWith("/") ? grant.slice(0, -1) : grant;
  validateD1Path(body);
  return grant;
}

export function isReservedD1Path(path: string): boolean {
  const segments = path.split("/");
  return segments[0]?.toLocaleLowerCase("en-US") === ".obsidian"
    || segments.some((segment) => segment.toLocaleLowerCase("en-US") === ".ds_store");
}

export function portablePathSegmentKey(value: string): string {
  return value.normalize("NFKD").toUpperCase().toLowerCase().normalize("NFKD");
}

export function portableD1PathKey(path: string): string {
  validateD1Path(path);
  return path.split("/").map(portablePathSegmentKey).join("/");
}

export function d1PathsConflict(leftPath: string, rightPath: string): boolean {
  if (leftPath === rightPath) return false;
  const left = leftPath.split("/");
  const right = rightPath.split("/");
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (portablePathSegmentKey(left[index]!) !== portablePathSegmentKey(right[index]!)) return false;
    if (left[index] !== right[index]) return true;
  }
  return false;
}

export function resolveD1Path(filesRoot: string, path: string): string {
  validateD1Path(path);
  const root = resolve(filesRoot);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Invalid D1 path: ${JSON.stringify(path)}`);
  }
  return target;
}

export async function assertSafeD1Parents(
  filesRoot: string,
  path: string,
  allowMissing = false,
): Promise<void> {
  validateD1Path(path);
  const root = resolve(filesRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("D1 root must be a real directory");
  const segments = path.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`D1 parent is not a real directory: ${path}`);
      }
    } catch (error) {
      if (allowMissing && isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }
}

export function hasD1Grant(grants: readonly string[] | null, path: string): boolean {
  if (grants === null) return true;
  return grants.some((grant) => grant.endsWith("/")
    ? path === grant.slice(0, -1) || path.startsWith(grant)
    : path === grant);
}

async function assertCatCaptureWithinLimit(
  filesRoot: string,
  paths: readonly string[],
  maxBytes: number,
): Promise<void> {
  let total = 0n;
  const limit = BigInt(maxBytes);
  for (const path of paths) {
    validateD1Path(path);
    await assertSafeD1Parents(filesRoot, path);
    const info = await lstat(resolveD1Path(filesRoot, path), { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
      throw new Error(`cat: ${path}: unsupported filesystem entry`);
    }
    total += info.size;
    if (total > limit) throw new Error("cat: captured output exceeds the size limit");
  }
}

async function readStableFile(
  filesRoot: string,
  path: string,
  options: { retainBytes: boolean; maxBytes: number },
): Promise<Buffer> {
  validateD1Path(path);
  await assertSafeD1Parents(filesRoot, path);
  const filePath = join(filesRoot, ...path.split("/"));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) {
        throw new Error("D1 admits only regular, non-hard-linked files");
      }
      if (options.retainBytes && before.size > BigInt(options.maxBytes)) {
        throw new Error("cat: captured output exceeds the size limit");
      }
      const bytes = options.retainBytes
        ? Buffer.allocUnsafe(Number(before.size))
        : Buffer.alloc(0);
      const chunk = options.retainBytes ? bytes : Buffer.allocUnsafe(VFS_READ_CHUNK_BYTES);
      let position = 0;
      let reachedEof = false;
      for (;;) {
        if (options.retainBytes && position === bytes.byteLength) {
          const extra = Buffer.allocUnsafe(1);
          reachedEof = (await handle.read(extra, 0, extra.byteLength, position)).bytesRead === 0;
          break;
        }
        const length = options.retainBytes
          ? bytes.byteLength - position
          : chunk.byteLength;
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (bytesRead === 0) {
          reachedEof = true;
          break;
        }
        position += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        before.dev === after.dev
        && before.ino === after.ino
        && before.size === after.size
        && before.mtimeNs === after.mtimeNs
        && before.ctimeNs === after.ctimeNs
        && BigInt(position) === after.size
        && reachedEof
      ) return options.retainBytes ? bytes : Buffer.alloc(0);
    } finally {
      await handle.close();
    }
  }
  throw new Error("file changed while it was being read");
}

async function formatListing(filesRoot: string, parsed: ParsedVfsCommand): Promise<string> {
  const operands = parsed.operands.length > 0 ? parsed.operands : [""];
  const lines: string[] = [];
  for (const operand of operands) {
    if (operand) validateD1Path(operand);
    if (operand) await assertSafeD1Parents(filesRoot, operand);
    const absolute = operand ? resolveD1Path(filesRoot, operand) : filesRoot;
    const info = await lstat(absolute);
    if (info.isFile()) {
      if (info.nlink !== 1) throw new Error(`ls: ${operand}: hard links are unsupported`);
      lines.push(parsed.flags.has("l") ? `-${info.size}\t${operand}` : operand);
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`ls: ${operand}: unsupported entry`);
    const walk = async (directoryPath: string, prefix: string): Promise<void> => {
      const entries = (await readdir(directoryPath, { withFileTypes: true }))
        .filter((entry) => !isReservedD1Path(prefix ? `${prefix}/${entry.name}` : entry.name))
        .filter((entry) => parsed.flags.has("a") || !entry.name.startsWith("."))
        .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        validateD1Path(path);
        if (!entry.isFile() && !entry.isDirectory()) continue;
        const entryInfo = await lstat(join(directoryPath, entry.name));
        if (entryInfo.isSymbolicLink() || (entryInfo.isFile() && entryInfo.nlink !== 1)) continue;
        lines.push(parsed.flags.has("l")
          ? `${entry.isDirectory() ? "d" : "-"}${entryInfo.size}\t${path}`
          : path);
        if (entry.isDirectory() && parsed.flags.has("R")) await walk(join(directoryPath, entry.name), path);
      }
    };
    await walk(absolute, operand);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function splitWords(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "single" | "double" | null = null;
  let escaped = false;
  const finish = () => {
    if (!started) return;
    words.push(word);
    word = "";
    started = false;
  };
  for (const character of input) {
    if (escaped) {
      word += character;
      started = true;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = null;
      else word += character;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      else if (character === "\\") escaped = true;
      else {
        if (character === "$" || character === "`") unsupportedSyntax(character);
        word += character;
      }
      started = true;
      continue;
    }
    if (/\s/u.test(character)) finish();
    else if (character === "'") {
      quote = "single";
      started = true;
    } else if (character === '"') {
      quote = "double";
      started = true;
    } else if (character === "\\") {
      escaped = true;
      started = true;
    } else if ("|><;&$`*?[]{}".includes(character)) unsupportedSyntax(character);
    else {
      word += character;
      started = true;
    }
  }
  if (escaped) throw new Error("VFS command ends with an incomplete escape");
  if (quote) throw new Error("VFS command has an unterminated quote");
  finish();
  return words;
}

function unsupportedSyntax(value: string): never {
  throw new Error(`Unsupported VFS command syntax: ${value}`);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
