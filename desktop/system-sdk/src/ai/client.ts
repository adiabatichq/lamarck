import { APICallError, type EmbeddingModelV4, type LanguageModelV4, type LanguageModelV4CallOptions, type LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { validateTypes, type Tool } from '@ai-sdk/provider-utils';
import type { SystemInvoke } from '../protocol.js';
import { decodeAi, encodeAi } from './codec.js';
import type { AiFailure, AiStart, ModelSelection } from './types.js';

type Tools = Record<string, Tool<any, any>>;
interface Scope { tools: Tools; open: boolean; active: Set<AbortController> }
export interface SystemAi {
  listOptions(): ReturnType<SystemInvokeForOptions>;
  languageModel(selection: ModelSelection): LanguageModelV4;
  embeddingModel(selection: ModelSelection): EmbeddingModelV4;
  withTools<T extends Tools, R>(selection: ModelSelection & { tools: T }, run: (value: { model: LanguageModelV4; tools: T }) => Promise<R>): Promise<R>;
}
type SystemInvokeForOptions = () => Promise<import('./types.js').AiOptions>;

export function createAi(invoke: SystemInvoke): SystemAi {
  function languageModel(selection: ModelSelection, scope?: Scope): LanguageModelV4 {
    return {
      specificationVersion: 'v4', provider: 'lamarck', modelId: selection.model,
      // Prevent AI SDK from downloading on the App's network. The codec then
      // rejects URL input explicitly; callers supply bounded bytes instead.
      supportedUrls: { '*': [/^https?:\/\//] },
      doGenerate: options => collect(selection, 'generate', options, scope) as ReturnType<LanguageModelV4['doGenerate']>,
      doStream: async options => ({ stream: await stream(selection, options, scope) }),
    };
  }
  async function open(selection: ModelSelection, operation: AiStart['operation'], options: { abortSignal?: AbortSignal }, scope?: Scope) {
    if (scope && !scope.open) throw new Error('AI tool scope is closed');
    const controller = new AbortController();
    scope?.active.add(controller);
    const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, controller.signal]) : controller.signal;
    const { abortSignal: _, ...data } = options;
    let invocationId: string | undefined;
    let sequence = 0;
    let closed = false;
    const completedTools = new Set<string>();
    const cancel = () => {
      if (invocationId) void invoke('ai.cancel', { invocationId }).catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    const finish = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', cancel);
      scope?.active.delete(controller);
      controller.abort();
    };
    try {
      signal.throwIfAborted();
      const started = await invoke('ai.start', { ...selection, operation, options: encodeAi(data), callbacks: !!scope });
      invocationId = started.invocationId;
      if (signal.aborted) { cancel(); signal.throwIfAborted(); }
    } catch (error) { finish(); throw error; }
    const id = invocationId;
    async function reply(event: Extract<import('./types.js').AiEvent, { type: 'tool' }>) {
      let value: unknown;
      let failed = false;
      try {
        if (!scope?.open || completedTools.has(event.toolCallId)) throw new Error('Invalid AI tool callback');
        completedTools.add(event.toolCallId);
        const tool = Object.hasOwn(scope.tools, event.name) ? scope.tools[event.name] : undefined;
        if (!tool?.execute) throw new Error('Unknown AI tool callback');
        // Use Vercel's own schema adapter and validator inside the Capsule.
        const input = await validateTypes({ value: decodeAi(event.input), schema: tool.inputSchema });
        signal.throwIfAborted();
        value = await tool.execute(input, { toolCallId: event.toolCallId, messages: [], context: undefined, abortSignal: signal });
        if (value && typeof value === 'object' && Symbol.asyncIterator in value) throw new Error('Streaming tool outputs are unsupported for subscription callbacks');
        encodeAi(value);
      } catch (error) { failed = true; value = error instanceof Error ? error.message : 'App tool failed'; }
      if (!closed && !signal.aborted) await invoke('ai.toolResult', { invocationId: id, toolCallId: event.toolCallId, value: encodeAi(value), failed });
    }
    return {
      finish,
      cancel: () => { cancel(); finish(); },
      async next() {
        signal.throwIfAborted();
        const { events } = await invoke('ai.next', { invocationId: id, sequence });
        signal.throwIfAborted();
        const output = [];
        for (const event of events) {
          if (event.sequence !== sequence++) throw new Error('AI event ordering violation');
          if (event.type === 'tool') {
            // Do not block the receive loop on tools: their nested System calls
            // use the same channel, and cancellation must remain responsive.
            void reply(event).catch(() => { cancel(); finish(); });
          } else output.push(event);
        }
        return output;
      },
    };
  }
  async function collect(selection: ModelSelection, operation: AiStart['operation'], options: { abortSignal?: AbortSignal }, scope?: Scope): Promise<unknown> {
    const call = await open(selection, operation, options, scope);
    try {
      for (;;) for (const event of await call.next()) {
        if (event.type === 'error') throw fromFailure(event.error);
        if (event.type === 'complete') return decodeAi(event.value);
        throw new Error('Unexpected AI stream event');
      }
    } finally { call.cancel(); }
  }
  async function stream(selection: ModelSelection, options: LanguageModelV4CallOptions, scope?: Scope): Promise<ReadableStream<LanguageModelV4StreamPart>> {
    const call = await open(selection, 'stream', options, scope);
    let pending: Awaited<ReturnType<typeof call.next>> = [];
    try {
      for (;;) {
        const [event, ...remaining] = await call.next();
        if (!event) continue;
        if (event.type === 'error') throw fromFailure(event.error);
        if (event.type !== 'ready') throw new Error('Expected AI stream readiness');
        pending = remaining;
        break;
      }
    } catch (error) { call.cancel(); throw error; }
    let cancelled = false;
    return new ReadableStream({
      async pull(controller) {
        try {
          for (;;) {
            const events = pending.length ? pending.splice(0) : await call.next();
            if (cancelled) return;
            let emitted = false;
            for (const event of events) {
              if (event.type === 'part') {
                const part = decodeAi(event.value) as LanguageModelV4StreamPart;
                if (part.type === 'error') part.error = fromFailure(part.error as AiFailure);
                controller.enqueue(part);
                emitted = true;
              } else if (event.type === 'error') throw fromFailure(event.error);
              else if (event.type === 'complete') { controller.close(); call.finish(); return; }
              else throw new Error('Unexpected AI stream event');
            }
            // Empty long polls and App tool callbacks do not satisfy a read.
            // Keep polling until data arrives or the invocation terminates.
            if (emitted) return;
          }
        } catch (error) {
          // Cancellation (including Vercel retries) also aborts any outstanding
          // poll. Do not deliver its result/error to an already-cancelled stream.
          if (cancelled) return;
          const failure = options.abortSignal?.aborted ? options.abortSignal.reason : error;
          controller.error(failure); call.cancel();
        }
      },
      cancel() { cancelled = true; call.cancel(); },
    }, { highWaterMark: 0 });
  }
  return Object.freeze({
    listOptions: () => invoke('ai.listOptions', {}),
    languageModel,
    embeddingModel(selection: ModelSelection): EmbeddingModelV4 {
      const metadata = () => invoke('ai.listOptions', {}).then(options => {
        const support = options.accessSources.find(s => s.id === selection.accessSource)?.support.find(s => s.model === selection.model);
        if (!support || support.maxEmbeddingsPerCall === undefined) throw new Error('Embedding model/source is unavailable');
        return support;
      });
      return {
        specificationVersion: 'v4', provider: 'lamarck', modelId: selection.model,
        get maxEmbeddingsPerCall() { return metadata().then(s => s.maxEmbeddingsPerCall); },
        get supportsParallelCalls() { return metadata().then(s => s.supportsParallelCalls ?? false); },
        doEmbed: options => collect(selection, 'embed', options) as ReturnType<EmbeddingModelV4['doEmbed']>,
      };
    },
    async withTools<T extends Tools, R>(selection: ModelSelection & { tools: T }, run: (value: { model: LanguageModelV4; tools: T }) => Promise<R>): Promise<R> {
      const scope: Scope = { tools: selection.tools, open: true, active: new Set() };
      for (const tool of Object.values(scope.tools)) {
        if (!tool.execute || tool.needsApproval || tool.toModelOutput || tool.type === 'provider' || tool.outputSchema) {
          throw new Error('AI callback tools require execute and inputSchema; approval, provider, output schema and custom output conversion are unsupported');
        }
      }
      try {
        const result = await run({ model: languageModel({ model: selection.model, accessSource: selection.accessSource }, scope), tools: selection.tools });
        if (scope.active.size || (result && typeof result === 'object' && ('stream' in result || 'consumeStream' in result))) throw new Error('Consume the AI stream inside withTools before returning');
        return result;
      } finally {
        scope.open = false;
        for (const controller of scope.active) controller.abort();
        scope.active.clear();
      }
    },
  });
}
function fromFailure(error: AiFailure): Error {
  if (error.code === 'cancelled') return new DOMException(error.message, 'AbortError');
  if (error.statusCode !== undefined || error.retryable) return new APICallError({ message: error.message, url: 'lamarck:ai', requestBodyValues: {}, statusCode: error.statusCode, isRetryable: error.retryable });
  return Object.assign(new Error(error.message), { code: error.code });
}
