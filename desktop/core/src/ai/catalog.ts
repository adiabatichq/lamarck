import type { AiModel, AiSupport, ManagedAiSource } from '@lamarck/system/protocol';
export const AI_CATALOG: AiModel[] = [
  ...['gpt-5-mini', 'gpt-5.4', 'gpt-5.3-codex'].map(id => ({ id: `openai:${id}`, name: id, provider: 'openai', type: 'language' as const })),
  ...['text-embedding-3-small', 'text-embedding-3-large'].map(id => ({ id: `openai:${id}`, name: id, provider: 'openai', type: 'embedding' as const })),
  ...['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'].map(id => ({ id: `anthropic:${id}`, name: id, provider: 'anthropic', type: 'language' as const })),
];
export function apiSupport(source: ManagedAiSource): AiSupport[] {
  return AI_CATALOG.filter(model => model.provider === source.provider && !model.id.endsWith('-codex')).map(model => model.type === 'embedding'
    ? { model: model.id, streaming: false, structuredOutput: false, tools: false, maxEmbeddingsPerCall: 2048, supportsParallelCalls: true }
    : { model: model.id, streaming: true, structuredOutput: true, tools: true });
}
