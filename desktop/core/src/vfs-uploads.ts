import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const UPLOAD_TTL_MS = 5 * 60_000;
const MAX_UPLOADS_PER_WORKLOAD = 4;
const MAX_UPLOADS_GLOBAL = 32;
const MAX_CHUNK_BYTES = 1024 * 1024;
export const MAX_VFS_UPLOAD_BYTES = 1024 * 1024 * 1024;

interface UploadSession {
  token: string;
  workloadId: string;
  path: string;
  nextChunkIndex: number;
  byteLength: number;
  completed: boolean;
  busy: boolean;
  expiresAt: number;
}

export interface ConsumedVfsUpload {
  token: string;
  path: string;
  byteLength: number;
}

export class VfsUploadStore {
  readonly root: string;
  private readonly sessions = new Map<string, UploadSession>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    workspacePath: string,
    private readonly maxUploadBytes = MAX_VFS_UPLOAD_BYTES,
  ) {
    if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 0) {
      throw new Error("VFS upload byte limit is invalid");
    }
    this.root = join(workspacePath, ".lamarck", "tmp", "vfs-uploads");
  }

  async initialize(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
  }

  async begin(workloadId: string): Promise<string> {
    this.expire();
    const workloadCount = [...this.sessions.values()]
      .filter((session) => session.workloadId === workloadId).length;
    if (workloadCount >= MAX_UPLOADS_PER_WORKLOAD || this.sessions.size >= MAX_UPLOADS_GLOBAL) {
      throw new Error("Too many concurrent VFS uploads");
    }

    let token: string;
    do token = randomBytes(32).toString("base64url");
    while (this.sessions.has(token));
    const path = join(this.root, token);
    const session: UploadSession = {
      token,
      workloadId,
      path,
      nextChunkIndex: 0,
      byteLength: 0,
      completed: false,
      busy: true,
      expiresAt: Date.now() + UPLOAD_TTL_MS,
    };
    // Reserve quota before filesystem creation yields so concurrent begins
    // observe this session in both workload and global counts.
    this.sessions.set(token, session);
    this.scheduleExpiry();
    try {
      await writeFile(path, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
      if (this.sessions.get(token) !== session) {
        unlinkFile(path);
        throw new Error("VFS upload is no longer active");
      }
      session.busy = false;
      session.expiresAt = Date.now() + UPLOAD_TTL_MS;
      this.scheduleExpiry();
      return token;
    } catch (error) {
      this.removeSession(session);
      unlinkFile(path);
      throw error;
    }
  }

  async append(workloadId: string, token: string, index: number, dataBase64: string): Promise<void> {
    this.expire();
    const session = this.requireOwned(workloadId, token);
    if (session.completed) throw new Error("VFS upload is already complete");
    if (session.busy) throw new Error("VFS upload already has an operation in progress");
    if (!Number.isSafeInteger(index) || index < 0 || index !== session.nextChunkIndex) {
      this.deleteSession(session);
      throw new Error("VFS upload chunk index is invalid");
    }
    let bytes: Buffer;
    try {
      bytes = decodeCanonicalBase64(dataBase64);
    } catch (error) {
      this.deleteSession(session);
      throw error;
    }
    if (bytes.byteLength > MAX_CHUNK_BYTES) {
      this.deleteSession(session);
      throw new Error("VFS upload chunk exceeds the size limit");
    }
    if (session.byteLength > this.maxUploadBytes - bytes.byteLength) {
      this.deleteSession(session);
      throw new Error("VFS upload exceeds the 1 GiB size limit");
    }

    session.busy = true;
    try {
      await appendFile(session.path, bytes);
      if (this.sessions.get(token) !== session) {
        unlinkFile(session.path);
        throw new Error("VFS upload is no longer active");
      }
      session.byteLength += bytes.byteLength;
      session.nextChunkIndex += 1;
      session.expiresAt = Date.now() + UPLOAD_TTL_MS;
      this.scheduleExpiry();
    } catch (error) {
      this.deleteSession(session);
      throw error;
    } finally {
      session.busy = false;
    }
  }

  complete(workloadId: string, token: string): void {
    this.expire();
    const session = this.requireOwned(workloadId, token);
    if (session.busy) throw new Error("VFS upload already has an operation in progress");
    session.completed = true;
    session.expiresAt = Date.now() + UPLOAD_TTL_MS;
    this.scheduleExpiry();
  }

  consume(workloadId: string, token: string): ConsumedVfsUpload {
    this.expire();
    const session = this.requireOwned(workloadId, token);
    if (session.busy) throw new Error("VFS upload already has an operation in progress");
    if (!session.completed) {
      this.deleteSession(session);
      throw new Error("VFS upload is not complete");
    }
    this.removeSession(session);
    return { token: session.token, path: session.path, byteLength: session.byteLength };
  }

  abort(workloadId: string, token: string): void {
    this.expire();
    const session = this.requireOwned(workloadId, token);
    this.deleteSession(session);
  }

  closeWorkload(workloadId: string): number {
    const owned = [...this.sessions.values()]
      .filter((session) => session.workloadId === workloadId);
    for (const session of owned) this.deleteSession(session);
    return owned.length;
  }

  expire(now = Date.now()): number {
    const expired = [...this.sessions.values()]
      .filter((session) => session.expiresAt <= now);
    for (const session of expired) this.deleteSession(session);
    return expired.length;
  }

  cleanupConsumed(upload: ConsumedVfsUpload): void {
    try {
      unlinkFile(upload.path);
    } catch (error) {
      console.warn(
        `[lamarck:vfs] consumed upload cleanup failed: ${boundedErrorMessage(error)}`
      );
    }
  }

  private requireOwned(workloadId: string, token: string): UploadSession {
    const session = this.sessions.get(token);
    if (!session || session.workloadId !== workloadId) {
      throw new Error("VFS upload token is not available to this workload");
    }
    return session;
  }

  private deleteSession(session: UploadSession): void {
    this.removeSession(session);
    unlinkFile(session.path);
  }

  private removeSession(session: UploadSession): void {
    if (this.sessions.get(session.token) === session) this.sessions.delete(session.token);
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.sessions.size === 0) return;
    const nextExpiry = Math.min(...[...this.sessions.values()].map((session) => session.expiresAt));
    this.expiryTimer = setTimeout(() => this.expire(), Math.max(1, nextExpiry - Date.now()));
    this.expiryTimer.unref?.();
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("VFS upload chunk is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error("VFS upload chunk is not canonical base64");
  }
  return bytes;
}

function unlinkFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}
