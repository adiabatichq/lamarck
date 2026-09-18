import type { LanguageModelV4, LanguageModelV4StreamPart, LanguageModelV4Usage, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import type { InvocationContext } from './invocations';
import { CodexRpc } from './runtime';
import { AiError } from './errors';

export const CODEX_CONTAINMENT = Object.freeze({
  'features.shell_tool': false, 'features.unified_exec': false,
  // Model metadata selects direct or code-mode dispatch. The bundled V8 host
  // has no imports or ambient IO; its tool registry is the same scoped registry.
  'features.code_mode': false,
  'features.code_mode_host': { enabled: true, disable_in_process_fallback: true },
  'features.sleep_tool': false,
  'features.multi_agent': false, 'features.apps': false, 'features.hooks': false,
  // New model metadata can select the V2 runtime despite the legacy flag.
  'features.multi_agent_v2': false, 'agents.enabled': false,
  'features.browser_use': false, 'features.computer_use': false,
  'features.image_generation': false, 'features.view_image': false,
  'features.workspace_dependencies': false, 'features.skills': false,
  'orchestrator.skills.enabled': false, 'orchestrator.mcp.enabled': false,
  'features.skip_host_skill_discovery': true, 'features.skill_search': false,
  'skills.bundled.enabled': false, 'skills.include_instructions': false,
  'tools.experimental_request_user_input.enabled': false, 'tools.update_plan.enabled': false,
  'features.memories': false, 'features.in_app_browser': false,
  'web_search': 'disabled', 'history.persistence': 'none',
  'shell_environment_policy.inherit': 'none', 'mcp_servers': {},
});
const unknownUsage = (): LanguageModelV4Usage => ({ inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } });
interface CodexModelInfo { model: string; displayName?: string; supportedReasoningEfforts: { reasoningEffort: string }[] }
export async function codexModels(rpc: CodexRpc): Promise<CodexModelInfo[]> {
  const models: CodexModelInfo[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const result = await rpc.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data) || models.length + result.data.length > 1000 || result.data.some((model: any) => typeof model.model !== 'string' || !model.model || !Array.isArray(model.supportedReasoningEfforts))) throw new AiError('discovery_failed', 'Invalid Codex model discovery');
    models.push(...result.data);
    cursor = result.nextCursor ?? undefined;
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new AiError('discovery_failed', 'Invalid Codex model discovery cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return models;
}
export function codexModel(modelId: string, rpc: CodexRpc, context: InvocationContext): LanguageModelV4 {
  const doStream: LanguageModelV4['doStream'] = async options => {
    if (options.providerOptions && Object.keys(options.providerOptions).length) throw new AiError('unsupported', 'Codex provider overrides are unsupported');
    if (options.tools?.some(tool => tool.type !== 'function')) throw new AiError('unsupported', 'Codex only supports App function tools');
    // A fresh ephemeral thread receives the complete call's history. Native
    // environment access is disabled in both thread and turn, independently
    // of approval policy. Only invocation-bound dynamic callbacks are exposed.
    const warnings: LanguageModelV4GenerateResult['warnings'] = ['maxOutputTokens', 'temperature', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'seed', 'stopSequences']
      .filter(key => options[key as keyof typeof options] !== undefined)
      .map(feature => ({ type: 'unsupported' as const, feature }));
    if (options.toolChoice && options.toolChoice.type !== 'auto' && options.toolChoice.type !== 'none') throw new AiError('unsupported', 'Codex does not support forced tool selection');
    const discovered = (await codexModels(rpc)).find(model => model.model === modelId);
    if (!discovered) throw new AiError('unsupported', 'The selected model is unavailable through this Codex subscription');
    let effort = options.reasoning === 'provider-default' ? undefined : options.reasoning;
    if (effort && !discovered.supportedReasoningEfforts.some(option => option.reasoningEffort === effort)) {
      // Portable minimal maps to native low only when low is advertised.
      if (effort === 'minimal' && discovered.supportedReasoningEfforts.some(option => option.reasoningEffort === 'low')) {
        effort = 'low';
        warnings.push({ type: 'compatibility', feature: 'reasoning', details: 'Codex maps minimal reasoning to the supported low effort.' });
      } else {
        warnings.push({ type: 'unsupported', feature: 'reasoning', details: `Codex does not advertise ${effort} reasoning for ${modelId}; using its default.` });
        effort = undefined;
      }
    }
    const system = options.prompt.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const history = options.prompt.filter(message => message.role !== 'system');
    const last = history.at(-1);
    if (last?.role !== 'user' || last.content.some(part => part.type !== 'text')) throw new AiError('unsupported', 'Codex requires a final text user message');
    const prompt = last.content.map(part => { if (part.type !== 'text') throw new AiError('unsupported', 'Codex file inputs are unsupported'); return part.text; }).join('\n');
    const items = history.slice(0, -1).flatMap(message => {
      const result: unknown[] = [];
      for (const part of message.content) {
        if (part.type === 'text') result.push({ type: 'message', role: message.role, content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }] });
        else if (part.type === 'tool-call') result.push({ type: 'function_call', name: part.toolName, call_id: part.toolCallId, arguments: JSON.stringify(part.input) });
        else if (part.type === 'tool-result') result.push({ type: 'function_call_output', call_id: part.toolCallId, output: JSON.stringify(part.output) });
        else throw new AiError('unsupported', 'This Codex history content is unsupported');
      }
      return result;
    });
    const tools = options.toolChoice?.type === 'none' ? [] : options.tools?.filter(tool => tool.type === 'function') ?? [];
    const declared = new Set(tools.map(tool => tool.name));
    const { thread, model: selectedModel } = await rpc.request('thread/start', {
      model: modelId, allowProviderModelFallback: false, ephemeral: true, environments: [],
      approvalPolicy: 'never', sandbox: 'read-only', config: CODEX_CONTAINMENT,
      ...(system ? { baseInstructions: system } : {}),
      dynamicTools: tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema })),
    });
    if (selectedModel !== modelId) throw new AiError('unsupported', 'Codex did not retain the explicitly selected model');
    if (items.length) await rpc.request('thread/inject_items', { threadId: thread.id, items });
    let usage = unknownUsage();
    const started = new Set<string>();
    const reasoning = new Set<string>();
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});
    let output!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({ start(controller) { output = controller; }, cancel() { void rpc.close(); } }, { highWaterMark: 8 * 1024 * 1024, size: part => Buffer.byteLength(JSON.stringify(part)) });
    const emit = (part: LanguageModelV4StreamPart) => {
      try {
        context.signal.throwIfAborted();
        if ((output.desiredSize ?? 0) < Buffer.byteLength(JSON.stringify(part))) throw new AiError('slow_consumer', 'Codex stream consumer is too slow');
        output.enqueue(part);
      } catch (error) { rejectDone(error); void rpc.close(); }
    };
    const abort = () => { rejectDone(new DOMException('Cancelled', 'AbortError')); void rpc.close(); };
    context.signal.addEventListener('abort', abort, { once: true });
    rpc.onClose = () => rejectDone(new AiError('runtime_closed', 'Codex runtime closed'));
    rpc.onRequest = async (method, params) => {
      if (method !== 'item/tool/call' || params.threadId !== thread.id || params.namespace != null || !declared.has(params.tool)) return { decision: 'decline' };
      const result = await context.tool(params.tool, params.arguments, params.callId);
      emit({ type: 'tool-call', toolCallId: params.callId, toolName: params.tool, input: JSON.stringify(params.arguments), providerExecuted: true });
      emit({ type: 'tool-result', toolCallId: params.callId, toolName: params.tool, result: result as any });
      return { contentItems: [{ type: 'inputText', text: typeof result === 'string' ? result : JSON.stringify(result) }], success: true };
    };
    rpc.onEvent = (method, params) => {
      if (params.threadId !== thread.id) return;
      if (method === 'item/agentMessage/delta') {
        const id = params.itemId;
        if (!started.has(id)) { started.add(id); emit({ type: 'text-start', id }); }
        emit({ type: 'text-delta', id, delta: params.delta });
      }
      if (method === 'item/reasoning/summaryTextDelta') {
        const id = `${params.itemId}:${params.summaryIndex ?? 0}`;
        if (!reasoning.has(id)) { reasoning.add(id); emit({ type: 'reasoning-start', id }); }
        emit({ type: 'reasoning-delta', id, delta: params.delta });
      }
      if (method === 'thread/tokenUsage/updated') {
        const reported = params.tokenUsage?.last;
        if (reported) usage = { inputTokens: { total: reported.inputTokens, noCache: undefined, cacheRead: reported.cachedInputTokens, cacheWrite: undefined }, outputTokens: { total: reported.outputTokens, text: undefined, reasoning: reported.reasoningOutputTokens } };
      }
      if (method === 'turn/completed') {
        if (params.turn.status !== 'completed') rejectDone(new AiError('subscription_failed', 'Codex generation failed or was interrupted'));
        else resolveDone();
      }
      if (method === 'error') rejectDone(new AiError('subscription_failed', 'Codex generation failed'));
    };
    emit({ type: 'stream-start', warnings });
    await rpc.request('turn/start', {
      threadId: thread.id, environments: [], model: modelId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      ...(options.responseFormat?.type === 'json' ? { outputSchema: options.responseFormat.schema ?? { type: 'object' } } : {}),
      ...(effort ? { effort } : {}),
    });
    void done.then(async () => {
      for (const id of reasoning) emit({ type: 'reasoning-end', id });
      for (const id of started) emit({ type: 'text-end', id });
      emit({ type: 'finish', finishReason: { unified: 'stop', raw: 'completed' }, usage });
      output.close();
    }, error => { output.error(error); }).finally(() => context.signal.removeEventListener('abort', abort));
    return { stream };
  };
  return {
    specificationVersion: 'v4', provider: 'codex-subscription', modelId, supportedUrls: {}, doStream,
    async doGenerate(options) {
      const { stream } = await doStream(options);
      const reader = stream.getReader();
      const content: LanguageModelV4GenerateResult['content'] = [];
      let usage = unknownUsage();
      let warnings: LanguageModelV4GenerateResult['warnings'] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'stream-start') warnings = value.warnings;
        else if (value.type === 'text-delta') {
          const last = content.at(-1);
          if (last?.type === 'text') last.text += value.delta;
          else content.push({ type: 'text', text: value.delta });
        } else if (value.type === 'reasoning-delta') {
          const last = content.at(-1);
          if (last?.type === 'reasoning') last.text += value.delta;
          else content.push({ type: 'reasoning', text: value.delta });
        } else if (value.type === 'tool-call' || value.type === 'tool-result') content.push(value);
        else if (value.type === 'finish') usage = value.usage;
      }
      return { content, usage, finishReason: { unified: 'stop', raw: 'completed' }, warnings };
    },
  };
}
