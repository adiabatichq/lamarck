import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { captureBlock, captureData, captureMessage, type JsonValue, type AiStart } from '@lamarck/system/protocol';
import type { AiCaptureRequest } from '@lamarck/system/protocol';
import type { AppAuthContext, AuthAdmission } from '../auth';
import type { AiTurnPublication } from '../guard-service/protocol';
import { CAPTURE_RECORD_BYTES, captureDirectory, validateRecord, validateUsage } from '../guard-service/ai-turn';
import { redactValue, redactString } from './capture-redaction.mjs';

export interface TurnWriter { publishAiTurn(input: AiTurnPublication): Promise<string> }
interface Turn {
  caller: AppAuthContext; token: string; callId: string; operation: 'generateText' | 'streamText'; startedAt: number;
  inputs: boolean; outputs: boolean; count: number; step: number; stepInvocations: number; pending: Promise<unknown>; queued: number;
  error?: Error; terminal?: { status: 'completed' | 'failed' | 'interrupted'; time: number; usage?: JsonValue }; result?: Promise<string>;
  flushes: Map<string, () => Promise<void>>; writer: TurnWriter; release(): void; tools: Set<string>; invocations: Set<string>;
}
export interface TurnCall {
  record(record: Record<string, unknown>): Promise<void>;
  content(part: unknown): Promise<void>;
  finish(result?: any, failure?: unknown): Promise<void>;
  tool(name: string, input: unknown, toolCallId: string, execute: () => Promise<unknown>): Promise<unknown>;
}
/** Host-owned incremental staging. State is bounded independently of turn length. */
export class AiTurns {
  private turns = new Map<string, Turn>();
  private deferred = new Map<string, { link(capture?: AiStart['capture']): Promise<void>; close(): void }>();
  private closed = new Map<string, { terminal: Turn['terminal']; result: Promise<string> }>();
  constructor(private workspace: string, private writerFor: (caller: AppAuthContext) => TurnWriter, private report: (error: unknown) => void = error => console.error('AI content capture failed', error)) {}
  private key(caller: AppAuthContext, callId: string) { return `${caller.channelId}\0${callId}`; }
  private require(caller: AppAuthContext, callId: string) {
    const turn = this.turns.get(this.key(caller, callId));
    if (!turn || turn.caller.appId !== caller.appId) throw new Error('Unknown AI capture or ownership mismatch');
    if (turn.error) throw turn.error;
    return turn;
  }
  async request(admission: AuthAdmission, input: AiCaptureRequest): Promise<{ ok: true; id?: string }> {
    if (admission.context.kind !== 'app' || !input || typeof input.callId !== 'string' || !input.callId || input.callId.length > 256) throw new Error('Invalid AI capture identity');
    const caller = admission.context;
    const key = this.key(caller, input.callId);
    if (input.action === 'link') {
      const pendingKey = this.key(caller, input.token);
      const pending = this.deferred.get(pendingKey);
      if (!pending) throw new Error('Unknown deferred model invocation');
      try { await pending.link(input.stepNumber === undefined ? undefined : { callId: input.callId, stepNumber: input.stepNumber }); }
      finally { this.deferred.delete(pendingKey); pending.close(); }
      return { ok: true };
    }
    if (input.action === 'start') {
      if (this.turns.has(key) || this.closed.has(key) || this.turns.size >= 64 || [...this.turns.values()].filter(t => t.caller.channelId === caller.channelId).length >= 8) throw new Error('Duplicate or excessive AI captures');
      if (!['generateText', 'streamText'].includes(input.operation) || !Number.isSafeInteger(input.time) || input.time < 0 || typeof input.recordInputs !== 'boolean' || typeof input.recordOutputs !== 'boolean') throw new Error('Invalid AI capture start');
      const token = randomUUID(); const directory = captureDirectory(this.workspace, token);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await Promise.all(['raw.jsonl', 'input.txt', 'answer.txt', 'output.txt'].map(name => writeFile(join(directory, name), '', { flag: 'wx', mode: 0o600 })));
      const abort = () => { void this.end(turn, { status: 'interrupted', time: Date.now() }).catch(this.report); };
      const turn: Turn = { caller, token, callId: input.callId, operation: input.operation, startedAt: input.time, inputs: input.recordInputs, outputs: input.recordOutputs, count: 0, step: -1, stepInvocations: 0, pending: Promise.resolve(), queued: 0, flushes: new Map(), writer: this.writerFor(caller), tools: new Set(), invocations: new Set(), release: () => { admission.signal.removeEventListener('abort', abort); admission.release(); } };
      this.turns.set(key, turn);
      admission.signal.addEventListener('abort', abort, { once: true });
      await this.append(turn, { kind: 'start', callId: input.callId, operation: input.operation, time: input.time, recordInputs: turn.inputs, recordOutputs: turn.outputs, exclusions: ['reasoning', 'credentials', 'runtime-context', 'binary-content'] });
      if (admission.signal.aborted) abort();
      return { ok: true };
    }
    const prior = this.closed.get(key);
    if (prior && input.action === 'end') {
      if (JSON.stringify(prior.terminal) !== JSON.stringify({ status: input.status, time: input.time, ...(input.usage !== undefined ? { usage: input.usage } : {}) })) throw new Error('Conflicting AI terminal delivery');
      return { ok: true, id: await prior.result };
    }
    if (prior && input.action === 'disconnect') return { ok: true, id: await prior.result };
    if (input.action === 'discard') {
      const discarded = this.turns.get(key);
      if (discarded) {
        this.poison(discarded, new Error(input.message));
        await discarded.pending.catch(() => {});
        this.turns.delete(key); discarded.release();
        await rm(captureDirectory(this.workspace, discarded.token), { recursive: true, force: true });
      }
      return { ok: true };
    }
    const turn = this.require(caller, input.callId);
    try {
      if (input.action === 'disconnect') return { ok: true, id: await this.end(turn, { status: 'interrupted', time: Date.now() }) };
      if (input.action === 'end') return { ok: true, id: await this.end(turn, { status: input.status, time: input.time, ...(input.usage !== undefined ? { usage: input.usage } : {}) }) };
      if (input.action !== 'record' || turn.terminal) throw new Error('Invalid AI capture operation');
      validateRecord(input.record); const record = input.record;
      if (!['input', 'step', 'tool-start', 'tool-end'].includes(record.kind as string)) throw new Error('App cannot supply Host capture attribution');
      if (record.kind === 'input') {
        if (!turn.inputs || turn.step >= 0) throw new Error('Unexpected AI initial context');
        captureMessage(record.message);
      } else if (record.kind === 'step') {
        if (turn.step >= 0 && turn.stepInvocations === 0) throw new Error('Missing Host model invocation for AI step');
        if (record.stepNumber !== turn.step + 1) throw new Error('Missing/out-of-order AI step');
        turn.step = record.stepNumber as number; turn.stepInvocations = 0;
      } else {
        if (record.stepNumber !== turn.step) throw new Error('Uncorrelated AI tool step');
        if ((!turn.inputs && record.input !== undefined) || (!turn.outputs && record.output !== undefined) || (turn.inputs && record.kind === 'tool-start' && record.input === undefined) || (turn.outputs && record.kind === 'tool-end' && record.output === undefined)) throw new Error('Invalid tool recording selection');
        const id = record.toolCallId as string;
        if (record.kind === 'tool-start') { if (turn.tools.has(id) || turn.tools.size >= 32) throw new Error('Duplicate/excessive AI tool'); turn.tools.add(id); }
        else if (!turn.tools.delete(id)) throw new Error('AI tool result without its call');
      }
      await this.append(turn, record);
      return { ok: true };
    } catch (error) { this.poison(turn, error); throw error; }
  }
  deferInvocation(caller: AppAuthContext, input: AiStart, invocationId: string, prompt: unknown[]) {
    if (!input.captureToken || !/^[a-f0-9-]{36}$/.test(input.captureToken) || input.capture || input.operation !== 'stream') throw new Error('Invalid deferred model invocation');
    const key = this.key(caller, input.captureToken);
    if (this.deferred.has(key) || this.deferred.size >= 64) throw new Error('Duplicate/excessive deferred model invocations');
    let resolve!: (value: TurnCall | undefined) => void;
    let reject!: (error: unknown) => void;
    let failure: unknown;
    let failed = false;
    let linked: TurnCall | undefined;
    const promise = new Promise<TurnCall | undefined>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    const timer = setTimeout(() => { this.deferred.delete(key); reject(new Error('AI model correlation timed out')); }, 30_000); timer.unref();
    this.deferred.set(key, {
      close: () => clearTimeout(timer),
      link: async capture => {
        try {
          if (capture) {
            linked = await this.invocation(caller, { ...input, capture }, invocationId);
            for (const message of prompt) await linked!.record({ kind: 'model-input', message });
            if (failed) await linked!.finish(undefined, failure);
          }
          resolve(linked);
        } catch (error) { reject(error); throw error; }
      },
    });
    return { promise, failed(error: unknown) { failed = true; failure = error; } };
  }
  async invocation(caller: AppAuthContext, input: AiStart, invocationId: string): Promise<TurnCall | undefined> {
    if (!input.capture) return undefined; // official disabled/overridden telemetry
    const turn = this.require(caller, input.capture.callId);
    if (turn.terminal || input.capture.stepNumber !== turn.step || turn.invocations.size >= 8) { const error = new Error('Invalid AI invocation correlation'); this.poison(turn, error); throw error; }
    const stepNumber = turn.step;
    turn.invocations.add(invocationId); turn.stepInvocations++;
    const common = { invocationId, stepNumber };
    const callbacks = new Set<string>();
    const textParts = new Map<string, string>();
    const toolInputs = new Map<string, string>();
    const activeText = new Set<string>();
    let streamError: JsonValue | undefined;
    const record = (value: Record<string, unknown>, terminalFlush = false) => {
      if (turn.terminal && !terminalFlush) return Promise.resolve();
      if (!turn.inputs && value.kind === 'model-input') return Promise.resolve();
      try { return this.append(turn, { ...value, ...(value.kind === 'model-input' ? { message: captureMessage(value.message) } : {}), ...common }); }
      catch (error) { this.poison(turn, error); return Promise.reject(error); }
    };
    const reset = this.work(turn, async () => { await writeFile(join(captureDirectory(this.workspace, turn.token), 'answer.txt'), '', { mode: 0o600 }); });
    const start = record({ kind: 'model-start', model: input.model, accessSource: input.accessSource });
    await Promise.all([reset, start]);
    const text = async (id: string, delta: string, final = false) => {
      let pending = (textParts.get(id) ?? '') + delta;
      if (Buffer.byteLength(pending) > 1024 * 1024) throw new Error('AI text redaction token exceeds the staging limit');
      let cut = final ? pending.length : Math.max(pending.lastIndexOf(' '), pending.lastIndexOf('\n'), pending.lastIndexOf('\t')) + 1;
      if (!final) {
        // Non-ASCII text cannot be part of the policy's ASCII credential tokens.
        for (let i = pending.length - 1; i >= cut; i--) if (pending.charCodeAt(i) > 127 && !(pending.charCodeAt(i) >= 0xd800 && pending.charCodeAt(i) <= 0xdfff)) { cut = i + 1; break; }
      }
      cut = privateKeyCut(pending, cut, final);
      const selected = pending.slice(0, cut);
      pending = pending.slice(cut);
      if (pending) textParts.set(id, pending); else textParts.delete(id);
      if (textParts.size > 32) throw new Error('Excessive AI text parts');
      if (cut) await record({ kind: 'model-content', content: { type: 'text', id, text: redactString(selected) } }, final);
    };
    const flush = async () => {
      for (const id of [...textParts.keys()]) await text(id, '', true);
      for (const [id, input] of toolInputs) { toolInputs.delete(id); await record({ kind: 'model-content', content: { type: 'tool-input-delta', id, delta: redactValue(input, 'input') } }, true); }
    };
    turn.flushes.set(invocationId, flush);
    return {
      record,
      content: async part => {
        if (turn.terminal || !turn.outputs) return;
        const value = part as any;
        try {
          if (value.type === 'error') { streamError = captureData(value.error); return; }
          if (value.type === 'text-start') { captureBlock(value); if (activeText.has(value.id) || activeText.size >= 32) throw new Error('Invalid text stream start'); activeText.add(value.id); return; }
          if (value.type === 'tool-input-start') { captureBlock(value); if (toolInputs.has(value.id) || toolInputs.size >= 32) throw new Error('Invalid tool input stream'); toolInputs.set(value.id, ''); }
          if (value.type === 'tool-input-delta') {
            captureBlock(value);
            if (!toolInputs.has(value.id)) throw new Error('Missing tool input start');
            const input = toolInputs.get(value.id)! + value.delta;
            if (Buffer.byteLength(input) > 512 * 1024) throw new Error('AI tool input exceeds staging limit');
            toolInputs.set(value.id, input); return;
          }
          if (value.type === 'tool-input-end') {
            captureBlock(value);
            if (!toolInputs.has(value.id)) throw new Error('Missing tool input start');
            await record({ kind: 'model-content', content: { type: 'tool-input-delta', id: value.id, delta: redactValue(toolInputs.get(value.id), 'input') } }); toolInputs.delete(value.id);
          }
          if (value.type === 'text-delta') { if (!activeText.has(value.id) || typeof value.id !== 'string' || typeof value.delta !== 'string') throw new Error('Malformed AI text delta'); await text(value.id, value.delta); return; }
          if (value.type === 'text-end') { if (!activeText.delete(value.id)) throw new Error('Missing text stream start'); await text(value.id, '', true); return; }
          if (value.type === 'tool-result' && callbacks.has(value.toolCallId)) return;
          if (['stream-start', 'text-start', 'response-metadata', 'finish', 'error'].includes(value.type)) return;
          const selected = captureBlock(part); if (selected !== undefined) await record({ kind: 'model-content', content: selected });
        } catch (error) { this.poison(turn, error); throw error; }
      },
      finish: async (result, failure = streamError) => {
        if (turn.terminal) { turn.invocations.delete(invocationId); return; }
        try {
          if (!failure && result && (activeText.size || toolInputs.size)) throw new Error('Missing stream content end observation');
          await flush();
          if (!turn.terminal) await record({ kind: 'model-end', ...(result?.usage !== undefined ? { usage: selectedUsage(result.usage) } : {}), ...(result?.finishReason !== undefined ? { finishReason: captureData(result.finishReason) } : {}), ...(result?.response?.modelId !== undefined ? { responseModelId: result.response.modelId } : {}), ...(failure !== undefined ? { error: failure instanceof Error ? { name: failure.name, message: failure.message } : captureData(failure) } : {}) });
        } catch (error) { this.poison(turn, error); throw error; } finally { turn.invocations.delete(invocationId); turn.flushes.delete(invocationId); }
      },
      tool: async (toolName, input, toolCallId, execute) => {
        if (callbacks.has(toolCallId)) throw new Error('Duplicate subscription capture tool');
        callbacks.add(toolCallId);
        const selectedTool = async (kind: 'tool-start' | 'tool-end', value: unknown, failed = false) => {
          try {
            await record({ kind, toolName, toolCallId, ...(kind === 'tool-start' ? (turn.inputs ? { input: captureData(value) } : {}) : { failed, ...(turn.outputs ? { output: value instanceof Error ? { name: value.name, message: value.message } : captureData(value) } : {}) }) });
          } catch (error) { this.poison(turn, error); throw error; }
        };
        await selectedTool('tool-start', input);
        const outcome = await execute().then(value => ({ failed: false, value }), value => ({ failed: true, value }));
        if (!turn.terminal) await selectedTool('tool-end', outcome.value, outcome.failed);
        if (outcome.failed) throw outcome.value;
        return outcome.value;
      },
    };
  }
  private work(turn: Turn, run: () => Promise<void>, bytes = 0): Promise<void> {
    if (turn.error) return Promise.reject(turn.error);
    turn.queued += bytes;
    if (turn.queued > 16 * 1024 * 1024) { const error = new Error('AI capture queue limit exceeded'); this.poison(turn, error); return Promise.reject(error); }
    const result = turn.pending.then(async () => { if (turn.error) throw turn.error; await run(); }).catch(error => { this.poison(turn, error); throw error; }).finally(() => { turn.queued -= bytes; });
    turn.pending = result; void result.catch(() => {});
    return result;
  }
  private append(turn: Turn, value: Record<string, unknown>): Promise<void> {
    try {
      const selected = captureData(value); validateRecord(selected);
      const record = { ...selected };
      for (const field of ['message', 'content', 'input', 'output', 'error']) if (record[field] !== undefined) record[field] = redactValue(record[field], field) as JsonValue;
      validateRecord(record);
      const line = JSON.stringify(record); const bytes = Buffer.byteLength(line);
      if (bytes > CAPTURE_RECORD_BYTES) throw new Error('AI capture record too large');
      return this.work(turn, async () => {
        const directory = captureDirectory(this.workspace, turn.token);
        await appendFile(join(directory, 'raw.jsonl'), line + '\n'); turn.count++;
        if (record.kind === 'input') {
          const message = record.message as { role: string; content: string | { type: string; text?: string }[] };
          const text = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
          if (text) await appendFile(join(directory, 'input.txt'), `${message.role}:\n${text}\n\n`);
        }
        if (record.kind === 'model-content' && (record.content as any)?.type === 'text') {
          const text = (record.content as any).text;
          if (typeof text !== 'string') throw new Error('Malformed captured text');
          await appendFile(join(directory, 'answer.txt'), text);
          await appendFile(join(directory, 'output.txt'), text);
        }
      }, bytes);
    } catch (error) { this.poison(turn, error); return Promise.reject(error); }
  }
  private poison(turn: Turn, error: unknown) {
    if (!turn.error) { turn.error = error instanceof Error ? error : new Error('AI capture failed'); this.report(turn.error); }
  }
  private end(turn: Turn, terminal: NonNullable<Turn['terminal']>): Promise<string> {
    if (turn.result) return turn.result; // first observed generation boundary wins
    if (!['completed', 'failed', 'interrupted'].includes(terminal.status) || !Number.isSafeInteger(terminal.time) || terminal.time < turn.startedAt) return Promise.reject(new Error('Invalid AI terminal boundary'));
    if (terminal.usage !== undefined) validateUsage(terminal.usage);
    turn.terminal = terminal;
    const key = this.key(turn.caller, turn.callId);
    turn.result = (async () => {
      if (terminal.status === 'completed' && (turn.step < 0 || turn.stepInvocations === 0 || turn.invocations.size || turn.tools.size)) throw new Error('Incomplete model/tool observations at completion');
      for (const flush of turn.flushes.values()) await flush();
      await this.append(turn, { kind: 'terminal', ...terminal });
      const input: AiTurnPublication = { token: turn.token, callId: turn.callId, operation: turn.operation, startedAt: turn.startedAt, endedAt: terminal.time, status: terminal.status, recordCount: turn.count, ...(terminal.usage !== undefined ? { usage: terminal.usage } : {}) };
      return await turn.writer.publishAiTurn(input);
    })().catch(error => { this.poison(turn, error); throw error; }).finally(async () => {
      this.turns.delete(key); turn.release();
      await rm(captureDirectory(this.workspace, turn.token), { recursive: true, force: true });
    });
    this.closed.set(key, { terminal, result: turn.result });
    if (this.closed.size > 256) this.closed.delete(this.closed.keys().next().value!);
    return turn.result;
  }
  async close() { for (const pending of this.deferred.values()) { pending.close(); await pending.link(); } this.deferred.clear(); await Promise.allSettled([...this.turns.values()].map(turn => this.end(turn, { status: 'interrupted', time: Date.now() }))); }
}
/** Keep every possible private-key header and its body together for the existing
 * redactor. A closing-marker prefix is not enough to make a block safe. */
function privateKeyCut(value: string, cut: number, final: boolean): number {
  let from = 0;
  for (;;) {
    const begin = value.indexOf('-----BEGIN', from);
    if (begin < 0) return cut;
    const tail = value.slice(begin);
    const opening = /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.exec(tail);
    if (opening) {
      const closing = /-----END [A-Z ]*PRIVATE KEY-----/.exec(tail.slice(opening[0].length));
      if (closing) {
        const end = begin + opening[0].length + closing.index + closing[0].length;
        // Even a complete block must not be divided at a whitespace boundary.
        if (cut > begin && cut < end) cut = begin;
        from = end;
        continue;
      }
    } else if (!/^-----BEGIN(?: [A-Z ]*| [A-Z ]*PRIVATE KEY-{1,4})?$/.test(tail)) {
      from = begin + '-----BEGIN'.length;
      continue; // Definitely not a private-key opening marker.
    }
    if (final) throw new Error('AI text ended with an incomplete private-key redaction block');
    return Math.min(cut, begin);
  }
}
export function selectedUsage(value: any): JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed AI usage');
  const { raw: _, ...selected } = value;
  const result = captureData(selected); validateUsage(result); return result;
}
