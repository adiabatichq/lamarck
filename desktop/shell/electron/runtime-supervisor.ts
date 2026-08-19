export type RuntimePhase = "starting" | "ready" | "restarting" | "failed";

export interface RuntimeState {
  generation: number;
  phase: RuntimePhase;
  error: string | null;
}

/** Owns the one live Core/Guard pair for the current Desktop runtime. */
export class DesktopRuntimeSupervisor<CoreProcess, GuardProcess> {
  #state: RuntimeState = Object.freeze({
    generation: 0,
    phase: "starting",
    error: null,
  });
  #core: CoreProcess | null = null;
  #guard: GuardProcess | null = null;
  #guardOrigin = "";

  constructor(
    private readonly onChange: (state: RuntimeState) => void = () => {},
  ) {}

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
