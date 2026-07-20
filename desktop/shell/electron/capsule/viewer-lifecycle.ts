/**
 * Main-process lifecycle gate for one App viewer.
 *
 * Reload is single-flight through both backend replacement and Electron
 * WebContents cutover. Destructive events can invalidate the current
 * generation synchronously, so an operation that is already awaiting I/O must
 * prove it still owns the viewer before publishing any replacement authority.
 */
export class ViewerLifecycleCoordinator {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #reloads = new Map<string, Promise<unknown>>();
  readonly #generations = new Map<string, number>();

  generation(appId: string): number {
    return this.#generations.get(appId) ?? 0;
  }

  invalidate(appId: string): number {
    const next = this.generation(appId) + 1;
    this.#generations.set(appId, next);
    return next;
  }

  assertCurrent(appId: string, generation: number): void {
    if (this.generation(appId) !== generation) {
      throw new Error("App viewer lifecycle generation changed");
    }
  }

  runExclusive<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(appId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(appId, tail);
    void tail.finally(() => {
      if (this.#tails.get(appId) === tail) this.#tails.delete(appId);
    });
    return result;
  }

  reload<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.#reloads.get(appId);
    if (existing) return existing as Promise<T>;
    const result = this.runExclusive(appId, operation);
    this.#reloads.set(appId, result);
    void result.finally(() => {
      if (this.#reloads.get(appId) === result) this.#reloads.delete(appId);
    }).catch(() => {});
    return result;
  }
}

export interface ViewerAuthoritySnapshot {
  readonly viewerId: string;
  readonly appId: string;
  readonly instanceId: string;
  readonly channelId: string;
  readonly capability: string;
}

/**
 * Final synchronous CAS before Main publishes a manager-issued authority into
 * an Electron renderer. Gateway/session setup contains awaits, so identity
 * equality must be re-proved after the last one rather than inferred from the
 * earlier openViewer result.
 */
export function assertViewerAuthorityCurrent(
  expected: ViewerAuthoritySnapshot,
  current: ViewerAuthoritySnapshot | null,
): void {
  if (
    current === null
    || current.viewerId !== expected.viewerId
    || current.appId !== expected.appId
    || current.instanceId !== expected.instanceId
    || current.channelId !== expected.channelId
    || current.capability !== expected.capability
  ) {
    throw new Error("App viewer authority changed before renderer publication");
  }
}
