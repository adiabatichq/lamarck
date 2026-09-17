import { randomUUID } from 'node:crypto';
import { encodeAi, type AiEvent, type AiStart, type JsonValue } from '@lamarck/system/protocol';
import type { AppAuthContext, AuthAdmission } from '../auth';
import { AiError, aiFailure } from './errors';

export interface InvocationContext {
  id: string;
  caller: AppAuthContext;
  signal: AbortSignal;
  streamReady(): Promise<void>;
  tool(name: string, input: unknown, toolCallId: string): Promise<unknown>;
  part(value: unknown): Promise<void>;
}
type Unsequenced<T> = T extends { sequence: number } ? Omit<T, 'sequence'> : never;
interface Invocation {
  id: string; caller: AppAuthContext; sourceId: string; controller: AbortController;
  events: AiEvent[]; sequence: number; readSequence: number; bytes: number; terminal: boolean;
  reading: boolean; wake?: () => void; drains: Set<() => void>; timer: ReturnType<typeof setTimeout>;
  idleTimer: ReturnType<typeof setTimeout>; release(): void;
  tools: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
  seenTools: Set<string>;
}
/** Pull-driven event frames multiplexed with control replies on the existing v1 channel. */
export class AiInvocations {
  private calls = new Map<string, Invocation>();
  private queuedBytes = 0;
  private running = new Set<Promise<void>>();
  private closed = false;
  private channelCounts = new Map<string, number>();
  constructor(private readonly limits = { perChannel: 8, global: 64, queueBytes: 8 * 1024 * 1024, globalBytes: 64 * 1024 * 1024, idleMs: 60_000, deadlineMs: 10 * 60_000, pollMs: 15_000 }) {}
  start(admission: AuthAdmission, input: AiStart, run: (context: InvocationContext) => Promise<unknown>): { invocationId: string } {
    if (this.closed) throw new AiError('closed', 'AI service is shutting down');
    if (admission.context.kind !== 'app') throw new AiError('unauthorized', 'App identity required');
    const caller = admission.context;
    if (this.running.size >= this.limits.global || (this.channelCounts.get(caller.channelId) ?? 0) >= this.limits.perChannel) throw new AiError('busy', 'Too many AI invocations');
    admission.signal.throwIfAborted();
    const id = `ai_${randomUUID()}`;
    const controller = new AbortController();
    const abort = () => this.cancel(caller, id);
    admission.signal.addEventListener('abort', abort, { once: true });
    let released = false;
    const call: Invocation = {
      id, caller, sourceId: input.accessSource, controller, events: [], sequence: 0, readSequence: 0, bytes: 0, terminal: false, reading: false,
      tools: new Map(), seenTools: new Set(), drains: new Set(),
      timer: setTimeout(abort, this.limits.deadlineMs), idleTimer: setTimeout(abort, this.limits.idleMs),
      release: () => {
        if (released) return;
        released = true;
        clearTimeout(call.timer);
        admission.signal.removeEventListener('abort', abort);
        admission.release();
      },
    };
    call.timer.unref(); call.idleTimer.unref();
    this.calls.set(id, call);
    this.channelCounts.set(caller.channelId, (this.channelCounts.get(caller.channelId) ?? 0) + 1);
    const context: InvocationContext = {
      id, caller, signal: controller.signal,
      streamReady: () => this.enqueue(call, { type: 'ready' }),
      part: value => this.enqueue(call, { type: 'part', value: encodeAi(value) }),
      tool: async (name, value, toolCallId) => {
        controller.signal.throwIfAborted();
        if (call.terminal) throw new AiError('closed', 'AI invocation ended');
        if (!input.callbacks) throw new AiError('tools_require_scope', 'Subscription tools require system.ai.withTools');
        if (call.seenTools.has(toolCallId) || call.seenTools.size >= 1024 || call.tools.size >= 32) throw new AiError('invalid_tool', 'Duplicate or excessive AI tool callbacks');
        call.seenTools.add(toolCallId);
        const promise = new Promise<unknown>((resolve, reject) => call.tools.set(toolCallId, { resolve, reject }));
        // Observe a simultaneous cancellation even while enqueue is waiting.
        void promise.catch(() => {});
        await this.enqueue(call, { type: 'tool', name, input: encodeAi(value), toolCallId });
        return promise;
      },
    };
    const task = Promise.resolve().then(() => run(context)).then(
      value => this.terminal(call, { type: 'complete', value: encodeAi(value) }),
      error => this.terminal(call, { type: 'error', error: { ...aiFailure(error, controller.signal), ...(call.seenTools.size ? { retryable: false } : {}) } }),
    ).catch(error => this.terminal(call, { type: 'error', error: aiFailure(error) })).finally(() => {
      call.release();
      for (const pending of call.tools.values()) pending.reject(new AiError('cancelled', 'AI invocation ended'));
      call.tools.clear();
      this.running.delete(task);
      const count = (this.channelCounts.get(caller.channelId) ?? 1) - 1;
      if (count) this.channelCounts.set(caller.channelId, count); else this.channelCounts.delete(caller.channelId);
    });
    this.running.add(task);
    return { invocationId: id };
  }
  async next(caller: AppAuthContext, id: string, sequence: number, signal?: AbortSignal): Promise<{ events: AiEvent[] }> {
    const call = this.require(caller, id);
    if (call.reading || sequence !== call.readSequence) throw new AiError('order', 'Invalid AI event cursor');
    call.reading = true;
    clearTimeout(call.idleTimer);
    const cancel = () => this.cancel(caller, id);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      if (!call.events.length && !call.terminal) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { call.wake = undefined; resolve(); }, this.limits.pollMs);
        call.wake = () => { clearTimeout(timer); call.wake = undefined; resolve(); };
      });
      signal?.throwIfAborted();
      const events = call.events.splice(0);
      this.queuedBytes -= call.bytes; call.bytes = 0;
      call.readSequence += events.length;
      for (const resolve of call.drains) resolve(); call.drains.clear();
      if (call.terminal) this.forget(call);
      return { events };
    } finally {
      signal?.removeEventListener('abort', cancel);
      call.reading = false;
      if (this.calls.has(id)) { call.idleTimer = setTimeout(cancel, this.limits.idleMs); call.idleTimer.unref(); }
    }
  }
  reply(caller: AppAuthContext, id: string, toolCallId: string, value: unknown, failed: boolean): void {
    const call = this.require(caller, id);
    const pending = call.tools.get(toolCallId);
    if (!pending || call.terminal) throw new AiError('invalid_tool', 'Unknown or completed AI tool callback');
    call.tools.delete(toolCallId);
    if (failed) pending.reject(new AiError('tool_failed', typeof value === 'string' ? value.slice(0, 1000) : 'App tool failed'));
    else pending.resolve(value);
  }
  cancel(caller: AppAuthContext, id: string): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.require(caller, id);
    call.controller.abort();
    for (const pending of call.tools.values()) pending.reject(new AiError('cancelled', 'AI invocation cancelled'));
    call.tools.clear();
    this.terminal(call, { type: 'error', error: aiFailure(null, call.controller.signal) });
    // Cancellation is acknowledged separately; no consumer is required to drain.
    this.forget(call);
  }
  cancelSource(id: string): void { for (const call of [...this.calls.values()]) if (call.sourceId === id) this.cancel(call.caller, call.id); }
  async close(): Promise<void> {
    this.closed = true;
    for (const call of [...this.calls.values()]) this.cancel(call.caller, call.id);
    await Promise.allSettled(this.running);
  }
  hasSource(id: string): boolean { return [...this.calls.values()].some(call => call.sourceId === id); }
  get size(): number { return this.calls.size; }
  private require(caller: AppAuthContext, id: string): Invocation {
    const call = this.calls.get(id);
    if (!call || call.caller.channelId !== caller.channelId || call.caller.appId !== caller.appId) throw new AiError('unknown_invocation', 'AI invocation is unavailable');
    return call;
  }
  private async enqueue(call: Invocation, event: Unsequenced<AiEvent>): Promise<void> {
    call.controller.signal.throwIfAborted();
    if (call.terminal) throw new AiError('closed', 'AI invocation ended');
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > this.limits.queueBytes - 256) throw new AiError('too_large', 'AI event exceeds the size limit');
    while (call.bytes + bytes > this.limits.queueBytes - 256 && !call.controller.signal.aborted) await new Promise<void>(resolve => { call.drains.add(resolve); });
    call.controller.signal.throwIfAborted();
    if (call.terminal) throw new AiError('closed', 'AI invocation ended');
    if (this.queuedBytes + bytes > this.limits.globalBytes - this.limits.global * 256) throw new AiError('slow_consumer', 'AI event queue is full');
    call.events.push({ ...event, sequence: call.sequence++ } as AiEvent);
    call.bytes += bytes; this.queuedBytes += bytes;
    call.wake?.();
  }
  private terminal(call: Invocation, event: Unsequenced<AiEvent>): void {
    if (call.terminal) return;
    call.terminal = true;
    let bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes + call.bytes > this.limits.queueBytes || bytes + this.queuedBytes > this.limits.globalBytes) {
      event = { type: 'error', error: { code: 'too_large', message: 'AI result exceeds the queue limit', retryable: false } };
      bytes = Buffer.byteLength(JSON.stringify(event));
    }
    call.bytes += bytes; this.queuedBytes += bytes;
    call.events.push({ ...event, sequence: call.sequence++ } as AiEvent);
    call.wake?.(); for (const resolve of call.drains) resolve(); call.drains.clear();
  }
  private forget(call: Invocation): void {
    if (!this.calls.delete(call.id)) return;
    clearTimeout(call.idleTimer);
    this.queuedBytes -= call.bytes; call.bytes = 0;
    call.wake?.(); for (const resolve of call.drains) resolve(); call.drains.clear();
  }
}
