import { APICallError } from '@ai-sdk/provider';
import type { AiFailure } from '@lamarck/system/protocol';
export class AiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function aiFailure(error: unknown, signal?: AbortSignal): AiFailure {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return { code: 'cancelled', message: 'AI invocation cancelled', retryable: false };
  if (error instanceof AiError) return { code: error.code, message: error.message, retryable: false };
  if (APICallError.isInstance(error)) return { code: 'provider_error', message: `AI provider request failed${error.statusCode ? ` (HTTP ${error.statusCode})` : ''}`, ...(error.statusCode ? { statusCode: error.statusCode } : {}), retryable: error.isRetryable };
  // Provider errors often contain request bodies, paths, URLs, or credentials.
  return { code: 'provider_error', message: 'AI source failed; check its connection or login in System', retryable: false };
}
