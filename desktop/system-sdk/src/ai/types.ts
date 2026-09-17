import type { JsonValue } from '../protocol.js';

export type AccessKind = 'api-key' | 'subscription' | 'local' | 'lamarck';
export type AccessSourceAllow = { mode: 'all' } | { mode: 'apps'; appIds: string[] };
export interface ModelSelection { model: string; accessSource: string }
export interface AiModel { id: string; name: string; provider: string; type: 'language' | 'embedding' }
export interface AiSupport {
  model: string;
  streaming: boolean;
  structuredOutput: boolean;
  tools: boolean;
  maxEmbeddingsPerCall?: number;
  supportsParallelCalls?: boolean;
}
export interface AiAccessSource {
  id: string;
  name: string;
  provider: string;
  kind: AccessKind;
  status: 'ready' | 'unavailable' | 'login-required';
  discovery: 'known' | 'unknown' | 'failed';
  support: AiSupport[];
}
export interface AiOptions { models: AiModel[]; accessSources: AiAccessSource[] }
export interface ManagedAiSource {
  id: string;
  provider: string;
  kind: AccessKind;
  name: string;
  allow: AccessSourceAllow;
  generation: number;
  config: { endpoint?: string };
}
export interface AiSourceInput {
  provider: string;
  kind: AccessKind;
  name: string;
  allow?: AccessSourceAllow;
  config?: { endpoint?: string };
  apiKey?: string;
}
export interface AiFailure {
  code: string;
  message: string;
  statusCode?: number;
  retryable: boolean;
}
export type AiEvent =
  // Sent only after provider.doStream resolves, before its first stream part.
  | { sequence: number; type: 'ready' }
  | { sequence: number; type: 'part'; value: JsonValue }
  | { sequence: number; type: 'tool'; toolCallId: string; name: string; input: JsonValue }
  | { sequence: number; type: 'complete'; value: JsonValue }
  | { sequence: number; type: 'error'; error: AiFailure };
export interface AiStart extends ModelSelection {
  operation: 'generate' | 'stream' | 'embed';
  options: JsonValue;
  callbacks: boolean;
}
