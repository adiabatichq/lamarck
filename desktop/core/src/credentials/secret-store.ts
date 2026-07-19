import type { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "crypto";

export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  has?(ref: string): Promise<boolean>;
}

export class MemorySecretStore implements SecretStore {
  private values = new Map<string, string>();

  async get(ref: string): Promise<string | undefined> {
    return this.values.get(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }

  async has(ref: string): Promise<boolean> {
    return this.values.has(ref);
  }
}

export class SqliteEncryptedSecretStore implements SecretStore {
  private key: Buffer;

  constructor(private systemDb: DatabaseSync, vaultKey: string | Uint8Array) {
    this.key = normalizeVaultKey(vaultKey);
  }

  async get(ref: string): Promise<string | undefined> {
    const row = this.systemDb.prepare(
      "SELECT ciphertext, nonce, algorithm FROM auth_secret_items WHERE id = ?",
    ).get(ref) as { ciphertext: string; nonce: string; algorithm: string } | null;
    if (!row) return undefined;
    if (row.algorithm !== "aes-256-gcm") {
      throw new Error(`Unsupported secret algorithm: ${row.algorithm}`);
    }
    return decryptString({
      key: this.key,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
    });
  }

  async set(ref: string, value: string): Promise<void> {
    const now = Date.now();
    const encrypted = encryptString({ key: this.key, plaintext: value });
    this.systemDb.prepare(
      `INSERT INTO auth_secret_items (id, ciphertext, nonce, algorithm, created_at, updated_at)
       VALUES (?, ?, ?, 'aes-256-gcm', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         nonce = excluded.nonce,
         algorithm = excluded.algorithm,
         updated_at = excluded.updated_at`,
    ).run(ref, encrypted.ciphertext, encrypted.nonce, now, now);
  }

  async delete(ref: string): Promise<void> {
    this.systemDb.prepare("DELETE FROM auth_secret_items WHERE id = ?").run(ref);
  }

  async has(ref: string): Promise<boolean> {
    const row = this.systemDb.prepare(
      "SELECT 1 AS present FROM auth_secret_items WHERE id = ?",
    ).get(ref);
    return Boolean(row);
  }
}

export function encodeVaultKey(key: Uint8Array): string {
  return base64url(Buffer.from(key));
}

export function decodeVaultKey(value: string): Buffer {
  return normalizeVaultKey(value);
}

export function createVaultKey(): Buffer {
  return randomBytes(32);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encryptString(opts: { key: Buffer; plaintext: string }): { ciphertext: string; nonce: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", opts.key, nonce);
  const encrypted = Buffer.concat([cipher.update(opts.plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: base64url(Buffer.concat([encrypted, tag])),
    nonce: base64url(nonce),
  };
}

function decryptString(opts: { key: Buffer; ciphertext: string; nonce: string }): string {
  const packed = unbase64url(opts.ciphertext);
  if (packed.length < 17) throw new Error("Invalid ciphertext");
  const encrypted = packed.subarray(0, -16);
  const tag = packed.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", opts.key, unbase64url(opts.nonce));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function normalizeVaultKey(value: string | Uint8Array): Buffer {
  const key = typeof value === "string" ? unbase64url(value) : Buffer.from(value);
  if (key.length !== 32) {
    throw new Error("LAMARCK_VAULT_KEY must decode to 32 bytes");
  }
  return key;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function unbase64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
