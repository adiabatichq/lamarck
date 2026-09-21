import { registerTelemetry, type Telemetry } from 'ai';
import type { JsonValue, SystemInvoke } from '../protocol.js';
import type { AiCaptureRequest } from './types.js';
import { captureData, captureMessage } from './capture-data.js';

interface Owner { provider: string; invoke: SystemInvoke }
interface Turn { owner: Owner; callId: string; stepNumber: number; inputs: boolean; outputs: boolean; closed: boolean; broken: boolean; pending: Promise<unknown> }
interface Registry { owners: Map<string, WeakRef<Owner>>; prompts: WeakMap<object, Turn>; turns: Map<string, Turn>; outcomes: WeakMap<object, (turn?: Turn) => Promise<void>> }
const key = Symbol.for('@lamarck/system/ai-capture-v1');
const globals = globalThis as typeof globalThis & { [key]?: Registry; reportError?: (error: unknown) => void };

/** Existing browser error dispatch / Node workload stderr, outside notify's catch. */
export function reportCaptureError(error: unknown): void {
  const failure = new Error(`AI content capture failed: ${error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'unknown capture failure'}`);
  if (typeof globals.reportError === 'function') globals.reportError(failure);
  else console.error(failure);
}
function registry(): Registry {
  if (globals[key]) return globals[key];
  const state: Registry = { owners: new Map(), prompts: new WeakMap(), turns: new Map(), outcomes: new WeakMap() };
  globals[key] = state;
  const observe = (fn: (event: any) => Promise<void>): ((event: any) => Promise<void>) => async event => {
    try { await fn(event); }
    catch (error) {
      const turn = state.turns.get(event?.callId);
      if (turn) {
        turn.broken = true;
        await turn.owner.invoke('ai.capture', { action: 'discard', callId: turn.callId, message: 'App capture observation failed' }).catch(reportCaptureError);
      }
      state.turns.delete(event?.callId);
      reportCaptureError(error);
    }
  };
  const collector: Telemetry = {
    async executeLanguageModelCall({ callId, execute }) {
      // Correlate by the exact provider result/error object. Stream retries do
      // not repeat onStepStart in ai@7.0.105. Host pauses before consuming
      // output until this link (or an explicit telemetry-disabled release).
      const link = async (outcome: unknown) => {
        if (!outcome || typeof outcome !== 'object') return;
        const bind = state.outcomes.get(outcome);
        if (!bind) return;
        state.outcomes.delete(outcome);
        try { await bind(state.turns.get(callId)); }
        catch (error) {
          const turn = state.turns.get(callId);
          if (turn) { turn.broken = true; await turn.owner.invoke('ai.capture', { action: 'discard', callId, message: 'Model correlation failed' }).catch(reportCaptureError); state.turns.delete(callId); }
          reportCaptureError(error);
        }
      };
      let result;
      try { result = await execute(); }
      catch (error) { await link(error); throw error; }
      await link(result); return result;
    },
    onStart: observe(async event => {
      const owner = state.owners.get(event.provider)?.deref();
      if (!owner || !['ai.generateText', 'ai.streamText'].includes(event.operationId)) return;
      if (state.turns.has(event.callId)) throw new Error('Duplicate generation start');
      const turn: Turn = { owner, callId: event.callId, stepNumber: -1, inputs: event.recordInputs !== false, outputs: event.recordOutputs !== false, closed: false, broken: false, pending: Promise.resolve() };
      state.turns.set(event.callId, turn);
      await send(turn, { action: 'start', callId: turn.callId, operation: event.operationId.slice(3), time: Date.now(), recordInputs: turn.inputs, recordOutputs: turn.outputs });
      if (!turn.inputs) return;
      if (event.instructions !== undefined) {
        const instructions = typeof event.instructions === 'string' ? [{ role: 'system', content: event.instructions }] : Array.isArray(event.instructions) ? event.instructions : [event.instructions];
        if (!Array.isArray(instructions)) throw new Error('Invalid generation instructions');
        for (const message of instructions) await record(turn, { kind: 'input', message: captureMessage(message) });
      }
      if (!Array.isArray(event.messages)) throw new Error('Missing generation messages');
      for (const message of event.messages) await record(turn, { kind: 'input', message: captureMessage(message) });
    }),
    onStepStart: observe(async event => {
      const turn = state.turns.get(event.callId);
      if (!turn || turn.closed || turn.broken) return;
      if (!Number.isSafeInteger(event.stepNumber) || event.stepNumber < 0 || !Array.isArray(event.promptMessages)) throw new Error('Pinned SDK did not expose the prepared step prompt');
      // ai@7.0.105 supplies this exact provider-prompt object in its step event.
      // Object identity, never prompt text or a mutable current-turn variable.
      turn.stepNumber = event.stepNumber;
      state.prompts.set(event.promptMessages, turn);
      await record(turn, { kind: 'step', stepNumber: event.stepNumber });
    }),
    onToolExecutionStart: observe(async event => {
      const turn = state.turns.get(event.callId); if (!turn || turn.closed || turn.broken) return;
      await record(turn, { kind: 'tool-start', stepNumber: turn.stepNumber, toolCallId: event.toolCall.toolCallId, toolName: event.toolCall.toolName, ...(turn.inputs ? { input: captureData(event.toolCall.input) } : {}) });
    }),
    onToolExecutionEnd: observe(async event => {
      const turn = state.turns.get(event.callId); if (!turn || turn.closed || turn.broken) return;
      const output = event.toolOutput;
      if (!output || !['tool-result', 'tool-error'].includes(output.type)) throw new Error('Missing tool execution output');
      await record(turn, { kind: 'tool-end', stepNumber: turn.stepNumber, toolCallId: event.toolCall.toolCallId, toolName: event.toolCall.toolName, failed: output.type === 'tool-error', ...(turn.outputs ? { output: captureData(output.type === 'tool-error' ? errorData(output.error) : output.output) } : {}) });
    }),
    onEnd: observe(async event => {
      const turn = state.turns.get(event.callId); if (!turn || turn.closed || turn.broken) return;
      await end(turn, event.finishReason === 'error' ? 'failed' : 'completed', event.usage === undefined ? undefined : selectedUsage(event.usage));
    }),
    onAbort: observe(async event => {
      const turn = state.turns.get(event.callId); if (turn && !turn.closed && !turn.broken) await end(turn, 'interrupted');
    }),
    onError: observe(async event => {
      const turn = state.turns.get(event.callId); if (!turn || turn.closed || turn.broken) return;
      if (event.error?.code === 'capture_failed' || event.error?.code === 'capture_unavailable') throw event.error;
      await end(turn, event.error?.name === 'AbortError' ? 'interrupted' : 'failed');
    }),
  };
  registerTelemetry(collector);
  return state;
}
function errorData(error: unknown): unknown {
  return error instanceof Error ? { name: error.name, message: error.message } : error;
}
function send(turn: Turn, request: AiCaptureRequest): Promise<unknown> {
  const next = turn.pending.then(() => turn.owner.invoke('ai.capture', request));
  turn.pending = next;
  return next;
}
function record(turn: Turn, value: unknown): Promise<unknown> {
  const selected = captureData(value);
  if (JSON.stringify(selected).length > 2 * 1024 * 1024) throw new Error('AI capture record exceeds the frame limit');
  return send(turn, { action: 'record', callId: turn.callId, record: selected });
}
async function end(turn: Turn, status: 'completed' | 'failed' | 'interrupted', usage?: unknown) {
  turn.closed = true;
  {
    await send(turn, { action: 'end', callId: turn.callId, status, time: Date.now(), ...(usage !== undefined ? { usage: captureData(usage) } : {}) });
  }
  registry().turns.delete(turn.callId);
}
export function createCaptureOwner(invoke: SystemInvoke) {
  const state = registry();
  // Per-runtime transport identity. It is not durable attribution; Host binds
  // source and producer and records actual model/source from each invocation.
  const owner: Owner = { provider: `lamarck.${crypto.randomUUID()}`, invoke };
  state.owners.set(owner.provider, new WeakRef(owner));
  for (const [provider, reference] of state.owners) if (!reference.deref()) state.owners.delete(provider);
  return {
    provider: owner.provider,
    deferred() {
      const token = crypto.randomUUID();
      let linked: Promise<void> | undefined;
      let linkedTurn: Turn | undefined;
      const bind = (turn?: Turn): Promise<void> => linked ??= (async () => {
        if (turn && (turn.owner !== owner || turn.closed || turn.broken)) throw new Error('Invalid deferred AI correlation');
        linkedTurn = turn;
        await owner.invoke('ai.capture', { action: 'link', token, callId: turn?.callId ?? token, ...(turn ? { stepNumber: turn.stepNumber } : {}) });
      })();
      return { token, outcome(value: object) { state.outcomes.set(value, bind); }, release: () => bind(), failed: (error: unknown) => failStream(linkedTurn, error) };
    },
    streamFailed: (prompt: object, error: unknown) => failStream(state.prompts.get(prompt), error),
    forPrompt(prompt: object) {
      const turn = state.prompts.get(prompt);
      if (!turn || turn.closed || turn.broken) return undefined;
      if (turn.owner !== owner) throw Object.assign(new Error('AI capture channel correlation mismatch'), { code: 'capture_failed' });
      return { callId: turn.callId, stepNumber: turn.stepNumber };
    },
  };
}

function selectedUsage(value: unknown): JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed AI usage');
  const { raw: _excluded, ...selected } = value as Record<string, unknown>;
  return captureData(selected);
}

async function failStream(turn: Turn | undefined, error: unknown) {
  if (!turn || turn.closed || turn.broken) return;
  // The proxy calls this only for a still-live stream: a pending pull rejected
  // by consumer cancellation belongs to that attempt, not the generation.
  // Error parts and startup errors still follow the official SDK's retries.
  try {
    if (error && typeof error === 'object' && 'code' in error && ['capture_failed', 'capture_unavailable'].includes(error.code as string)) throw error;
    await end(turn, error && typeof error === 'object' && 'name' in error && error.name === 'AbortError' ? 'interrupted' : 'failed'); }
  catch (failure) {
    turn.broken = true;
    await turn.owner.invoke('ai.capture', { action: 'discard', callId: turn.callId, message: 'Stream capture failed' }).catch(reportCaptureError);
    registry().turns.delete(turn.callId); reportCaptureError(failure);
  }
}
