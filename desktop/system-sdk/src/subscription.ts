import type { D0Event, SqlStatement, SubscriptionBatch } from './protocol.js';

export interface Subscription {
  /** Stops new deliveries. An already-running callback may finish. */
  cancel(): Promise<void>;
  /** Resolves on cancellation; rejects on a handler, transport, or SQL error. */
  readonly done: Promise<void>;
}
export interface SubscriptionTransport {
  start(input: SqlStatement): Promise<{ subscriptionId: string }>;
  next(input: { subscriptionId: string; acknowledged: number }): Promise<SubscriptionBatch>;
  cancel(input: { subscriptionId: string }): Promise<unknown>;
}

/** Callbacks execute only here, in the subscribing runtime. */
export function createSubscribe(transport: SubscriptionTransport, signal?: AbortSignal) {
  return async (query: SqlStatement, handler: (event: D0Event) => void | Promise<void>): Promise<Subscription> => {
    if (typeof handler !== 'function') throw new Error('subscribe requires a handler');
    if (signal?.aborted) throw new Error('Subscription runtime ended');
    const { subscriptionId } = await transport.start(query);
    let canceled = false;
    let canceling: Promise<void> | undefined;
    const cancel = (): Promise<void> => {
      canceled = true;
      signal?.removeEventListener('abort', abort);
      return canceling ??= transport.cancel({ subscriptionId }).then(() => {});
    };
    const abort = () => { void cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const done = (async () => {
      let acknowledged = 0;
      try {
        while (!canceled) {
          const batch = await transport.next({ subscriptionId, acknowledged });
          for (const event of batch.events) {
            if (canceled) break;
            await handler(event);
          }
          acknowledged = batch.sequence;
        }
      } catch (error) {
        if (!canceled) throw error;
      } finally {
        await cancel().catch(() => {});
      }
    })();
    // Consumers can await done; a forgotten handle must not crash the runtime.
    void done.catch(() => {});
    return Object.freeze({ cancel, done });
  };
}
