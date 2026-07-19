import type { DatabaseSync } from "node:sqlite";

export type CredentialStatus = "active" | "expired" | "revoked" | "refresh_failed";
export type CredentialKind = "apiKey" | "oauth2" | "managedProvider" | "lamarckSession";

export interface CredentialRecord {
  id: string;
  kind: CredentialKind;
  ownerType: string;
  ownerId: string;
  scopes: string[] | undefined;
  status: CredentialStatus;
  secretItemId: string;
  expiresAt: number | undefined;
  metadata: Record<string, unknown> | undefined;
  statusChangedAt: number;
  createdAt: number;
  updatedAt: number;
}

interface CredentialUpsertInput {
  id: string;
  kind: CredentialKind;
  ownerType: string;
  ownerId: string;
  scopes?: string[];
  status?: CredentialStatus;
  secretItemId: string;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export class CredentialStore {
  constructor(private systemDb: DatabaseSync) {}

  upsert(input: CredentialUpsertInput): CredentialRecord {
    const now = Date.now();
    const existing = this.get(input.id);
    const nextStatus = input.status ?? existing?.status ?? "active";
    const statusChangedAt = existing && existing.status === nextStatus
      ? existing.statusChangedAt
      : now;
    this.systemDb.prepare(
      `INSERT INTO auth_credentials
       (id, kind, account_id, owner_type, owner_id, scopes_json, status, secret_item_id,
        expires_at, metadata, status_changed_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         owner_type = excluded.owner_type,
         owner_id = excluded.owner_id,
         scopes_json = excluded.scopes_json,
         status = excluded.status,
         secret_item_id = excluded.secret_item_id,
         expires_at = excluded.expires_at,
         metadata = excluded.metadata,
         status_changed_at = excluded.status_changed_at,
         updated_at = excluded.updated_at`,
    ).run(
      input.id,
      input.kind,
      input.ownerType,
      input.ownerId,
      input.scopes ? JSON.stringify(input.scopes) : null,
      nextStatus,
      input.secretItemId,
      input.expiresAt ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      statusChangedAt,
      existing?.createdAt ?? now,
      now,
    );
    return this.get(input.id)!;
  }

  get(id: string): CredentialRecord | undefined {
    const row = this.systemDb.prepare("SELECT * FROM auth_credentials WHERE id = ?").get(id) as unknown as
      | CredentialRow
      | undefined;
    return row ? rowToCredential(row) : undefined;
  }

  listByOwner(ownerType: string, ownerId: string): CredentialRecord[] {
    return (this.systemDb.prepare(
      "SELECT * FROM auth_credentials WHERE owner_type = ? AND owner_id = ? ORDER BY created_at",
    ).all(ownerType, ownerId) as unknown as CredentialRow[]).map(rowToCredential);
  }

  setStatus(id: string, status: CredentialStatus, metadata?: Record<string, unknown>): void {
    const now = Date.now();
    const current = this.get(id);
    const mergedMetadata = metadata === undefined
      ? current?.metadata
      : { ...(current?.metadata ?? {}), ...metadata };
    this.systemDb.prepare(
      `UPDATE auth_credentials
       SET status = ?,
           metadata = ?,
           status_changed_at = CASE WHEN status = ? THEN status_changed_at ELSE ? END,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      status,
      mergedMetadata ? JSON.stringify(mergedMetadata) : null,
      status,
      now,
      now,
      id,
    );
  }

  delete(id: string): void {
    const credential = this.get(id);
    this.systemDb.prepare("DELETE FROM auth_credentials WHERE id = ?").run(id);
    if (credential) {
      this.systemDb.prepare("DELETE FROM auth_secret_items WHERE id = ?").run(credential.secretItemId);
    }
  }
}

interface CredentialRow {
  id: string;
  kind: CredentialKind;
  owner_type: string;
  owner_id: string;
  scopes_json: string | null;
  status: CredentialStatus;
  secret_item_id: string;
  expires_at: number | null;
  metadata: string | null;
  status_changed_at: number;
  created_at: number;
  updated_at: number;
}

function rowToCredential(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    kind: row.kind,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    scopes: row.scopes_json ? JSON.parse(row.scopes_json) as string[] : undefined,
    status: row.status,
    secretItemId: row.secret_item_id,
    expiresAt: row.expires_at ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined,
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
