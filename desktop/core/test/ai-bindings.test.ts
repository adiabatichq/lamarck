import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { encodeAi } from '@lamarck/system/protocol';
import { validateAppManifest, type AppManifest } from '../src/app-loader';
import { SYSTEM_SCHEMA_V1 } from '../src/db';
import { CredentialStore } from '../src/credentials/credential-store';
import { SqliteEncryptedSecretStore } from '../src/credentials/secret-store';
import { AiService, type AiAdapter } from '../src/ai/service';
import { handleAiRequest } from '../src/ai/routes';
import type { AppAuthContext, AuthAdmission } from '../src/auth';

let root: string, db: DatabaseSync, service: AiService;
const manifests = new Map<string, AppManifest>();
let status: 'ready' | 'login-required' = 'ready';
const adapter: AiAdapter = {
  describe: vi.fn<AiAdapter['describe']>(async source => ({ models: [], view: { id: source.id, name: source.name, provider: source.provider, kind: source.kind, status,
    discovery: status === 'ready' ? 'known' : 'unknown', support: [{ model: 'openai:text-embedding-3-small', streaming: false, structuredOutput: false, tools: false, maxEmbeddingsPerCall: 2 }] } })),
  open: vi.fn(async () => { throw new Error('No provider execution in management tests'); }),
};
function declaration(id: string, provider = 'openai') {
  const result = validateAppManifest({ manifestVersion: 1, id, name: id, description: 'Bindings fixture', runtime: { jobs: { run: { command: ['node', 'run.mjs'] } } }, permissions: { writes: { files: [], tables: [] } },
    ai: { accessSources: { summary: { name: 'Summary', provider } } } });
  if (!result.ok) throw new Error(result.error);
  manifests.set(id, result.manifest); return result.manifest;
}
function caller(appId = 'app-a'): AppAuthContext {
  return { kind: 'app', appId, workload: 'job:run', channelId: appId, authorization: { activationId: 'fixture', manifestDigest: `sha256:${'1'.repeat(64)}`, packageDigest: `sha256:${'2'.repeat(64)}`, appCommit: '3'.repeat(40), writeTables: [], fileGrants: [], aiAccessSources: structuredClone(manifests.get(appId)!.ai?.accessSources ?? {}) } };
}
function createService() {
  return new AiService(db, new CredentialStore(db), new SqliteEncryptedSecretStore(db, new Uint8Array(32).fill(1)), root, adapter,
    { current: async () => [...manifests.values()] });
}
async function management(path: string, body?: unknown, context: AuthAdmission['context'] = { kind: 'host' }) {
  const request = new Request(`http://localhost/api/ai/${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  return (await handleAiRequest(service, request, { context, signal: new AbortController().signal, release() {} })).body as any;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-bindings-')); db = new DatabaseSync(join(root, 'system.db')); db.exec(SYSTEM_SCHEMA_V1);
  manifests.clear(); status = 'ready'; vi.clearAllMocks(); declaration('app-a'); declaration('app-b'); service = createService();
});
afterEach(async () => { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); });

test('Console discovers requirements before calls, creates/selects/clears bindings, and persists across restart', async () => {
  expect((await management('sources')).requirements).toEqual(expect.arrayContaining([
    expect.objectContaining({ appId: 'app-a', reference: 'summary', state: 'setup-required' }),
    expect.objectContaining({ appId: 'app-b', reference: 'summary', state: 'setup-required' }),
  ]));
  const first = await management('sources', { provider: 'openai', kind: 'subscription', name: 'Existing Codex' });
  const second = await management('sources', { provider: 'openai', kind: 'api-key', name: 'Created API', apiKey: 'fixture-only' });
  await management('bindings', { appId: 'app-a', reference: 'summary', sourceId: first.id });
  await management('bindings', { appId: 'app-b', reference: 'summary', sourceId: second.id });
  await service.close(); db.close(); db = new DatabaseSync(join(root, 'system.db')); service = createService();
  const requirements = (await management('sources')).requirements;
  expect(requirements.find((item: any) => item.appId === 'app-a')).toMatchObject({ sourceId: first.id, state: 'configured' });
  expect(requirements.find((item: any) => item.appId === 'app-b')).toMatchObject({ sourceId: second.id, state: 'configured' });
  await management('bindings', { appId: 'app-a', reference: 'summary', sourceId: second.id });
  await management('bindings', { appId: 'app-b', reference: 'summary', sourceId: null });
  expect(service.sources.binding('app-a', 'summary')).toBe(second.id);
  expect((await service.requirements()).find(item => item.appId === 'app-b')!.state).toBe('setup-required');
  expect(adapter.open).not.toHaveBeenCalled();
});

test('bindings cannot grant access, manufacture declarations, or be managed by Apps', async () => {
  const source = await service.sources.save({ name: 'Restricted', provider: 'openai', kind: 'subscription', allow: { mode: 'apps', appIds: ['app-a'] } });
  await expect(management('bindings', { appId: 'app-b', reference: 'summary', sourceId: source.id })).rejects.toMatchObject({ code: 'source_denied' });
  await expect(management('bindings', { appId: 'app-a', reference: 'missing', sourceId: source.id })).rejects.toMatchObject({ code: 'unknown_reference' });
  await expect(management('bindings', { appId: 'app-a', reference: 'summary', sourceId: source.id }, caller())).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(management('bindings', { appId: 'app-a', reference: 'summary', sourceId: source.id, allow: 'all' })).rejects.toMatchObject({ code: 'invalid_request' });
  await service.bind('app-a', 'summary', source.id);
  expect(service.sources.get(source.id)!.allow).toEqual({ mode: 'apps', appIds: ['app-a'] });
  const other = await service.sources.save({ name: 'Claude', provider: 'anthropic', kind: 'subscription' });
  await expect(service.bind('app-a', 'summary', other.id)).rejects.toMatchObject({ code: 'provider_mismatch' });
});

test('label/key/provider changes and missing/denied sources show their actual state without substitution', async () => {
  const source = await service.sources.save({ name: 'Codex', provider: 'openai', kind: 'subscription' });
  await service.bind('app-a', 'summary', source.id);
  manifests.get('app-a')!.ai!.accessSources.summary.name = 'Renamed';
  status = 'login-required';
  const inventory = await management('sources');
  expect(inventory.requirements[0]).toMatchObject({ name: 'Renamed', sourceId: source.id, state: 'configured' });
  expect(inventory.accessSources[0].status).toBe('login-required');
  await service.sources.save({ name: source.name, provider: source.provider, kind: source.kind, allow: { mode: 'apps', appIds: [] } }, source.id);
  expect((await service.requirements())[0]).toMatchObject({ sourceId: source.id, state: 'attention', issue: 'source-denied' });
  await service.sources.save({ name: source.name, provider: source.provider, kind: source.kind, allow: { mode: 'all' } }, source.id);
  declaration('app-a', 'anthropic');
  expect((await service.requirements())[0].issue).toBe('provider-mismatch');
  await service.sources.remove(source.id);
  expect((await service.requirements())[0].issue).toBe('source-missing');
  manifests.get('app-a')!.ai!.accessSources = { chat: { name: 'New key', provider: 'openai' } };
  expect((await service.requirements())[0]).toMatchObject({ reference: 'chat', state: 'setup-required' });
  expect((await service.requirements()).some(item => item.appId === 'app-a' && item.reference === 'summary')).toBe(false);
  expect(service.sources.binding('app-a', 'summary')).toBe(source.id);
  delete manifests.get('app-a')!.ai;
  expect((await service.requirements()).every(item => item.appId !== 'app-a')).toBe(true);
});

test('capability lookup shares provider, readiness, allow, generation, exact model and operation checks', async () => {
  const source = await service.sources.save({ name: 'API', provider: 'openai', kind: 'api-key', apiKey: 'fixture' });
  await service.bind('app-a', 'summary', source.id);
  const selection = { model: 'openai:text-embedding-3-small', accessSource: 'summary' };
  expect(await service.capabilities(caller(), selection, 'embed')).toMatchObject({ maxEmbeddingsPerCall: 2 });
  await expect(service.capabilities(caller(), { ...selection, model: 'anthropic:fixture' }, 'embed')).rejects.toMatchObject({ code: 'provider_mismatch' });
  await expect(service.capabilities(caller(), { ...selection, model: 'openai:missing' }, 'embed')).rejects.toMatchObject({ code: 'unsupported' });
  await expect(service.capabilities(caller(), selection, 'generate')).rejects.toMatchObject({ code: 'unsupported' });
  status = 'login-required'; service.refreshSource(source.id);
  await expect(service.capabilities(caller(), selection, 'embed')).rejects.toMatchObject({ code: 'source_unavailable' });
  status = 'ready'; service.refreshSource(source.id);
  const original = adapter.describe;
  let finish!: () => void;
  vi.mocked(adapter.describe).mockImplementationOnce(async source => { await new Promise<void>(resolve => { finish = resolve; }); return original(source); });
  const pending = service.capabilities(caller(), selection, 'embed');
  const changed = expect(pending).rejects.toMatchObject({ code: 'source_changed' });
  await service.sources.save({ provider: source.provider, kind: source.kind, name: 'Changed' }, source.id);
  finish(); await changed;
  await service.sources.save({ provider: source.provider, kind: source.kind, name: 'Denied', allow: { mode: 'apps', appIds: [] } }, source.id);
  await expect(service.capabilities(caller(), selection, 'embed')).rejects.toMatchObject({ code: 'source_denied' });
  expect(adapter.open).not.toHaveBeenCalled();
});

test('unbound setup errors are non-retryable and precede discovery and execution', async () => {
  const admission = { context: caller(), signal: new AbortController().signal, release() {} };
  expect(() => service.start(admission, { model: 'openai:gpt-5.6-luna', accessSource: 'summary', operation: 'generate', options: encodeAi({ prompt: [] }), callbacks: false }))
    .toThrow(expect.objectContaining({ code: 'source_configuration_required', retryable: false }));
  await expect(service.capabilities(caller(), { model: 'openai:text-embedding-3-small', accessSource: 'summary' }, 'embed')).rejects.toMatchObject({ code: 'source_configuration_required', retryable: false });
  expect(adapter.describe).not.toHaveBeenCalled(); expect(adapter.open).not.toHaveBeenCalled();
});
