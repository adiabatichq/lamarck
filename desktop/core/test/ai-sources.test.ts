import { DatabaseSync } from 'node:sqlite';
import { describe, test, expect, vi } from 'vitest';
import { SYSTEM_SCHEMA_V1, SYSTEM_DATABASE_VERSION } from '../src/db';
import { AiSourceStore, allowed, validateAllow } from '../src/ai/source-store';
import { CredentialStore } from '../src/credentials/credential-store';
import { SqliteEncryptedSecretStore } from '../src/credentials/secret-store';
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); db.exec(SYSTEM_SCHEMA_V1);
  const secrets = new SqliteEncryptedSecretStore(db, new Uint8Array(32).fill(7)); const changed = vi.fn();
  const store = new AiSourceStore(db, new CredentialStore(db), secrets, changed);
  return { db, secrets, store, changed };
}
describe('v1 AI source store', () => {
  test('defaults to all including future Apps, persists policy, isolates same-provider keys', async () => {
    const { db, store, secrets } = fixture();
    try {
      const first = await store.save({ name: 'Personal', provider: 'openai', kind: 'api-key', apiKey: 'personal-secret' });
      const second = await store.save({ name: 'Work', provider: 'openai', kind: 'api-key', apiKey: 'work-secret', allow: { mode: 'apps', appIds: [] } });
      expect(SYSTEM_DATABASE_VERSION).toBe(1);
      expect(first.allow).toEqual({ mode: 'all' }); expect(allowed(first, 'app-created-later')).toBe(true);
      expect(allowed(second, 'any-app')).toBe(false);
      const updated = await store.save({ name: 'Renamed', provider: 'openai', kind: 'api-key', apiKey: 'rotated' }, second.id);
      expect(updated.allow).toEqual(second.allow); expect(updated.id).toBe(second.id); expect(updated.generation).toBe(2);
      const restarted = new AiSourceStore(db, new CredentialStore(db), secrets);
      expect(restarted.get(second.id)).toEqual(updated);
      expect(JSON.stringify(restarted.list())).not.toContain('secret');
      await restarted.remove(first.id);
      expect(await secrets.get(`ai-source:${first.id}`)).toBeUndefined();
      expect(await restarted.apiKey(second.id)).toBe('rotated');
    } finally { db.close(); }
  });
  test('rejects invalid policies, credentials and unsupported source configuration', async () => {
    const { db, store } = fixture();
    try {
      for (const value of [undefined, {}, { mode: 'all', appIds: [] }, { mode: 'apps', appIds: ['../host'] }]) expect(() => validateAllow(value)).toThrow();
      await expect(store.save({ name: 'Credits', provider: 'openai', kind: 'lamarck' })).rejects.toThrow('Unsupported');
      await expect(store.save({ name: 'API', provider: 'openai', kind: 'api-key' })).rejects.toThrow('key');
      await expect(store.save({ name: 'Endpoint', provider: 'local', kind: 'local', config: { endpoint: 'file:///etc/passwd' } })).rejects.toThrow();
    } finally { db.close(); }
  });
  test('stale login completion cannot replace credentials after reconfiguration or deletion', async () => {
    const { db, store, secrets } = fixture();
    try {
      const source = await store.save({ name: 'Subscription', provider: 'openai', kind: 'subscription' });
      await store.save({ name: 'New account', provider: 'openai', kind: 'subscription' }, source.id);
      await store.saveSubscription(source.id, source.generation, 'stale-auth');
      expect(await secrets.get(`ai-subscription:${source.id}`)).toBeUndefined();
      await store.remove(source.id);
      await store.saveSubscription(source.id, 2, 'late-auth');
      expect(await secrets.get(`ai-subscription:${source.id}`)).toBeUndefined();
    } finally { db.close(); }
  });
  test('serializes delayed secret replacement with source removal', async () => {
    const { db, store, secrets } = fixture();
    try {
      const source = await store.save({ name: 'Key', provider: 'openai', kind: 'api-key', apiKey: 'a' });
      const save = store.save({ name: 'Key', provider: 'openai', kind: 'api-key', apiKey: 'b' }, source.id);
      const remove = store.remove(source.id);
      await Promise.all([save, remove]);
      expect(store.get(source.id)).toBeUndefined(); expect(await secrets.get(`ai-source:${source.id}`)).toBeUndefined();
    } finally { db.close(); }
  });
});
