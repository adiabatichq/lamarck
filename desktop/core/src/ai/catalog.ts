import type { AiModel, AiSupport, ManagedAiSource } from '@lamarck/system/protocol';
export const AI_CATALOG: AiModel[] = [
  ...[['gpt-6-astra', 'GPT-6 Astra'], ['gpt-5.6-sol', 'GPT-5.6 Sol'], ['gpt-5.6-terra', 'GPT-5.6 Terra'], ['gpt-5.6-luna', 'GPT-5.6 Luna']].map(([id, name]) => ({ id: `openai:${id}`, name, provider: 'openai', type: 'language' as const })),
  ...[['text-embedding-3-small', 'Text Embedding 3 Small'], ['text-embedding-3-large', 'Text Embedding 3 Large']].map(([id, name]) => ({ id: `openai:${id}`, name, provider: 'openai', type: 'embedding' as const })),
  ...[['claude-fable-5-1', 'Claude Fable 5.1'], ['claude-opus-5', 'Claude Opus 5'], ['claude-sonnet-5', 'Claude Sonnet 5'], ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5']].map(([id, name]) => ({ id: `anthropic:${id}`, name, provider: 'anthropic', type: 'language' as const })),
];
export function apiSupport(source: ManagedAiSource): AiSupport[] {
  return AI_CATALOG.filter(model => model.provider === source.provider).map(model => model.type === 'embedding'
    ? { model: model.id, streaming: false, structuredOutput: false, tools: false, maxEmbeddingsPerCall: 2048, supportsParallelCalls: true }
    : { model: model.id, streaming: true, structuredOutput: true, tools: true });
}
