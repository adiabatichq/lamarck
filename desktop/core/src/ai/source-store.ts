import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AccessSourceAllow, AiSourceInput, ManagedAiSource } from '@lamarck/system/protocol';
import { CredentialStore } from '../credentials/credential-store';
import type { SecretStore } from '../credentials/secret-store';
import { PACKAGE_ID_PATTERN } from '../package-id';

export class AiSourceStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private db: DatabaseSync, readonly credentials: CredentialStore, readonly secrets: SecretStore, private changed: (id: string) => void = () => {}) {}
  list(): ManagedAiSource[] {
    return (this.db.prepare('SELECT * FROM ai_access_sources ORDER BY id').all() as unknown as Row[]).map(fromRow);
  }
  get(id: string): ManagedAiSource | undefined {
    const row = this.db.prepare('SELECT * FROM ai_access_sources WHERE id = ?').get(id) as unknown as Row | undefined;
    return row && fromRow(row);
  }
  save(input: AiSourceInput, id?: string): Promise<ManagedAiSource> {
    return this.serial(async () => {
      const existing = id ? this.get(id) : undefined;
      if (id && !existing) throw new Error('AI source not found');
      validateInput(input);
      if (existing && (existing.provider !== input.provider || existing.kind !== input.kind)) throw new Error('Source provider and kind cannot change');
      const sourceId = existing?.id ?? `access_${randomUUID()}`;
      const allow = validateAllow(input.allow ?? existing?.allow ?? { mode: 'all' });
      const key = input.apiKey?.trim();
      if (input.kind === 'api-key' && !key && !existing) throw new Error('API key is required');
      if (key && input.kind !== 'api-key') throw new Error('API keys only belong to API-key sources');
      const ref = `ai-source:${sourceId}`;
      // Serialize mutations so a delayed secret write cannot resurrect removed
      // sources or overwrite a newer configuration.
      if (key) {
        await this.secrets.set(ref, key);
        this.credentials.upsert({ id: ref, kind: 'apiKey', ownerType: 'ai-source', ownerId: sourceId, secretItemId: ref, status: 'active' });
      }
      const source: ManagedAiSource = {
        id: sourceId, provider: input.provider, kind: input.kind, name: input.name.trim(), allow,
        config: input.config ?? existing?.config ?? {}, generation: (existing?.generation ?? 0) + 1,
      };
      this.db.prepare(`INSERT INTO ai_access_sources (id, provider, kind, name, allow_json, config_json, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
        allow_json=excluded.allow_json, config_json=excluded.config_json, generation=excluded.generation`)
        .run(source.id, source.provider, source.kind, source.name, JSON.stringify(source.allow), JSON.stringify(source.config), source.generation);
      this.changed(source.id);
      return source;
    });
  }
  saveSubscription(id: string, generation: number, auth: string): Promise<void> {
    return this.serial(async () => {
      if (this.get(id)?.generation !== generation) return;
      const ref = `ai-subscription:${id}`;
      await this.secrets.set(ref, auth);
      this.credentials.upsert({ id: ref, kind: 'managedProvider', ownerType: 'ai-source', ownerId: id, secretItemId: ref, status: 'active' });
    });
  }
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      this.db.prepare('DELETE FROM ai_access_sources WHERE id = ?').run(id);
      this.changed(id);
      for (const credential of this.credentials.listByOwner('ai-source', id)) {
        await this.secrets.delete(credential.secretItemId);
        this.credentials.delete(credential.id);
      }
    });
  }
  async apiKey(id: string): Promise<string> {
    const record = this.credentials.get(`ai-source:${id}`);
    const key = record?.status === 'active' ? await this.secrets.get(record.secretItemId) : undefined;
    if (!key) throw new Error('AI source credentials are unavailable');
    return key;
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.writes.then(run);
    this.writes = result.catch(() => {});
    return result;
  }
}
interface Row { id: string; provider: string; kind: ManagedAiSource['kind']; name: string; allow_json: string; config_json: string; generation: number }
function fromRow(row: Row): ManagedAiSource {
  return { id: row.id, provider: row.provider, kind: row.kind, name: row.name, allow: validateAllow(JSON.parse(row.allow_json)), config: JSON.parse(row.config_json), generation: row.generation };
}
export function allowed(source: ManagedAiSource, appId: string): boolean {
  return source.allow.mode === 'all' || source.allow.appIds.includes(appId);
}
export function validateAllow(value: unknown): AccessSourceAllow {
  if (!value || typeof value !== 'object') throw new Error('Invalid AI source allow setting');
  const allow = value as AccessSourceAllow;
  if (allow.mode === 'all' && Object.keys(value).length === 1) return { mode: 'all' };
  if (allow.mode === 'apps' && Object.keys(value).length === 2 && Array.isArray(allow.appIds) && allow.appIds.length <= 10000 && allow.appIds.every(id => typeof id === 'string' && id.length <= 200 && PACKAGE_ID_PATTERN.test(id))) return { mode: 'apps', appIds: [...new Set(allow.appIds)] };
  throw new Error('Invalid AI source allow setting');
}
function validateInput(input: AiSourceInput): void {
  if (!input || Object.keys(input).some(key => !['provider', 'kind', 'name', 'allow', 'config', 'apiKey'].includes(key))) throw new Error('Invalid AI source configuration');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('AI source name is required (120 characters maximum)');
  if (!((['openai', 'anthropic'].includes(input.provider) && ['api-key', 'subscription'].includes(input.kind)) || (input.provider === 'local' && input.kind === 'local'))) throw new Error('Unsupported AI provider/source kind');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 16000)) throw new Error('Invalid API key');
  if (input.config && (typeof input.config !== 'object' || Object.keys(input.config).some(key => key !== 'endpoint'))) throw new Error('Invalid AI endpoint configuration');
  if (input.kind === 'local') {
    const url = new URL(input.config?.endpoint ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Local endpoint must be an HTTP(S) service URL without credentials');
  } else if (input.config?.endpoint) throw new Error('Only local sources accept an endpoint');
}
