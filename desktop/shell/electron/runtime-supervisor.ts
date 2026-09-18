export type RuntimePhase = "starting" | "ready" | "restarting" | "failed";

export interface RuntimeState {
  generation: number;
  phase: RuntimePhase;
  error: string | null;
}

export interface RuntimeStartOptions {
  expectedVaultId?: string;
  rotatePort?: boolean;
}

interface RuntimeOperations<CoreProcess, GuardProcess> {
  start(generation: number, options?: RuntimeStartOptions): Promise<void>;
  stopGateway(): Promise<void>;
  stopApps(controlPlaneLost: boolean): Promise<void>;
  stopCore(child: CoreProcess): Promise<void>;
  stopGuard(child: GuardProcess): Promise<void>;
}

/** Owns the one live Core/Guard pair for the current Desktop runtime. */
export class DesktopRuntimeSupervisor<CoreProcess extends object, GuardProcess extends object> {
  #state: RuntimeState = Object.freeze({
    generation: 0,
    phase: "starting",
    error: null,
  });
  #core: CoreProcess | null = null;
  #guard: GuardProcess | null = null;
  #guardOrigin = "";
  #queue: Promise<void> = Promise.resolve();
  #expectedCoreStops = new WeakSet<CoreProcess>();
  #expectedGuardStops = new WeakSet<GuardProcess>();

  constructor(
    private readonly onChange: (state: RuntimeState) => void = () => {},
    private readonly operations?: RuntimeOperations<CoreProcess, GuardProcess>,
  ) {}

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  expectCoreStop(child: CoreProcess): void { this.#expectedCoreStops.add(child); }
  expectGuardStop(child: GuardProcess): void { this.#expectedGuardStops.add(child); }
  isExpectedCoreStop(child: CoreProcess): boolean { return this.#expectedCoreStops.has(child); }
  isExpectedGuardStop(child: GuardProcess): boolean { return this.#expectedGuardStops.has(child); }

  async start(options?: RuntimeStartOptions): Promise<number> {
    const operations = this.#operations();
    const generation = this.begin();
    try {
      await operations.start(generation, options);
      return generation;
    } catch (error) {
      this.fail(generation, error instanceof Error ? error.message : String(error));
      const failures: unknown[] = [];
      try { await operations.stopGateway(); } catch (failure) { failures.push(failure); }
      try { await this.#stopProcesses(); } catch (failure) { failures.push(failure); }
      if (failures.length) {
        throw new AggregateError([error, ...failures], "Runtime startup failed and control-plane cleanup was incomplete");
      }
      throw error;
    }
  }

  async stop(mode: "replace" | "failure" | "lost" = "replace"): Promise<void> {
    const operations = this.#operations();
    if (mode === "replace") {
      this.prepareRestart();
      await operations.stopGateway();
      // Intentional replacement must finish revocation while Core is alive.
      await operations.stopApps(false);
      await this.#stopProcesses();
      return;
    }
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<void>) => {
      try { await operation(); } catch (error) { failures.push(error); }
    };
    await attempt(() => operations.stopGateway());
    if (mode === "lost") {
      await Promise.all([
        attempt(() => operations.stopApps(true)),
        attempt(() => this.#stopProcesses()),
      ]);
    } else {
      await attempt(() => operations.stopApps(false));
      await attempt(() => this.#stopProcesses());
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Runtime shutdown was incomplete");
  }

  async #stopProcesses(): Promise<void> {
    const operations = this.#operations();
    const core = this.#core;
    const guard = this.#guard;
    const failures: unknown[] = [];
    try {
      if (core) await operations.stopCore(core);
    } catch (error) { failures.push(error); }
    // Guard owns data.db. Attempt its release even if Core could not stop.
    try {
      if (guard) await operations.stopGuard(guard);
    } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Control-plane process teardown was incomplete");
  }

  #operations(): RuntimeOperations<CoreProcess, GuardProcess> {
    if (!this.operations) throw new Error("Runtime operations are not configured");
    return this.operations;
  }

  snapshot(): RuntimeState {
    return this.#state;
  }

  get core(): CoreProcess | null {
    return this.#core;
  }

  get guard(): GuardProcess | null {
    return this.#guard;
  }

  get guardOrigin(): string {
    return this.#guardOrigin;
  }

  begin(): number {
    if (this.#core || this.#guard) {
      throw new Error("Cannot start a runtime generation while its predecessor is still attached");
    }
    this.#guardOrigin = "";
    this.#publish({
      generation: this.#state.generation + 1,
      phase: "starting",
      error: null,
    });
    return this.#state.generation;
  }

  attachGuard(generation: number, child: GuardProcess): void {
    this.#assertStartingGeneration(generation);
    if (this.#guard) throw new Error("Guard utility is already attached");
    this.#guard = child;
    this.#guardOrigin = "";
  }

  publishGuardOrigin(
    generation: number,
    child: GuardProcess,
    origin: string,
  ): boolean {
    if (
      generation !== this.#state.generation
      || this.#state.phase !== "starting"
      || this.#guard !== child
    ) return false;
    this.#guardOrigin = origin;
    return true;
  }

  attachCore(generation: number, child: CoreProcess): void {
    this.#assertStartingGeneration(generation);
    if (!this.#guard || !this.#guardOrigin) {
      throw new Error("Cannot attach Core before Guard is ready");
    }
    if (this.#core) throw new Error("Node Core is already attached");
    this.#core = child;
  }

  detachCore(child: CoreProcess): boolean {
    if (this.#core !== child) return false;
    this.#core = null;
    return true;
  }

  detachGuard(child: GuardProcess): boolean {
    if (this.#guard !== child) return false;
    this.#guard = null;
    this.#guardOrigin = "";
    return true;
  }

  ready(generation: number): boolean {
    if (
      generation !== this.#state.generation
      || this.#state.phase !== "starting"
      || !this.#core
      || !this.#guard
      || !this.#guardOrigin
    ) return false;
    this.#publish({ generation, phase: "ready", error: null });
    return true;
  }

  prepareRestart(reason: string | null = null): boolean {
    if (this.#state.phase === "restarting") return false;
    this.#publish({
      generation: this.#state.generation,
      phase: "restarting",
      error: reason,
    });
    return true;
  }

  fail(generation: number, error: string): boolean {
    if (generation !== this.#state.generation) return false;
    this.#publish({ generation, phase: "failed", error });
    return true;
  }

  #assertStartingGeneration(generation: number): void {
    if (
      generation !== this.#state.generation
      || this.#state.phase !== "starting"
    ) {
      throw new Error("Runtime process belongs to a stale generation");
    }
  }

  #publish(state: RuntimeState): void {
    this.#state = Object.freeze({ ...state });
    this.onChange(this.#state);
  }
}
