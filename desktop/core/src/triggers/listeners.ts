import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SqlStatement, SubscriptionBatch } from '@lamarck/system/protocol';
import type { EventMatchResult } from '../guard-service/protocol';

const REGISTRATION_RESPONSE_TIMEOUT_MS = 30_000;

export interface EventMatcher {
  eventBoundary(): Promise<number>;
  matchEvents(input: SqlStatement & { after: number; preview?: boolean; limit?: number }): Promise<EventMatchResult>;
}
interface Listener {
  owner: string;
  query: SqlStatement;
  matcher: EventMatcher;
  cursor: number;
  sequence: number;
  pending?: EventMatchResult;
  busy: boolean;
  controller: AbortController;
  confirmRegistration: () => void;
}
interface RegistrationOptions {
  requestSignal?: AbortSignal;
  /** Bind initialization's Guard calls to request/owner/registry cancellation. */
  matcher?: (signal: AbortSignal) => EventMatcher;
}
export function subscriptionQuery(input: unknown): SqlStatement {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected SQL subscription settings');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'sql' && key !== 'params') || typeof value.sql !== 'string') {
    throw new Error('Subscription accepts only sql and optional params');
  }
  return JSON.parse(JSON.stringify(value)) as SqlStatement;
}

/** Ephemeral, capability-owned listeners. Nothing here is a saved Trigger. */
export class RuntimeListeners {
  private listeners = new Map<string, Listener>();
  private initializing = new Set<{ owner: string; controller: AbortController }>();
  async start(owner: string, matcher: EventMatcher, input: unknown, runtimeSignal: AbortSignal, options: RegistrationOptions = {}): Promise<{ subscriptionId: string }> {
    const initialization = { owner, controller: new AbortController() };
    const signal = AbortSignal.any([runtimeSignal, initialization.controller.signal, ...(options.requestSignal ? [options.requestSignal] : [])]);
    signal.throwIfAborted();
    const count = [...this.listeners.values()].filter((entry) => entry.owner === owner).length;
    const pending = [...this.initializing].filter((entry) => entry.owner === owner).length;
    if (count + pending >= 12 || this.listeners.size + this.initializing.size >= 1024) throw new Error('Runtime subscription limit reached');
    this.initializing.add(initialization);
    try {
      const query = subscriptionQuery(input);
      const registrationMatcher = options.matcher?.(signal) ?? matcher;
      const cursor = await withAbort(registrationMatcher.eventBoundary(), signal);
      signal.throwIfAborted();
      await withAbort(registrationMatcher.matchEvents({ ...query, after: cursor }), signal);
      signal.throwIfAborted();
      const subscriptionId = randomUUID();
      const controller = new AbortController();
      const abort = () => this.cancel(owner, subscriptionId);
      // A handle is established when its first next request arrives. Reclaim
      // an unreceived start reply without imposing a lease on live listeners.
      const expiry = setTimeout(abort, REGISTRATION_RESPONSE_TIMEOUT_MS);
      expiry.unref?.();
      let requestSignal = options.requestSignal;
      const confirmRegistration = () => {
        clearTimeout(expiry);
        requestSignal?.removeEventListener('abort', abort);
        requestSignal = undefined;
      };
      this.listeners.set(subscriptionId, { owner, matcher, query, cursor, sequence: 0, busy: false, controller, confirmRegistration });
      runtimeSignal.addEventListener('abort', abort, { once: true });
      requestSignal?.addEventListener('abort', abort, { once: true });
      controller.signal.addEventListener('abort', () => {
        confirmRegistration();
        runtimeSignal.removeEventListener('abort', abort);
      }, { once: true });
      return { subscriptionId };
    } finally {
      this.initializing.delete(initialization);
    }
  }
  async next(owner: string, subscriptionId: string, acknowledged: number): Promise<SubscriptionBatch> {
    const entry = this.listeners.get(subscriptionId);
    if (!entry || entry.owner !== owner) throw new Error('Subscription unavailable for this runtime');
    if (entry.busy) throw new Error('Subscription already has a delivery request');
    if (!Number.isSafeInteger(acknowledged) || acknowledged < 0) throw new Error('Invalid subscription acknowledgement');
    entry.busy = true;
    try {
      if (entry.pending) {
        if (acknowledged === entry.sequence - 1) return { sequence: entry.sequence, events: entry.pending.events };
        if (acknowledged !== entry.sequence) throw new Error('Invalid subscription acknowledgement');
        entry.cursor = entry.pending.cursor;
        entry.pending = undefined;
      } else if (acknowledged !== entry.sequence) throw new Error('Invalid subscription acknowledgement');
      entry.confirmRegistration();
      const batch = await withAbort(entry.matcher.matchEvents({ ...entry.query, after: entry.cursor }), entry.controller.signal);
      entry.controller.signal.throwIfAborted();
      entry.pending = batch;
      entry.sequence++;
      if (batch.events.length === 0) await delay(500, undefined, { signal: entry.controller.signal });
      return { sequence: entry.sequence, events: batch.events };
    } finally { entry.busy = false; }
  }
  cancel(owner: string, subscriptionId: string): { ok: true } {
    const entry = this.listeners.get(subscriptionId);
    if (entry && entry.owner !== owner) throw new Error('Subscription unavailable for this runtime');
    if (entry) { this.listeners.delete(subscriptionId); entry.controller.abort(); }
    return { ok: true };
  }
  closeOwner(owner: string): void {
    for (const entry of this.initializing) if (entry.owner === owner) entry.controller.abort();
    for (const [id, entry] of this.listeners) if (entry.owner === owner) this.cancel(owner, id);
  }
  close(): void {
    for (const entry of this.initializing) entry.controller.abort();
    for (const [id, entry] of this.listeners) this.cancel(entry.owner, id);
  }
}

/** Release admission promptly even if an underlying operation replies late. */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
