import { randomBytes } from "node:crypto";
import {
  assertSafeD1Parents,
  d1PathsConflict,
  executeReadVfsCommand,
  hasD1Grant,
  isReservedD1Path,
  parseVfsCommand,
  resolveD1Path,
  validateD1Path,
  validateVfsMetadata,
  type ParsedVfsCommand,
} from "@lamarck/system/internal/vfs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { VfsCommandWireOptions, VfsCommandWireResult } from "@lamarck/system/protocol";
import { ContentBlobStore } from "./blob-store";
import { D1ObserverState } from "./d1-observer-state";
import { D1Sequencer } from "./d1-sequencer";
import {
  compareFileSnapshots,
  externalizeFileChanges,
  readStableD1File,
  recordedChanges,
  scanD1Files,
  type D1FileChange,
  type D1FileSnapshot,
} from "./filesystem-changes";
import type { RemoteGuard } from "./remote-guard";

export interface VfsCaller {
  guard: RemoteGuard;
  fileGrants: readonly string[] | null;
  trustedHost: boolean;
  workloadId?: string;
}

interface OpenHandle {
  path: string;
  digest: string;
  workloadId: string;
}

export const MAX_VFS_OPEN_HANDLES_PER_WORKLOAD = 256;

export interface VfsOpenContent {
  bytes: Buffer;
  mediaType: string;
}

export class VfsService {
  readonly filesRoot: string;
  private readonly openHandles = new Map<string, OpenHandle>();
  private readonly openHandleTokensByWorkload = new Map<string, Set<string>>();

  constructor(
    workspacePath: string,
    private readonly state: D1ObserverState,
    private readonly blobStore: ContentBlobStore,
    private readonly sequencer: D1Sequencer,
  ) {
    this.filesRoot = join(workspacePath, "files");
  }

  async initialize(): Promise<void> {
    await mkdir(this.filesRoot, { recursive: true });
  }

  async command(
    caller: VfsCaller,
    commandText: string,
    options: VfsCommandWireOptions = {},
  ): Promise<VfsCommandWireResult> {
    let parsed: ParsedVfsCommand;
    try {
      parsed = parseVfsCommand(commandText);
      validateOptions(options);
    } catch (error) {
      return result(1, Buffer.alloc(0), Buffer.from(`${errorMessage(error)}\n`));
    }

    if (parsed.name === "import" || parsed.name === "export") {
      if (!caller.trustedHost) {
        return result(1, Buffer.alloc(0), Buffer.from(`${parsed.name} is available only to trusted Host tools\n`));
      }
    }

    if (isMutating(parsed.name)) {
      return this.sequencer.run(() => this.executeMutation(caller, parsed, options));
    }
    try {
      const output = await this.executeRead(parsed);
      return result(0, options.stdout === "ignore" ? Buffer.alloc(0) : output, Buffer.alloc(0));
    } catch (error) {
      return result(1, Buffer.alloc(0), Buffer.from(`${errorMessage(error)}\n`));
    }
  }

  async open(caller: VfsCaller, path: string, origin: string): Promise<string> {
    if (!caller.workloadId) throw new Error("system.vfs.open requires a bound workload");
    const workloadTokens = this.openHandleTokensByWorkload.get(caller.workloadId) ?? new Set<string>();
    if (workloadTokens.size >= MAX_VFS_OPEN_HANDLES_PER_WORKLOAD) {
      throw new Error("system.vfs.open handle limit exceeded for this workload");
    }
    const snapshot = await readStableD1File(this.filesRoot, path);
    const token = randomBytes(32).toString("base64url");
    this.openHandles.set(token, {
      path: snapshot.path,
      digest: snapshot.digest,
      workloadId: caller.workloadId,
    });
    workloadTokens.add(token);
    this.openHandleTokensByWorkload.set(caller.workloadId, workloadTokens);
    return new URL(`/api/vfs/open/${token}`, origin).toString();
  }

  closeWorkload(workloadId: string): number {
    const tokens = this.openHandleTokensByWorkload.get(workloadId);
    if (!tokens) return 0;
    for (const token of tokens) this.openHandles.delete(token);
    this.openHandleTokensByWorkload.delete(workloadId);
    return tokens.size;
  }

  async resolveOpen(token: string, workloadIsOpen: (id: string) => boolean): Promise<VfsOpenContent | null> {
    const handle = this.openHandles.get(token);
    if (!handle || !workloadIsOpen(handle.workloadId)) {
      this.deleteOpenHandle(token, handle);
      return null;
    }
    try {
      const snapshot = await readStableD1File(this.filesRoot, handle.path);
      if (snapshot.digest !== handle.digest) {
        this.deleteOpenHandle(token, handle);
        return null;
      }
      return {
        bytes: snapshot.bytes,
        mediaType: mediaTypeForPath(handle.path),
      };
    } catch {
      this.deleteOpenHandle(token, handle);
      return null;
    }
  }

  private deleteOpenHandle(token: string, handle = this.openHandles.get(token)): void {
    this.openHandles.delete(token);
    if (!handle) return;
    const workloadTokens = this.openHandleTokensByWorkload.get(handle.workloadId);
    workloadTokens?.delete(token);
    if (workloadTokens?.size === 0) this.openHandleTokensByWorkload.delete(handle.workloadId);
  }

  private async executeMutation(
    caller: VfsCaller,
    parsed: ParsedVfsCommand,
    options: VfsCommandWireOptions,
  ): Promise<VfsCommandWireResult> {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let exitCode = 0;
    let before = new Map<string, D1FileSnapshot>();
    let after = before;
    let moveMappings: Array<{ from: string; path: string }> = [];
    try {
      before = await this.scanRecordedFiles();
      await this.preflight(caller, parsed);
      const stdin = decodeStdin(options.stdin);
      const execution = await this.performMutation(parsed, stdin);
      stdout = execution.stdout;
      moveMappings = execution.moves;
    } catch (error) {
      exitCode = 1;
      stderr = Buffer.from(`${errorMessage(error)}\n`);
    }

    try {
      after = await this.scanRecordedFiles();
      let changes = compareFileSnapshots(before, after);
      if (parsed.name === "mv" && moveMappings.length > 0) {
        changes = rewriteExplicitMoves(changes, before, after, moveMappings);
      }
      if (changes.length > 0) {
        const payload = {
          argv: parsed.argv,
          ...(options.author === undefined ? {} : { author: options.author }),
          ...externalizeFileChanges(changes, this.blobStore),
        };
        const eventId = await caller.guard.writeWorkspaceEvent({
          type: "workspace.files.changed",
          startedAt: Date.now(),
          payload,
        });
        this.state.apply(eventId, recordedChanges(changes), after);
      }
    } catch (error) {
      // A filesystem effect without D0/checkpoint completion must surface as a
      // transport failure. The observer will recover it from filesystem state.
      throw new Error(`VFS evidence recording failed: ${errorMessage(error)}`, { cause: error });
    }
    return result(
      exitCode,
      options.stdout === "ignore" ? Buffer.alloc(0) : stdout,
      stderr,
    );
  }

  private async scanRecordedFiles(): Promise<Map<string, D1FileSnapshot>> {
    return scanD1Files(this.filesRoot, {
      isExcluded: (path) => this.state.isExcluded(path),
      onWarning: (message) => console.warn(`[lamarck:d1] ${message}`),
    });
  }

  private async preflight(caller: VfsCaller, parsed: ParsedVfsCommand): Promise<void> {
    const force = parsed.flags.has("f");
    if (parsed.name === "tee") {
      for (const path of parsed.operands) {
        validateD1Path(path);
        requireGrant(caller, path, "write");
        await assertParentDirectory(this.filesRoot, path);
        await assertWritableFileTarget(this.filesRoot, path);
      }
      await this.assertNoCollisions(parsed.operands);
      return;
    }
    if (parsed.name === "mkdir") {
      for (const path of parsed.operands) {
        validateD1Path(path);
        const candidates = parsed.flags.has("p") ? parentPaths(path) : [path];
        for (const candidate of candidates) requireGrant(caller, candidate, "create");
        await assertSafeD1Parents(this.filesRoot, path, parsed.flags.has("p"));
        await assertDirectoryTarget(this.filesRoot, path);
      }
      await this.assertNoCollisions(parsed.operands);
      return;
    }
    if (parsed.name === "rm") {
      for (const path of parsed.operands) {
        validateD1Path(path);
        const entries = await collectEntryPaths(this.filesRoot, path);
        if (entries.length === 0 && !force) throw new Error(`rm: ${path}: No such file or directory`);
        for (const entry of entries) requireGrant(caller, entry.path, "remove");
        if (entries.some((entry) => entry.directory) && !parsed.flags.has("R") && !parsed.flags.has("r")) {
          throw new Error(`rm: ${path}: is a directory`);
        }
      }
      return;
    }
    if (parsed.name === "cp" || parsed.name === "mv") {
      const mappings = await resolveCopyMappings(this.filesRoot, parsed);
      for (const mapping of mappings) {
        const sourceEntries = await collectEntryPaths(this.filesRoot, mapping.from);
        if (sourceEntries.length === 0) throw new Error(`${parsed.name}: ${mapping.from}: No such file or directory`);
        if (sourceEntries[0]!.directory && parsed.name === "cp" && !parsed.flags.has("R") && !parsed.flags.has("r")) {
          throw new Error(`cp: ${mapping.from}: is a directory (use -R)`);
        }
        for (const entry of sourceEntries) {
          if (parsed.name === "mv") requireGrant(caller, entry.path, "move");
          const suffix = entry.path.slice(mapping.from.length);
          const target = `${mapping.path}${suffix}`;
          validateD1Path(target);
          requireGrant(caller, target, parsed.name === "mv" ? "move" : "copy");
        }
        await assertParentDirectory(this.filesRoot, mapping.path);
        const destinationExists = await pathExists(resolveD1Path(this.filesRoot, mapping.path));
        if (destinationExists && !force) {
          throw new Error(`${parsed.name}: ${mapping.path}: destination exists (use -f)`);
        }
        if (destinationExists) {
          const replacedEntries = await collectEntryPaths(this.filesRoot, mapping.path);
          for (const entry of replacedEntries) requireGrant(caller, entry.path, "replace");
        }
      }
      await this.assertNoCollisions(
        mappings.map((mapping) => mapping.path),
        [
          ...(parsed.name === "mv" ? mappings.map((mapping) => mapping.from) : []),
          ...(force ? mappings.map((mapping) => mapping.path) : []),
        ],
      );
      return;
    }
    if (parsed.name === "import") {
      const destination = parsed.operands[1]!;
      validateD1Path(destination);
      await assertParentDirectory(this.filesRoot, destination);
      const importedPaths = await collectHostImportPaths(parsed.operands[0]!, destination);
      for (const path of importedPaths) requireGrant(caller, path, "import");
      const destinationExists = await pathExists(resolveD1Path(this.filesRoot, destination));
      if (destinationExists && !force) {
        throw new Error(`import: ${destination}: destination exists (use -f)`);
      }
      if (destinationExists) {
        const replacedEntries = await collectEntryPaths(this.filesRoot, destination);
        for (const entry of replacedEntries) requireGrant(caller, entry.path, "replace");
      }
      await this.assertNoCollisions(importedPaths, force ? [destination] : []);
    }
  }

  private async assertNoCollisions(paths: readonly string[], replaced: readonly string[] = []): Promise<void> {
    const existing = await collectEntryPaths(this.filesRoot, "", true);
    for (const path of paths) {
      const peer = paths.find((candidate) => candidate !== path && d1PathsConflict(candidate, path));
      if (peer) throw new Error(`D1 path ${JSON.stringify(path)} collides with ${JSON.stringify(peer)}`);
      for (const entry of existing) {
        if (replaced.some((root) => entry.path === root || entry.path.startsWith(`${root}/`))) continue;
        if (entry.path !== path && d1PathsConflict(entry.path, path)) {
          throw new Error(`D1 path ${JSON.stringify(path)} collides with ${JSON.stringify(entry.path)}`);
        }
      }
    }
  }

  private async performMutation(
    parsed: ParsedVfsCommand,
    stdin: Buffer,
  ): Promise<{ stdout: Buffer; moves: Array<{ from: string; path: string }> }> {
    const force = parsed.flags.has("f");
    if (parsed.name === "tee") {
      for (const path of parsed.operands) {
        await writeFile(resolveD1Path(this.filesRoot, path), stdin, {
          flag: parsed.flags.has("a") ? "a" : "w",
        });
      }
      return { stdout: stdin, moves: [] };
    }
    if (parsed.name === "mkdir") {
      for (const path of parsed.operands) {
        await mkdir(resolveD1Path(this.filesRoot, path), { recursive: parsed.flags.has("p") });
      }
      return { stdout: Buffer.alloc(0), moves: [] };
    }
    if (parsed.name === "rm") {
      for (const path of parsed.operands) {
        await rm(resolveD1Path(this.filesRoot, path), {
          recursive: parsed.flags.has("R") || parsed.flags.has("r"),
          force,
        });
      }
      return { stdout: Buffer.alloc(0), moves: [] };
    }
    if (parsed.name === "cp" || parsed.name === "mv") {
      const mappings = await resolveCopyMappings(this.filesRoot, parsed);
      for (const mapping of mappings) {
        const source = resolveD1Path(this.filesRoot, mapping.from);
        const destination = resolveD1Path(this.filesRoot, mapping.path);
        if (force) await rm(destination, { recursive: true, force: true });
        if (parsed.name === "cp") {
          await cp(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
        } else {
          try {
            await rename(source, destination);
          } catch (error) {
            if (!isNodeError(error, "EXDEV")) throw error;
            await cp(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
            await rm(source, { recursive: true });
          }
        }
      }
      return { stdout: Buffer.alloc(0), moves: parsed.name === "mv" ? mappings : [] };
    }
    if (parsed.name === "import") {
      const source = resolve(parsed.operands[0]!);
      const destination = resolveD1Path(this.filesRoot, parsed.operands[1]!);
      if (force) await rm(destination, { recursive: true, force: true });
      await cp(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
      return { stdout: Buffer.alloc(0), moves: [] };
    }
    throw new Error(`Unsupported mutating command: ${parsed.name}`);
  }

  private async executeRead(parsed: ParsedVfsCommand): Promise<Buffer> {
    if (parsed.name === "cat" || parsed.name === "stat" || parsed.name === "ls") {
      return executeReadVfsCommand(this.filesRoot, parsed);
    }
    if (parsed.name === "export") {
      await collectEntryPaths(this.filesRoot, parsed.operands[0]!);
      const source = resolveD1Path(this.filesRoot, parsed.operands[0]!);
      const destination = resolve(parsed.operands[1]!);
      if (await pathExists(destination) && !parsed.flags.has("f")) {
        throw new Error("export: destination exists (use -f)");
      }
      if (parsed.flags.has("f")) await rm(destination, { recursive: true, force: true });
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
      return Buffer.alloc(0);
    }
    throw new Error(`${parsed.name} is not a read command`);
  }
}

function isMutating(name: ParsedVfsCommand["name"]): boolean {
  return name === "tee" || name === "cp" || name === "mv" || name === "rm"
    || name === "mkdir" || name === "import";
}

function validateOptions(options: VfsCommandWireOptions): void {
  validateVfsMetadata(options);
  if (options.stdin !== undefined && (
    !options.stdin
    || typeof options.stdin !== "object"
    || (options.stdin.encoding !== "utf8" && options.stdin.encoding !== "base64")
    || typeof options.stdin.data !== "string"
  )) throw new Error("VFS stdin encoding is invalid");
}

function decodeStdin(stdin: VfsCommandWireOptions["stdin"]): Buffer {
  if (!stdin) return Buffer.alloc(0);
  if (stdin.encoding === "utf8") return Buffer.from(stdin.data, "utf8");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(stdin.data)) {
    throw new Error("VFS stdin is not canonical base64");
  }
  const bytes = Buffer.from(stdin.data, "base64");
  if (bytes.toString("base64") !== stdin.data) throw new Error("VFS stdin is not canonical base64");
  return bytes;
}

function result(exitCode: number, stdout: Buffer, stderr: Buffer): VfsCommandWireResult {
  return {
    success: exitCode === 0,
    exitCode,
    stdoutBase64: stdout.toString("base64"),
    stderrBase64: stderr.toString("base64"),
  };
}

function requireGrant(caller: VfsCaller, path: string, operation: string): void {
  if (!hasD1Grant(caller.fileGrants, path)) {
    throw new Error(`VFS source is not allowed to ${operation} ${path}`);
  }
}

async function assertParentDirectory(filesRoot: string, path: string): Promise<void> {
  await assertSafeD1Parents(filesRoot, path);
  const parent = dirname(resolveD1Path(filesRoot, path));
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`VFS parent is not a regular directory: ${path}`);
}

async function assertWritableFileTarget(filesRoot: string, path: string): Promise<void> {
  try {
    const info = await lstat(resolveD1Path(filesRoot, path));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error(`VFS target is not a regular, non-hard-linked file: ${path}`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function assertDirectoryTarget(filesRoot: string, path: string): Promise<void> {
  try {
    const info = await lstat(resolveD1Path(filesRoot, path));
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`VFS directory target is unsupported: ${path}`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function collectHostImportPaths(sourcePath: string, destination: string): Promise<string[]> {
  const source = resolve(sourcePath);
  const info = await lstat(source);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) {
    throw new Error("import source must contain only regular files and directories");
  }
  const paths = [destination];
  if (info.isDirectory()) await collectHostTree(source, destination, paths);
  for (const path of paths) validateD1Path(path);
  return paths;
}

async function collectHostTree(root: string, destination: string, paths: string[]): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const sourcePath = join(root, entry.name);
    const destinationPath = `${destination}/${entry.name}`;
    const info = await lstat(sourcePath);
    paths.push(destinationPath);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await collectHostTree(sourcePath, destinationPath, paths);
    } else if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error("import source must contain only regular, non-hard-linked files and directories");
    }
  }
}

async function resolveCopyMappings(
  filesRoot: string,
  parsed: ParsedVfsCommand,
): Promise<Array<{ from: string; path: string }>> {
  const sources = parsed.operands.slice(0, -1);
  const rawDestination = parsed.operands.at(-1)!;
  for (const path of [...sources, rawDestination]) validateD1Path(path);
  await assertSafeD1Parents(filesRoot, rawDestination);
  let destinationDirectory = false;
  try {
    destinationDirectory = (await lstat(resolveD1Path(filesRoot, rawDestination))).isDirectory();
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  if (sources.length > 1 && !destinationDirectory) {
    throw new Error(`${parsed.name}: multiple sources require an existing destination directory`);
  }
  return sources.map((source) => ({
    from: source,
    path: destinationDirectory ? `${rawDestination}/${basename(source)}` : rawDestination,
  }));
}

async function collectEntryPaths(
  filesRoot: string,
  path: string,
  ignoreUnsupported = false,
): Promise<Array<{ path: string; directory: boolean }>> {
  if (path === "") {
    const values: Array<{ path: string; directory: boolean }> = [];
    let entries;
    try { entries = await readdir(filesRoot, { withFileTypes: true }); } catch (error) {
      if (isNodeError(error, "ENOENT")) return values;
      throw error;
    }
    for (const entry of entries) {
      if (isReservedD1Path(entry.name)) continue;
      try {
        values.push(...await collectEntryPaths(filesRoot, entry.name, ignoreUnsupported));
      } catch (error) {
        if (!ignoreUnsupported) throw error;
      }
    }
    return values;
  }
  validateD1Path(path);
  await assertSafeD1Parents(filesRoot, path);
  let info;
  try { info = await lstat(resolveD1Path(filesRoot, path)); } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) {
    throw new Error(`Unsupported filesystem entry: ${path}`);
  }
  const values = [{ path, directory: info.isDirectory() }];
  if (info.isDirectory()) {
    const entries = await readdir(resolveD1Path(filesRoot, path), { withFileTypes: true });
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (isReservedD1Path(child)) continue;
      try {
        values.push(...await collectEntryPaths(filesRoot, child, ignoreUnsupported));
      } catch (error) {
        if (!ignoreUnsupported) throw error;
      }
    }
  }
  return values;
}

function mediaTypeForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ({
    avif: "image/avif",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function parentPaths(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function rewriteExplicitMoves(
  changes: readonly D1FileChange[],
  before: ReadonlyMap<string, D1FileSnapshot>,
  after: ReadonlyMap<string, D1FileSnapshot>,
  mappings: readonly { from: string; path: string }[],
): D1FileChange[] {
  const rewritten = [...changes];
  for (const mapping of mappings) {
    const sources = [...before.keys()].filter((path) => (
      path === mapping.from || path.startsWith(`${mapping.from}/`)
    ));
    for (const sourcePath of sources) {
      const suffix = sourcePath.slice(mapping.from.length);
      const destinationPath = `${mapping.path}${suffix}`;
      const source = before.get(sourcePath);
      const destination = after.get(destinationPath);
      if (!source || !destination || source.digest !== destination.digest) continue;
      const sourceIndex = rewritten.findIndex((change) => change.kind === "deleted" && change.path === sourcePath);
      const destinationIndex = rewritten.findIndex((change) => (
        change.path === destinationPath && (change.kind === "added" || change.kind === "modified")
      ));
      if (sourceIndex === -1 || destinationIndex === -1) continue;
      const oldDestination = before.get(destinationPath);
      const removeIndexes = [sourceIndex, destinationIndex].sort((left, right) => right - left);
      for (const index of removeIndexes) rewritten.splice(index, 1);
      if (oldDestination) {
        rewritten.push({ kind: "deleted", path: destinationPath, digest: oldDestination.digest });
      }
      rewritten.push({ kind: "moved", from: sourcePath, path: destinationPath, digest: destination.digest });
    }
  }
  return rewritten.sort((left, right) => {
    const pathOrder = Buffer.from(left.path).compare(Buffer.from(right.path));
    if (pathOrder !== 0) return pathOrder;
    if (left.kind === "deleted" && right.kind === "moved") return -1;
    if (left.kind === "moved" && right.kind === "deleted") return 1;
    return left.kind.localeCompare(right.kind);
  });
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
