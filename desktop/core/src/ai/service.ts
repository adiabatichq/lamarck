import { createProviderRegistry } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4CallOptions, EmbeddingModelV4CallOptions, ProviderV4 } from '@ai-sdk/provider';
import { decodeAi, type AiAccessSource, type AiModel, type AiOptions, type AiStart, type ManagedAiSource } from '@lamarck/system/protocol';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthAdmission, AppAuthContext } from '../auth';
import { CredentialStore } from '../credentials/credential-store';
import type { SecretStore } from '../credentials/secret-store';
import { AiSourceStore, allowed } from './source-store';
import { AI_CATALOG, apiSupport } from './catalog';
import { AiInvocations, type InvocationContext } from './invocations';
import { AiSubscriptions } from './subscriptions';
import { AiError, aiFailure } from './errors';

export interface AiAdapter {
  describe(source: ManagedAiSource): Promise<{ view: AiAccessSource; models: AiModel[] }>;
  open(source: ManagedAiSource, options: LanguageModelV4CallOptions, context: InvocationContext): Promise<{ provider: ProviderV4; dispose(): Promise<void> }>;
}
export class AiService {
  readonly sources: AiSourceStore;
  readonly invocations = new AiInvocations();
  readonly subscriptions: AiSubscriptions;
  private descriptions = new Map<string, { generation: number; time: number; promise: Promise<AiAccessSource> }>();
  private catalog = new Map(AI_CATALOG.map(model => [model.id, model]));
  constructor(private db: DatabaseSync, credentials: CredentialStore, secrets: SecretStore, runtimeRoot: string, private adapter?: AiAdapter) {
    for (const row of db.prepare('SELECT metadata_json FROM ai_models').all() as { metadata_json: string }[]) {
      const model = JSON.parse(row.metadata_json) as AiModel; this.catalog.set(model.id, model);
    }
    this.sources = new AiSourceStore(db, credentials, secrets, id => {
      this.descriptions.delete(id); this.invocations.cancelSource(id); this.subscriptions.invalidate(id);
    });
    this.subscriptions = new AiSubscriptions(this.sources, runtimeRoot);
  }
  async options(caller?: AppAuthContext): Promise<AiOptions> {
    const sources = this.sources.list().filter(source => !caller || allowed(source, caller.appId));
    const accessSources = await Promise.all(sources.map(source => this.describe(source)));
    return {
      models: [...this.catalog.values()],
      // Re-check after asynchronous discovery; revocation cannot leak a source.
      accessSources: accessSources.filter((source, index) => {
        const current = this.sources.get(source.id);
        return current && current.generation === sources[index].generation && (!caller || allowed(current, caller.appId));
      }),
    };
  }
  start(admission: AuthAdmission, input: AiStart): { invocationId: string } {
    if (admission.context.kind !== 'app') throw new AiError('unauthorized', 'App identity required');
    if (!input || !['generate', 'stream', 'embed'].includes(input.operation) || typeof input.model !== 'string' || typeof input.accessSource !== 'string' || typeof input.callbacks !== 'boolean') throw new AiError('invalid_request', 'Invalid AI invocation');
    const source = this.sources.get(input.accessSource);
    if (!source || !allowed(source, admission.context.appId)) throw new AiError('source_denied', 'AI source is unavailable to this App');
    const separator = input.model.indexOf(':');
    if (separator < 1 || input.model.slice(0, separator) !== source.provider || !input.model.slice(separator + 1)) throw new AiError('provider_mismatch', 'Model and source providers must match');
    const options = decodeAi(input.options) as LanguageModelV4CallOptions;
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new AiError('invalid_request', 'Invalid AI call options');
    if (options.headers && Object.keys(options.headers).some(name => name.toLowerCase() !== 'user-agent')) throw new AiError('unsupported', 'Custom provider HTTP headers are unsupported');
    if (options.includeRawChunks) throw new AiError('unsupported', 'Raw provider chunks are unsupported');
    if (source.kind === 'subscription' && options.providerOptions && Object.keys(options.providerOptions).length) throw new AiError('unsupported', 'Subscription runtime overrides are unsupported');
    if (input.operation === 'embed') {
      if (!Array.isArray((options as unknown as EmbeddingModelV4CallOptions).values)) throw new AiError('invalid_request', 'Embedding values are required');
    } else if (!Array.isArray(options.prompt)) throw new AiError('invalid_request', 'Language prompt is required');
    return this.invocations.start(admission, input, async context => {
      let handle: Awaited<ReturnType<AiAdapter['open']>> | undefined;
      try {
        const view = await this.describe(source);
        context.signal.throwIfAborted();
        if (this.sources.get(source.id)?.generation !== source.generation) throw new AiError('source_changed', 'AI source configuration changed');
        const support = view.support.find(candidate => candidate.model === input.model);
        const model = this.catalog.get(input.model);
        if (view.status !== 'ready' || view.discovery !== 'known') throw new AiError('source_unavailable', 'AI source is not ready; check its connection or login in System');
        if (!support || !model || model.type !== (input.operation === 'embed' ? 'embedding' : 'language')) throw new AiError('unsupported', 'This source does not support the selected model or operation');
        if ((input.operation === 'stream' && !support.streaming) || (options.responseFormat?.type === 'json' && !support.structuredOutput) || (options.tools?.length && !support.tools)) throw new AiError('unsupported', 'The selected source does not support this capability');
        if (source.kind === 'subscription' && options.tools?.length && !input.callbacks) throw new AiError('tools_require_scope', 'Use system.ai.withTools for subscription tools');
        handle = this.adapter ? await this.adapter.open(source, options, context) : await this.open(source, options, context);
        context.signal.throwIfAborted();
        const registry = createProviderRegistry({ [source.provider]: handle.provider });
        let result: any;
        if (input.operation === 'embed') {
          const model = registry.embeddingModel(input.model as `${string}:${string}`);
          result = await model.doEmbed({ ...options as unknown as EmbeddingModelV4CallOptions, abortSignal: context.signal });
        } else {
          const model = registry.languageModel(input.model as `${string}:${string}`);
          const callOptions = { ...options, abortSignal: context.signal };
          if (input.operation === 'generate') { result = await model.doGenerate(callOptions); }
          else {
            const response = await model.doStream(callOptions);
            const reader = response.stream.getReader();
            const cancel = () => { void reader.cancel().catch(() => {}); };
            let completed = false;
            context.signal.addEventListener('abort', cancel, { once: true });
            try {
              // Keep doStream startup failures outside the App's returned stream
              // so Vercel can apply maxRetries before streaming has begun.
              await context.streamReady();
              for (;;) {
                context.signal.throwIfAborted();
                const { done, value } = await reader.read();
                if (done) { completed = true; break; }
                if (value.type === 'raw') throw new AiError('unsupported', 'Raw provider output is unsupported');
                await context.part(value.type === 'error' ? { type: 'error', error: aiFailure(value.error) } : value.type === 'finish' ? { ...value, providerMetadata: { ...value.providerMetadata, lamarck: { invocationId: context.id } } } : value);
              }
            } finally { context.signal.removeEventListener('abort', cancel); if (!completed) cancel(); reader.releaseLock(); }
            result = null;
          }
        }
        context.signal.throwIfAborted();
        // Provider request/debug bodies are deliberately not exposed or retained.
        if (result && typeof result === 'object') {
          result.providerMetadata = { ...result.providerMetadata, lamarck: { invocationId: context.id } };
          delete result.request;
          if (result.response) result.response = { id: result.response.id, modelId: result.response.modelId, timestamp: result.response.timestamp };
        }
        return result;
      } catch (error) {
        const failure = aiFailure(error, context.signal);
        if ((failure.statusCode === 401 || failure.statusCode === 403 || failure.code === 'login_required') && this.sources.get(source.id)?.generation === source.generation) {
          const cached = this.descriptions.get(source.id);
          if (cached) this.descriptions.set(source.id, { ...cached, time: Date.now(), promise: cached.promise.then(view => ({ ...view, status: source.kind === 'subscription' ? 'login-required' : 'unavailable' })) });
        }
        throw error;
      } finally {
        await handle?.dispose();
      }
    });
  }
  refreshSource(id: string): void { this.descriptions.delete(id); }
  async close(): Promise<void> { this.subscriptions.close(); await this.invocations.close(); await this.subscriptions.settled(); }
  private async describe(source: ManagedAiSource): Promise<AiAccessSource> {
    const current = this.descriptions.get(source.id);
    if (current?.generation === source.generation && (Date.now() - current.time < 15_000 || this.invocations.hasSource(source.id))) return current.promise;
    const promise = (async (): Promise<AiAccessSource> => {
      const base = { id: source.id, name: source.name, provider: source.provider, kind: source.kind };
      try {
        let result: { view: AiAccessSource; models: AiModel[] };
        if (this.adapter) result = await this.adapter.describe(source);
        else if (source.kind === 'subscription') {
          const value = await this.subscriptions.describe(source);
          result = { view: { ...base, status: value.status, support: value.support, discovery: value.status === 'ready' ? 'known' : 'unknown' }, models: value.models };
        } else if (source.kind === 'local') {
          const response = await fetch(`${source.config.endpoint!.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
          if (!response.ok) throw new Error('Local discovery failed');
          const text = await boundedText(response, 1024 * 1024);
          const data = JSON.parse(text).data;
          if (!Array.isArray(data) || data.length > 1000) throw new Error('Invalid local model catalog');
          const models: AiModel[] = data.map((item: any) => {
            if (typeof item.id !== 'string' || !item.id || item.id.length > 256) throw new Error('Invalid local model id');
            return { id: `local:${item.id}`, name: item.id, provider: 'local', type: 'language' };
          });
          result = { models, view: { ...base, status: 'ready', discovery: 'known', support: models.map(model => ({ model: model.id, streaming: true, structuredOutput: false, tools: false })) } };
        } else {
          await this.sources.apiKey(source.id);
          result = { models: [], view: { ...base, status: 'ready', discovery: 'known', support: apiSupport(source) } };
        }
        if (this.sources.get(source.id)?.generation !== source.generation) throw new Error('Stale discovery');
        for (const model of result.models) {
          this.catalog.set(model.id, model);
          this.db.prepare('INSERT INTO ai_models (id, metadata_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json').run(model.id, JSON.stringify(model));
        }
        return result.view;
      } catch {
        return { ...base, status: 'unavailable', discovery: 'failed', support: [] };
      }
    })();
    this.descriptions.set(source.id, { generation: source.generation, time: Date.now(), promise });
    return promise;
  }
  private async open(source: ManagedAiSource, options: LanguageModelV4CallOptions, context: InvocationContext) {
    if (source.kind === 'subscription') return this.subscriptions.open(source, options, context);
    const provider = source.kind === 'local'
      ? createOpenAICompatible({ name: 'local', baseURL: source.config.endpoint! })
      : source.provider === 'openai'
        ? createOpenAI({ apiKey: await this.sources.apiKey(source.id) })
        : createAnthropic({ apiKey: await this.sources.apiKey(source.id) });
    return { provider, dispose: async () => {} };
  }
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty discovery response');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error('Local model catalog is too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel(); reader.releaseLock(); }
}
